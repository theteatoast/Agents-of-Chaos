import { ethers } from 'ethers';
import pool from '../db/index.js';
import config from '../config/index.js';
import { fetchTradeEventFromTx, readReservesOnChain, formatSignedInt256ToNumber } from './chainSync.js';

const SIDES = new Set(['BUY_YES', 'BUY_NO', 'SELL_YES', 'SELL_NO']);

/** Rough mid price for YES (display only): share of virtual no-reserve in pool. */
export function impliedYesPrice(reserveYes, reserveNo) {
    const ry = Number(reserveYes);
    const rn = Number(reserveNo);
    if (!Number.isFinite(ry) || !Number.isFinite(rn) || ry + rn <= 0) return 0.5;
    return rn / (ry + rn);
}

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

function cpmmQuote({ reserveYes, reserveNo, side, usdcAmount }) {
    const amount = Number(usdcAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error('usdcAmount must be positive');
    }

    const k = reserveYes * reserveNo;
    if (side === 'BUY_YES') {
        const newYes = reserveYes + amount;
        const newNo = k / newYes;
        return { sharesDelta: reserveNo - newNo, newYes, newNo };
    }
    if (side === 'BUY_NO') {
        const newNo = reserveNo + amount;
        const newYes = k / newNo;
        return { sharesDelta: reserveYes - newYes, newYes, newNo };
    }
    if (side === 'SELL_YES') {
        if (amount >= reserveYes) throw new Error('Sell amount too large for pool depth');
        const newYes = reserveYes - amount;
        const newNo = k / newYes;
        return { sharesDelta: -(newNo - reserveNo), newYes, newNo };
    }
    if (side === 'SELL_NO') {
        if (amount >= reserveNo) throw new Error('Sell amount too large for pool depth');
        const newNo = reserveNo - amount;
        const newYes = k / newNo;
        return { sharesDelta: -(newYes - reserveYes), newYes, newNo };
    }
    throw new Error('Unsupported side');
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
    return rows.map((o, idx) => {
        const pYes = impliedYesPrice(o.reserve_yes, o.reserve_no);
        return {
            ...o,
            outcome_index: idx,
            implied_yes: +pYes.toFixed(6),
            implied_no: +(1 - pYes).toFixed(6),
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

export async function quoteTrade({ marketId, outcomeId, side, usdcAmount }) {
    if (!SIDES.has(side)) throw new Error('Invalid side');
    const market = await getMarketById(marketId);
    if (!market) throw new Error('Market not found');
    if (market.status !== 'OPEN') throw new Error('Market is not open');
    const now = await getDbNow();
    if (!isTradingOpen(market, now)) {
        throw new Error('Trading is closed for this market (deadline passed). You can still view positions until resolution.');
    }

    const { rows } = await pool.query('SELECT * FROM market_outcomes WHERE id = $1 AND market_id = $2', [outcomeId, marketId]);
    const outcome = rows[0];
    if (!outcome) throw new Error('Outcome not found');

    const feeRate = market.fee_bps / 10000;
    const feeUsdc = Number(usdcAmount) * feeRate;
    const netAmount = Number(usdcAmount) - feeUsdc;
    const reserveYes = Number(outcome.reserve_yes);
    const reserveNo = Number(outcome.reserve_no);
    const result = cpmmQuote({ reserveYes, reserveNo, side, usdcAmount: netAmount });
    const avgPrice = Math.abs(netAmount / result.sharesDelta);

    return {
        marketId,
        outcomeId,
        side,
        grossUsdc: Number(usdcAmount),
        feeUsdc,
        fee_bps: market.fee_bps,
        net_to_pool_usdc: netAmount,
        protocol_fee_destination: config.protocolTreasuryAddress || 'configure PROTOCOL_TREASURY_ADDRESS',
        netUsdc: netAmount,
        sharesDelta: result.sharesDelta,
        avgPrice,
        nextReserves: { yes: result.newYes, no: result.newNo },
        disclosure: {
            summary:
                'Gross USDC is your payment. The protocol fee is deducted; the remainder goes into the AMM pool as liquidity for your trade. Sandbox agent credits are separate from USDC.',
        },
    };
}

export async function executeTrade({ walletAddress, marketId, outcomeId, side, usdcAmount, txHash }) {
    if (!config.allowUnverifiedTrades) {
        throw new Error(
            'Unverified DB trades are disabled. Trade USDC on-chain via the deployed contract, then POST /markets/trade/confirm with the tx hash.'
        );
    }
    const quote = await quoteTrade({ marketId, outcomeId, side, usdcAmount });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            `UPDATE market_outcomes
             SET reserve_yes = $1, reserve_no = $2
             WHERE id = $3`,
            [quote.nextReserves.yes, quote.nextReserves.no, outcomeId]
        );

        await client.query(
            `INSERT INTO market_positions (wallet_address, market_id, outcome_id, shares, total_cost_usdc, updated_at)
             VALUES ($1, $2, $3, $4, $5, NOW())
             ON CONFLICT (wallet_address, market_id, outcome_id)
             DO UPDATE SET
               shares = market_positions.shares + EXCLUDED.shares,
               total_cost_usdc = market_positions.total_cost_usdc + EXCLUDED.total_cost_usdc,
               updated_at = NOW()`,
            [walletAddress.toLowerCase(), marketId, outcomeId, quote.sharesDelta, quote.netUsdc]
        );

        const tradeInsert = await client.query(
            `INSERT INTO market_trades
            (wallet_address, market_id, outcome_id, side, usdc_amount, shares_delta, avg_price, fee_usdc, tx_hash, block_timestamp)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
            RETURNING *`,
            [walletAddress.toLowerCase(), marketId, outcomeId, side, quote.grossUsdc, quote.sharesDelta, quote.avgPrice, quote.feeUsdc, txHash || null]
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

/** Apply indexed DB state from a mined Base tx that emitted `Trade` on the ChaosPredictionMarket contract. */
export async function syncTradeFromTxHash(txHash) {
    const normalizedHash = txHash?.toLowerCase();
    if (!normalizedHash || !normalizedHash.startsWith('0x')) throw new Error('Invalid tx hash');

    const dup = await pool.query('SELECT id FROM market_trades WHERE tx_hash = $1', [normalizedHash]);
    if (dup.rows.length) {
        return { duplicate: true, tradeId: dup.rows[0].id };
    }

    const ev = await fetchTradeEventFromTx(normalizedHash);
    const wallet = String(ev.user).toLowerCase();
    const outcomeId = await getOutcomeIdByIndex(ev.marketId, ev.outcomeIndex);
    const sideNames = ['BUY_YES', 'BUY_NO', 'SELL_YES', 'SELL_NO'];
    const side = sideNames[ev.side];
    if (!side) throw new Error('Invalid trade side in event');

    const grossUsdc = Number(ethers.formatUnits(ev.grossUsdc, 6));
    const feeUsdc = Number(ethers.formatUnits(ev.feeUsdc, 6));
    const netUsdc = Number(ethers.formatUnits(ev.netUsdc, 6));
    const usdcToUser = Number(ethers.formatUnits(ev.usdcToUser, 6));
    const sharesDelta = formatSignedInt256ToNumber(ev.sharesDelta, 6);

    const reserves = await readReservesOnChain(ev.marketId, ev.outcomeIndex);
    const costDelta = ev.side < 2 ? netUsdc : -usdcToUser;
    const avgPrice = Math.abs(sharesDelta) > 1e-12 ? Math.abs(netUsdc / sharesDelta) : 0;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(`UPDATE market_outcomes SET reserve_yes = $1, reserve_no = $2 WHERE id = $3`, [
            reserves.reserve_yes,
            reserves.reserve_no,
            outcomeId,
        ]);

        await client.query(
            `INSERT INTO market_positions (wallet_address, market_id, outcome_id, shares, total_cost_usdc, updated_at)
             VALUES ($1,$2,$3,$4,$5,NOW())
             ON CONFLICT (wallet_address, market_id, outcome_id)
             DO UPDATE SET
               shares = market_positions.shares + $4,
               total_cost_usdc = GREATEST(0, market_positions.total_cost_usdc + $6),
               updated_at = NOW()`,
            [wallet, ev.marketId, outcomeId, sharesDelta, costDelta, costDelta]
        );

        const tradeInsert = await client.query(
            `INSERT INTO market_trades
            (wallet_address, market_id, outcome_id, side, usdc_amount, shares_delta, avg_price, fee_usdc, tx_hash, block_timestamp)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
            RETURNING *`,
            [wallet, ev.marketId, outcomeId, side, grossUsdc, sharesDelta, avgPrice, feeUsdc, normalizedHash]
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
        const pYes = impliedYesPrice(row.reserve_yes, row.reserve_no);
        const shares = Number(row.shares);
        const cost = Number(row.total_cost_usdc);
        const markValue = Math.max(0, shares * pYes);
        const avgEntry = shares !== 0 ? cost / shares : 0;
        return {
            ...row,
            implied_yes: +pYes.toFixed(6),
            estimated_mark_value_usdc: +markValue.toFixed(6),
            avg_entry_usdc_per_share: +avgEntry.toFixed(8),
            unrealized_pnl_usdc: +(markValue - cost).toFixed(6),
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
        rules: [
            'Sandbox economy (agent credits, food, energy) is simulated and has no monetary value.',
            'USDC on Base is used only for prediction-market trades against the on-chain / recorded liquidity model.',
            'A protocol fee is taken from each trade’s gross USDC; the rest goes to the pool for that trade.',
            'You can quote and trade (buy or sell) while the market is OPEN and before the betting deadline.',
            'When the deadline passes, new trades stop. The winner is the agent with the highest sandbox credits at resolution (latest tick snapshot).',
            'The platform earns revenue only from the configured fee on trades, not from hidden spreads.',
            'Trades are executed on-chain in USDC; this API indexes confirmed transactions — do not trust off-chain balance changes without a matching tx.',
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

export async function claimWinnings(walletAddress, marketId) {
    const normalized = walletAddress.toLowerCase();
    const market = await getMarketById(marketId);
    if (!market) throw new Error('Market not found');
    if (market.status !== 'RESOLVED') throw new Error('Market not resolved yet');
    if (!market.winning_agent_id) throw new Error('Winning outcome unavailable');

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const winnerRows = await client.query(
            `SELECT id FROM market_outcomes WHERE market_id = $1 AND agent_id = $2`,
            [marketId, market.winning_agent_id]
        );
        const winningOutcomeId = winnerRows.rows[0]?.id;
        if (!winningOutcomeId) throw new Error('Winning outcome not found');

        const posRows = await client.query(
            `SELECT id, shares
             FROM market_positions
             WHERE wallet_address = $1 AND market_id = $2 AND outcome_id = $3`,
            [normalized, marketId, winningOutcomeId]
        );
        const position = posRows.rows[0];
        if (!position || Number(position.shares) <= 0) {
            throw new Error('No claimable winning shares');
        }

        const payoutUsdc = Number(position.shares);
        await client.query(
            `UPDATE market_positions
             SET shares = 0, total_cost_usdc = 0, updated_at = NOW()
             WHERE id = $1`,
            [position.id]
        );
        await client.query('COMMIT');
        return { payoutUsdc, marketId, outcomeId: winningOutcomeId };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}
