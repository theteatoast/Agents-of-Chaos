/**
 * Adds betting_opens_at / betting_closes_at to prediction_markets (Neon / existing DBs).
 * Run: node db/migrate_market_times.js
 */
import pool from './index.js';

async function migrate() {
    await pool.query(`
        ALTER TABLE prediction_markets
        ADD COLUMN IF NOT EXISTS betting_opens_at TIMESTAMPTZ DEFAULT NOW();
    `);
    await pool.query(`
        ALTER TABLE prediction_markets
        ADD COLUMN IF NOT EXISTS betting_closes_at TIMESTAMPTZ;
    `);
    await pool.query(`
        UPDATE prediction_markets
        SET betting_opens_at = COALESCE(betting_opens_at, created_at)
        WHERE betting_opens_at IS NULL;
    `);
    console.log('✅ Migration complete: prediction_markets time columns.');
    await pool.end();
}

migrate().catch((err) => {
    console.error('❌ Migration failed:', err);
    process.exit(1);
});
