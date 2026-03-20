import pool from './index.js';

const AGENTS = [
    { name: 'Atlas', personality: 'Aggressive trader, always looking for profit' },
    { name: 'Nova', personality: 'Conservative saver, hoards resources' },
    { name: 'Blaze', personality: 'Risk-taker, loves volatile markets' },
    { name: 'Echo', personality: 'Balanced strategist, adapts to market conditions' },
    { name: 'Frost', personality: 'Cautious and defensive, focuses on survival' },
    { name: 'Spark', personality: 'Opportunistic, buys low and sells high' },
    { name: 'Drift', personality: 'Lazy, prefers to hold and do nothing' },
    { name: 'Pulse', personality: 'Workaholic, always grinding for credits' },
    { name: 'Shade', personality: 'Contrarian, does the opposite of the crowd' },
    { name: 'Volt', personality: 'Energy-obsessed, prioritizes energy above all' },
];

async function seed() {
    // Clear existing data
    await pool.query('DELETE FROM event_logs');
    await pool.query('DELETE FROM market_state');
    await pool.query('DELETE FROM agents');

    // Insert agents with random starting balances
    for (const agent of AGENTS) {
        const credits = Math.floor(Math.random() * 150) + 50;  // 50-200
        const food = Math.floor(Math.random() * 15) + 5;       // 5-20
        const energy = Math.floor(Math.random() * 15) + 5;     // 5-20
        await pool.query(
            'INSERT INTO agents (name, personality, credits, food, energy) VALUES ($1, $2, $3, $4, $5)',
            [agent.name, agent.personality, credits, food, energy]
        );
    }

    // Insert initial market state at tick 0
    await pool.query(
        'INSERT INTO market_state (tick, food_price, energy_price) VALUES ($1, $2, $3)',
        [0, 5.0, 3.0]
    );

    // Create default USDC prediction market for richest agent
    const marketInsert = await pool.query(
        `INSERT INTO prediction_markets (slug, title, settlement_tick, status, fee_bps)
         VALUES ($1, $2, $3, 'OPEN', $4)
         RETURNING id`,
        ['richest-agent-t200', 'Who will be richest at tick 200?', 200, 200]
    );
    await pool.query(
        `INSERT INTO market_outcomes (market_id, agent_id)
         SELECT $1, id FROM agents ORDER BY id`,
        [marketInsert.rows[0].id]
    );

    console.log('🌱 Seeded 10 agents and initial market state.');
    await pool.end();
}

seed().catch((err) => {
    console.error('❌ Seed failed:', err);
    process.exit(1);
});
