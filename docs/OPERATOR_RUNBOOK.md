# Operator runbook — full timeline (before, during, after the economy runs)

Use this as a **checklist** for **you** (operator + contract owner). Times below assume you configured **IST** auto start/stop like in [SANDBOX_SCHEDULE_AND_PAYOUTS.md](./SANDBOX_SCHEDULE_AND_PAYOUTS.md).

---

## Phase 0 — Before launch (one-time)

| When | Step | Who |
|------|------|-----|
| Any time | Deploy Postgres, run `npm run setup-db`, migrations, `seed` or `db:reset` if you want a clean slate. | You |
| Any time | Deploy `ChaosParimutuelMarket` to Base; set `PREDICTION_MARKET_CONTRACT_ADDRESS` on the server. | Owner |
| Any time | `npm run register:market -- <marketId>` so on-chain `marketId`, `closeTime`, `feeBps`, `outcomeCount` match the DB. | Owner |
| Before betting opens | Align **`betting_closes_at`** (DB) with **`MARKET_CLOSES_AT`** / seed and with on-chain **`closeTime`**. | You |
| Before sim window | Set **`SIMULATION_AUTO_START_AT`** / **`SIMULATION_AUTO_STOP_AT`** (IST) on Render / `.env`. | You |
| Before sim window | Ensure **`GROQ_API_KEY`** and **`DATABASE_URL`** are set; server stays **awake** during the window (paid host or ping). | You |

---

## Phase 1 — Economy **starts** (sandbox ticks)

| When | Step | Who |
|------|------|-----|
| At **`SIMULATION_AUTO_START_AT`** (e.g. 1:00 IST day 1) | Server auto-calls **`startSimulation`** (Groq ticks begin). **Or** you manually `POST /simulation/start` with admin key if you are not using auto schedule. | Server / you |
| During the window | Agents trade in the DB; **`tick_snapshots`** records richest agent each tick. **No USDC moves** here — only sandbox credits. | Automatic |
| Optional | Watch logs / dashboard for starvation, Groq 429s; tune `TICK_INTERVAL_MS`, `GROQ_MIN_DELAY_MS` if needed. | You |

---

## Phase 2 — While betting is **open** (USDC on Base)

| When | Step | Who |
|------|------|-----|
| From market open until **`closeTime`** | Users **bet** (`bet`) and may **exit** (`exitStake`) before close. | Bettors |
| Any time | You monitor **BaseScan** + your DB (`market_trades`) for volume. | You |

---

## Phase 3 — Betting **closes** (on-chain `closeTime`)

| When | Step | Who |
|------|------|-----|
| After **`closeTime`** | No new **`bet`** or **`exitStake`** on-chain for that market. | Automatic (contract) |
| At **`SIMULATION_AUTO_STOP_AT`** (e.g. 1:00 IST next day) | Server auto-**stops** the tick loop (`stopSimulation`). | Server |
| Same wall time or later | Confirm **richest agent** in DB (`tick_snapshots` / `agents`) matches the outcome index you will resolve (**0,1,2…** = `market_outcomes` order). | You |

---

## Phase 4 — **Resolve** the market (owner, on-chain)

| When | Step | Who |
|------|------|-----|
| After winner is final and you verified outcome index | **`resolveMarket(marketId, winningOutcomeIndex)`** — CLI: `npm run resolve:market -- <marketId> <index>` or BaseScan **Write**. | **Owner only** |
| After tx confirms | DB may still say `OPEN` until `resolveMarketsByDeadline` runs — on-chain state is what matters for **claim**. | Automatic / you |

---

## Phase 5 — **Winners claim** USDC

| When | Step | Who |
|------|------|-----|
| After **`resolveMarket`** is mined | Each winner calls **`claim(marketId)`** (dashboard **Claim winnings** or BaseScan). | Each winner |
| After each claim tx | `POST /markets/trade/confirm` indexes the tx (your UI does this). | App |

---

## Phase 6 — If something goes wrong (stuck funds — **fallback**)

**Normal path:** winners should always try **`claim`** first (same wallet, Base, enough ETH for gas).

**If USDC is still stuck** after you’ve verified off-chain (tx failed, UI bug, edge case):

1. **Verify** the user’s address and the **exact USDC amount** owed (BaseScan + `stakeOf` / `claim` simulation).
2. **Announce** the planned action (Discord/Telegram) so the community sees it.
3. **Owner** calls **`pause()`** on the contract (BaseScan → Write → `pause`).  
   - New **`bet`** / **`exitStake`** are blocked.  
   - **`claim`** is **not** behind `whenNotPaused` in the current contract — users can still try **`claim`** while paused.
4. If **`claim`** still cannot be used**, owner calls **`rescueUSDC(recipient, amount)`** (only works **while paused**).  
   - Script: `npm run rescue:usdc -- <userWallet> <amountUsdc>`  
   - **Requires redeploy** of the contract that includes `rescueUSDC` (see repo `ChaosParimutuelMarket.sol`).
5. **`unpause()`** when you are done with maintenance.

**Risks**

- **`rescueUSDC`** can move **any** USDC balance from the contract — use a **multisig** owner, **never** reuse keys casually, and **document** each rescue (tx hash + reason).
- This does **not** fix wrong **`resolveMarket`** (winner locked forever on-chain). Wrong resolution requires **operational** handling off-chain, not a magic contract button.

**When *not* to use rescue**

- User simply needs **more ETH on Base** for gas → help them fund gas, then **`claim`**.
- User used **wrong wallet** → you cannot pull USDC to a different address **through `claim`**; rescue to the **correct** wallet only after **legal/ops** agreement (rescue is a **manual** transfer).

---

## Quick reference — who does what

| Action | Owner | Bettors | Server |
|--------|-------|---------|--------|
| Start/stop **simulation** ticks | — | — | Auto or admin API |
| **bet** / **exitStake** | — | ✓ | — |
| **registerMarket** / **resolveMarket** | ✓ | — | — |
| **claim** | — | ✓ (winners) | Indexes tx |
| **pause** / **rescueUSDC** / **unpause** | ✓ | — | — |

---

## Related docs

- [SANDBOX_SCHEDULE_AND_PAYOUTS.md](./SANDBOX_SCHEDULE_AND_PAYOUTS.md) — IST schedule, payouts, resolve steps  
- [README.md](../README.md) — env vars, API, deploy  

---

*This is operational guidance, not legal advice. For production, use audits, multisig, and clear terms with users.*
