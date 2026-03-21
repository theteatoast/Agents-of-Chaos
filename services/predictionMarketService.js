import { ethers } from 'ethers';
import pool from '../db/index.js';
import config from '../config/index.js';
import { fetchBetEventFromTx, readMarketStakeTotals } from './chainSync.js';

const SIDES = new Set(['BUY_YES', 'BUY_NO', 'SELL_YES', 'SELL_NO', 'BET']);

export async function getDbNow() {
    const { rows } = await pool.query(`SELECT NOW() AS now`);
    return rows[0].now;
}

export function isTradingOpen(market, nowDate) {
    if (!market || market.status !== 'OPEN') return false;
    if (!market.betting_closes_at) return true;
    const close = new Date(market.betting_closes_at);
    const now = new Date(nowDate);
    return now < close;
}

export async function listMarkets() {
    const { rows } = await pool.query(
        `SELECT pm.*, COUNT(mo.id)::int AS outcomes
         FROM prediction_markets pm
         LEFT JOIN market_outcomes mo ON mo.market_id = pm.id
         GROUP BY pm.id
         ORDER BY pm.created_at DESC`
    );
    const now = await getDbNow();
    return rows.map((m) => ({
        ...m,
        trading_open: isTradingOpen(m, now),
        server_now: now,
    }));
}

export async function getMarketById(marketId) {
    const { rows } = await pool.query('SELECT * FROM prediction_markets WHERE id = $1', [marketId]);
    return rows[0];
}

export async function getMarketOutcomes(marketId) {
    const { rows } = await pool.query(
        `SELECT mo.*, a.name AS agent_name
         FROM market_outcomes mo
         JOIN agents a ON a.id = mo.agent_id
         WHERE mo.market_id = $1
         ORDER BY mo.id`,
        [marketId]
    );
    let chainTotals = null;
    try {
        if (config.predictionMarketContractAddress) {
            chainTotals = await readMarketStakeTotals(marketId);
        }
    } catch {
        chainTotals = null;
    }
    const poolSum = chainTotals ? chainTotals.reduce((a, b) => a + b, 0) : 0;
    return rows.map((o, idx) => {
        const stakeOnOutcome = (chainTotals?.[idx] ?? Number(o.reserve_yes)) || 0;
        const implied = poolSum > 0 ? stakeOnOutcome / poolSum : rows.length > 0 ? 1 / rows.length : 0;
        return {
            ...o,
            outcome_index: idx,
            pool_stake_usdc: +stakeOnOutcome.toFixed(6),
            implied_pool_share: +implied.toFixed(6),
            implied_yes: +implied.toFixed(6),
            implied_no: +(1 - implied).toFixed(6),
        };
    });
}

export async function getOutcomeIdByIndex(marketId, outcomeIndex) {
    const { rows } = await pool.query(
        `SELECT id FROM (
           SELECT id, ROW_NUMBER() OVER (ORDER BY id) - 1 AS idx
           FROM market_outcomes
           WHERE market_id = $1
         ) x WHERE idx = $2`,
        [marketId, outcomeIndex]
    );
    if (!rows[0]) throw new Error('Outcome index not found for this market');
    return rows[0].id;
}

export async function createMarket({
    slug,
    title,
    settlementTick,
    feeBps = config.protocolFeeBps,
    bettingOpensAt,
    bettingClosesAt,
}) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const insertMarket = await client.query(
            `INSERT INTO prediction_markets (slug, title, settlement_tick, fee_bps, betting_opens_at, betting_closes_at)
             VALUES ($1, $2, $3, $4, COALESCE($5, NOW()), $6)
             RETURNING *`,
            [slug, title, settlementTick, feeBps, bettingOpensAt || null, bettingClosesAt || null]
        );
        const market = insertMarket.rows[0];
        await client.query(
            `INSERT INTO market_outcomes (market_id, agent_id)
             SELECT $1, id FROM agents ORDER BY id`,
            [market.id]
        );
        await client.query('COMMIT');
        return market;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

/** Parimutuel quote: fee on gross → treasury; net increases the shared pool. */
export async function quoteBet({ marketId, outcomeId, usdcAmount }) {
    const gross = Number(usdcAmount);
    if (!Number.isFinite(gross) || gross <= 0) throw new Error('usdcAmount must be positive');

    const market = await getMarketById(marketId);
    if (!market) throw new Error('Market not found');
    if (market.status !== 'OPEN') throw new Error('Market is not open');
    const now = await getDbNow();
    if (!isTradingOpen(market, now)) {
        throw new Error('Trading is closed for this market (deadline passed).');
    }

    const { rows } = await pool.query(
        `SELECT id, ROW_NUMBER() OVER (ORDER BY id) - 1 AS outcome_index
         FROM market_outcomes WHERE market_id = $1 ORDER BY id`,
        [marketId]
    );
    const row = rows.find((r) => r.id === outcomeId);
    if (!row) throw new Error('Outcome not found');
    const outcomeIndex = Number(row.outcome_index);

    const feeBps = market.fee_bps;
    const feeRate = feeBps / 10000;
    const feeOnGrossUsdc = gross * feeRate;
    const netAmount = gross - feeOnGrossUsdc;

    let totals = [];
    try {
        totals = await readMarketStakeTotals(marketId);
    } catch {
        totals = [];
    }
    while (totals.length < rows.length) totals.push(0);
    const poolBefore = totals.reduce((a, b) => a + b, 0);
    const stakeBefore = totals[outcomeIndex] ?? 0;
    const poolAfter = poolBefore + netAmount;
    const stakeAfter = stakeBefore + netAmount;
    const shareOfPoolIfWins = poolAfter > 0 ? stakeAfter / poolAfter : 0;

    return {
        marketId,
        outcomeId,
        outcome_index: outcomeIndex,
        side: 'BET',
        grossUsdc: gross,
        feeUsdc: feeOnGrossUsdc,
        fee_on_gross_usdc: feeOnGrossUsdc,
        fee_bps: feeBps,
        net_to_pool_usdc: netAmount,
        netUsdc: netAmount,
        pool_total_before_usdc: poolBefore,
        pool_total_after_usdc: poolAfter,
        stake_on_outcome_before_usdc: stakeBefore,
        stake_on_outcome_after_usdc: stakeAfter,
        implied_share_of_pool_if_this_outcome_wins: +shareOfPoolIfWins.toFixed(8),
        sharesDelta: netAmount,
        avgPrice: netAmount > 0 ? 1 : 0,
        min_out_kind: 'none',
        min_out_suggested: 0,
        parimutuel: true,
        protocol_fee_destination: config.protocolTreasuryAddress || 'configure PROTOCOL_TREASURY_ADDRESS',
        disclosure: {
            summary:
                'Parimutuel: fee on gross USDC goes to treasury; net is added to the on-chain pool. If this outcome wins, winners split the full pool pro-rata by net stake on the winning outcome (see contract).',
        },
    };
}

/** Back-compat: `side` ignored for parimutuel (bet on selected outcome). */
export async function quoteTrade({ marketId, outcomeId, side, usdcAmount }) {
    if (side && !SIDES.has(side)) throw new Error('Invalid side');
    return quoteBet({ marketId, outcomeId, usdcAmount });
}

export async function executeTrade({ walletAddress, marketId, outcomeId, side, usdcAmount, txHash }) {
    if (!config.allowUnverifiedTrades) {
        throw new Error(
            'Unverified DB trades are disabled. Bet on-chain, then POST /markets/trade/confirm with the tx hash.'
        );
    }
    const quote = await quoteBet({ marketId, outcomeId, usdcAmount });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        let totals = [];
        try {
            totals = await readMarketStakeTotals(marketId);
        } catch {
            totals = [];
        }
        const { rows: oc } = await client.query(
            `SELECT id FROM market_outcomes WHERE market_id = $1 ORDER BY id`,
            [marketId]
        );
        while (totals.length < oc.length) totals.push(0);
        const idx = Number(quote.outcome_index);
        totals[idx] = quote.stake_on_outcome_after_usdc;
        for (let i = 0; i < oc.length; i++) {
            await client.query(`UPDATE market_outcomes SET reserve_yes = $1, reserve_no = 0 WHERE id = $2`, [
                totals[i] ?? 0,
                oc[i].id,
            ]);
        }

        await client.query(
            `INSERT INTO market_positions (wallet_address, market_id, outcome_id, shares, total_cost_usdc, updated_at)
             VALUES ($1, $2, $3, $4, $5, NOW())
             ON CONFLICT (wallet_address, market_id, outcome_id)
             DO UPDATE SET
               shares = market_positions.shares + EXCLUDED.shares,
               total_cost_usdc = market_positions.total_cost_usdc + EXCLUDED.total_cost_usdc,
               updated_at = NOW()`,
            [walletAddress.toLowerCase(), marketId, outcomeId, quote.netUsdc, quote.grossUsdc]
        );

        const tradeInsert = await client.query(
            `INSERT INTO market_trades
            (wallet_address, market_id, outcome_id, side, usdc_amount, shares_delta, avg_price, fee_usdc, tx_hash, block_timestamp)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
            RETURNING *`,
            [
                walletAddress.toLowerCase(),
                marketId,
                outcomeId,
                'BET',
                quote.grossUsdc,
                quote.netUsdc,
                quote.avgPrice,
                quote.feeUsdc,
                txHash || null,
            ]
        );

        await client.query(
            `INSERT INTO protocol_fees (market_id, trade_id, fee_usdc)
             VALUES ($1, $2, $3)`,
            [marketId, tradeInsert.rows[0].id, quote.feeUsdc]
        );
        await client.query('COMMIT');
        return tradeInsert.rows[0];
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

/** Index a mined Base tx that emitted `BetPlaced` on ChaosParimutuelMarket. */
export async function syncTradeFromTxHash(txHash) {
    const normalizedHash = txHash?.toLowerCase();
    if (!normalizedHash || !normalizedHash.startsWith('0x')) throw new Error('Invalid tx hash');

    const dup = await pool.query('SELECT id FROM market_trades WHERE tx_hash = $1', [normalizedHash]);
    if (dup.rows.length) {
        return { duplicate: true, tradeId: dup.rows[0].id };
    }

    const ev = await fetchBetEventFromTx(normalizedHash);
    const wallet = String(ev.user).toLowerCase();
    const outcomeId = await getOutcomeIdByIndex(ev.marketId, ev.outcomeIndex);

    const grossUsdc = Number(ethers.formatUnits(ev.grossUsdc, 6));
    const feeUsdc = Number(ethers.formatUnits(ev.feeUsdc, 6));
    const netUsdc = Number(ethers.formatUnits(ev.netUsdc, 6));
    const avgPrice = netUsdc > 0 ? 1 : 0;

    const totals = await readMarketStakeTotals(ev.marketId);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows: oc } = await client.query(
            `SELECT id FROM market_outcomes WHERE market_id = $1 ORDER BY id`,
            [ev.marketId]
        );
        for (let i = 0; i < oc.length; i++) {
            await client.query(`UPDATE market_outcomes SET reserve_yes = $1, reserve_no = 0 WHERE id = $2`, [
                totals[i] ?? 0,
                oc[i].id,
            ]);
        }

        await client.query(
            `INSERT INTO market_positions (wallet_address, market_id, outcome_id, shares, total_cost_usdc, updated_at)
             VALUES ($1,$2,$3,$4,$5,NOW())
             ON CONFLICT (wallet_address, market_id, outcome_id)
             DO UPDATE SET
               shares = market_positions.shares + $4,
               total_cost_usdc = market_positions.total_cost_usdc + $6,
               updated_at = NOW()`,
            [wallet, ev.marketId, outcomeId, netUsdc, grossUsdc, grossUsdc]
        );

        const tradeInsert = await client.query(
            `INSERT INTO market_trades
            (wallet_address, market_id, outcome_id, side, usdc_amount, shares_delta, avg_price, fee_usdc, tx_hash, block_timestamp)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
            RETURNING *`,
            [wallet, ev.marketId, outcomeId, 'BET', grossUsdc, netUsdc, avgPrice, feeUsdc, normalizedHash]
        );

        await client.query(`INSERT INTO protocol_fees (market_id, trade_id, fee_usdc) VALUES ($1, $2, $3)`, [
            ev.marketId,
            tradeInsert.rows[0].id,
            feeUsdc,
        ]);

        await client.query('COMMIT');
        return { duplicate: false, trade: tradeInsert.rows[0] };
    } catch (error) {
        await client.query('ROLLBACK');
        if (error && error.code === '23505') {
            return { duplicate: true, tradeId: null };
        }
        throw error;
    } finally {
        client.release();
    }
}

export async function getPositions(walletAddress) {
    const { rows } = await pool.query(
        `SELECT p.*, pm.title, pm.status, pm.winning_agent_id, mo.agent_id, a.name AS agent_name,
                mo.reserve_yes, mo.reserve_no, pm.betting_closes_at
         FROM market_positions p
         JOIN prediction_markets pm ON pm.id = p.market_id
         JOIN market_outcomes mo ON mo.id = p.outcome_id
         JOIN agents a ON a.id = mo.agent_id
         WHERE p.wallet_address = $1
         ORDER BY p.updated_at DESC`,
        [walletAddress.toLowerCase()]
    );
    return rows.map((row) => {
        const netStake = Number(row.shares);
        const cost = Number(row.total_cost_usdc);
        const poolOnOutcome = Number(row.reserve_yes) || 0;
        const impliedShare = poolOnOutcome > 0 ? netStake / poolOnOutcome : 0;
        return {
            ...row,
            net_stake_usdc: +netStake.toFixed(6),
            cost_basis_gross_usdc: +cost.toFixed(6),
            implied_share_of_outcome_pool: +impliedShare.toFixed(6),
            note: 'Parimutuel: claim winnings on-chain via contract.claim(marketId) after resolution.',
        };
    });
}

/** Resolve markets whose betting_closes_at has passed (wall clock). Winner = richest sandbox credits at last recorded tick. */
export async function resolveMarketsByDeadline() {
    const now = await getDbNow();
    const { rows: due } = await pool.query(
        `SELECT id FROM prediction_markets
         WHERE status = 'OPEN'
           AND betting_closes_at IS NOT NULL
           AND betting_closes_at <= $1`,
        [now]
    );
    const resolvedIds = [];
    for (const m of due) {
        const { rows: snap } = await pool.query(
            `SELECT richest_agent_id FROM tick_snapshots ORDER BY tick DESC LIMIT 1`
        );
        let winnerId = snap[0]?.richest_agent_id;
        if (!winnerId) {
            const { rows: top } = await pool.query(
                `SELECT id FROM agents ORDER BY credits DESC NULLS LAST LIMIT 1`
            );
            winnerId = top[0]?.id;
        }
        if (!winnerId) continue;
        await pool.query(
            `UPDATE prediction_markets
             SET status = 'RESOLVED', winning_agent_id = $1, resolved_at = NOW()
             WHERE id = $2 AND status = 'OPEN'`,
            [winnerId, m.id]
        );
        resolvedIds.push(m.id);
    }
    return resolvedIds;
}

/** Legacy: tick-based settlement only when no wall-clock deadline is set. */
export async function resolveMaturedMarkets(currentTick) {
    const pending = await pool.query(
        `SELECT id, settlement_tick
         FROM prediction_markets
         WHERE status IN ('OPEN', 'CLOSED')
           AND settlement_tick <= $1
           AND betting_closes_at IS NULL
         ORDER BY settlement_tick ASC`,
        [currentTick]
    );

    if (!pending.rows.length) return [];

    const { rows: snapRows } = await pool.query(
        `SELECT tick, richest_agent_id
         FROM tick_snapshots
         WHERE tick = $1`,
        [currentTick]
    );
    const snapshot = snapRows[0];
    if (!snapshot?.richest_agent_id) return [];

    const resolvedIds = [];
    for (const market of pending.rows) {
        await pool.query(
            `UPDATE prediction_markets
             SET status = 'RESOLVED', winning_agent_id = $1, resolved_at = NOW()
             WHERE id = $2`,
            [snapshot.richest_agent_id, market.id]
        );
        resolvedIds.push(market.id);
    }
    return resolvedIds;
}

export function getTransparencyPayload() {
    const feeBps = config.protocolFeeBps;
    return {
        chain: 'base',
        chain_id: config.baseChainId,
        usdc_contract: config.usdcContractAddress,
        protocol_fee_bps: feeBps,
        protocol_fee_percent: feeBps / 100,
        protocol_treasury: config.protocolTreasuryAddress || null,
        model: 'parimutuel',
        rules: [
            'Agents live in a simulated economy (credits, food, energy); you bet USDC on which agent ends richest.',
            'Parimutuel: all bettors’ USDC (after protocol fee) forms the pool — no house seed liquidity.',
            'Protocol fee is taken from each bet’s gross USDC and sent to the configured treasury on-chain.',
            'After the betting deadline, the richest agent in the sandbox wins; the contract owner resolves the matching outcome index on-chain.',
            'Winners claim USDC from the contract via claim(marketId); payout is pro-rata by net stake on the winning outcome.',
            'This API only indexes confirmed on-chain bets — verify balances on BaseScan.',
            'Creating markets and simulation control may require admin credentials.',
        ],
        explorer_base: 'https://basescan.org',
    };
}

export async function getProtocolFeesDaily() {
    const { rows } = await pool.query(
        `SELECT DATE(created_at) AS day, COALESCE(SUM(fee_usdc), 0) AS fee_usdc
         FROM protocol_fees
         GROUP BY DATE(created_at)
         ORDER BY day DESC
         LIMIT 30`
    );
    return rows;
}

export async function claimWinnings(_walletAddress, _marketId) {
    throw new Error(
        'Payouts are claimed on-chain only: call ChaosParimutuelMarket.claim(marketId) from your wallet after the owner calls resolveMarket. USDC is not sent by this API.'
    );
}
