import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { ethers } from 'ethers';
import config from '../config/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ARTIFACT_REL = join(
    'contracts',
    'artifacts',
    'contracts',
    'contracts',
    'ChaosParimutuelMarket.sol',
    'ChaosParimutuelMarket.json'
);

let cachedArtifact = null;
let cachedIface = null;

function loadArtifact() {
    if (cachedArtifact) return cachedArtifact;
    const artifactPath = join(__dirname, '..', ARTIFACT_REL);
    const publicPath = join(__dirname, '..', 'public', 'abi', 'ChaosParimutuelMarket.json');
    const path = existsSync(artifactPath) ? artifactPath : publicPath;
    if (!existsSync(path)) {
        throw new Error(
            'ChaosParimutuelMarket artifact not found. Run: npm run compile:contracts and copy abi to public/abi/ChaosParimutuelMarket.json'
        );
    }
    cachedArtifact = JSON.parse(readFileSync(path, 'utf-8'));
    cachedIface = new ethers.Interface(cachedArtifact.abi);
    return cachedArtifact;
}

function getIface() {
    loadArtifact();
    return cachedIface;
}

export function getContractInterface() {
    return getIface();
}

export function getContractAbi() {
    return loadArtifact().abi;
}

export function formatSignedInt256ToNumber(value, decimals = 6) {
    const v = BigInt(value);
    const neg = v < 0n;
    const abs = neg ? -v : v;
    const n = Number(ethers.formatUnits(abs, decimals));
    return neg ? -n : n;
}

const ERC20_MIN = ['function allowance(address,address) view returns (uint256)', 'function balanceOf(address) view returns (uint256)'];

const BASE_RPC_FALLBACKS = ['https://mainnet.base.org', 'https://base.llamarpc.com', 'https://base.publicnode.com'];

async function withRpcFallback(fn) {
    const urls = [config.baseRpcUrl, ...BASE_RPC_FALLBACKS.filter((u) => u !== config.baseRpcUrl)];
    let lastErr;
    for (const url of urls) {
        try {
            return await fn(url);
        } catch (e) {
            lastErr = e;
        }
    }
    throw lastErr;
}

/**
 * Parse a mined tx: `BetPlaced`, `StakeExited`, or `Claimed`.
 */
export async function fetchParimutuelEventFromTx(txHash) {
    loadArtifact();
    const iface = getIface();
    if (!config.predictionMarketContractAddress) {
        throw new Error('PREDICTION_MARKET_CONTRACT_ADDRESS is not set');
    }

    return withRpcFallback(async (rpcUrl) => {
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        const net = await provider.getNetwork();
        if (Number(net.chainId) !== config.baseChainId) {
            throw new Error(`RPC chainId mismatch: expected ${config.baseChainId}, got ${net.chainId}`);
        }

        const receipt = await provider.getTransactionReceipt(txHash);
        if (!receipt) throw new Error('Transaction not found or not mined');
        if (receipt.status !== 1) throw new Error('Transaction reverted');

        const contractAddr = config.predictionMarketContractAddress.toLowerCase();
        const betTopic = iface.getEvent('BetPlaced').topicHash;
        const exitTopic = iface.getEvent('StakeExited').topicHash;
        const claimTopic = iface.getEvent('Claimed').topicHash;
        const claimLog = receipt.logs.find(
            (l) => l.address.toLowerCase() === contractAddr && l.topics[0] === claimTopic
        );
        const exitLog = receipt.logs.find(
            (l) => l.address.toLowerCase() === contractAddr && l.topics[0] === exitTopic
        );
        const betLog = receipt.logs.find(
            (l) => l.address.toLowerCase() === contractAddr && l.topics[0] === betTopic
        );

        if (claimLog) {
            const parsed = iface.parseLog({ topics: claimLog.topics, data: claimLog.data });
            return {
                kind: 'claim',
                user: parsed.args.user,
                marketId: Number(parsed.args.marketId),
                outcomeIndex: Number(parsed.args.outcomeIndex),
                amount: parsed.args.amount,
            };
        }
        if (exitLog) {
            const parsed = iface.parseLog({ topics: exitLog.topics, data: exitLog.data });
            return {
                kind: 'exit',
                user: parsed.args.user,
                marketId: Number(parsed.args.marketId),
                outcomeIndex: Number(parsed.args.outcomeIndex),
                netUsdcReturned: parsed.args.netUsdcReturned,
            };
        }
        if (betLog) {
            const parsed = iface.parseLog({ topics: betLog.topics, data: betLog.data });
            return {
                kind: 'bet',
                user: parsed.args.user,
                marketId: Number(parsed.args.marketId),
                outcomeIndex: Number(parsed.args.outcomeIndex),
                grossUsdc: parsed.args.grossUsdc,
                feeUsdc: parsed.args.feeUsdc,
                netUsdc: parsed.args.netUsdc,
            };
        }
        throw new Error(
            'No BetPlaced, StakeExited, or Claimed event from the prediction market contract in this receipt'
        );
    });
}

/** @deprecated Prefer fetchParimutuelEventFromTx — kept for callers that only index bets. */
export async function fetchBetEventFromTx(txHash) {
    const ev = await fetchParimutuelEventFromTx(txHash);
    if (ev.kind !== 'bet') throw new Error('No BetPlaced event in this receipt (this tx may be exitStake)');
    return ev;
}

/** @returns {Promise<number[]>} net stake per outcome index (USDC float) */
export async function readMarketStakeTotals(marketId) {
    const artifact = loadArtifact();
    if (!config.predictionMarketContractAddress) {
        throw new Error('PREDICTION_MARKET_CONTRACT_ADDRESS is not set');
    }
    const mid = Number(marketId);
    if (!Number.isFinite(mid) || mid < 1) return [];

    return withRpcFallback(async (rpcUrl) => {
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        const net = await provider.getNetwork();
        if (Number(net.chainId) !== config.baseChainId) {
            throw new Error(`RPC chain mismatch: expected ${config.baseChainId}, got ${net.chainId}`);
        }
        const c = new ethers.Contract(config.predictionMarketContractAddress, artifact.abi, provider);
        const m = await c.markets(mid);
        const n = Number(m.outcomeCount);
        if (!m.active || n < 1) return [];
        const totals = [];
        for (let i = 0; i < n; i++) {
            const t = await c.totalStakeOnOutcome(mid, i);
            totals.push(Number(ethers.formatUnits(t, 6)));
        }
        return totals;
    });
}

export async function readTotalPool(marketId) {
    const artifact = loadArtifact();
    if (!config.predictionMarketContractAddress) {
        throw new Error('PREDICTION_MARKET_CONTRACT_ADDRESS is not set');
    }
    const mid = Number(marketId);
    if (!Number.isFinite(mid)) return 0;

    return withRpcFallback(async (rpcUrl) => {
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        const net = await provider.getNetwork();
        if (Number(net.chainId) !== config.baseChainId) {
            throw new Error(`RPC chain mismatch: expected ${config.baseChainId}, got ${net.chainId}`);
        }
        const c = new ethers.Contract(config.predictionMarketContractAddress, artifact.abi, provider);
        const p = await c.totalPool(mid);
        return Number(ethers.formatUnits(p, 6));
    });
}

/**
 * Server-side reads for bet UX — avoids browser wallet RPC issues (Rabby "missing revert data").
 * @param {string|number|undefined} outcomeIndexOpt — if set, includes `stake_net_usdc` for `stakeOf(market, outcome, wallet)`.
 * @returns {Promise<object>}
 */
export async function getBetPrecheck(marketId, walletAddress, outcomeIndexOpt) {
    const contractAddr = config.predictionMarketContractAddress;
    if (!contractAddr) {
        throw new Error('PREDICTION_MARKET_CONTRACT_ADDRESS is not set');
    }
    const w = String(walletAddress || '').trim().toLowerCase();
    if (!/^0x[a-fA-F0-9]{40}$/.test(w)) {
        throw new Error('Invalid wallet address');
    }
    const artifact = loadArtifact();
    const mid = Number(marketId);
    if (!Number.isFinite(mid) || mid < 1) throw new Error('Invalid marketId');

    return withRpcFallback(async (rpcUrl) => {
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        const net = await provider.getNetwork();
        if (Number(net.chainId) !== config.baseChainId) {
            throw new Error(`RPC chain mismatch: expected ${config.baseChainId}, got ${net.chainId}`);
        }
        const market = new ethers.Contract(contractAddr, artifact.abi, provider);
        const m = await market.markets(mid);
        const poolWei = await market.totalPool(mid);
        const usdc = new ethers.Contract(config.usdcContractAddress, ERC20_MIN, provider);
        const allowanceRaw = await usdc.allowance(w, contractAddr);
        const balanceRaw = await usdc.balanceOf(w);
        let stake_net_usdc = null;
        if (outcomeIndexOpt !== undefined && outcomeIndexOpt !== null && outcomeIndexOpt !== '') {
            const oid = Number(outcomeIndexOpt);
            if (Number.isFinite(oid) && oid >= 0 && oid < Number(m.outcomeCount)) {
                const stakeRaw = await market.stakeOf(mid, oid, w);
                stake_net_usdc = ethers.formatUnits(stakeRaw, 6);
            }
        }
        return {
            marketId: mid,
            active: Boolean(m.active),
            resolved: Boolean(m.resolved),
            outcomeCount: Number(m.outcomeCount),
            closeTime: Number(m.closeTime),
            feeBps: Number(m.feeBps),
            pool_total_usdc: Number(ethers.formatUnits(poolWei, 6)),
            allowance_usdc: ethers.formatUnits(allowanceRaw, 6),
            balance_usdc: ethers.formatUnits(balanceRaw, 6),
            stake_net_usdc,
        };
    });
}

/**
 * Dry-run `bet` on a reliable RPC (same as precheck). Surfaces reverts before the wallet signs.
 * @param {number} marketId
 * @param {number} outcomeIndex
 * @param {bigint} grossSmallest — USDC amount in 6-decimal base units
 * @param {string} fromAddress — wallet that will send the tx (for balance/allowance checks inside the call)
 */
export async function simulateBet(marketId, outcomeIndex, grossSmallest, fromAddress) {
    const contractAddr = config.predictionMarketContractAddress;
    if (!contractAddr) {
        throw new Error('PREDICTION_MARKET_CONTRACT_ADDRESS is not set');
    }
    const from = String(fromAddress || '').trim().toLowerCase();
    if (!/^0x[a-fA-F0-9]{40}$/.test(from)) {
        throw new Error('Invalid wallet address');
    }
    const mid = Number(marketId);
    const oid = Number(outcomeIndex);
    if (!Number.isFinite(mid) || mid < 1) throw new Error('Invalid marketId');
    if (!Number.isFinite(oid) || oid < 0) throw new Error('Invalid outcomeIndex');
    if (typeof grossSmallest !== 'bigint' || grossSmallest <= 0n) throw new Error('Invalid gross amount');

    const artifact = loadArtifact();
    return withRpcFallback(async (rpcUrl) => {
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        const net = await provider.getNetwork();
        if (Number(net.chainId) !== config.baseChainId) {
            throw new Error(`RPC chain mismatch: expected ${config.baseChainId}, got ${net.chainId}`);
        }
        const market = new ethers.Contract(contractAddr, artifact.abi, provider);
        await market.bet.staticCall(mid, oid, grossSmallest, { from });

        /** Wallets often fail estimateGas via their own RPC (missing revert data). Same params on server RPC usually works. */
        let gas_limit = null;
        try {
            const data = market.interface.encodeFunctionData('bet', [mid, oid, grossSmallest]);
            const gas = await provider.estimateGas({ to: contractAddr, from, data });
            gas_limit = gas.toString();
        } catch {
            /* staticCall already proved the bet can execute; gas estimate is optional */
        }
        return { ok: true, gas_limit };
    });
}

/**
 * Dry-run `exitStake` — full withdrawal of net stake before betting closes.
 */
export async function simulateExitStake(marketId, outcomeIndex, fromAddress) {
    const contractAddr = config.predictionMarketContractAddress;
    if (!contractAddr) {
        throw new Error('PREDICTION_MARKET_CONTRACT_ADDRESS is not set');
    }
    const from = String(fromAddress || '').trim().toLowerCase();
    if (!/^0x[a-fA-F0-9]{40}$/.test(from)) {
        throw new Error('Invalid wallet address');
    }
    const mid = Number(marketId);
    const oid = Number(outcomeIndex);
    if (!Number.isFinite(mid) || mid < 1) throw new Error('Invalid marketId');
    if (!Number.isFinite(oid) || oid < 0) throw new Error('Invalid outcomeIndex');

    const artifact = loadArtifact();
    return withRpcFallback(async (rpcUrl) => {
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        const net = await provider.getNetwork();
        if (Number(net.chainId) !== config.baseChainId) {
            throw new Error(`RPC chain mismatch: expected ${config.baseChainId}, got ${net.chainId}`);
        }
        const market = new ethers.Contract(contractAddr, artifact.abi, provider);
        await market.exitStake.staticCall(mid, oid, { from });

        let gas_limit = null;
        try {
            const data = market.interface.encodeFunctionData('exitStake', [mid, oid]);
            const gas = await provider.estimateGas({ to: contractAddr, from, data });
            gas_limit = gas.toString();
        } catch {
            /* optional */
        }
        return { ok: true, gas_limit };
    });
}

/**
 * Read whether `claim(marketId)` will succeed and estimated USDC payout (6 decimals).
 */
export async function getClaimPrecheck(marketId, walletAddress) {
    const contractAddr = config.predictionMarketContractAddress;
    if (!contractAddr) {
        throw new Error('PREDICTION_MARKET_CONTRACT_ADDRESS is not set');
    }
    const w = String(walletAddress || '').trim().toLowerCase();
    if (!/^0x[a-fA-F0-9]{40}$/.test(w)) {
        throw new Error('Invalid wallet address');
    }
    const mid = Number(marketId);
    if (!Number.isFinite(mid) || mid < 1) throw new Error('Invalid marketId');

    const artifact = loadArtifact();
    return withRpcFallback(async (rpcUrl) => {
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        const net = await provider.getNetwork();
        if (Number(net.chainId) !== config.baseChainId) {
            throw new Error(`RPC chain mismatch: expected ${config.baseChainId}, got ${net.chainId}`);
        }
        const c = new ethers.Contract(contractAddr, artifact.abi, provider);
        const m = await c.markets(mid);
        if (!m.resolved) {
            return {
                can_claim: false,
                reason: 'not_resolved',
                resolved: false,
            };
        }
        const winIdx = Number(m.winningOutcome);
        const stakeRaw = await c.stakeOf(mid, winIdx, w);
        if (stakeRaw === 0n) {
            return {
                can_claim: false,
                reason: 'nothing_to_claim',
                resolved: true,
                winning_outcome_index: winIdx,
            };
        }
        const P = await c.resolvedPoolSnapshot(mid);
        const W = await c.resolvedWinningStakeSnapshot(mid);
        if (W === 0n) {
            return { can_claim: false, reason: 'no_winning_stake_snapshot', resolved: true };
        }
        const payoutRaw = (stakeRaw * P) / W;
        return {
            can_claim: true,
            resolved: true,
            winning_outcome_index: winIdx,
            stake_net_usdc: ethers.formatUnits(stakeRaw, 6),
            estimated_payout_usdc: ethers.formatUnits(payoutRaw, 6),
        };
    });
}

/** Dry-run `claim(marketId)` for gas estimate. */
export async function simulateClaim(marketId, fromAddress) {
    const contractAddr = config.predictionMarketContractAddress;
    if (!contractAddr) {
        throw new Error('PREDICTION_MARKET_CONTRACT_ADDRESS is not set');
    }
    const from = String(fromAddress || '').trim().toLowerCase();
    if (!/^0x[a-fA-F0-9]{40}$/.test(from)) {
        throw new Error('Invalid wallet address');
    }
    const mid = Number(marketId);
    if (!Number.isFinite(mid) || mid < 1) throw new Error('Invalid marketId');

    const artifact = loadArtifact();
    return withRpcFallback(async (rpcUrl) => {
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        const net = await provider.getNetwork();
        if (Number(net.chainId) !== config.baseChainId) {
            throw new Error(`RPC chain mismatch: expected ${config.baseChainId}, got ${net.chainId}`);
        }
        const market = new ethers.Contract(contractAddr, artifact.abi, provider);
        await market.claim.staticCall(mid, { from });

        let gas_limit = null;
        try {
            const data = market.interface.encodeFunctionData('claim', [mid]);
            const gas = await provider.estimateGas({ to: contractAddr, from, data });
            gas_limit = gas.toString();
        } catch {
            /* optional */
        }
        return { ok: true, gas_limit };
    });
}
