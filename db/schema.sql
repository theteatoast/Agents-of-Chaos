-- agents table
CREATE TABLE IF NOT EXISTS agents (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  personality TEXT NOT NULL,
  credits FLOAT DEFAULT 100,
  food INT DEFAULT 10,
  energy INT DEFAULT 10,
  status TEXT DEFAULT 'ACTIVE',
  last_action TEXT DEFAULT 'NONE'
);

-- market state
CREATE TABLE IF NOT EXISTS market_state (
  tick INT PRIMARY KEY DEFAULT 0,
  food_price FLOAT DEFAULT 5.0,
  energy_price FLOAT DEFAULT 3.0
);

-- event logs
CREATE TABLE IF NOT EXISTS event_logs (
  id SERIAL PRIMARY KEY,
  tick INT NOT NULL,
  description TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Snapshot richest-agent resolution source
CREATE TABLE IF NOT EXISTS tick_snapshots (
  tick INT PRIMARY KEY,
  richest_agent_id INT REFERENCES agents(id),
  richest_agent_credits DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Human USDC betting markets (separate from sandbox economy)
CREATE TABLE IF NOT EXISTS prediction_markets (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  settlement_tick INT NOT NULL,
  betting_opens_at TIMESTAMPTZ DEFAULT NOW(),
  betting_closes_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'OPEN', -- OPEN, PAUSED, CLOSED, RESOLVED
  fee_bps INT NOT NULL DEFAULT 200,
  winning_agent_id INT REFERENCES agents(id),
  resolved_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- One market has binary outcomes for each agent
CREATE TABLE IF NOT EXISTS market_outcomes (
  id SERIAL PRIMARY KEY,
  market_id INT NOT NULL REFERENCES prediction_markets(id) ON DELETE CASCADE,
  agent_id INT NOT NULL REFERENCES agents(id),
  reserve_yes DOUBLE PRECISION NOT NULL DEFAULT 1000,
  reserve_no DOUBLE PRECISION NOT NULL DEFAULT 1000,
  UNIQUE (market_id, agent_id)
);

CREATE TABLE IF NOT EXISTS user_wallet_links (
  id SERIAL PRIMARY KEY,
  wallet_address TEXT UNIQUE NOT NULL,
  auth_nonce TEXT,
  nonce_expires_at TIMESTAMP,
  last_authenticated_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS market_positions (
  id SERIAL PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  market_id INT NOT NULL REFERENCES prediction_markets(id) ON DELETE CASCADE,
  outcome_id INT NOT NULL REFERENCES market_outcomes(id) ON DELETE CASCADE,
  shares DOUBLE PRECISION NOT NULL DEFAULT 0,
  total_cost_usdc DOUBLE PRECISION NOT NULL DEFAULT 0,
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (wallet_address, market_id, outcome_id)
);

CREATE TABLE IF NOT EXISTS market_trades (
  id SERIAL PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  market_id INT NOT NULL REFERENCES prediction_markets(id) ON DELETE CASCADE,
  outcome_id INT NOT NULL REFERENCES market_outcomes(id) ON DELETE CASCADE,
  side TEXT NOT NULL, -- BUY_YES, BUY_NO, SELL_YES, SELL_NO
  usdc_amount DOUBLE PRECISION NOT NULL,
  shares_delta DOUBLE PRECISION NOT NULL,
  avg_price DOUBLE PRECISION NOT NULL,
  fee_usdc DOUBLE PRECISION NOT NULL,
  tx_hash TEXT,
  block_timestamp TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS protocol_fees (
  id SERIAL PRIMARY KEY,
  market_id INT REFERENCES prediction_markets(id),
  trade_id INT REFERENCES market_trades(id),
  fee_usdc DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_event_logs_tick ON event_logs (tick DESC);
CREATE INDEX IF NOT EXISTS idx_market_trades_market_id ON market_trades (market_id);
CREATE INDEX IF NOT EXISTS idx_market_positions_wallet ON market_positions (wallet_address);
