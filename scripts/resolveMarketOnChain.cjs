/**
 * Owner: resolve a market on-chain after betting is done (must match richest agent → outcome index).
 *
 *   npm run resolve:market -- <marketId> <winningOutcomeIndex>
 *
 * winningOutcomeIndex = position in market_outcomes ORDER BY id (same as UI / contract).
 */
const path = require('path');
const fs = require('fs');
const { ethers } = require('ethers');

const KEY_ALIASES = ['DEPLOYER_PRIVATE_KEY', 'PRIVATE_KEY', 'ETH_PRIVATE_KEY', 'WALLET_PRIVATE_KEY'];

function loadEnv() {
    require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
}

function resolvePk() {
    for (const k of KEY_ALIASES) {
        const v = process.env[k];
        if (!v) continue;
        const hex = v.startsWith('0x') ? v.slice(2) : v;
        if (/^[0-9a-fA-F]{64}$/.test(hex)) return new ethers.Wallet('0x' + hex);
    }
    throw new Error('Set DEPLOYER_PRIVATE_KEY in .env');
}

const ART = path.join(
    __dirname,
    '..',
    'contracts',
    'artifacts',
    'contracts',
    'contracts',
    'ChaosParimutuelMarket.sol',
    'ChaosParimutuelMarket.json'
);

async function main() {
    loadEnv();
    const marketId = Number(process.argv[2]);
    const winIdx = Number(process.argv[3]);
    if (!Number.isFinite(marketId) || marketId < 1 || !Number.isFinite(winIdx) || winIdx < 0) {
        throw new Error('Usage: npm run resolve:market -- <marketId> <winningOutcomeIndex>');
    }
    const addr = process.env.PREDICTION_MARKET_CONTRACT_ADDRESS;
    if (!addr) throw new Error('PREDICTION_MARKET_CONTRACT_ADDRESS required');
    if (!fs.existsSync(ART)) throw new Error('Run: npm run compile:contracts\n' + ART);

    const { abi } = JSON.parse(fs.readFileSync(ART, 'utf8'));
    const rpc = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
    const w = resolvePk().connect(new ethers.JsonRpcProvider(rpc));
    const c = new ethers.Contract(addr, abi, w);

    console.log('resolveMarket', String(marketId), String(winIdx), 'from', w.address);
    const tx = await c.resolveMarket(marketId, winIdx);
    console.log('tx', tx.hash);
    await tx.wait();
    console.log('✅ Resolved on-chain');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
