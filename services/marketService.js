import pool from '../db/index.js';

export async function getMarketState() {
    const { rows } = await pool.query('SELECT * FROM market_state ORDER BY tick DESC LIMIT 1');
    return rows[0] || { tick: 0, food_price: 5.0, energy_price: 3.0 };
}

export async function updateMarketState(tick, foodPrice, energyPrice) {
    await pool.query(
        `INSERT INTO market_state (tick, food_price, energy_price)
     VALUES ($1, $2, $3)
     ON CONFLICT (tick) DO UPDATE SET food_price = $2, energy_price = $3`,
        [tick, foodPrice, energyPrice]
    );
}

export async function saveTickSnapshot(tick, richestAgentId, richestCredits) {
    await pool.query(
        `INSERT INTO tick_snapshots (tick, richest_agent_id, richest_agent_credits)
         VALUES ($1, $2, $3)
         ON CONFLICT (tick) DO UPDATE
         SET richest_agent_id = $2, richest_agent_credits = $3`,
        [tick, richestAgentId, richestCredits]
    );
}
