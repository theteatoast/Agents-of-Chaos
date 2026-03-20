/**
 * Unique tx_hash for market_trades (idempotent indexing).
 * Run: node db/migrate_tx_unique.js
 */
import pool from './index.js';

async function migrate() {
    await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS market_trades_tx_hash_unique
        ON market_trades (tx_hash)
        WHERE tx_hash IS NOT NULL;
    `);
    console.log('✅ Migration complete: unique tx_hash on market_trades.');
    await pool.end();
}

migrate().catch((err) => {
    console.error('❌ Migration failed:', err);
    process.exit(1);
});
