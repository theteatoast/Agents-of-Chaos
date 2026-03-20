import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import pool from './index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function setupDb() {
    const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
    await pool.query(sql);
    console.log('✅ Database schema created successfully.');
    await pool.end();
}

setupDb().catch((err) => {
    console.error('❌ Schema setup failed:', err);
    process.exit(1);
});
