require('hardhat/config');

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
    solidity: {
        version: '0.8.20',
        settings: {
            optimizer: { enabled: true, runs: 200 },
            viaIR: true,
        },
    },
    paths: {
        sources: './contracts/contracts',
        artifacts: './contracts/artifacts',
        cache: './contracts/cache',
    },
    networks: {
        base: {
            url: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
            accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
        },
    },
};
