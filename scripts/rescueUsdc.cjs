/**
 * Owner only — contract must be PAUSED first.
 *
 *   npm run rescue:usdc -- <recipientAddress> <amountUsdc>
 *
 * Example: send 10.5 USDC (6 decimals) to a user who cannot claim via UI:
 *   npm run rescue:usdc -- 0xRecipient... 10.5
 *
 * Requires: PREDICTION_MARKET_CONTRACT_ADDRESS, DEPLOYER_PRIVATE_KEY (or owner key), BASE_RPC_URL
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
    throw new Error('Set DEPLOYER_PRIVATE_KEY (owner wallet) in .env');
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
    const to = process.argv[2];
    const amountStr = process.argv[3];
    if (!to || !/^0x[a-fA-F0-9]{40}$/.test(to)) {
        throw new Error('Usage: npm run rescue:usdc -- <recipientAddress> <amountUsdc>\nExample: npm run rescue:usdc -- 0x... 10.5');
    }
    const amount = Number(amountStr);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('amountUsdc must be a positive number');

    const addr = process.env.PREDICTION_MARKET_CONTRACT_ADDRESS;
    if (!addr) throw new Error('PREDICTION_MARKET_CONTRACT_ADDRESS required');
    if (!fs.existsSync(ART)) throw new Error('Run: npm run compile:contracts\n' + ART);

    const { abi } = JSON.parse(fs.readFileSync(ART, 'utf8'));
    const rpc = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
    const w = resolvePk().connect(new ethers.JsonRpcProvider(rpc));
    const c = new ethers.Contract(addr, abi, w);

    const paused = await c.paused();
    if (!paused) {
        throw new Error(
            'Contract is not paused. Owner must call pause() first (BaseScan → Write → pause), ' +
                'then run this script, then unpause() when done.'
        );
    }

    const raw = ethers.parseUnits(String(amount), 6);
    console.log('rescueUSDC', to, amount, 'USDC (raw', raw.toString(), ') from', w.address);
    const tx = await c.rescueUSDC(to, raw);
    console.log('tx', tx.hash);
    await tx.wait();
    console.log('✅ USDC rescued (emit USDCRescued on BaseScan)');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
