import { pool, transaction } from '../apps/backend/src/db';
import fs from 'node:fs';
export async function migrate() { await transaction(async (c) => { await c.query('SELECT pg_advisory_xact_lock(830017)'); await c.query('CREATE TABLE IF NOT EXISTS schema_migrations(version int PRIMARY KEY, applied_at timestamptz DEFAULT now())'); for (const file of fs.readdirSync('infra').filter(f => /^\d+_.*\.sql$/.test(f)).sort()) {
    const version = Number(file.split('_')[0]);
    if (!(await c.query('SELECT version FROM schema_migrations WHERE version=$1', [version])).rows.length) {
        await c.query(fs.readFileSync('infra/' + file, 'utf8'));
        await c.query('INSERT INTO schema_migrations(version) VALUES($1)', [version]);
    }
}
// Migrations of feature branches that have no final number yet (see infra/pending/README.md): idempotent SQL, applied after the numbered chain, tracked by file name.
if (fs.existsSync('infra/pending')) {
    await c.query('CREATE TABLE IF NOT EXISTS schema_pending_migrations(name text PRIMARY KEY, applied_at timestamptz DEFAULT now())');
    for (const file of fs.readdirSync('infra/pending').filter(f => /\.sql$/.test(f)).sort()) {
        if (!(await c.query('SELECT 1 FROM schema_pending_migrations WHERE name=$1', [file])).rows.length) {
            await c.query(fs.readFileSync('infra/pending/' + file, 'utf8'));
            await c.query('INSERT INTO schema_pending_migrations(name) VALUES($1)', [file]);
        }
    }
} }); }
if (require.main === module)
    migrate().then(async () => { console.log('Migrations applied/confirmed'); await pool.end(); }).catch(e => { console.error(e); process.exit(1); });
