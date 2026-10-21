import './helpers/gpr2-isolation';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  MigrationError, MigrationFile, applyMigrations, checksumOf, declaredClass, destructiveStatements, parseCliArgs, planMigrations, readLegacyManifest, readMigrationFiles
} from '../scripts/migration-runner';

/**
 * GPR-2 R03d — controlled migration execution (TD §13.1, §13.4; decision C17; scenario A29): classes, additivity, checksums, contract gate, plan/dry run,
 * boot safety, all-or-nothing. Pure + PGlite here; the real server (concurrent runners, a failure in the middle, the upgrade from the old runner's
 * ledger) is gpr2-r03d-migration-pg.test.ts.
 */
const code = (fn: () => unknown) => { try { fn(); return 'NO ERROR'; } catch (e: any) { return e instanceof MigrationError ? e.code : 'UNEXPECTED:' + e.message; } };
const file = (version: number, cls: MigrationFile['class'], sql: string): MigrationFile => ({ version, file: String(version).padStart(3, '0') + '_x.sql', sql, checksum: checksumOf(sql), class: cls });

test('R03d checksum: sha256 of the file with line endings normalised, so a Windows checkout verifies', () => {
  assert.equal(checksumOf('a\r\nb\r\n'), checksumOf('a\nb\n'));
  assert.notEqual(checksumOf('a\nb\n'), checksumOf('a\nb \n'));
  assert.match(checksumOf('x'), /^[0-9a-f]{64}$/);
});

test('R03d class header: read from the first lines only; absent is null', () => {
  assert.equal(declaredClass('-- migration-class: additive\nCREATE TABLE t();'), 'additive');
  assert.equal(declaredClass('-- migration-class:  CONTRACT \nDROP TABLE t;'), 'contract');
  assert.equal(declaredClass('-- some comment\n-- migration-class: additive\n'), 'additive');
  assert.equal(declaredClass('CREATE TABLE t();'), null);
  assert.equal(declaredClass('\n'.repeat(20) + '-- migration-class: additive'), null, 'a header buried deep in the file does not count');
});

test('R03d additive means additive: every destructive or data-rewriting statement is found; comments and look-alikes are not', () => {
  const cases: [string, string][] = [
    ['DROP TABLE t;', 'DROP'], ['drop column x', 'DROP'], ['ALTER TABLE t DROP COLUMN c;', 'DROP'], ['TRUNCATE t;', 'TRUNCATE'], ['DELETE FROM t WHERE x=1;', 'DELETE FROM'],
    ['UPDATE t SET a=1;', 'UPDATE'], ['UPDATE ONLY public.t AS x SET a=1;', 'UPDATE'], ['ALTER TABLE t ALTER COLUMN c TYPE bigint;', 'ALTER COLUMN'], ['ALTER TABLE t ALTER COLUMN c SET NOT NULL;', 'ALTER COLUMN'],
    ['ALTER TABLE t RENAME TO u;', 'RENAME'], ['DROP INDEX i;', 'DROP'], ['DROP TRIGGER g ON t;', 'DROP'], ['DROP CONSTRAINT x', 'DROP']
  ];
  for (const [sql, label] of cases)
    assert.ok(destructiveStatements(sql).some(n => n.toUpperCase().includes(label.toUpperCase().split(' ')[0])), sql + ' → ' + label + ' (got ' + JSON.stringify(destructiveStatements(sql)) + ')');
  // allowed in an additive file
  for (const ok of ['CREATE TABLE t(a int);', 'ALTER TABLE t ADD COLUMN c text;', 'ALTER TABLE t ADD CONSTRAINT k CHECK (a>0) NOT VALID;', 'ALTER TABLE t VALIDATE CONSTRAINT k;', 'CREATE INDEX i ON t(a);',
    'ALTER TABLE t ALTER COLUMN c SET DEFAULT 1;', 'CREATE TRIGGER g BEFORE UPDATE OR DELETE ON t FOR EACH ROW EXECUTE FUNCTION f();', '-- DROP TABLE t; in a comment\nCREATE TABLE u();', '/* TRUNCATE t */ SELECT 1;'])
    assert.deepEqual(destructiveStatements(ok), [], ok);
});

test('R03d reading the real chain: 001–025 are LEGACY and match the pinned manifest; 026/027 declare ADDITIVE and are verified additive', () => {
  const files = readMigrationFiles('infra');
  assert.deepEqual(files.slice(0, 25).map(f => f.class), Array(25).fill('legacy'));
  assert.ok(files.slice(25).every(f => f.class === 'additive'), 'every migration after 025 declares its class');
  assert.deepEqual(files.map(f => f.version), Array.from({ length: files.length }, (_, i) => i + 1), 'numbered without gaps');
  const manifest = readLegacyManifest('infra');
  assert.equal(Object.keys(manifest).length, 25);
  for (const f of files.slice(0, 25)) assert.equal(f.checksum, manifest[f.file], f.file);
});

test('R03d the pinned manifest IS the baseline: the hashes equal the files at base commit 678e795 (so "unchanged since baseline" is checkable, not asserted)', (t) => {
  const BASE = '678e795f8802a76ac025f28b0d698351af8b7721';
  try { execFileSync('git', ['cat-file', '-e', BASE + '^{commit}'], { stdio: 'ignore' }); } catch { t.skip('the base commit is not in this clone (shallow)'); return; }
  const manifest = readLegacyManifest('infra');
  for (const [name, hash] of Object.entries(manifest))
    assert.equal(checksumOf(execFileSync('git', ['show', `${BASE}:infra/${name}`], { encoding: 'utf8', maxBuffer: 1 << 26 })), hash, name);
});

test('R03d a legacy file edited after the baseline is refused (an applied migration is never edited); a new file needs a class', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpr2-mig-'));
  try {
    const legacySql = 'CREATE TABLE a();';
    fs.writeFileSync(path.join(dir, '001_a.sql'), legacySql);
    const manifest = { '001_a.sql': checksumOf(legacySql) };
    assert.equal(readMigrationFiles(dir, manifest).length, 1);
    fs.writeFileSync(path.join(dir, '001_a.sql'), legacySql + '\nALTER TABLE a ADD COLUMN x int;');
    assert.equal(code(() => readMigrationFiles(dir, manifest)), 'MIGRATION_LEGACY_MANIFEST_MISMATCH');
    fs.writeFileSync(path.join(dir, '001_a.sql'), legacySql);
    // versions after the legacy range
    const real = fs.readdirSync('infra').filter(f => /^\d+_.*\.sql$/.test(f) && Number(f.split('_')[0]) <= 25);
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'gpr2-mig-'));
    for (const f of real) fs.copyFileSync(path.join('infra', f), path.join(dir2, f));
    const m = readLegacyManifest('infra');
    const put = (name: string, sql: string) => fs.writeFileSync(path.join(dir2, name), sql);
    put('026_n.sql', 'CREATE TABLE n();');
    assert.equal(code(() => readMigrationFiles(dir2, m)), 'MIGRATION_CLASS_MISSING');
    put('026_n.sql', '-- migration-class: whatever\nCREATE TABLE n();');
    assert.equal(code(() => readMigrationFiles(dir2, m)), 'MIGRATION_CLASS_UNKNOWN');
    put('026_n.sql', '-- migration-class: additive\nCREATE TABLE n();\nDROP TABLE old;');
    assert.equal(code(() => readMigrationFiles(dir2, m)), 'MIGRATION_NOT_ADDITIVE');
    put('026_n.sql', '-- migration-class: contract\nDROP TABLE old;');
    assert.equal(code(() => readMigrationFiles(dir2, m)), 'NO ERROR', 'a contract file may be destructive — it is gated at run time instead');
    put('026_m.sql', '-- migration-class: additive\nCREATE TABLE m();');
    assert.equal(code(() => readMigrationFiles(dir2, m)), 'MIGRATION_VERSION_DUPLICATE');
    fs.rmSync(dir2, { recursive: true, force: true });
  }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('R03d planning: what would run, in order; --through; unverified legacy rows are reported, not promoted', () => {
  const chain = [file(1, 'additive', 'a'), file(2, 'additive', 'b'), file(3, 'additive', 'c')];
  assert.deepEqual(planMigrations(chain, []).pending.map(p => p.version), [1, 2, 3]);
  assert.deepEqual(planMigrations(chain, [{ version: 1, checksum: chain[0].checksum }]).pending.map(p => p.version), [2, 3]);
  assert.deepEqual(planMigrations(chain, [], { through: 2 }).pending.map(p => p.version), [1, 2]);
  assert.deepEqual(planMigrations(chain, [{ version: 1, checksum: chain[0].checksum }, { version: 2, checksum: chain[1].checksum }, { version: 3, checksum: chain[2].checksum }]).pending, []);
  const legacy = [{ ...file(1, 'legacy', 'a') }, file(2, 'additive', 'b')];
  assert.deepEqual(planMigrations(legacy, [{ version: 1, checksum: null }]).unverifiedInLedger, [1], 'a legacy row without a checksum is unverified in the ledger');
});

test('R03d a recorded checksum that no longer matches the file is refused; a row WITHOUT a checksum is reported unverified, never refused', () => {
  const chain = [file(1, 'additive', 'a'), file(2, 'additive', 'b')];
  assert.equal(code(() => planMigrations(chain, [{ version: 1, checksum: 'f'.repeat(64) }])), 'MIGRATION_CHANGED_AFTER_APPLY');
  assert.equal(code(() => planMigrations([file(1, 'legacy', 'a')], [{ version: 1, checksum: 'f'.repeat(64) }])), 'MIGRATION_CHANGED_AFTER_APPLY');
  // written by the previous runner (version only): the same treatment as a legacy row — and the plan still proceeds with what is pending
  const plan = planMigrations(chain, [{ version: 1, checksum: null }]);
  assert.deepEqual(plan.unverifiedInLedger, [1]);
  assert.deepEqual(plan.pending.map(p => p.version), [2]);
  assert.deepEqual(planMigrations(chain, [{ version: 1, checksum: null }, { version: 2, checksum: null }]).unverifiedInLedger, [1, 2]);
});

test('R03d a file that appears BELOW an applied version is refused, not guessed at', () => {
  const chain = [file(1, 'additive', 'a'), file(2, 'additive', 'b'), file(3, 'additive', 'c')];
  assert.equal(code(() => planMigrations(chain, [{ version: 1, checksum: chain[0].checksum }, { version: 3, checksum: chain[2].checksum }])), 'MIGRATION_GAP');
});

test('R03d a CONTRACT migration never runs implicitly: refused unless the operator names it, and never at application start — refused before anything is applied', () => {
  const chain = [file(1, 'additive', 'a'), file(2, 'contract', 'DROP TABLE x')];
  assert.equal(code(() => planMigrations(chain, [])), 'MIGRATION_CONTRACT_NOT_ALLOWED');
  assert.equal(code(() => planMigrations(chain, [], { allowContract: [3] })), 'MIGRATION_CONTRACT_NOT_ALLOWED', 'naming another version allows nothing');
  assert.equal(code(() => planMigrations(chain, [], { allowContract: [2] })), 'NO ERROR');
  assert.equal(code(() => planMigrations(chain, [], { mode: 'boot', allowContract: [2] })), 'MIGRATION_CONTRACT_IN_BOOT', 'no flag can make the application start run a contract step');
  assert.equal(code(() => planMigrations(chain, [], { through: 1 })), 'NO ERROR', 'stopping before it is fine');
  assert.equal(code(() => planMigrations(chain, [{ version: 1, checksum: chain[0].checksum }, { version: 2, checksum: chain[1].checksum }], { mode: 'boot' })), 'NO ERROR', 'an already-applied contract step is history, not a pending one');
});

test('R03d CLI arguments', () => {
  assert.deepEqual(parseCliArgs([]), { plan: false, mode: 'explicit', allowContract: [] });
  assert.deepEqual(parseCliArgs(['--plan', '--through=27', '--allow-contract=28,29']), { plan: true, mode: 'explicit', allowContract: [28, 29], through: 27 });
  assert.throws(() => parseCliArgs(['--force']), /unknown argument/);
  assert.throws(() => parseCliArgs(['--through=x']), /integer/);
  assert.throws(() => parseCliArgs(['--allow-contract=a']), /integer/);
});

test('A29 the application start never migrates: no backend module imports the runner, and the image starts the API without it', () => {
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.ts') ? [path.join(d, e.name)] : []));
  const imports = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"][^'"]*scripts\/migrat(?:e|ion-runner)['"]/;
  for (const sample of ["import { migrate } from '../../../scripts/migrate';", "const m = await import('../../scripts/migration-runner');", "const m = require('../scripts/migrate')"]) assert.match(sample, imports, 'the detector is not vacuous: ' + sample);
  assert.doesNotMatch("// see scripts/migrate.ts for the migration lock", imports, 'a comment that merely names the file is not an import');
  const importers = walk('apps/backend/src').filter(f => imports.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(importers, [], 'the API process cannot apply a migration as a side effect of starting');
  const docker = fs.readFileSync('infra/Dockerfile', 'utf8');
  const cmds = docker.split('\n').filter(l => /^\s*CMD\b/.test(l));
  assert.ok(cmds.length > 0 && cmds.every(l => !/migrat/i.test(l)), 'no CMD of the image runs a migration');
  assert.match(docker, /API startup must not apply schema migrations/);
});

// ----------------------------------------------------------------------------------------------------------------------------------
// PGlite: the runner against a real (in-memory) ledger
// ----------------------------------------------------------------------------------------------------------------------------------
async function memoryDb() {
  delete process.env.DATABASE_URL;
  process.env.DB_MODE = 'pglite';
  process.env.PGLITE_DIR = 'memory://';
  const db = await import('../apps/backend/src/db');
  return db;
}

test('R03d all-or-nothing and idempotent: a failing migration rolls the WHOLE run back; the fixed chain then applies; a re-run is a no-op (restart safety)', async () => {
  const { transaction, pool } = await memoryDb();
  const good = [file(1, 'additive', 'CREATE TABLE r03d_a(id int);'), file(2, 'additive', 'CREATE TABLE r03d_b(id int);')];
  const bad = [...good, file(3, 'additive', 'CREATE TABLE r03d_c(id int); INSERT INTO table_that_does_not_exist VALUES (1);')];
  await assert.rejects(() => transaction(c => applyMigrations(c, bad)), /table_that_does_not_exist/);
  assert.equal((await pool.query("SELECT to_regclass('r03d_a') IS NOT NULL AS x")).rows[0].x, false, 'migration 1 was rolled back with the failed 3');
  assert.equal((await pool.query("SELECT to_regclass('schema_migrations') IS NOT NULL AS x")).rows[0].x, false, 'even the ledger table: the failed run left nothing');
  const first = await transaction(c => applyMigrations(c, good));
  assert.deepEqual(first.applied.map(a => a.version), [1, 2]);
  const rows = (await pool.query('SELECT version, checksum, file_name, migration_class, runner_version FROM schema_migrations ORDER BY version')).rows;
  assert.deepEqual(rows.map((r: any) => [r.version, r.checksum, r.migration_class]), [[1, good[0].checksum, 'additive'], [2, good[1].checksum, 'additive']]);
  assert.ok(rows.every((r: any) => r.runner_version === 'gpr2-r03d.1' && r.file_name));
  const again = await transaction(c => applyMigrations(c, good));
  assert.deepEqual(again.applied, [], 'restart: nothing to do');
  // the file is edited after it ran: refused with the version named, nothing applied
  const edited = [file(1, 'additive', 'CREATE TABLE r03d_a(id int, extra int);'), good[1]];
  await assert.rejects(() => transaction(c => applyMigrations(c, edited)), /MIGRATION_CHANGED_AFTER_APPLY/);
});

test('R03d a contract step is applied only when named, and then in the same run; boot mode refuses it even when named', async () => {
  const { transaction, pool } = await memoryDb();
  await pool.query('DROP TABLE IF EXISTS schema_migrations');
  const chain = [file(1, 'additive', 'CREATE TABLE r03d_keep(id int); CREATE TABLE r03d_old(id int);'), file(2, 'contract', 'DROP TABLE r03d_old;')];
  await assert.rejects(() => transaction(c => applyMigrations(c, chain)), /MIGRATION_CONTRACT_NOT_ALLOWED/);
  assert.equal((await pool.query("SELECT to_regclass('r03d_keep') IS NOT NULL AS x")).rows[0].x, false, 'refused BEFORE anything was applied — the additive step did not run either');
  await assert.rejects(() => transaction(c => applyMigrations(c, chain, { mode: 'boot', allowContract: [2] })), /MIGRATION_CONTRACT_IN_BOOT/);
  const r = await transaction(c => applyMigrations(c, chain, { allowContract: [2] }));
  assert.deepEqual(r.applied.map(a => [a.version, a.class]), [[1, 'additive'], [2, 'contract']]);
  assert.equal((await pool.query("SELECT to_regclass('r03d_old') IS NULL AS gone")).rows[0].gone, true);
  assert.deepEqual((await pool.query('SELECT version, migration_class FROM schema_migrations ORDER BY version')).rows.map((x: any) => [x.version, x.migration_class]), [[1, 'additive'], [2, 'contract']], 'recorded as what it was');
});

test('R03d a ledger written the OLD way (version only, every file recorded) is accepted by the real runner: nothing applied, everything reported unverified — the f8.3-migration-011-upgrade scenario', async () => {
  const { pool } = await memoryDb();
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
  const files = readMigrationFiles('infra');
  await pool.query('CREATE TABLE schema_migrations(version int PRIMARY KEY, applied_at timestamptz DEFAULT now())');
  for (const f of files) {
    await pool.query(f.sql);
    await pool.query('INSERT INTO schema_migrations(version) VALUES($1)', [f.version]);
  }
  const { migrate } = await import('../scripts/migrate');
  const r = await migrate();
  assert.deepEqual(r.applied, []);
  assert.deepEqual(r.unverifiedInLedger, files.map(f => f.version), 'every row is unverified — including the post-025 ones the old runner wrote');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM schema_migrations WHERE checksum IS NOT NULL')).rows[0].n, 0, 'and none was given a checksum it never earned');
});

test('R03d the real chain on a fresh database: all files applied with checksums, legacy range recorded as legacy, a second run is a no-op, boot mode agrees', async () => {
  const { transaction, pool } = await memoryDb();
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
  const { migrate } = await import('../scripts/migrate');
  const first = await migrate();
  const files = readMigrationFiles('infra');
  assert.equal(first.applied.length, files.length);
  const rows = (await pool.query('SELECT version, checksum, migration_class FROM schema_migrations ORDER BY version')).rows;
  assert.equal(rows.length, files.length);
  assert.deepEqual(rows.map((r: any) => r.checksum), files.map(f => f.checksum), 'a fresh database verifies EVERY file, legacy included');
  assert.deepEqual(rows.slice(0, 25).map((r: any) => r.migration_class), Array(25).fill('legacy'));
  assert.deepEqual((await migrate()).applied, []);
  assert.deepEqual((await migrate({ mode: 'boot' })).applied, [], 'boot mode on a fully migrated database does nothing');
  void transaction;
});
