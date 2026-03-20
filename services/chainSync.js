import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { ethers } from 'ethers';
import config from '../config/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadArtifact() {
    const artifactPath = join(
        __dirname,
        '..',
        'contracts',
        'artifacts',
        'contracts',
        'contracts',
        'ChaosPredictionMarket.sol',
        'ChaosPredictionMarket.json'
    );
    const publicPath = join(__dirname, '..', 'public', 'abi', 'ChaosPredictionMarket.json');
    const path = existsSync(artifactPath) ? artifactPath : publicPath;
    return JSON.parse(readFileSync(path, 'utf-8'));
}

const artifact = loadArtifact();
const iface = new ethers.Interface(artifact.abi);

export function getContractInterface() {
    return iface;
}

export function getContractAbi() {
    return artifact.abi;
}

export function formatSignedInt256ToNumber(value, decimals = 6) {
    const v = BigInt(value);
    const neg = v < 0n;
    const abs = neg ? -v : v;
    const n = Number(ethers.formatUnits(abs, decimals));
    return neg ? -n : n;
}

export async function fetchTradeEventFromTx(txHash) {
    if (!config.predictionMarketContractAddress) {
        throw new Error('PREDICTION_MARKET_CONTRACT_ADDRESS is not set');
    }
    const provider = new ethers.JsonRpcProvider(config.baseRpcUrl);
    const net = await provider.getNetwork();
    if (Number(net.chainId) !== config.baseChainId) {
        throw new Error(`RPC chainId mismatch: expected ${config.baseChainId}, got ${net.chainId}`);
    }

    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) throw new Error('Transaction not found or not mined');
    if (receipt.status !== 1) throw new Error('Transaction reverted');

    const contractAddr = config.predictionMarketContractAddress.toLowerCase();
    const tradeTopic = iface.getEvent('Trade').topicHash;
    const log = receipt.logs.find(
        (l) => l.address.toLowerCase() === contractAddr && l.topics[0] === tradeTopic
    );
    if (!log) throw new Error('No Trade event from the prediction market contract in this receipt');

    const parsed = iface.parseLog({ topics: log.topics, data: log.data });
    return {
        user: parsed.args.user,
        marketId: Number(parsed.args.marketId),
        outcomeIndex: Number(parsed.args.outcomeIndex),
        side: Number(parsed.args.side),
        grossUsdc: parsed.args.grossUsdc,
        feeUsdc: parsed.args.feeUsdc,
        netUsdc: parsed.args.netUsdc,
        sharesDelta: parsed.args.sharesDelta,
        usdcToUser: parsed.args.usdcToUser,
    };
}

export async function readReservesOnChain(marketId, outcomeIndex) {
    if (!config.predictionMarketContractAddress) {
        throw new Error('PREDICTION_MARKET_CONTRACT_ADDRESS is not set');
    }
    const provider = new ethers.JsonRpcProvider(config.baseRpcUrl);
    const c = new ethers.Contract(config.predictionMarketContractAddress, artifact.abi, provider);
    const [ry, rn] = await Promise.all([c.reserveYes(marketId, outcomeIndex), c.reserveNo(marketId, outcomeIndex)]);
    return {
        reserve_yes: Number(ethers.formatUnits(ry, 6)),
        reserve_no: Number(ethers.formatUnits(rn, 6)),
    };
}
