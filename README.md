# Agents of Chaos

**AI agents dropped into an economy** — they earn, trade, scam, or starve. **You can bet on who ends up richest.**

The simulation runs in the database: credits, food, energy, and tick-by-tick chaos (powered by Groq). **Bets** are in **USDC on Base**: a **parimutuel** pool (`ChaosParimutuelMarket.sol`) — bettors’ money **is** the liquidity; protocol fee on each bet goes to treasury. When betting closes, the **richest agent** in the economy wins — you predicted which agent that would be.

The API **indexes** on-chain trades into Postgres; it does not custody user funds. Off-chain `POST /markets/trade` (DB-only, unverified) is **disabled by default** — production flow is **wallet → contract → `POST /markets/trade/confirm`**.

---

## Table of contents

1. [Architecture](#architecture)
2. [Prerequisites](#prerequisites)
3. [Quick start (local + Neon)](#quick-start-local--neon)
4. [Total workflow](#total-workflow)
   - [A. Agent economy (simulation)](#a-agent-economy-simulation)
   - [B. Betting on who ends richest (Base)](#b-betting-on-who-ends-richest-base)
   - [C. Deploy & register on Base](#c-deploy--register-on-base)
5. [Environment variables](#environment-variables)
6. [Database](#database)
7. [API reference](#api-reference)
8. [Frontend (wallet flow)](#frontend-wallet-flow)
9. [Economics & fees](#economics--fees)
10. [Resolution & claims](#resolution--claims)
11. [Security & operations](#security--operations)
12. [Troubleshooting](#troubleshooting)
13. [Scripts](#scripts)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Fastify (server.js)                      │
├────────────────────────────┬────────────────────────────────────┤
│  Static UI (public/)      │  REST API                             │
│  Chart.js + ethers (UMD)   │  economy + betting APIs                  │
└────────────────────────────┴────────────────────────────────────┘
         │                                    │
         │                                    ├── Postgres (Neon)
         │                                    │   agents, prediction_markets,
         │                                    │   market_outcomes, market_trades,
         │                                    │   market_positions, tick_snapshots…
         │                                    │
         └── Browser wallet ──► Base RPC ──► ChaosParimutuelMarket
                    │              ▲
                    │              └── chainSync.js: receipt, Trade event,
                    │                  reserveYes/No read-back
                    └── trade/confirm indexes tx → DB
```

**Key files**

| Area | Path |
|------|------|
| Contract | `contracts/contracts/ChaosParimutuelMarket.sol` |
| Hardhat | `hardhat.config.cjs` (Solidity `viaIR: true` — avoids “stack too deep”) |
| Browser ABI | `public/abi/ChaosParimutuelMarket.json` (auto-copied after `npm run compile:contracts`) |
| Config | `config/index.js` |
| Chain indexing | `services/chainSync.js`, `services/predictionMarketService.js` |
| Tick / Groq | `simulation/tickEngine.js`, `ai/groqClient.js` |

---

## Prerequisites

- **Node.js** 18+
- **PostgreSQL** (e.g. [Neon](https://neon.tech) serverless)
- **Groq API key** for agent decisions (`GROQ_API_KEY`)
- For on-chain: **Base** wallet with USDC, **`BASE_RPC_URL`**, deployed contract address

---

## Quick start (local + Neon)

1. **Clone & install**

   ```bash
   npm install
   ```

2. **Create `.env`** (see [Environment variables](#environment-variables)). Minimum for DB + agent simulation:

   ```env
   DATABASE_URL=postgresql://user:pass@host/db?sslmode=require
   GROQ_API_KEY=your_groq_key
   ```

3. **Schema** (creates all tables from `db/schema.sql`):

   ```bash
   npm run setup-db
   ```

4. **Migrations** (existing DBs / Neon):

   ```bash
   npm run migrate
   npm run migrate:tx
   ```

5. **Seed** agents + default prediction market (optional; **wipes** agent/market data — see `db/seed.js`):

   ```bash
   npm run seed
   ```

6. **Run API + dashboard**

   ```bash
   npm run dev
   ```

   Open **http://localhost:3000** (or `PORT`).

---

## Total workflow

### A. Agent economy (simulation)

1. **Start the economy** — `POST /simulation/start` (or the UI). The tick engine runs on an interval and calls **Groq** so each agent chooses actions: **work**, buy/sell **food** & **energy**, or **hold** — starvation and bad luck are part of the game.
2. **State** — `market_state` holds the tick and prices; every agent has **credits**, **food**, **energy** tracked in Postgres.
3. **Leaderboard** — Each tick, the **richest agent** is stored in **`tick_snapshots`** — that’s the source of truth for **who wins** when a bet resolves.
4. **Stop** — `POST /simulation/stop`.

**Credits in the economy are not USDC** — they’re the in-game score. **USDC on Base** is only for **betting** on those outcomes (see below).

---

### B. Betting on who ends richest (Base) — **parimutuel**

1. **Open a betting market in Postgres** — `POST /markets` with `slug`, `title`, `settlementTick`, optional `feeBps`, `bettingOpensAt`, `bettingClosesAt`. One **outcome** is created per **agent** (`market_outcomes`).
2. **Mirror on-chain (no USDC from you)** — Deploy **`ChaosParimutuelMarket`** (`npm run deploy:contract`). Owner calls **`registerMarket(marketId, closeTimeUnix, feeBps, outcomeCount)`** — **only gas**, **no seed liquidity**. `marketId` = `prediction_markets.id`; `outcomeCount` = number of outcomes; indices **0 … n-1** match `ORDER BY id`.
3. **Bettors fund the pool** — Each **`bet(marketId, outcomeIndex, grossUsdc)`** pulls USDC: **fee → treasury**, **net → on-chain pool**. All losing stakes + winning stakes stay in the contract until **`claim`**.
4. **Dashboard** — Wallet on **Base**, `/markets/config` (`market_model: parimutuel`), `/markets/abi` → **`ChaosParimutuelMarket.json`**.
5. **Quote** — `POST /markets/quote` with `{ marketId, outcomeId, side: "BET", usdcAmount }` — pool totals & fee (no AMM / no `minOut`).
6. **On-chain bet** — Approve USDC, then **`bet(marketId, outcomeIndex, grossUsdc)`**.
7. **Index** — UI **`POST /markets/trade/confirm`** with `{ "txHash" }`; server decodes **`BetPlaced`**, syncs **`market_outcomes`** stake mirrors from **`totalStakeOnOutcome`**.
8. **Resolve (owner)** — After the economy winner is known, map **richest agent → outcome index** and call **`resolveMarket(marketId, winningOutcomeIndex)`** on-chain (must match DB `winning_agent_id` ordering).
9. **Claim (winners)** — **`claim(marketId)`** on-chain; payout = **pro-rata** net stake on winning outcome × **full pool** (fixed snapshot at resolve). **Protocol revenue** = **fees on each bet** (transparent on BaseScan).
10. **Rate limit** — `/markets/trade/confirm`: **30/min/IP**.

**Dev escape hatch:** set `ALLOW_UNVERIFIED_TRADES=true` to allow **`POST /markets/trade`** (writes DB from server-side quote only — **not** for production).

---

### C. Deploy & register on Base

1. **Compile**

   ```bash
   npm run compile:contracts
   ```

2. **Compile** copies the ABI to `public/abi/ChaosParimutuelMarket.json` (see `scripts/copyParimutuelAbi.cjs`).

3. **Deploy** `ChaosParimutuelMarket` (constructor **`(USDC, TREASURY)`** — Base mainnet USDC default: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`):

   ```bash
   # Requires DEPLOYER_PRIVATE_KEY in .env (wallet with ETH on Base for gas)
   npm run deploy:contract
   ```

   Copy the printed address into **`.env`**:

   ```env
   PREDICTION_MARKET_CONTRACT_ADDRESS=0xYourDeployedAddress
   ```

   **Restart** the Node server so it reloads `dotenv`.

4. **Owner: `registerMarket`** — **no USDC** required (parimutuel). Only **gas** on Base.

   ```bash
   npm run register:market -- 3
   ```

   Reads `fee_bps`, `betting_closes_at`, and outcome count from Postgres, then calls `registerMarket` on `PREDICTION_MARKET_CONTRACT_ADDRESS`.

5. **Resolve on-chain (owner)** when you know the winning agent’s **outcome index** (0-based, `ORDER BY market_outcomes.id`):

   ```bash
   npm run resolve:market -- 3 0
   ```

6. **Set env** — `PREDICTION_MARKET_CONTRACT_ADDRESS`, `PROTOCOL_TREASURY_ADDRESS`, `PROTOCOL_FEE_BPS`, `BASE_RPC_URL`, restart the server.

7. **Run migrations** on Neon: `npm run migrate` and `npm run migrate:tx`.

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | Postgres connection string (Neon: include `?sslmode=require`) |
| `GROQ_API_KEY` | Yes* | Groq API key for agent LLM (*required for simulation ticks) |
| `PORT` | No | HTTP port (default `3000`) |
| `BASE_RPC_URL` | For chain | Base JSON-RPC (default `https://mainnet.base.org`) |
| `BASE_CHAIN_ID` | No | Default `8453` (Base mainnet) |
| `USDC_CONTRACT_ADDRESS` | No | Base USDC (default canonical) |
| `PREDICTION_MARKET_CONTRACT_ADDRESS` | Production | Deployed `ChaosParimutuelMarket` — **required** for `trade/confirm` |
| `PROTOCOL_TREASURY_ADDRESS` | Recommended | Protocol fee recipient (shown in transparency API) |
| `PROTOCOL_FEE_BPS` | No | e.g. `200` = 2% (must match market/contract registration intent) |
| `ALLOW_UNVERIFIED_TRADES` | No | Set `true` **only in dev** — enables DB-only `POST /markets/trade` |
| `ADMIN_API_KEY` | **Yes (prod)** | Min **12** characters. Protects `POST /simulation/start`, `POST /simulation/stop`, `POST /markets` (create), and `POST /markets/trade`. Send `Authorization: Bearer <key>` or `X-Admin-Key`. The dashboard prompts once per browser session for start/stop. |
| `MARKET_CLOSES_AT` | No | ISO 8601 — used by **`npm run seed`** for default `betting_closes_at` |

---

## Database

| Script | Purpose |
|--------|---------|
| `npm run setup-db` | Run `db/schema.sql` — initial create |
| `npm run migrate` | Add `betting_opens_at` / `betting_closes_at` if missing |
| `npm run migrate:tx` | Unique partial index on `market_trades(tx_hash)` where not null (idempotent indexing) |
| `npm run seed` | **Destructive** reseed: agents + one default “who’s richest?” betting market |

**Neon:** Create a project, paste `DATABASE_URL`, run `setup-db` then migrations. Use `seed` once for a demo dataset.

---

## API reference

### Agent economy (dashboard)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/simulation/start` | Start the tick loop (**admin key required**) — alias: `/sandbox/simulation/start` |
| `POST` | `/simulation/stop` | Stop the tick loop (**admin key required**) |
| `GET` | `/simulation/status` | Status |
| `GET` | `/agents` | List agents (alias: `/sandbox/agents`) |
| `GET` | `/market` | Food/energy prices & tick (alias: `/sandbox/market`) |
| `GET` | `/events` | Recent tick events (alias: `/sandbox/events`) |

### Wallet (optional linking)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/wallet/challenge` | Nonce challenge |
| `POST` | `/wallet/verify` | Verify signature |

### Betting (who ends richest)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/markets` | List markets (`domain: usdc`, `chain: base`) |
| `GET` | `/markets/transparency` | Rules + fee + treasury + chain info |
| `GET` | `/markets/config` | `chain_id`, USDC, contract, fee bps, flags |
| `GET` | `/markets/abi` | Contract ABI JSON for wallet UI |
| `GET` | `/markets/:marketId/precheck?wallet=0x…` | Server-side `markets()`, pool, USDC allowance/balance (avoids flaky wallet RPC on reads) |
| `POST` | `/markets/:marketId/simulate-bet` | Body: `{ outcomeIndex, gross_smallest, wallet }` — dry-run `bet` + optional `gas_limit` from server `estimateGas` (UI passes it to MetaMask to avoid flaky wallet RPC) |
| `POST` | `/markets` | Create market + outcomes (**admin key required**) |
| `GET` | `/markets/:marketId/outcomes` | Outcomes + reserves |
| `POST` | `/markets/quote` | Parimutuel quote (fee, pool totals, `side: "BET"`) |
| `POST` | `/markets/trade` | **DB-only trade** — only if `ALLOW_UNVERIFIED_TRADES=true` — **admin key required** |
| `POST` | `/markets/trade/confirm` | **Production:** `{ txHash }` — index from chain |
| `GET` | `/markets/fees/daily` | Aggregated protocol fee rows |
| `GET` | `/positions/:walletAddress` | Positions + marks / PnL helpers |
| `POST` | `/positions/:walletAddress/claim` | **DB bookkeeping** payout after resolution (not on-chain redemption) |

---

## Frontend (wallet flow)

- Loads **ethers** (UMD) + contract ABI from **`/markets/abi`**.
- **`tradeLocked` / `quoteLocked`** — disables actions while a request or tx is in flight.
- **Chain switch** — prompts to Base if needed.
- **Buy:** `minOut` from quote’s **`min_out_suggested`** (~1.5% vs expected shares). **USDC `approve`** requests only the **exact trade amount** (not unlimited), so wallets like Rabby show a normal number instead of a huge “max” allowance.
- **Sell:** `minOut` from **`min_out_suggested`** (USDC to user after fees, with cushion).
- After mining: **`POST /markets/trade/confirm`** with real `txHash`.
- **`api()`** — failed HTTP responses surface as `{ error }` so the UI does not silently succeed.

---

## Economics & fees

- **Parimutuel** per market: one **shared USDC pool**; **`bet`** adds net stake after fee; **`resolveMarket`** + **`claim`** pay winners pro-rata (see `ChaosParimutuelMarket.sol`).
- **Fee on gross:** `fee = gross * feeBps / 10000`, `net = gross - fee` — **`net` is what enters the curve** for both buys and sells.
- **Buys:** Protocol takes fee on gross from the user’s USDC; user receives **shares** subject to slippage `minOut`.
- **Sells:** After the curve produces **USDC out**, the contract applies a **second fee on proceeds**; user receives **`usdcToUser`** (also exposed on the **`Trade`** event for indexing).
- **Quotes:** `POST /markets/quote` mirrors this logic; `min_out_suggested` is used as the UI’s **`minOut`** for both sides.

---

## Resolution & claims

- **`betting_closes_at`:** After this time (server DB clock), new trades are rejected by the API quote path; on-chain, the contract uses its **`closeTime`** — keep them aligned.
- **Winner:** The agent with the **most credits** in the economy at resolution — from the latest **`tick_snapshots`** row, fallback **`agents.credits`**. That’s the outcome your bet resolves against.
- **Background:** `server.js` runs **`resolveMarketsByDeadline()`** every ~5s for open markets past `betting_closes_at`.
- **`POST /positions/.../claim`:** Clears winning **position shares** in DB and returns a **notional `payoutUsdc`** — **bookkeeping / demo**; **not** automatic on-chain redemption of pool USDC. Wire a contract `claim` / admin process if you need real settlement.

---

## Security & operations

- **Treat as real DeFi** if there is material TVL: **professional audit**, **testnet drills**, **multisig owner**, monitored **`pause()`**, key hygiene.
- **Owner powers:** `registerMarket`, `pause` / `unpause`, `setTreasury`, pull seed USDC via `registerMarket` (user must **approve** first).
- **Do not** enable **`ALLOW_UNVERIFIED_TRADES`** in production.
- Set a strong **`ADMIN_API_KEY`** so only you can start/stop the simulation, create markets via API, or use unverified DB trades. Never commit it; never expose it in frontend bundles (the UI only stores it in **sessionStorage** after you type it for start/stop).
- **Confirm endpoint** is rate-limited; for heavy traffic consider Redis or a gateway limiter.

---

## Troubleshooting

| Issue | What to check |
|-------|----------------|
| `PREDICTION_MARKET_CONTRACT_ADDRESS is not set` | Add address to `.env` from `npm run deploy:contract`, **restart** the API (env is read at startup) |
| UI says “Set PREDICTION_MARKET…” | Same: deploy → `.env` → restart; verify `GET /markets/config` shows `prediction_market_contract` |
| `No Trade event in this receipt` | Wrong contract, wrong chain, or tx not a `trade()` call |
| `chainId mismatch` | `BASE_RPC_URL` points to wrong network vs `BASE_CHAIN_ID` |
| Unique violation on `tx_hash` | Expected on replay — confirm is idempotent |
| `403` / admin on simulation | Set `ADMIN_API_KEY` on the server; use same value in the dashboard prompt or `Authorization` header |
| Hardhat “stack too deep” | `viaIR: true` is already set in `hardhat.config.cjs` |
| `Nothing to compile` from Hardhat | Normal if you didn’t change `.sol` files; artifacts in `contracts/artifacts` are current. Use `npm run compile:contracts:force` to rebuild anyway |
| `npm run compile:contracts --force` warns about npm “protections” | **`--force` went to npm**, not Hardhat. Use **`npm run compile:contracts:force`** (separate script) for `hardhat compile --force` |
| UI can’t load ABI | Run `npm run compile:contracts` (copies `ChaosParimutuelMarket.json` to `public/abi/`) |

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Dev server with `--watch` |
| `npm start` | Production `node server.js` |
| `npm run setup-db` | Apply `schema.sql` |
| `npm run migrate` | Market time columns |
| `npm run migrate:tx` | Unique `tx_hash` index |
| `npm run seed` | Seed agents + default market |
| `npm run compile:contracts` | `hardhat compile` (prints **Nothing to compile** when artifacts are already up to date — that’s OK) |
| `npm run compile:contracts:force` | Full recompile: `hardhat compile --force` |

---

## License

MIT

---

## Disclaimer

This software is provided **as-is**. Prediction markets and smart contracts involve **financial and legal risk**. Nothing here is investment, legal, or tax advice. For production, obtain a **professional smart contract audit** and comply with applicable regulations.
