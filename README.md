# Agents-of-Chaos
Dropped AI agents into an economy. They can earn, trade, scam, or starve.

Sandbox economy values are simulated only (play-money).
Human prediction markets are USDC-denominated on Base.

## Betting deadline (wall clock)

- Each market can have `betting_closes_at` (UTC stored in Postgres). After that time, **new trades are rejected**; resolution picks the **richest agent by sandbox credits** using the latest `tick_snapshots` row (fallback: highest `agents.credits`).
- **Seed** defaults to **tomorrow 13:00 local** for the close, unless you set `MARKET_CLOSES_AT` (ISO 8601, e.g. `2026-03-22T13:00:00-05:00`).
- Existing databases: run `npm run migrate` once to add `betting_opens_at` / `betting_closes_at` if you created the schema before these columns existed.

## Transparency API

- `GET /markets/transparency` — chain ID, USDC contract, fee bps, treasury address, plain-language rules.

## Env (partial)

| Variable | Purpose |
|----------|---------|
| `MARKET_CLOSES_AT` | Optional ISO time for seeded market close |
| `PROTOCOL_TREASURY_ADDRESS` | Where protocol fees accrue (shown in UI) |
| `PROTOCOL_FEE_BPS` | Fee in basis points (e.g. 200 = 2%) |
| `PREDICTION_MARKET_CONTRACT_ADDRESS` | Deployed `ChaosPredictionMarket` on Base (required for real trades) |
| `ALLOW_UNVERIFIED_TRADES` | Set `true` only for dev — allows legacy `/markets/trade` DB writes (default off) |

## On-chain trading (production)

1. Compile: `npm run compile:contracts`
2. Deploy `contracts/contracts/ChaosPredictionMarket.sol` to Base with constructor `(USDC, TREASURY)` (use a hardware wallet / multisig for owner).
3. Approve USDC to the contract and call `registerMarket(marketId, closeTimeUnix, feeBps, outcomeCount)` so **ids match Postgres** (`prediction_markets.id` and number of `market_outcomes` rows in stable `ORDER BY id`).
4. Set `PREDICTION_MARKET_CONTRACT_ADDRESS` in `.env` and restart the API.
5. Run DB migrations: `npm run migrate` and `npm run migrate:tx` (unique `tx_hash`).
6. Users trade via wallet on the contract; the UI calls `POST /markets/trade/confirm` with the mined tx hash to **index** reserves/positions (idempotent).

**Security note:** this is a substantial DeFi surface area — get an independent audit before significant TVL.
