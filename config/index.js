import 'dotenv/config';

const tickMs = parseInt(process.env.TICK_INTERVAL_MS || '30000', 10);
const groqDelay = parseInt(process.env.GROQ_MIN_DELAY_MS || '2100', 10);
const foodEveryN = parseInt(process.env.FOOD_CONSUME_EVERY_N_TICKS || '2', 10);

const config = {
  port: parseInt(process.env.PORT, 10) || 3000,
  databaseUrl: process.env.DATABASE_URL,
  groqApiKey: process.env.GROQ_API_KEY,
  baseRpcUrl: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
  baseChainId: parseInt(process.env.BASE_CHAIN_ID || '8453', 10),
  usdcContractAddress: process.env.USDC_CONTRACT_ADDRESS || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  protocolTreasuryAddress: process.env.PROTOCOL_TREASURY_ADDRESS,
  protocolFeeBps: parseInt(process.env.PROTOCOL_FEE_BPS || '200', 10),
  predictionMarketContractAddress: process.env.PREDICTION_MARKET_CONTRACT_ADDRESS || '',
  allowUnverifiedTrades: process.env.ALLOW_UNVERIFIED_TRADES === 'true',
  /** Min 12 chars. Required for: simulation start/stop, POST /markets, POST /markets/trade (when enabled). */
  adminApiKey: process.env.ADMIN_API_KEY || '',
  /**
   * Wall-clock ms between simulation ticks. Default 30s so N agents × Groq delay can stay under free-tier RPM.
   * Rule of thumb: TICK_INTERVAL_MS ≥ (agentCount × GROQ_MIN_DELAY_MS) + a few seconds buffer.
   */
  tickInterval: Number.isFinite(tickMs) && tickMs >= 5000 ? tickMs : 30000,
  /**
   * Minimum ms between Groq completion calls (sequential). ~2100ms ≈ ≤28 RPM. Set 0 if your Groq tier allows bursts.
   */
  groqMinDelayMs: Number.isFinite(groqDelay) && groqDelay >= 0 ? groqDelay : 2100,
  /** Max parallel Groq calls per tick. Default 1 avoids burst 429s; raise only with a higher Groq rate limit. */
  groqMaxConcurrent: Math.min(8, Math.max(1, parseInt(process.env.GROQ_MAX_CONCURRENT || '1', 10) || 1)),
  /** Retries when Groq returns 429 / rate limit. */
  groqMaxRetries: Math.min(6, Math.max(0, parseInt(process.env.GROQ_MAX_RETRIES || '3', 10) || 3)),
  /**
   * Consume 1 food unit only every N ticks (1 = old harsh behavior). Default 2 halves starvation speed for fairer runs.
   */
  foodConsumeEveryNTicks: Number.isFinite(foodEveryN) && foodEveryN >= 1 ? Math.floor(foodEveryN) : 2,
};

export default config;
