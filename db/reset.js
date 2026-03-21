/**
 * Full wipe + re-seed (same as npm run seed). Use when you want a clean economy from scratch.
 *
 *   npm run db:reset
 *
 * Then restart the dev server, or POST /simulation/reset (with admin key) to sync in-memory tick.
 */
import pool from './index.js';
import { wipeAndSeed } from './seed.js';

async function main() {
    try {
        await wipeAndSeed();
        console.log('✅ Database erased and re-seeded.');
        console.log('   → Restart `npm run dev` or call POST /simulation/reset so the running server’s tick counter matches the DB.');
    } catch (err) {
        console.error('❌ db:reset failed:', err);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

main();
