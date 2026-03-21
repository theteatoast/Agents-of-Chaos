# Agents of Chaos

**AI agents dropped into an economy** — they earn, trade, scam, or starve. **You can bet on who ends up richest.**

The simulation runs in the database: credits, food, energy, and tick-by-tick chaos (powered by Groq). **Bets** are in **USDC on Base**: a **parimutuel** pool (`ChaosParimutuelMarket.sol`) — bettors’ money **is** the liquidity; protocol fee on each bet goes to treasury. When betting closes, the **richest agent** in the economy wins — you predicted which agent that would be.

The API **indexes** on-chain trades into Postgres; it does not custody user funds. Off-chain `POST /markets/trade` (DB-only, unverified) is **disabled by default** — production flow is **wallet → contract → `POST /markets/trade/confirm`**.

**Money at risk:** Parimutuel betting uses **real USDC on Base**. If you bet on the **wrong** agent, you can **lose the full net amount** you staked on that outcome. If you bet on the **right** agent, your profit depends on pool size and how many others picked the same winner — see [How payouts work](#how-payouts-work-profit-loss-risk) and [After betting closes](#after-betting-closes-resolution-and-payouts).

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
9. [How payouts work (profit, loss, risk)](#how-payouts-work-profit-loss-risk)
10. [Economics & fees (parimutuel)](#economics--fees-parimutuel)
11. [After betting closes: resolution and payouts](#after-betting-closes-resolution-and-payouts)
12. [Security & operations](#security--operations)
13. [Troubleshooting](#troubleshooting)
14. [Scripts](#scripts)

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

**Survival vs competition:** Agents lose **food** over time unless they **buy** or manage credits. Defaults are tuned so short runs aren’t mass-starvation by tick 7: food drains **every 2 ticks** (configurable), seed food is **14–35**, and Groq prompts nudge **BUY_FOOD** when food is low. Tune **`FOOD_CONSUME_EVERY_N_TICKS`**, **`TICK_INTERVAL_MS`**, and Groq delays if you still see 429s.

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
| `TICK_INTERVAL_MS` | No | Wall-clock ms between economy ticks (default **`30000`**). Should be **≥ (number of agents × `GROQ_MIN_DELAY_MS`)** so one tick finishes before the next starts (avoids overlapping Groq bursts). |
| `GROQ_MIN_DELAY_MS` | No | Pause between **sequential** Groq calls (default **`2100`** ≈ ≤28 RPM). Set **`0`** only if your Groq tier allows higher throughput. |
| `GROQ_MAX_CONCURRENT` | No | Parallel Groq calls per tick (default **`1`**). Increase only with a higher rate limit; parallel calls can spike RPM. |
| `GROQ_MAX_RETRIES` | No | Retries on **429** / rate limit (default **`3`**, exponential backoff). |
| `FOOD_CONSUME_EVERY_N_TICKS` | No | Consume **1 food** every **N** ticks (default **`2`**). Use **`1`** to restore the old “harsh” every-tick hunger. |
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
| `npm run db:reset` | Same wipe + seed as `seed` (alias). Clears **wallet links**, trades, events, snapshots — full sandbox + market reset |

**Start the simulation from scratch (clean DB + tick 0):**

1. Stop the sim if it’s running (`POST /simulation/stop` or UI).
2. Run **`npm run db:reset`** (or **`npm run seed`**) with `DATABASE_URL` set.
3. **Restart** `npm run dev` **or** call **`POST /simulation/reset`** (admin key) so the server’s in-memory tick counter matches the DB (otherwise a long-running process could still use an old tick number).

To **revert uncommitted code** (separate from DB): `git checkout -- .` or `git restore .` — only if you use Git and want to discard local edits.

**Neon:** Create a project, paste `DATABASE_URL`, run `setup-db` then migrations. Use `seed` or `db:reset` once for a demo dataset.

---

## API reference

### Agent economy (dashboard)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/simulation/start` | Start the tick loop (**admin key required**) — alias: `/sandbox/simulation/start` |
| `POST` | `/simulation/stop` | Stop the tick loop (**admin key required**) |
| `POST` | `/simulation/reset` | Stop ticks and set in-memory tick from **`market_state`** (**admin key**) — use after `db:reset` without restarting the server — alias: `/sandbox/simulation/reset` |
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
| `POST` | `/positions/:walletAddress/claim` | **Not implemented for USDC:** returns an error directing you to call **`ChaosParimutuelMarket.claim(marketId)`** on Base after the owner resolves — this API never sends USDC |

---

## Frontend (wallet flow)

- Loads **ethers** (UMD) + contract ABI from **`/markets/abi`**.
- **Wallet connect (EIP-6963):** If multiple extensions are installed (e.g. MetaMask + Rabby), the UI lists them so you pick which provider to use. **Disconnect** clears the selected provider and session UI; use **Switch** to choose another wallet.
- **`tradeLocked` / `quoteLocked`** — disables actions while a request or tx is in flight.
- **Chain switch** — prompts to **Base** if needed (`BASE_CHAIN_ID` / config).
- **Parimutuel bet flow:** Pick market → agent outcome → USDC amount → quote via **`POST /markets/quote`** (or UI preview) → optional **`POST /markets/:id/simulate-bet`** for gas estimate → **USDC `approve`** (exact amount, not unlimited) → **`bet(marketId, outcomeIndex, grossUsdc)`** on the contract → **`POST /markets/trade/confirm`** with `{ txHash }` so the server indexes **`BetPlaced`**.
- **`api()`** — failed HTTP responses surface as `{ error }` so the UI does not silently succeed.

---

## How payouts work (profit, loss, risk)

This is a **parimutuel** market, not an order book or CPMM: **all losing stakes fund the winners** (after the protocol fee is taken).

| Situation | What happens to your USDC |
|-----------|---------------------------|
| **You bet on the winning agent** | After on-chain **`resolveMarket`**, you call **`claim(marketId)`**. Your payout is **pro-rata** from the **entire net pool** \(P\) based on your **net stake** \(s\) on the winning outcome vs total net stake on that outcome \(W\): **`payout = s × P ÷ W`** (see contract; snapshots are fixed at resolve). You can **multiply your money** vs your stake if few others picked the winner and the pool is large — or earn **less than you put in** if many people shared the winning side. |
| **You bet on a losing agent** | You **do not** get a refund. Your **net stake** stays in the pool and is **distributed to winners** (it is not “burned” to nowhere — it pays the other side). From your perspective you can **lose 100%** of the net amount you staked on that outcome. |
| **Protocol fee** | Taken from **each bet’s gross** USDC and sent to **`treasury`** on-chain. That fee **never** enters the winner’s pool — factor it in when sizing bets. |
| **Operational risk** | If the contract owner never calls **`resolveMarket`**, or resolves the **wrong outcome index**, on-chain settlement won’t match what you expect. **Runners** should align **DB winner** (richest agent) with the **outcome index** passed to **`resolveMarket`**. |
| **Edge case** | On-chain **`resolveMarket` reverts** if **no net stake** sits on the winning outcome \(`W = 0`\). Don’t resolve to an outcome nobody bet on. |

**Agents’ in-game “credits” are not USDC.** Only your **Base USDC** in the betting contract is at stake.

---

## Economics & fees (parimutuel)

- **Single pool per market:** Every bet moves **`grossUsdc`** from the user; **`fee = gross × feeBps / 10_000`** to **`treasury`**; **`net = gross − fee`** increases **`totalStakeOnOutcome`** and **`totalPool`**.
- **No AMM curve, no `minOut` slippage** on the contract — the quote API may still expose `min_out_suggested: 0` / `min_out_kind: 'none'` for compatibility.
- **Implied “odds”** in the UI are **informational** (share of the pool if that outcome wins); they change as others bet.

---

## After betting closes: resolution and payouts

1. **Betting window ends** — After **`closeTime`** (on-chain) and **`betting_closes_at`** (API), **new `bet()` calls revert** (`TradingClosed`). Keep DB and contract times aligned when registering markets.
2. **Who wins?** The **richest agent** in the **simulated economy** (by sandbox credits) determines the **winning outcome**: the outcome row tied to that **`agent_id`** (index = position in **`ORDER BY market_outcomes.id`**).
3. **Database resolution (automatic)** — `server.js` calls **`resolveMarketsByDeadline()`** about every **5 seconds**. For markets past **`betting_closes_at`**, it sets **`prediction_markets.status = RESOLVED`** and **`winning_agent_id`** from the latest **`tick_snapshots.richest_agent_id`** (fallback: top **`agents.credits`**). This is **off-chain bookkeeping** for the app UI — **it does not move USDC**.
4. **On-chain resolution (owner, manual)** — Someone with the **owner key** must still call **`resolveMarket(marketId, winningOutcomeIndex)`** on **`ChaosParimutuelMarket`**. Use **`npm run resolve:market -- <marketId> <index>`** or your own script. This **locks** **`resolvedPoolSnapshot`** and **`resolvedWinningStakeSnapshot`** used for payouts.
5. **Claiming USDC (bettors)** — Each winner calls **`claim(marketId)`** from their wallet. USDC is **transferred from the contract**; the server does **not** custody funds.
6. **Where the money goes** — **Losers’ net stakes** are effectively **paid to winners** through the shared pool formula; **fees** already went to **treasury** on each bet.

**Important:** The simulated economy **keeps ticking** after betting closes. The **DB auto-resolution** snapshots “richest at deadline”; your operational process should still ensure the **on-chain `winningOutcomeIndex`** matches the outcome you advertise (re-run **`resolve:market`** if you coordinate resolution after a specific tick).

---

## Security & operations

- **Treat as real DeFi** if there is material TVL: **professional audit**, **testnet drills**, **multisig owner**, monitored **`pause()`**, key hygiene.
- **Owner powers:** `registerMarket` (metadata only — **no** USDC from owner), `resolveMarket`, `pause` / `unpause`, `setTreasury`.
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
| `resolveMarket` reverts `NoWinningStake` | On-chain total net stake on the winning outcome is **zero** — pick an outcome index that has bets, or don’t resolve until someone stakes on the winner |
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
| `npm run deploy:contract` | Deploy `ChaosParimutuelMarket` to Base (needs `DEPLOYER_PRIVATE_KEY` + ETH for gas) |
| `npm run register:market -- <marketId>` | Owner: `registerMarket` from DB row (gas only) |
| `npm run resolve:market -- <marketId> <winningOutcomeIndex>` | Owner: `resolveMarket` on-chain |

---

## License

MIT

---

## Disclaimer

This software is provided **as-is**. Prediction markets and smart contracts involve **financial and legal risk**. Nothing here is investment, legal, or tax advice. For production, obtain a **professional smart contract audit** and comply with applicable regulations.
