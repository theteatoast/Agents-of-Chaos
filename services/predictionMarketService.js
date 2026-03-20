import pool from '../db/index.js';
import config from '../config/index.js';

const SIDES = new Set(['BUY_YES', 'BUY_NO', 'SELL_YES', 'SELL_NO']);

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
    return rows;
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
    return rows;
}

export async function createMarket({ slug, title, settlementTick, feeBps = config.protocolFeeBps }) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const insertMarket = await client.query(
            `INSERT INTO prediction_markets (slug, title, settlement_tick, fee_bps)
             VALUES ($1, $2, $3, $4)
             RETURNING *`,
            [slug, title, settlementTick, feeBps]
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
        netUsdc: netAmount,
        sharesDelta: result.sharesDelta,
        avgPrice,
        nextReserves: { yes: result.newYes, no: result.newNo },
    };
}

export async function executeTrade({ walletAddress, marketId, outcomeId, side, usdcAmount, txHash }) {
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

export async function getPositions(walletAddress) {
    const { rows } = await pool.query(
        `SELECT p.*, pm.title, pm.status, pm.winning_agent_id, mo.agent_id, a.name AS agent_name
         FROM market_positions p
         JOIN prediction_markets pm ON pm.id = p.market_id
         JOIN market_outcomes mo ON mo.id = p.outcome_id
         JOIN agents a ON a.id = mo.agent_id
         WHERE p.wallet_address = $1
         ORDER BY p.updated_at DESC`,
        [walletAddress.toLowerCase()]
    );
    return rows;
}

export async function resolveMaturedMarkets(currentTick) {
    const pending = await pool.query(
        `SELECT id, settlement_tick
         FROM prediction_markets
         WHERE status IN ('OPEN', 'CLOSED') AND settlement_tick <= $1
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
