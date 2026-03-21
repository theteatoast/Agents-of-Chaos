/** Copy compiled ChaosParimutuelMarket ABI to public/ for the browser. Run after: npm run compile:contracts */
const fs = require('fs');
const path = require('path');

const src = path.join(
    __dirname,
    '..',
    'contracts',
    'artifacts',
    'contracts',
    'contracts',
    'ChaosParimutuelMarket.sol',
    'ChaosParimutuelMarket.json'
);
const dst = path.join(__dirname, '..', 'public', 'abi', 'ChaosParimutuelMarket.json');

if (!fs.existsSync(src)) {
    console.error('Missing:', src, '\nRun: npm run compile:contracts');
    process.exit(1);
}
fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.copyFileSync(src, dst);
console.log('Copied ABI →', dst);
