import pool from './index.js';

const AGENTS = [
    { name: 'tk', personality: 'Aggressive trader, always looking for profit' },
    { name: 'Srijan', personality: 'Conservative saver, hoards resources' },
    { name: 'Kunal', personality: 'Risk-taker, loves volatile markets' },
    { name: 'Ahaan Raizada', personality: 'Balanced strategist, adapts to market conditions' },
    { name: 'Saxenasahab', personality: 'Cautious and defensive, focuses on survival' },
    { name: 'Hamza Ali Mazari', personality: 'Opportunistic, buys low and sells high' },
    { name: 'NPC 1', personality: 'Lazy, prefers to hold and do nothing' },
    { name: 'NPC 2', personality: 'Workaholic, always grinding for credits' },
    { name: 'NPC 3', personality: 'Contrarian, does the opposite of the crowd' },
    { name: 'NPC 4', personality: 'Energy-obsessed, prioritizes energy above all' },
];

async function seed() {
    // Clear existing data (order respects FKs)
    await pool.query('DELETE FROM protocol_fees');
    await pool.query('DELETE FROM market_trades');
    await pool.query('DELETE FROM market_positions');
    await pool.query('DELETE FROM market_outcomes');
    await pool.query('DELETE FROM prediction_markets');
    await pool.query('DELETE FROM tick_snapshots');
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

    // Default close: tomorrow 13:00 local, or MARKET_CLOSES_AT (ISO 8601)
    const closesAt = process.env.MARKET_CLOSES_AT
        ? new Date(process.env.MARKET_CLOSES_AT)
        : (() => {
            const d = new Date();
            d.setDate(d.getDate() + 1);
            d.setHours(13, 0, 0, 0);
            return d;
        })();

    // High settlement_tick so resolution is driven by betting_closes_at (see resolveMarketsByDeadline)
    const marketInsert = await pool.query(
        `INSERT INTO prediction_markets (slug, title, settlement_tick, status, fee_bps, betting_opens_at, betting_closes_at)
         VALUES ($1, $2, $3, 'OPEN', $4, NOW(), $5)
         RETURNING id`,
        [
            'richest-agent-session',
            'Which agent has the most sandbox credits when betting closes?',
            999999,
            200,
            closesAt,
        ]
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
