# Sandbox auto schedule (IST) & how winners get paid

## 1. Auto-start / auto-stop the **economy simulation** (Groq ticks)

The server can start and stop the **sandbox simulation** on a wall-clock schedule using **ISO 8601** datetimes. **IST = UTC+5:30**, written as `+05:30` in the string.

### Example: 1:00 IST 22 Mar 2026 → 1:00 IST 23 Mar 2026

Set in **`.env`** (or your host’s environment, e.g. Render):

```env
SIMULATION_AUTO_START_AT=2026-03-22T01:00:00+05:30
SIMULATION_AUTO_STOP_AT=2026-03-23T01:00:00+05:30
```

- **Start:** `2026-03-22` at **01:00** India time  
- **Stop:** `2026-03-23` at **01:00** India time  

The process checks about **every 30 seconds**. Between start and stop it ensures the simulation is **running**; at or after stop it **stops** the tick loop.

**Requirements**

- Server must be **up** at those times (free Render tiers **sleep** when idle — use a **paid** instance or an external ping if you need guaranteed uptime).
- **`GROQ_API_KEY`** must be set or ticks will fail.

**Inspect schedule**

`GET /simulation/status` includes a `schedule` object with the parsed times.

---

## 2. Align **betting close** with your event (important)

**Sandbox schedule** (`SIMULATION_*`) only controls the **AI economy** ticks.

**USDC betting** on Base is controlled separately:

- **Database:** `prediction_markets.betting_closes_at`
- **On-chain:** `closeTime` in `registerMarket` (must match what you intend)

For a session where betting should end when the sim window ends, set **`betting_closes_at`** to **23 Mar 2026, 01:00 IST** (or your chosen deadline) and ensure **`registerMarket`** used the same **`closeTime`** (Unix seconds). If you use `npm run seed`, set **`MARKET_CLOSES_AT`** to the same instant in ISO form, e.g.:

```env
MARKET_CLOSES_AT=2026-03-23T01:00:00+05:30
```

Then re-seed or update the row in SQL; re-run **`npm run register:market -- <id>`** if the on-chain market was registered with a different close time.

---

## 3. After the simulation / betting ends — how money moves (parimutuel)

This is **not** the sandbox “credits.” **Real money** is **USDC on Base** in **`ChaosParimutuelMarket`**.

### What the pool is

- Every **bet** sends **gross USDC**; the **fee %** goes to the **treasury**; the **net** amount stays in the **contract** as stakes on each **outcome** (each agent).
- **Losers’ net stakes** stay in the **same pool** and are used to pay **winners** (pro-rata). Nothing extra is “minted.”

### Who wins

- The **richest agent** in the **sandbox** (by in-game credits) at resolution time maps to one **outcome index** (same order as `market_outcomes` / agents).
- Bettors who staked on **that** outcome are **winners** for payout purposes.

### After the market is **resolved on-chain**

1. **Owner** calls **`resolveMarket(marketId, winningOutcomeIndex)`** on Base when the winning agent is final (must match the outcome index for that agent).  
2. The contract **locks** how much USDC is in the pool and how much was staked on the winning outcome.

### How a correct bettor **gets USDC**

Winners do **not** receive USDC automatically to their wallet. Each winner must call:

```text
claim(marketId)
```

on the **same contract**, with the **same wallet** they used to bet. The contract sends **USDC** to that wallet:

\[
\text{payout} = \text{your net stake on winning outcome} \times \frac{\text{total pool at resolve}}{\text{total net stake on winning outcome}}
\]

So if you predicted the **correct agent** and had **net stake** on that outcome, **`claim`** is how you **withdraw your winnings** (principal share of the pool + share of losers’ stakes), per the contract’s formula.

**UI:** ensure users know to use **Claim** after resolution (or your app’s claim flow). **Gas** is paid in **ETH on Base**.

### If betting is still open and they want out early

While **`block.timestamp < closeTime`** and the market is not resolved, they can **`exitStake(marketId, outcomeIndex)`** to pull their **full net stake** back (no second protocol fee). After close / resolve, use **`claim`** (winners) only.

---

## 4. Short checklist for your 22–23 Mar IST window

| Step | Action |
|------|--------|
| 1 | Set `SIMULATION_AUTO_START_AT` / `SIMULATION_AUTO_STOP_AT` as above. |
| 2 | Set `MARKET_CLOSES_AT` / DB `betting_closes_at` + on-chain `closeTime` to match your betting end. |
| 3 | Keep server **awake** during the window. |
| 4 | After betting ends & winner known: **`resolveMarket`** then tell users to **`claim`**. |

---

## 5. Disclaimer

Smart contracts and markets involve risk. This document is operational guidance, not legal or financial advice.
