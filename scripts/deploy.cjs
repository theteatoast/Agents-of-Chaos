/**
 * Deploy ChaosParimutuelMarket to Base using ethers + compiled artifact.
 *
 * .env (project root or cwd): any of the usual names, OR any VAR=0x<64 hex> / VAR=<64 hex>
 *
 *   npm run compile:contracts
 *   npm run deploy:contract
 */
const path = require('path');
const fs = require('fs');
const { ethers } = require('ethers');

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
    const candidates = [
        path.join(__dirname, '..', '.env'),
        path.join(process.cwd(), '.env'),
    ];
    const loaded = [];
    const seen = new Set();
    for (const p of candidates) {
        const norm = path.resolve(p);
        if (seen.has(norm)) continue;
        seen.add(norm);
        if (fs.existsSync(p)) {
            dotenv.config({ path: p });
            loaded.push(norm);
        }
    }
    return loaded;
}

function stripEnvQuotes(s) {
    let t = String(s).trim();
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
        t = t.slice(1, -1);
    }
    return t.trim();
}

function stripBom(s) {
    if (s.charCodeAt(0) === 0xfeff) return s.slice(1);
    return s;
}

/** Scan .env files for any line KEY=value where value is a 64-hex private key (optional 0x). */
function tryParseHexPrivateKeyFromFiles(filePaths) {
    for (const filePath of filePaths) {
        if (!fs.existsSync(filePath)) continue;
        let raw = fs.readFileSync(filePath, 'utf8');
        raw = stripBom(raw);
        for (const line of raw.split(/\r?\n/)) {
            const t = line.trim();
            if (!t || t.startsWith('#')) continue;
            const eq = t.indexOf('=');
            if (eq === -1) continue;
            const k = t.slice(0, eq).trim().replace(/^export\s+/, '');
            let val = stripEnvQuotes(t.slice(eq + 1).trim());
            const hashIdx = val.indexOf('#');
            if (hashIdx !== -1) val = val.slice(0, hashIdx).trim();
            const hex = val.startsWith('0x') ? val.slice(2) : val;
            if (/^[0-9a-fA-F]{64}$/.test(hex)) {
                return {
                    key: '0x' + hex,
                    sourceVar: `${k} (${path.basename(filePath)})`,
                };
            }
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
        if (/^[0-9a-fA-F]{64}$/.test(hex)) {
            return { key: '0x' + hex, sourceVar: name };
        }
    }
    return null;
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

async function main() {
    const loadedEnvFiles = loadEnvFiles();
    const envPath = path.join(__dirname, '..', '.env');
    const cwdEnv = path.join(process.cwd(), '.env');

    let resolved = resolvePrivateKey();
    if (!resolved) {
        resolved = tryParseHexPrivateKeyFromFiles([envPath, cwdEnv]);
    }

    if (!resolved) {
        throw new Error(
            `No deployer private key found.\n\n` +
                `1) Put a 64-character hex key (with or without 0x) in .env using one of:\n` +
                `   ${KEY_ALIASES.join(', ')}\n` +
                `2) Or any variable name whose value is exactly 64 hex digits (we scan .env lines).\n\n` +
                `Env files loaded: ${loadedEnvFiles.length ? loadedEnvFiles.join(' | ') : '(none — put .env in the project folder)'}\n` +
                `Expected file: ${envPath}`
        );
    }

    const pk = resolved.key;

    const rpc = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
    const provider = new ethers.JsonRpcProvider(rpc);
    const wallet = new ethers.Wallet(pk, provider);

    const usdc = process.env.USDC_CONTRACT_ADDRESS || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    const treasury = process.env.PROTOCOL_TREASURY_ADDRESS || wallet.address;

    if (!fs.existsSync(ARTIFACT)) {
        throw new Error('Artifact not found. Run: npm run compile:contracts\n' + ARTIFACT);
    }
    const artifact = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8'));

    console.log('RPC:', rpc);
    console.log('Deploying with:', wallet.address, `(from ${resolved.sourceVar})`);
    console.log('USDC:', usdc);
    console.log('Treasury:', treasury);

    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
    const c = await factory.deploy(usdc, treasury);
    await c.waitForDeployment();
    const addr = await c.getAddress();

    console.log('\n✅ ChaosParimutuelMarket deployed to:', addr);
    console.log('\nAdd to .env and restart the API:');
    console.log('PREDICTION_MARKET_CONTRACT_ADDRESS=' + addr);
    console.log('\nCopy ABI: contracts/artifacts/.../ChaosParimutuelMarket.json → public/abi/ChaosParimutuelMarket.json');
    console.log('Then owner: registerMarket(marketId, closeTime, feeBps, outcomeCount) — no USDC seed.\n');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
