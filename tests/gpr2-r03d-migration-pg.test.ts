import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { IsolatedDatabase, Session, createIsolatedDatabase, recordEvidence, scrubConnectionEnvironment, sleep, until } from './helpers/gpr2-native-pg';

/**
 * GPR-2 R03d on NATIVE PostgreSQL (disposable database on the isolated cluster, never Render) — scenario A29: "Boot restart, миграции, старый API/UI,
 * contract dry-run: никакого неконтролируемого destructive DDL".
 *   * two runners started at the same moment on an empty database: the advisory lock serialises them, every version is recorded once
 *   * a run that fails in the middle leaves NOTHING (all-or-nothing), the repaired chain then applies, a restart is a no-op
 *   * the upgrade from the OLD runner's ledger (version + applied_at only): the new columns are added, the 25 legacy rows are reported unverified, 026-028 apply
 *   * --plan on a database with no ledger at all, and on one with the old ledger, applies nothing and takes no lock
 *   * a contract step is refused before anything is applied; a refusal leaves the database exactly as it was
 */
let db: IsolatedDatabase;
let dbm: any, runner: any, mig: any;
before(async () => {
  scrubConnectionEnvironment();
  db = await createIsolatedDatabase('r03d');
  process.env.DB_MODE = 'postgres';
  process.env.DATABASE_URL = db.url;
  process.env.AUTH_MODE = 'mock';
  process.env.MOCK_LOGIN_KEY = 'gpr2-r03d-pg';
  dbm = await import('../apps/backend/src/db');
  runner = await import('../scripts/migration-runner');
  mig = await import('../scripts/migrate');
  recordEvidence('r03d-isolation', db.evidence);
});
after(async () => {
  await dbm.pool.end();
  await sleep(300); // let the pool's sockets close before DROP DATABASE ... FORCE
  await db?.drop();
});

const raw = async () => { const c = new Client({ connectionString: db.url }); await c.connect(); return c; };
const reset = async () => { const c = await raw(); await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public'); await c.end(); };
const versions = async () => { const c = await raw(); try { return (await c.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map((r: any) => r.version as number); } finally { await c.end(); } };

test('A29 two runners started together on an empty database: serialised by the advisory lock, every version recorded exactly once', async () => {
  await reset();
  const observer = await Session.open(db.url, 'observer');
  try {
    const both = await Promise.all([mig.migrate(), mig.migrate()]);
    const files = runner.readMigrationFiles('infra');
    assert.deepEqual(await versions(), files.map((f: any) => f.version));
    const applied = both.map((r: any) => r.applied.length).sort((a: number, b: number) => a - b);
    assert.deepEqual(applied, [0, files.length], 'one runner applied the whole chain, the other found nothing to do (it waited for the lock, then saw the ledger)');
    recordEvidence('r03d-concurrent-runners', { files: files.length, applied });
  }
  finally { await observer.close(); }
});

test('A29 a run that fails in the middle leaves NOTHING; the repaired chain applies; a restart is a no-op', async () => {
  await reset();
  const mk = (version: number, sql: string) => ({ version, file: String(version).padStart(3, '0') + '_t.sql', sql, checksum: runner.checksumOf(sql), class: 'additive' });
  const good = [mk(1, 'CREATE TABLE t1(id int);'), mk(2, 'CREATE TABLE t2(id int);'), mk(3, 'CREATE TABLE t3(id int);')];
  const broken = [good[0], good[1], mk(3, 'CREATE TABLE t3(id int); ALTER TABLE t3 ADD COLUMN c nonexistent_type;')];
  await assert.rejects(() => dbm.transaction((c: any) => runner.applyMigrations(c, broken)), /nonexistent_type/);
  const c = await raw();
  try {
    assert.equal((await c.query("SELECT to_regclass('t1') IS NOT NULL AS x")).rows[0].x, false, 'migration 1 did not survive the failure of 3');
    assert.equal((await c.query("SELECT to_regclass('schema_migrations') IS NOT NULL AS x")).rows[0].x, false, 'neither did the ledger');
    const fixed = await dbm.transaction((cc: any) => runner.applyMigrations(cc, good));
    assert.deepEqual(fixed.applied.map((a: any) => a.version), [1, 2, 3]);
    assert.deepEqual((await dbm.transaction((cc: any) => runner.applyMigrations(cc, good))).applied, [], 'restart: nothing');
  }
  finally { await c.end(); }
});

test('A29 upgrade from the OLD runner\'s ledger: its rows stay, are reported UNVERIFIED (never promoted), and the new migrations apply with checksums', async () => {
  await reset();
  const c = await raw();
  try {
    // exactly what the old runner left behind: a ledger with version + applied_at only, 1..25 applied
    await c.query('CREATE TABLE schema_migrations(version int PRIMARY KEY, applied_at timestamptz DEFAULT now())');
    for (const f of fs.readdirSync('infra').filter(f => /^\d+_.*\.sql$/.test(f)).sort().filter(f => Number(f.split('_')[0]) <= 25)) {
      await c.query(fs.readFileSync(path.join('infra', f), 'utf8'));
      await c.query('INSERT INTO schema_migrations(version) VALUES($1)', [Number(f.split('_')[0])]);
    }
    const oldRows = (await c.query('SELECT version, applied_at FROM schema_migrations ORDER BY version')).rows;
    assert.equal(oldRows.length, 25);

    // --plan: nothing applied, no lock, no ledger change — even though the checksum column does not exist yet
    // R04 CP-02 (REG-02): R04 added 028 (additive expand: five DROP NOT NULL). The list is still pinned, and checked against the repository chain.
    // GPR-2 R05 adds 029+ (additive: new columns, tables, indexes and guards; no row of an existing table rewritten).
    const AFTER_OLD_RUNNER = [26, 27, 28, 29, 30, 31, 32];
    const newer = runner.readMigrationFiles('infra').filter((f: any) => f.version > 25);
    assert.deepEqual(newer.map((f: any) => f.version), AFTER_OLD_RUNNER, 'the migrations the old runner never knew');
    assert.deepEqual(newer.map((f: any) => f.class), AFTER_OLD_RUNNER.map(() => 'additive'), 'none of them is a contract step');
    assert.deepEqual(newer.flatMap((f: any) => runner.destructiveStatements(f.sql)), [], 'and none carries destructive DDL');
    const plan = await mig.planMigrationsOnDatabase();
    assert.deepEqual(plan.pending.map((p: any) => p.version), AFTER_OLD_RUNNER);
    assert.deepEqual(plan.unverifiedInLedger, Array.from({ length: 25 }, (_, i) => i + 1), 'the plan already says the 25 old rows are unverified');
    const cols = (await c.query("SELECT column_name FROM information_schema.columns WHERE table_name='schema_migrations' ORDER BY 1")).rows.map((r: any) => r.column_name);
    assert.deepEqual(cols, ['applied_at', 'version'], 'planning did not touch the ledger');
    assert.deepEqual((await c.query('SELECT version FROM schema_migrations')).rows.length, 25);

    const result = await mig.migrate();
    assert.deepEqual(result.applied.map((a: any) => a.version), AFTER_OLD_RUNNER);
    assert.deepEqual(result.unverifiedInLedger, Array.from({ length: 25 }, (_, i) => i + 1));
    const after = (await c.query('SELECT version, applied_at, checksum FROM schema_migrations ORDER BY version')).rows;
    assert.deepEqual(after.slice(0, 25).map((r: any) => [r.version, r.applied_at.toISOString()]), oldRows.map((r: any) => [r.version, r.applied_at.toISOString()]), 'the old rows (and their times) are untouched');
    assert.ok(after.slice(0, 25).every((r: any) => r.checksum === null), 'and are not given a checksum they never earned');
    assert.ok(after.slice(25).every((r: any) => /^[0-9a-f]{64}$/.test(r.checksum)));
    const plan2 = await mig.planMigrationsOnDatabase();
    assert.deepEqual([plan2.pending, plan2.unverifiedInLedger.length], [[], 25]);
    recordEvidence('r03d-upgrade-from-old-ledger', { unverifiedInLedger: plan2.unverifiedInLedger.length, newlyApplied: result.applied.map((a: any) => a.file) });
  }
  finally { await c.end(); }
});

test('A29 --plan on a database with no ledger at all lists the whole chain and creates nothing', async () => {
  await reset();
  const plan = await mig.planMigrationsOnDatabase();
  assert.equal(plan.pending.length, runner.readMigrationFiles('infra').length);
  const c = await raw();
  try { assert.equal((await c.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'")).rows[0].n, 0, 'an empty database stayed empty'); }
  finally { await c.end(); }
});

test('A29 a contract step is refused BEFORE anything is applied; the database is left exactly as it was; naming it applies it once', async () => {
  await reset();
  const mk = (version: number, cls: string, sql: string) => ({ version, file: String(version).padStart(3, '0') + '_c.sql', sql, checksum: runner.checksumOf(sql), class: cls });
  const chain = [mk(1, 'additive', 'CREATE TABLE keep(id int); CREATE TABLE old_thing(id int); INSERT INTO old_thing VALUES (1);'), mk(2, 'contract', 'DROP TABLE old_thing;')];
  await dbm.transaction((c: any) => runner.applyMigrations(c, chain, { through: 1 }));
  await assert.rejects(() => dbm.transaction((c: any) => runner.applyMigrations(c, chain)), /MIGRATION_CONTRACT_NOT_ALLOWED/);
  await assert.rejects(() => dbm.transaction((c: any) => runner.applyMigrations(c, chain, { mode: 'boot', allowContract: [2] })), /MIGRATION_CONTRACT_IN_BOOT/);
  const c = await raw();
  try {
    assert.equal((await c.query('SELECT count(*)::int AS n FROM old_thing')).rows[0].n, 1, 'the data the contract step would drop is still there');
    assert.deepEqual(await versions(), [1]);
    await dbm.transaction((cc: any) => runner.applyMigrations(cc, chain, { allowContract: [2] }));
    assert.equal((await c.query("SELECT to_regclass('old_thing') IS NULL AS gone")).rows[0].gone, true);
    assert.deepEqual(await versions(), [1, 2]);
  }
  finally { await c.end(); }
});

test('A29 a second runner arriving while the first holds the lock waits for it and does not apply anything twice (observed blocked)', async () => {
  await reset();
  const holder = await Session.open(db.url, 'lock-holder');
  const observer = await Session.open(db.url, 'observer');
  try {
    await holder.begin();
    await holder.query('SELECT pg_advisory_xact_lock(830017)'); // the migration lock, held as a running migration would hold it
    let done = false;
    const run = mig.migrate().then((r: any) => { done = true; return r; });
    await until(async () => (await observer.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND wait_event='advisory'")).rows[0].n === 1, 'the runner to wait for the migration lock');
    await sleep(100);
    assert.equal(done, false);
    await holder.commit();
    const r = await run;
    assert.equal(r.applied.length, runner.readMigrationFiles('infra').length);
  }
  finally { await holder.close(); await observer.close(); }
});
