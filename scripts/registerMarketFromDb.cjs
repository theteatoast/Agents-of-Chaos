/**
 * Register a prediction market on-chain from Postgres (must match deploy owner key).
 *
 *   npm run register:market -- 3
 *
 * Requires: DATABASE_URL, DEPLOYER_PRIVATE_KEY (or same key resolution as deploy.cjs),
 * PREDICTION_MARKET_CONTRACT_ADDRESS, BASE_RPC_URL (optional).
 *
 * Parimutuel: registerMarket pulls no USDC — owner only pays gas.
 */
const path = require('path');
const fs = require('fs');
const { ethers } = require('ethers');
const { Pool } = require('pg');

const KEY_ALIASES = [
    'DEPLOYER_PRIVATE_KEY',
    'PRIVATE_KEY',
    'ETH_PRIVATE_KEY',
    'WALLET_PRIVATE_KEY',
    'DEPLOYER_KEY',
    'DEPLOY_PRIVATE_KEY',
];

function loadEnvFiles() {
    const dotenv = require('dotenv');
    const candidates = [path.join(__dirname, '..', '.env'), path.join(process.cwd(), '.env')];
    const seen = new Set();
    for (const p of candidates) {
        const norm = path.resolve(p);
        if (seen.has(norm)) continue;
        seen.add(norm);
        if (fs.existsSync(p)) dotenv.config({ path: p });
    }
}

function stripEnvQuotes(s) {
    let t = String(s).trim();
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) t = t.slice(1, -1);
    return t.trim();
}

function tryParseHexPrivateKeyFromFiles(filePaths) {
    for (const filePath of filePaths) {
        if (!fs.existsSync(filePath)) continue;
        let raw = fs.readFileSync(filePath, 'utf8');
        if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
        for (const line of raw.split(/\r?\n/)) {
            const t = line.trim();
            if (!t || t.startsWith('#')) continue;
            const eq = t.indexOf('=');
            if (eq === -1) continue;
            let val = stripEnvQuotes(t.slice(eq + 1).trim());
            const hashIdx = val.indexOf('#');
            if (hashIdx !== -1) val = val.slice(0, hashIdx).trim();
            const hex = val.startsWith('0x') ? val.slice(2) : val;
            if (/^[0-9a-fA-F]{64}$/.test(hex)) return { key: '0x' + hex, sourceVar: 'scanned .env' };
        }
    }
    return null;
}

function resolvePrivateKey() {
    for (const name of KEY_ALIASES) {
        const raw = process.env[name];
        if (!raw) continue;
        const v = stripEnvQuotes(raw);
        if (!v) continue;
        const hex = v.startsWith('0x') ? v.slice(2) : v;
        if (/^[0-9a-fA-F]{64}$/.test(hex)) return { key: '0x' + hex, sourceVar: name };
    }
    const envPath = path.join(__dirname, '..', '.env');
    return tryParseHexPrivateKeyFromFiles([envPath, path.join(process.cwd(), '.env')]);
}

const ARTIFACT = path.join(
    __dirname,
    '..',
    'contracts',
    'artifacts',
    'contracts',
    'contracts',
    'ChaosParimutuelMarket.sol',
    'ChaosParimutuelMarket.json'
);

/** Legacy CPMM deployments expose SEED_RESERVE(); ChaosParimutuelMarket does not. */
async function probeSeedReserve(provider, address) {
    const iface = new ethers.Interface(['function SEED_RESERVE() view returns (uint256)']);
    const data = iface.encodeFunctionData('SEED_RESERVE', []);
    try {
        const code = await provider.getCode(address);
        if (!code || code === '0x') return { isSeededCpmm: false, seedWei: null, hasCode: false };
        const result = await provider.call({ to: address, data });
        if (!result || result === '0x') return { isSeededCpmm: false, seedWei: null, hasCode: true };
        const [seed] = iface.decodeFunctionResult('SEED_RESERVE', result);
        return { isSeededCpmm: seed > 0n, seedWei: seed.toString(), hasCode: true };
    } catch {
        return { isSeededCpmm: false, seedWei: null, hasCode: null };
    }
}

async function main() {
    loadEnvFiles();

    const marketId = Number(process.argv[2] || process.env.REGISTER_MARKET_ID || '3');
    if (!Number.isFinite(marketId) || marketId < 1) {
        throw new Error('Usage: npm run register:market -- <marketId>\nExample: npm run register:market -- 3');
    }

    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) throw new Error('DATABASE_URL is required');

    const contractAddr = process.env.PREDICTION_MARKET_CONTRACT_ADDRESS;
    if (!contractAddr) throw new Error('PREDICTION_MARKET_CONTRACT_ADDRESS is required');

    const resolved = resolvePrivateKey();
    if (!resolved) throw new Error('No deployer private key (same as deploy.cjs — DEPLOYER_PRIVATE_KEY etc.)');

    if (!fs.existsSync(ARTIFACT)) {
        throw new Error('Artifact not found. Run: npm run compile:contracts\n' + ARTIFACT);
    }
    const artifact = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8'));

    const useSsl = /sslmode=require|neon\.tech|supabase\.co/i.test(dbUrl);
    const pool = new Pool({ connectionString: dbUrl, ssl: useSsl ? { rejectUnauthorized: false } : undefined });

    try {
    const { rows: mr } = await pool.query(
        `SELECT id, fee_bps, betting_closes_at FROM prediction_markets WHERE id = $1`,
        [marketId]
    );
    if (!mr.length) {
        const { rows: all } = await pool.query(
            `SELECT id, slug FROM prediction_markets ORDER BY id ASC LIMIT 50`
        );
        const ids = all.map((r) => r.id);
        const hint =
            ids.length === 0
                ? 'No rows in prediction_markets — run seed or POST /markets to create a market.'
                : `Valid prediction_markets.id values in this database: ${ids.join(', ')}. Use one of these after --`;
        throw new Error(`No prediction_markets row with id=${marketId}. ${hint}`);
    }

    const { rows: cr } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM market_outcomes WHERE market_id = $1`,
        [marketId]
    );

    const feeBps = Number(mr[0].fee_bps);
    const closes = mr[0].betting_closes_at;
    if (!closes) throw new Error(`prediction_markets.betting_closes_at is null for id=${marketId}`);

    const closeTimeUnix = Math.floor(new Date(closes).getTime() / 1000);
    if (!Number.isFinite(closeTimeUnix) || closeTimeUnix <= 0) {
        throw new Error(`Invalid betting_closes_at for id=${marketId}: ${closes}`);
    }

    const outcomeCount = cr[0].n;
    if (outcomeCount < 1 || outcomeCount > 64) {
        throw new Error(`outcomeCount must be 1..64, got ${outcomeCount}`);
    }
    if (feeBps > 2000) throw new Error(`fee_bps ${feeBps} > 2000 (contract FeeTooHigh)`);

    const rpc = process.env.BASE_RPC_URL || 'https://mainnet.base.org';

    const provider = new ethers.JsonRpcProvider(rpc);
    const wallet = new ethers.Wallet(resolved.key, provider);

    const market = new ethers.Contract(contractAddr, artifact.abi, wallet);

    const seedProbe = await probeSeedReserve(provider, contractAddr);
    const isOldCpmm = seedProbe.isSeededCpmm;
    if (isOldCpmm) {
        throw new Error(
            `PREDICTION_MARKET_CONTRACT_ADDRESS (${contractAddr}) is a legacy CPMM contract (has SEED_RESERVE).\n` +
                `Its registerMarket() pulls USDC seed from the owner — you are seeing "transfer amount exceeds allowance" because no USDC was approved.\n\n` +
                `This repo’s default flow uses ChaosParimutuelMarket: registerMarket uses gas only.\n` +
                `Fix: run "npm run compile:contracts" then "npm run deploy:contract", put the new address in .env, restart, and run this script again.\n` +
                `Or: approve USDC to this contract for the seed amount if you must keep this address.`
        );
    }

    console.log('RPC:', rpc);
    console.log('Contract:', contractAddr);
    console.log('Signer (must be contract owner):', wallet.address);
    console.log('marketId:', marketId);
    console.log('closeTime (unix):', closeTimeUnix, new Date(closeTimeUnix * 1000).toISOString());
    console.log('feeBps:', feeBps);
    console.log('outcomeCount:', outcomeCount);
    console.log('Owner USDC spend for registration: 0 (parimutuel pool is funded by bettors only).');

    const onchain = await market.markets(marketId);
    if (onchain.active) {
        const r = await pool.query(
            `UPDATE market_outcomes SET reserve_yes = 0, reserve_no = 0 WHERE market_id = $1`,
            [marketId]
        );
        console.log(`\n✅ Market already active on-chain. Reset DB stake mirrors (${r.rowCount} outcomes).`);
        return;
    }

    console.log('Calling registerMarket…');
    let reg;
    try {
        reg = await market.registerMarket(marketId, closeTimeUnix, feeBps, outcomeCount);
    } catch (e) {
        const msg = String(e?.reason || e?.message || e || '');
        if (/exceeds allowance|transfer amount exceeds allowance/i.test(msg)) {
            throw new Error(
                `${msg}\n\n` +
                    `If you did not mean to spend USDC here, your PREDICTION_MARKET_CONTRACT_ADDRESS may be the old CPMM contract. ` +
                    `Deploy ChaosParimutuelMarket and update .env (see error above when SEED_RESERVE is detected).`
            );
        }
        throw e;
    }
    console.log('registerMarket tx:', reg.hash);
    await reg.wait();
    const r = await pool.query(`UPDATE market_outcomes SET reserve_yes = 0, reserve_no = 0 WHERE market_id = $1`, [marketId]);
    console.log(`\n✅ Registered market ${marketId} on-chain. DB outcomes reset (${r.rowCount} rows); stakes sync from chain after bets.`);
    } finally {
        await pool.end().catch(() => {});
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
