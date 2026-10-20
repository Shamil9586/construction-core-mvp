import { pool, transaction } from '../apps/backend/src/db';
import { MigrationPlan, PlanOptions, applyMigrations, parseCliArgs, planAgainstLedger, readMigrationFiles } from './migration-runner';
/**
 * Applies the numbered migrations in infra/. GPR-2 R03d: every migration after 025 declares a class (additive | contract) and carries a checksum in
 * the ledger; an additive file is verified to be additive; a contract file runs only when the operator names it (--allow-contract=NNN) and never
 * at application start. `npm run db:migrate -- --plan` shows what would run and applies nothing. Without arguments this behaves as before:
 * every unapplied additive migration is applied in one transaction under one advisory lock, and a re-run is a no-op.
 */
export async function migrate(opts: PlanOptions = {}) {
    const files = readMigrationFiles('infra');
    return transaction(async (c) => applyMigrations(c, files, opts));
}
export async function planMigrationsOnDatabase(opts: PlanOptions = {}): Promise<MigrationPlan> {
    return planAgainstLedger(pool, readMigrationFiles('infra'), opts);
}
if (require.main === module) {
    const cli = parseCliArgs(process.argv.slice(2));
    (cli.plan ? planMigrationsOnDatabase(cli).then(p => { console.log(JSON.stringify(p, null, 2)); }) : migrate(cli).then(r => { console.log('Migrations applied/confirmed' + (r.applied.length ? ': ' + r.applied.map(m => m.file).join(', ') : '')); }))
        .then(async () => { await pool.end(); }).catch(async e => { console.error(e); await pool.end().catch(() => undefined); process.exit(1); });
}
