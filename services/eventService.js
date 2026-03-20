import pool from '../db/index.js';

export async function logEvent(tick, description) {
    await pool.query(
        'INSERT INTO event_logs (tick, description) VALUES ($1, $2)',
        [tick, description]
    );
}

export async function getRecentEvents(limit = 50) {
    const { rows } = await pool.query(
        'SELECT * FROM event_logs ORDER BY created_at DESC LIMIT $1',
        [limit]
    );
    return rows;
}

export async function logEventsBatch(events) {
    if (!events.length) return;
    const values = [];
    const params = [];
    let i = 1;
    for (const event of events) {
        values.push(`($${i++}, $${i++})`);
        params.push(event.tick, event.description);
    }
    await pool.query(
        `INSERT INTO event_logs (tick, description) VALUES ${values.join(', ')}`,
        params
    );
}
