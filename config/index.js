import 'dotenv/config';

const config = {
  port: parseInt(process.env.PORT, 10) || 3000,
  databaseUrl: process.env.DATABASE_URL,
  groqApiKey: process.env.GROQ_API_KEY,
  baseRpcUrl: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
  baseChainId: parseInt(process.env.BASE_CHAIN_ID || '8453', 10),
  usdcContractAddress: process.env.USDC_CONTRACT_ADDRESS || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  protocolTreasuryAddress: process.env.PROTOCOL_TREASURY_ADDRESS,
  protocolFeeBps: parseInt(process.env.PROTOCOL_FEE_BPS || '200', 10),
  tickInterval: 20000, // 20s — safe for Groq free tier (~30 req/min)
};

export default config;
