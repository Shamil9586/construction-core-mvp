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

// ----------------------------------------------------------------------------------------------------------------------------------
// R03d / B1 — the additive scan must not mistake the stored body of CREATE FUNCTION for an effect of applying the migration, and must not
// hide anything else. Only comments and the dollar-quoted body of a top-level CREATE [OR REPLACE] FUNCTION … AS are ever removed.
// ----------------------------------------------------------------------------------------------------------------------------------
const FN = (name: string, body: string, tag = '$$') => `CREATE OR REPLACE FUNCTION ${name}() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS ${tag}\nBEGIN\n${body}\nEND;\n${tag};`;
const FN_TAIL = (name: string, body: string, tag = '$$') => `CREATE FUNCTION ${name}() RETURNS void AS ${tag}\nBEGIN\n${body}\nEND;\n${tag} LANGUAGE plpgsql;`;
const DML = 'DELETE FROM t WHERE x = 1;\nUPDATE t SET a = 2 WHERE b = 3;\nINSERT INTO t(a) VALUES (1);';

test('R03d/B1 DML inside the body of a CREATE FUNCTION is not a migration effect; the same file stays additive', () => {
  for (const sql of [
    FN('f', DML), FN_TAIL('f', DML), FN('f', DML, '$body$'), FN('f', DML, '$_$'), FN('f', DML, '$ß$'),
    FN('f', 'TRUNCATE t; DROP TABLE u; ALTER TABLE t DROP COLUMN c; ALTER TABLE t RENAME TO v;'),
    // two functions, one of them replaced, and a trigger that merely names the function
    FN('f', DML) + '\n' + FN_TAIL('g', DML, '$g$') + '\nCREATE TRIGGER trg BEFORE UPDATE OR DELETE ON t FOR EACH ROW EXECUTE FUNCTION f();',
    // a different dollar tag inside the body does not end it; neither does '$$' inside a string of a named-tag body
    FN('f', "EXECUTE $q$ DELETE FROM t $q$; SELECT '$$ not the end';", '$body$'),
    // nested block comment and quotes inside the body
    FN('f', "/* /* nested */ DELETE FROM t */ DELETE FROM t; SELECT 'it''s; DELETE FROM t'; SELECT E'\\'; UPDATE t SET a=1';"),
    // statements around it that are additive
    'CREATE TABLE t(a int);\nCREATE INDEX i ON t(a);\n' + FN('f', DML) + '\nREVOKE ALL ON FUNCTION f() FROM PUBLIC;'
  ])
    assert.deepEqual(destructiveStatements(sql), [], sql);
});

test('R03d/B1 a FIN-SDO-1-shaped file (SECURITY DEFINER functions whose bodies delete and update their own tables) is additive; nothing else in it is hidden', () => {
  const fin = `-- migration-class: additive\nCREATE TABLE fin_buf(id int primary key, v int);\n` +
    FN('fin_sdo_update_edit_buffer', 'DELETE FROM fin_buf WHERE id = 1;\nUPDATE fin_buf SET v = v + 1;') + '\n' +
    FN('fin_sdo_commit_edit_buffer', 'UPDATE fin_buf SET v = 0;') + '\nREVOKE ALL ON FUNCTION fin_sdo_commit_edit_buffer() FROM PUBLIC;\n';
  assert.deepEqual(destructiveStatements(fin), []);
  // a top-level DELETE next to armed functions is found twice over: as itself, and as a statement that could run the hidden DML (RV-02)
  for (const bad of [fin + 'DELETE FROM fin_buf;', 'DELETE FROM fin_buf;\n' + fin]) {
    assert.ok(destructiveStatements(bad).includes('DELETE FROM'), 'a top-level DELETE next to the functions is still found');
    assert.ok(destructiveStatements(bad).some(n => n.startsWith('HIDDEN FUNCTION DML COULD RUN')), 'and the file is no longer definitions-only');
  }
});

test('R03d/B1 fail closed: destructive statements are found before, after and between functions, and in everything that is not a function body', () => {
  const danger: [string, string][] = [
    ['DROP TABLE t;', 'DROP'], ['DELETE FROM t;', 'DELETE FROM'], ['UPDATE t SET a = 1;', 'UPDATE … SET (data rewrite)'], ['TRUNCATE t;', 'TRUNCATE'],
    ['ALTER TABLE t DROP COLUMN c;', 'DROP'], ['ALTER TABLE t ALTER COLUMN c DROP DEFAULT;', 'ALTER TABLE … DROP'], ['ALTER TABLE t RENAME TO u;', 'RENAME'],
    ['ALTER TABLE t ALTER COLUMN c TYPE bigint;', 'ALTER COLUMN … TYPE'], ['ALTER TABLE t ALTER COLUMN c SET NOT NULL;', 'ALTER COLUMN … SET NOT NULL']
  ];
  for (const [bad, label] of danger) {
    const harmless = FN('f', DML);
    for (const sql of [
      bad, harmless + '\n' + bad, bad + '\n' + harmless, harmless + '\n' + bad + '\n' + FN_TAIL('g', DML, '$g$'),
      // DO blocks run at migration time: never exempt, alone or right after / before a function
      `DO $$ BEGIN ${bad} END $$;`, harmless + `\nDO $$ BEGIN ${bad} END $$;`, `DO $do$ BEGIN ${bad} END $do$;\n` + harmless,
      // the dollar string is not the body of a CREATE FUNCTION: after the AS-clause, after a comma, in a procedure, in a statement that only mentions FUNCTION
      `CREATE FUNCTION f() RETURNS int AS $a$ SELECT 1 $a$ LANGUAGE sql, $b$ ${bad} $b$;`,
      `CREATE PROCEDURE p() LANGUAGE sql AS $$ ${bad} $$;`,
      `CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $a$ SELECT 1 $a$ AS $b$ ${bad} $b$;`,
      `COMMENT ON FUNCTION f() IS $c$ ${bad} $c$;`, `SELECT $x$ ${bad} $x$;`,
      // a single-quoted (old-style) body is not exempt
      `CREATE FUNCTION f() RETURNS void AS 'BEGIN ${bad.replace(/'/g, "''")} END;' LANGUAGE plpgsql;`,
      // clauses after the body are still scanned
      FN_TAIL('f', DML).replace('LANGUAGE plpgsql;', `LANGUAGE plpgsql; ${bad}`),
      // CREATE FUNCTION that is not at the start of its statement does not qualify
      `EXPLAIN CREATE FUNCTION f() RETURNS void AS $$ ${bad} $$ LANGUAGE sql;`, `SELECT 1 CREATE FUNCTION f() RETURNS void AS $$ ${bad} $$ LANGUAGE sql;`,
      // SQL-standard unquoted bodies run statement by statement in the file
      `CREATE FUNCTION f() RETURNS void LANGUAGE sql BEGIN ATOMIC ${bad} END;`
    ])
      assert.ok(destructiveStatements(sql).includes(label), `${label} must be found in: ${sql} (got ${JSON.stringify(destructiveStatements(sql))})`);
  }
});

test('R03d/B1 only the first AS-body of a function statement is exempt, and only when closed', () => {
  // a dollar string inside a function statement that does NOT follow the AS keyword is not the body (default value, SET clause, comment text)
  for (const sql of ['CREATE FUNCTION f(a text DEFAULT $d$ DELETE FROM t $d$) RETURNS void AS $$ x $$ LANGUAGE sql;',
    'CREATE FUNCTION f() RETURNS void LANGUAGE sql SET search_path = $s$ DELETE FROM t $s$ AS $$ x $$;',
    'CREATE FUNCTION f() RETURNS text LANGUAGE sql RETURN $r$ DELETE FROM t $r$;'])
    assert.deepEqual(destructiveStatements(sql), ['DELETE FROM'], sql);
  // DO is never a function head: even a dollar string directly after DO ... AS-like text is scanned
  for (const sql of ['DO $$ DELETE FROM t $$;', 'DO LANGUAGE plpgsql $$ DELETE FROM t $$;', 'DO AS $$ DELETE FROM t $$;'])
    assert.deepEqual(destructiveStatements(sql), ['DELETE FROM'], sql);
  assert.deepEqual(destructiveStatements('CREATE FUNCTION f() RETURNS void AS $a$ DELETE FROM t $a$ LANGUAGE sql;'), []);
  assert.deepEqual(destructiveStatements('CREATE FUNCTION f() RETURNS void AS $a$ x $a$ AS $b$ DELETE FROM t $b$;'), ['DELETE FROM'], 'a second AS-clause is not a second exemption');
  assert.ok(destructiveStatements('CREATE FUNCTION f() RETURNS void AS $a$ DELETE FROM t').includes('UNTERMINATED DOLLAR QUOTE'));
  assert.ok(destructiveStatements('CREATE FUNCTION f() RETURNS void AS $a$ DELETE FROM t').includes('DELETE FROM'), 'an unterminated body is scanned, not exempted');
});

test('R03d/B1 comments, strings, quoted identifiers and dollar quotes cannot be used to hide a statement', () => {
  const hides: [string, string][] = [
    ["SELECT '--'; DROP TABLE t;", 'DROP'],                          // '--' inside a string is not a comment
    ["SELECT '/*'; DELETE FROM t; SELECT '*/';", 'DELETE FROM'],      // nor is '/*'
    ['SELECT "--"; DROP TABLE t;', 'DROP'], ['SELECT "a;b"; TRUNCATE t;', 'TRUNCATE'],
    ['-- x\rDROP TABLE t;', 'DROP'], ['-- x\r\nDROP TABLE t;', 'DROP'],  // CR ends a line comment in PostgreSQL
    ['/* a */ /* b */ DROP TABLE t;', 'DROP'], ['/* /* nested */ still comment */ DELETE FROM t;', 'DELETE FROM'],
    ["SELECT E'\\''; DROP TABLE t; SELECT E'x';", 'DROP'],            // E'' escape does not leave the string open
    ["SELECT '$$'; DELETE FROM t; SELECT '$$';", 'DELETE FROM'],       // '$$' in a string does not start a dollar quote
    ['SELECT $a$ $$ $a$; TRUNCATE t;', 'TRUNCATE'], ['SELECT $$ $a$ $$; TRUNCATE t;', 'TRUNCATE'],
    ['-- CREATE FUNCTION f() RETURNS void AS $$\nDELETE FROM t;\n-- $$ LANGUAGE sql;', 'DELETE FROM'],   // a function header in a comment opens nothing
    ["CREATE FUNCTION f() RETURNS void AS $$ x $$ LANGUAGE sql; -- ok\nDELETE FROM t;", 'DELETE FROM'],
    ["ALTER TABLE t ADD COLUMN c text DEFAULT 'a;b', DROP COLUMN x;", 'DROP'],  // ';' in a string does not end the statement
    ["ALTER TABLE t ADD COLUMN c text DEFAULT $$a;b$$, ALTER COLUMN y DROP DEFAULT;", 'ALTER TABLE … DROP']
  ];
  for (const [sql, label] of hides)
    assert.ok(destructiveStatements(sql).includes(label), `${label} must be found in: ${JSON.stringify(sql)} (got ${JSON.stringify(destructiveStatements(sql))})`);
  // and what is genuinely a comment is still not a statement
  for (const ok of ['-- DELETE FROM t;\nSELECT 1;', '/* DROP TABLE t; /* nested */ TRUNCATE t; */ SELECT 1;', '-- x\r-- DROP TABLE t\rSELECT 1;', 'SELECT 1; /* UPDATE t SET a=1 */'])
    assert.deepEqual(destructiveStatements(ok), [], ok);
});

test('R03d/B1 SQL the scanner cannot delimit with certainty is reported, so an additive file containing it is refused', () => {
  const cases: [string, string][] = [
    ['SELECT 1; /* DROP TABLE t;', 'UNTERMINATED COMMENT'], ["SELECT 'x; DROP TABLE t;", 'UNTERMINATED QUOTE'], ['SELECT "x; DROP TABLE t;', 'UNTERMINATED QUOTE'],
    ['DO $$ BEGIN DELETE FROM t; END', 'UNTERMINATED DOLLAR QUOTE'], ['SELECT $a$ x $b$;', 'UNTERMINATED DOLLAR QUOTE'],
    ['SELECT a$b$ x $b$;', 'AMBIGUOUS DOLLAR QUOTE'], ['SELECT 1$$ x -- $$; DROP TABLE t;', 'AMBIGUOUS DOLLAR QUOTE'],
    ["SET standard_conforming_strings = off; SELECT 'a\\'; DROP TABLE t; --';", 'STRING-SYNTAX SETTING (standard_conforming_strings)'],
    ["SELECT set_config('standard_conforming_strings', 'off', true);", 'STRING-SYNTAX SETTING (standard_conforming_strings)']
  ];
  for (const [sql, label] of cases)
    assert.ok(destructiveStatements(sql).includes(label), `${label} for ${JSON.stringify(sql)} (got ${JSON.stringify(destructiveStatements(sql))})`);
  // parameter placeholders and identifiers that merely contain '$' are fine
  assert.deepEqual(destructiveStatements('CREATE TABLE t$1(a int); SELECT $1, $2;'), []);
});

test('R03d/B1 class semantics through readMigrationFiles: additive with a function body passes; additive with a DO / top-level DML is refused; contract is unchanged', () => {
  const real = fs.readdirSync('infra').filter(f => /^\d+_.*\.sql$/.test(f) && Number(f.split('_')[0]) <= 25);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpr2-mig-b1-'));
  try {
    for (const f of real) fs.copyFileSync(path.join('infra', f), path.join(dir, f));
    const m = readLegacyManifest('infra');
    const put = (sql: string) => fs.writeFileSync(path.join(dir, '026_n.sql'), sql);
    const additive = (body: string) => '-- migration-class: additive\nCREATE TABLE n(a int);\n' + body;
    put(additive(FN('n_fn', 'DELETE FROM n; UPDATE n SET a = 1;')));
    assert.equal(code(() => readMigrationFiles(dir, m)), 'NO ERROR');
    assert.equal(readMigrationFiles(dir, m)[25].class, 'additive');
    for (const bad of [FN('n_fn', DML) + '\nDELETE FROM n;', 'DELETE FROM n;\n' + FN('n_fn', DML), FN('n_fn', DML) + '\nDO $$ BEGIN DELETE FROM n; END $$;',
      'DO $$ BEGIN UPDATE n SET a = 1; END $$;\n' + FN('n_fn', DML), FN('n_fn', DML) + '\nDROP TABLE n;', FN('n_fn', DML) + '\nALTER TABLE n DROP COLUMN a;',
      FN('n_fn', DML).replace('$$;', '$$; /* unterminated')]) {
      put(additive(bad));
      assert.equal(code(() => readMigrationFiles(dir, m)), 'MIGRATION_NOT_ADDITIVE', bad);
    }
    // contract: never scanned, still gated at run time exactly as before
    put('-- migration-class: contract\n' + FN('n_fn', DML) + '\nDROP TABLE n;');
    assert.equal(code(() => readMigrationFiles(dir, m)), 'NO ERROR');
    assert.equal(readMigrationFiles(dir, m)[25].class, 'contract');
    assert.equal(code(() => planMigrations(readMigrationFiles(dir, m), [])), 'MIGRATION_CONTRACT_NOT_ALLOWED');
    // checksum / change-after-apply protection is independent of the scan
    put(additive(FN('n_fn', DML)));
    const files = readMigrationFiles(dir, m);
    assert.equal(code(() => planMigrations(files, [{ version: 26, checksum: 'f'.repeat(64) }])), 'MIGRATION_CHANGED_AFTER_APPLY');
  }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('R03d/B1 applying a migration that defines a DML function runs none of that DML: the data is untouched, the function exists', async () => {
  const { transaction, pool } = await memoryDb();
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await pool.query('CREATE TABLE b1_rows(id int primary key, v int); INSERT INTO b1_rows VALUES (1, 10), (2, 20);');
  const fn = `CREATE OR REPLACE FUNCTION b1_wipe() RETURNS void LANGUAGE plpgsql AS $$ BEGIN DELETE FROM b1_rows; UPDATE b1_rows SET v = 0; END; $$;`;
  const chain = [file(1, 'additive', fn)];
  assert.deepEqual(destructiveStatements(fn), []);
  const r = await transaction(c => applyMigrations(c, chain));
  assert.deepEqual(r.applied.map(a => a.version), [1]);
  assert.deepEqual((await pool.query('SELECT id, v FROM b1_rows ORDER BY id')).rows, [{ id: 1, v: 10 }, { id: 2, v: 20 }], 'the migration did not execute the body');
  assert.equal((await pool.query("SELECT to_regproc('b1_wipe') IS NOT NULL AS x")).rows[0].x, true);
});

// ----------------------------------------------------------------------------------------------------------------------------------
// R03d / B1 correction cycle 1
//   RV-01  a dollar-quote tag has no length limit (no 130-character window)
//   RV-02  a function body hidden from the scan must not be runnable by the SAME migration (call, DO, CTAS, trigger + INSERT, …)
//   RV-04  no literal U+FFFF in the source
// Ground truth for "does it run" is a real PostgreSQL (PGlite), not this file's opinion.
// ----------------------------------------------------------------------------------------------------------------------------------
const VIOLATION = /^HIDDEN FUNCTION DML COULD RUN/;
const hasViolation = (sql: string) => destructiveStatements(sql).some(n => VIOLATION.test(n));
/** The call / name / statement-kind model on its own, without the ordering rule — so a test cannot pass merely because the order was wrong. */
const model = (sql: string) => destructiveStatements(sql, { phaseRule: false });
const modelViolation = (sql: string) => model(sql).some(n => VIOLATION.test(n));
const TAG_LENGTHS = [1, 63, 64, 127, 128, 129, 130, 131, 200, 1000, 5000];

test('R03d/B1 RV-01 dollar tags of any length (128, 129, 200, 5000 …) delimit exactly like short ones — nothing after the literal is hidden', () => {
  for (const len of TAG_LENGTHS) for (const ch of ['a', 'ß']) {
    const t = '$' + ch.repeat(len) + '$';
    const label = `tag length ${len} (${ch})`;
    // the reviewer's pattern: a comment marker INSIDE the literal must not swallow the statement after it
    assert.ok(destructiveStatements(`SELECT ${t} x -- ${t}; DROP TABLE t;`).includes('DROP'), label + ': -- inside the literal');
    assert.ok(destructiveStatements(`SELECT ${t} x /* ${t}; DELETE FROM t; /* y */`).includes('DELETE FROM'), label + ': /* inside the literal');
    assert.ok(destructiveStatements(`SELECT ${t} ' ${t}; TRUNCATE t;`).includes('TRUNCATE'), label + ': quote inside the literal');
    assert.ok(destructiveStatements(`SELECT ${t} x ${t}\n-- c\n; UPDATE t SET a = 1;`).includes('UPDATE … SET (data rewrite)'), label + ': after the literal and a comment');
    assert.ok(destructiveStatements(`DO ${t} BEGIN DELETE FROM t; END ${t};`).includes('DELETE FROM'), label + ': DO block');
    // a long tag does not stop a function body from being a body (definitions only: accepted), nor from hiding anything after it
    const fn = `CREATE FUNCTION f() RETURNS void AS ${t} BEGIN DELETE FROM t; END ${t} LANGUAGE plpgsql;`;
    assert.deepEqual(destructiveStatements(fn), [], label + ': function body');
    assert.ok(destructiveStatements(fn + '\nDROP TABLE u;').includes('DROP'), label + ': DROP after a function');
    assert.ok(destructiveStatements(fn.replace(/\$ LANGUAGE/, '$ -- ') + '\nDROP TABLE u;').includes('DROP'), label + ': comment after the body');
    // not closed / closed by a different tag: reported and scanned, never exempted
    const open = destructiveStatements(`SELECT ${t} DELETE FROM t`);
    assert.ok(open.includes('UNTERMINATED DOLLAR QUOTE') && open.includes('DELETE FROM'), label + ': unterminated');
    const other = destructiveStatements(`SELECT ${t} x $${ch.repeat(len + 1)}$; DELETE FROM t;`);
    assert.ok(other.includes('UNTERMINATED DOLLAR QUOTE') && other.includes('DELETE FROM'), label + ': closed by a longer tag');
    const unclosedBody = destructiveStatements(`CREATE FUNCTION f() RETURNS void AS ${t} DELETE FROM t`);
    assert.ok(unclosedBody.includes('DELETE FROM') && unclosedBody.includes('UNTERMINATED DOLLAR QUOTE'), label + ': unterminated function body');
  }
  // the verdict must not depend on the tag length at all
  const verdict = (len: number) => JSON.stringify(destructiveStatements(`SELECT $${'a'.repeat(len)}$ -- $${'a'.repeat(len)}$; DROP TABLE t; CREATE FUNCTION f() RETURNS void AS $${'a'.repeat(len)}$ DELETE FROM t $${'a'.repeat(len)}$ LANGUAGE sql;`));
  for (const len of TAG_LENGTHS) assert.equal(verdict(len), verdict(1), 'length ' + len);
});

test('R03d/B1 RV-01 malformed or look-alike delimiters are never exempted and never hide what follows', () => {
  const flagged: [string, string][] = [
    ['SELECT $1$ DELETE FROM t $1$;', 'DELETE FROM'],              // a tag cannot start with a digit: $1 is a parameter
    ['SELECT $a b$ DELETE FROM t $a b$;', 'DELETE FROM'],          // a space ends the would-be tag
    ['SELECT $a-b$ DELETE FROM t $a-b$;', 'DELETE FROM'],
    ['SELECT $a DELETE FROM t;', 'DELETE FROM'],                   // no second $
    ['SELECT $ DELETE FROM t;', 'DELETE FROM'],
    ['SELECT $$ x $a$; DELETE FROM t;', 'UNTERMINATED DOLLAR QUOTE'],
    ['SELECT $a$ x $A$; DELETE FROM t;', 'UNTERMINATED DOLLAR QUOTE'],   // tags are case sensitive
    ['SELECT x$tag$ y $tag$; DELETE FROM t;', 'AMBIGUOUS DOLLAR QUOTE'],
    ['SELECT 1$tag$ y $tag$; DELETE FROM t;', 'AMBIGUOUS DOLLAR QUOTE']
  ];
  for (const [sql, label] of flagged)
    assert.ok(destructiveStatements(sql).includes(label), `${label} in ${JSON.stringify(sql)} (got ${JSON.stringify(destructiveStatements(sql))})`);
  // the scan stays linear: no pathological input makes it quadratic
  for (const sql of ['$a'.repeat(200000), '$' + 'a'.repeat(300000), '$a$ '.repeat(100000), "'".repeat(100000), '/*'.repeat(100000)]) {
    const t0 = Date.now();
    destructiveStatements(sql);
    assert.ok(Date.now() - t0 < 3000, 'linear time for ' + sql.slice(0, 8));
  }
});

test('R03d/B1 RV-04 the source carries no literal U+FFFF; the escape is the same code-unit range', () => {
  const src = fs.readFileSync('scripts/migration-runner.ts', 'utf8');
  assert.equal(src.includes('\uffff'), false, 'no literal noncharacter in the source');
  assert.equal([...src].every(c => c.charCodeAt(0) < 0x2100 || c.charCodeAt(0) === 0x2192), true, 'no stray invisible / noncharacter code points');
  assert.ok(src.includes('\\u0080-\\uffff'), 'the escape form is present');
  assert.ok(/[\u0080-\uffff]/.test('\uffff') && /[\u0080-\uffff]/.test('ß') && !/[\u0080-\uffff]/.test('\u007f'), 'range semantics');
});

// ---- ground truth: a real PostgreSQL decides whether a migration runs the hidden DML --------------------------------------------
class Rolled { constructor(readonly result: 'changed' | 'unchanged' | 'error') {} }
async function oracle() {
  const { transaction, pool } = await memoryDb();
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await pool.query('CREATE TABLE t(a int); INSERT INTO t VALUES (1),(2); CREATE TABLE u(a int); INSERT INTO u VALUES (7);');
  const observe = async (c: any) => {
    const t = (await c.query("SELECT to_regclass('t') IS NOT NULL AS ok")).rows[0].ok ? (await c.query("SELECT coalesce(string_agg(a::text, ',' ORDER BY a), '') AS v FROM t")).rows[0].v : 'DROPPED';
    const u = (await c.query("SELECT to_regclass('u') IS NOT NULL AS ok")).rows[0].ok ? (await c.query("SELECT coalesce(string_agg(a::text, ',' ORDER BY a), '') AS v FROM u")).rows[0].v : 'DROPPED';
    return t + '|' + u;
  };
  /** Apply `sql` the way the runner does (one multi-statement query inside a transaction), report whether the data changed, always roll back. */
  return async (sql: string): Promise<'changed' | 'unchanged' | 'error'> => {
    try {
      await transaction(async (c: any) => {
        const before = await observe(c);
        try { await c.query(sql); } catch { throw new Rolled('error'); }
        throw new Rolled((await observe(c)) === before ? 'unchanged' : 'changed');
      });
    }
    catch (e: any) { if (e instanceof Rolled) return e.result; throw e; }
    throw new Error('unreachable');
  };
}
const WIPE_FN = (name: string, ret = 'void', body = 'DELETE FROM t;', extra = '') => `CREATE FUNCTION ${name}() RETURNS ${ret} LANGUAGE plpgsql AS $f$ BEGIN ${body} ${ret === 'void' || ret === 'event_trigger' ? '' : ret === 'trigger' ? 'RETURN NULL;' : ret === 'boolean' ? 'RETURN true;' : 'RETURN 1;'} END; $f$;${extra}`;

test('R03d/B1 RV-02 every way a migration can RUN a hidden function body is refused — and the real database confirms each one really runs it', async () => {
  const run = await oracle();
  const ARMED = WIPE_FN('wipe');
  const paths: Record<string, string> = {
    'direct call': ARMED + ' SELECT wipe();',
    'DO block': ARMED + ' DO $$ BEGIN PERFORM wipe(); END $$;',
    'CREATE TABLE AS': ARMED + ' CREATE TABLE z AS SELECT wipe()::text AS w;',
    'SELECT INTO': ARMED + ' SELECT wipe()::text INTO TEMP z2;',
    'trigger + INSERT': WIPE_FN('tw', 'trigger') + ' CREATE TRIGGER trg AFTER INSERT ON u FOR EACH ROW EXECUTE FUNCTION tw(); INSERT INTO u VALUES (8);',
    'INSERT … SELECT': ARMED + ' INSERT INTO u SELECT 1 FROM (SELECT wipe()::text) s;',
    'WITH': ARMED + ' WITH x AS (SELECT wipe()::text AS w) SELECT w FROM x;',
    'materialized view (PostgreSQL 17 runs it with a safe search_path, hence public.t)': WIPE_FN('wipe_q', 'void', 'DELETE FROM public.t;') + ' CREATE MATERIALIZED VIEW mv AS SELECT wipe_q()::text AS w;',
    'prepared statement': ARMED + ' PREPARE p AS SELECT wipe(); EXECUTE p;',
    'VOLATILE DEFAULT on an existing table': WIPE_FN('wipe_int', 'int') + ' ALTER TABLE u ADD COLUMN c int DEFAULT wipe_int();',
    'CHECK validated on an existing table': WIPE_FN('wipe_bool', 'boolean') + ' ALTER TABLE u ADD CONSTRAINT ck CHECK (wipe_bool());',
    'event trigger + later DDL': WIPE_FN('ew', 'event_trigger') + ' CREATE EVENT TRIGGER et ON ddl_command_end EXECUTE FUNCTION ew(); CREATE TABLE zz(a int);',
    'indirect: an innocent-looking function calls the armed one': ARMED + ' CREATE FUNCTION g() RETURNS void LANGUAGE plpgsql AS $g$ BEGIN PERFORM wipe(); END; $g$; SELECT g();',
    'procedure + CALL': ARMED + ' CREATE PROCEDURE p() LANGUAGE plpgsql AS $p$ BEGIN PERFORM wipe(); END; $p$; CALL p();',
    'trigger fired by an UPDATE': WIPE_FN('tw', 'trigger') + ' CREATE TRIGGER trg AFTER UPDATE ON u FOR EACH ROW EXECUTE FUNCTION tw(); UPDATE u SET a = a;'
  };
  for (const [name, sql] of Object.entries(paths)) {
    assert.equal(await run(sql), 'changed', name + ': the oracle must show the data really changing, or this case proves nothing');
    assert.ok(destructiveStatements(sql).length > 0, name + ': must be refused as additive (got ' + JSON.stringify(destructiveStatements(sql)) + ')');
  }
});

test('R03d/B1 RV-02 what stays accepted: definitions only — and the real database confirms none of it touches data', async () => {
  const run = await oracle();
  const accepted: Record<string, string> = {
    'tables + indexes + armed functions + constraint triggers + grants (FIN-shaped order)':
      `CREATE TABLE fin_a(id int PRIMARY KEY, tenant int NOT NULL, kind text, amt numeric DEFAULT 0, CONSTRAINT chk CHECK (amt >= 0));
       CREATE TABLE fin_b(id int PRIMARY KEY, a_id int REFERENCES fin_a(id), ts timestamptz DEFAULT now());
       CREATE UNIQUE INDEX fin_a_one ON fin_a(tenant) WHERE kind = 'X';
       CREATE INDEX ON fin_b(a_id);
       ALTER TABLE fin_a ADD CONSTRAINT fin_a_amt CHECK (amt < 1000000);
       ALTER TABLE fin_b ADD COLUMN note text DEFAULT 'n';` + WIPE_FN('wipe') + WIPE_FN('tw', 'trigger') + `
       CREATE TRIGGER fin_t AFTER INSERT ON fin_a FOR EACH ROW EXECUTE FUNCTION tw();
       CREATE CONSTRAINT TRIGGER fin_c AFTER INSERT ON fin_b DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tw();
       COMMENT ON FUNCTION wipe() IS 'x'; REVOKE ALL ON FUNCTION wipe() FROM PUBLIC; GRANT SELECT ON fin_a TO PUBLIC;`,
    'quoted / mixed-case names are matched exactly': 'CREATE TABLE "Fin_X"(a int); CREATE INDEX ON "Fin_X"(a); ALTER TABLE "Fin_X" ADD COLUMN b int;' + WIPE_FN('wipe'),
    'schema-qualified consistently': 'CREATE TABLE public.fin_q(a int); CREATE INDEX ON public.fin_q(a);' + WIPE_FN('wipe')
  };
  for (const [name, sql] of Object.entries(accepted)) {
    assert.deepEqual(destructiveStatements(sql), [], name);
    assert.equal(await run(sql), 'unchanged', name + ': and the data is untouched');
  }
  // a function whose body has nothing to flag behaves exactly as before: it may be called in the same file (the old scanner read that body too)
  const innocent = `CREATE FUNCTION ins() RETURNS void LANGUAGE plpgsql AS $f$ BEGIN INSERT INTO u VALUES (9); END; $f$; SELECT ins();`;
  assert.deepEqual(destructiveStatements(innocent), []);
});

test('R03d/B1 RV-02 near-misses are refused: a table the file did not create, a different spelling, IF NOT EXISTS, AS, CONCURRENTLY, ATTACH, ordering', () => {
  const ARMED = WIPE_FN('wipe');
  const refused: Record<string, string> = {
    'index on an existing table': ARMED + ' CREATE INDEX ix ON u(a);',
    'ALTER an existing table': ARMED + ' ALTER TABLE u ADD COLUMN c int DEFAULT 1;',
    'qualified vs unqualified': ARMED + ' CREATE TABLE s.fin_a(a int); CREATE INDEX ON fin_a(a);',
    'unqualified vs qualified': ARMED + ' CREATE TABLE fin_a(a int); CREATE INDEX ON s.fin_a(a);',
    'different quoting case': ARMED + ' CREATE TABLE "Fin_a"(a int); CREATE INDEX ON fin_a(a);',
    'IF NOT EXISTS (may be a table with rows)': ARMED + ' CREATE TABLE IF NOT EXISTS fin_a(a int); CREATE INDEX ON fin_a(a);',
    'CREATE TABLE … AS': ARMED + ' CREATE TABLE fin_a(a) AS SELECT 1;',
    'CREATE TABLE AS without a column list': ARMED + ' CREATE TABLE fin_a AS SELECT 1;',
    'index before the table exists': ARMED + ' CREATE INDEX ON fin_a(a); CREATE TABLE fin_a(a int);',
    'CONCURRENTLY': ARMED + ' CREATE TABLE fin_a(a int); CREATE INDEX CONCURRENTLY ON fin_a(a);',
    'ATTACH PARTITION': ARMED + ' CREATE TABLE fin_a(a int) PARTITION BY LIST (a); ALTER TABLE fin_a ATTACH PARTITION u FOR VALUES IN (7);',
    'INHERIT': ARMED + ' CREATE TABLE fin_a(a int); ALTER TABLE fin_a INHERIT u;',
    'a string that looks like a closing paren': ARMED + " CREATE TABLE fin_a(a text DEFAULT ')') AS SELECT 1;",
    'SET search_path': ARMED + ' SET search_path = x;',
    'BEGIN / COMMIT': ARMED + ' BEGIN; COMMIT;',
    'CREATE EVENT TRIGGER': ARMED + ' CREATE EVENT TRIGGER et ON ddl_command_end EXECUTE FUNCTION ew();',
    'CREATE VIEW': ARMED + ' CREATE VIEW v AS SELECT 1;',
    'CREATE PROCEDURE': ARMED + " CREATE PROCEDURE p() LANGUAGE sql AS 'select 1';"
  };
  for (const [name, sql] of Object.entries(refused))
    assert.ok(modelViolation(sql), name + ' (got ' + JSON.stringify(destructiveStatements(sql)) + ')');
  // the same statements next to an UNARMED function, or no function, are untouched by this rule
  assert.deepEqual(destructiveStatements(`CREATE FUNCTION f() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$; CREATE INDEX ix ON u(a); SELECT f();`), []);
});

// ---- differential: a randomised corpus judged by the real database, and compared with the previous scanner -------------------------
/** The scanner as it was before B1 (comment strip + regexes over everything), kept here as the reference for "nothing that used to be found is lost". */
const LEGACY_DESTRUCTIVE: [RegExp, string][] = [
  [/\bDROP\s+(TABLE|COLUMN|SCHEMA|DATABASE|TYPE|VIEW|INDEX|CONSTRAINT|TRIGGER|FUNCTION|SEQUENCE|POLICY|EXTENSION)\b/i, 'DROP'], [/\bALTER\s+TABLE\b[^;]*\bDROP\b/i, 'ALTER TABLE … DROP'],
  [/\bTRUNCATE\b/i, 'TRUNCATE'], [/\bDELETE\s+FROM\b/i, 'DELETE FROM'], [/\bUPDATE\s+(ONLY\s+)?[A-Za-z_."]+\s+(AS\s+\w+\s+)?SET\b/i, 'UPDATE … SET (data rewrite)'],
  [/\bALTER\s+COLUMN\s+\S+\s+(SET\s+DATA\s+)?TYPE\b/i, 'ALTER COLUMN … TYPE'], [/\bALTER\s+COLUMN\s+\S+\s+SET\s+NOT\s+NULL\b/i, 'ALTER COLUMN … SET NOT NULL'], [/\bRENAME\b/i, 'RENAME']
];
const legacyFlags = (sql: string) => { const text = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' '); return LEGACY_DESTRUCTIVE.some(([re]) => re.test(text)); };
function prng(seed: number) { return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

test('R03d/B1 differential: 600 random migrations judged by a real PostgreSQL — whatever really changes data is flagged, and the previous scanner\'s catches are kept', async () => {
  const run = await oracle();
  const rnd = prng(20261106);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
  const tag = () => { const n = pick([0, 1, 3, 63, 127, 128, 129, 130, 200, 5000]); return n === 0 ? '$$' : '$' + pick(['a', 'ß', 'Q']).repeat(n) + '$'; };
  const dangers = ['DELETE FROM t;', 'DROP TABLE u;', 'TRUNCATE t;', 'UPDATE t SET a = a + 1;', 'ALTER TABLE u RENAME TO u2;', 'ALTER TABLE t ALTER COLUMN a TYPE bigint;'];
  const noise = (): string => {
    const t = tag();
    return pick([
      () => 'SELECT 1;', () => `SELECT '--';`, () => `SELECT '/*';`, () => `SELECT '*/';`, () => `SELECT E'\\'';`, () => `SELECT "--" FROM (SELECT 1 AS "--") q;`,
      () => `SELECT ${t} x -- ${t};`, () => `SELECT ${t} x /* ${t};`, () => `SELECT ${t} ' ${t};`, () => `SELECT ${t} ; ${t};`, () => `SELECT 1 -- c\n;`, () => `SELECT 1 /* c ; */;`,
      () => `SELECT 1 /* a /* nested */ b */;`, () => `-- ${t}\nSELECT 1;`, () => `-- c\rSELECT 1;`, () => `/* ${t} */ SELECT 1;`,
      () => `CREATE OR REPLACE FUNCTION nf${Math.floor(rnd() * 1e6)}() RETURNS int LANGUAGE sql AS ${t} SELECT 1 ${t};`,
      () => `CREATE OR REPLACE FUNCTION nd${Math.floor(rnd() * 1e6)}() RETURNS void LANGUAGE plpgsql AS ${t} BEGIN ${pick(dangers)} END; ${t};`
    ])();
  };
  let executed = 0, caughtByNew = 0, missedByLegacy = 0, lostFromLegacy = 0;
  for (let i = 0; i < 600; i++) {
    const parts = Array.from({ length: 1 + Math.floor(rnd() * 5) }, noise);
    const danger = pick(dangers);
    parts.splice(Math.floor(rnd() * (parts.length + 1)), 0, danger);
    const sql = parts.join(rnd() < 0.5 ? '\n' : ' ');
    const outcome = await run(sql);
    const flagged = destructiveStatements(sql).length > 0;
    if (outcome === 'changed') {
      executed++;
      assert.ok(flagged, 'the database changed data but the scan accepted it:\n' + sql.slice(0, 600));
      caughtByNew++;
      if (!legacyFlags(sql)) missedByLegacy++;
    }
    // monotonic against the previous scanner where the DB shows the danger is real
    if (outcome === 'changed' && legacyFlags(sql) && !flagged) lostFromLegacy++;
  }
  assert.ok(executed >= 150, 'the corpus must exercise real executions (' + executed + ')');
  assert.equal(lostFromLegacy, 0, 'nothing the previous scanner caught (and that really runs) may be lost');
  assert.equal(caughtByNew, executed);
  console.log(`# differential: executed=${executed} caughtByNew=${caughtByNew} missedByPreviousScanner=${missedByLegacy}`);
});

test('R03d/B1 RV-02 a hidden body the scanner cannot read with certainty counts as armed; string literals inside a table definition do not confuse the definitions-only check', () => {
  // a non-SQL body (here Python) with an unbalanced quote cannot be delimited reliably: treated as armed, so a later call is refused
  const py = (call: string) => `CREATE FUNCTION f() RETURNS void LANGUAGE plpython3u AS $p$\n# it's a comment\npass\n$p$; ${call}`;
  assert.deepEqual(destructiveStatements(py('')), [], 'on its own, a definition is fine');
  assert.ok(hasViolation(py('SELECT f();')), 'but the file may not also run it');
  assert.ok(destructiveStatements(py('SELECT f();')).length > 0);
  // parentheses and the word AS inside string literals / quoted identifiers of a table definition are not structure
  const armed = WIPE_FN('wipe');
  for (const ok of [
    "CREATE TABLE fin_s(a text DEFAULT '(', b text DEFAULT ')', c text DEFAULT 'x AS y');",
    `CREATE TABLE fin_s("a (" text, "b AS" text DEFAULT ')');`,
    "CREATE TABLE fin_s(a text DEFAULT $q$ ) AS SELECT 1 ( $q$); CREATE INDEX ON fin_s(a);",
    "CREATE TABLE fin_s(a text GENERATED ALWAYS AS (upper('(')) STORED);"
  ])
    assert.deepEqual(destructiveStatements(ok + armed), [], ok);
  // a real CREATE TABLE AS is still refused even when strings try to confuse the parenthesis matching
  for (const bad of ["CREATE TABLE fin_s(a) AS SELECT ')';", "CREATE TABLE fin_s(a text DEFAULT ')') AS SELECT 1;", "CREATE TABLE fin_s(a) AS SELECT '(' WHERE true;"])
    assert.ok(modelViolation(armed + bad), bad);
});

// ----------------------------------------------------------------------------------------------------------------------------------
// R03d / B1 correction cycle 2 — RV-06: PostgreSQL evaluates functions while it runs DDL (constant folding of IMMUTABLE calls, eager evaluation of
// non-volatile DEFAULTs, GENERATED columns, CHECK / index expressions), so a hidden body is reachable from any expression, empty table or not.
// ----------------------------------------------------------------------------------------------------------------------------------
const RV06_WIPE = 'CREATE FUNCTION wipe() RETURNS int LANGUAGE plpgsql AS $f$ BEGIN DELETE FROM t; RETURN 1; END $f$;';
const RV06_WRAPPERS: Record<string, string> = {
  'IMMUTABLE sql': 'CREATE FUNCTION w_imm(int) RETURNS int LANGUAGE sql IMMUTABLE AS $w$ SELECT wipe() + $1 $w$;',
  'STABLE sql': 'CREATE FUNCTION w_imm(int) RETURNS int LANGUAGE sql STABLE AS $w$ SELECT wipe() + $1 $w$;',
  'VOLATILE sql': 'CREATE FUNCTION w_imm(int) RETURNS int LANGUAGE sql VOLATILE AS $w$ SELECT wipe() + $1 $w$;',
  'IMMUTABLE plpgsql': 'CREATE FUNCTION w_imm(int) RETURNS int LANGUAGE plpgsql IMMUTABLE AS $w$ BEGIN RETURN wipe() + $1; END $w$;'
};
const RV06_SLOTS: Record<string, (e: string) => string> = {
  'CREATE TABLE … DEFAULT': e => `CREATE TABLE nt(a int DEFAULT ${e});`,
  'CREATE TABLE … CHECK': e => `CREATE TABLE nt(a int, CHECK (${e} > 0));`,
  'CREATE TABLE … GENERATED': e => `CREATE TABLE nt(a int, g int GENERATED ALWAYS AS (${e}) STORED);`,
  'CREATE TABLE … EXCLUDE': e => `CREATE TABLE nt(a int, EXCLUDE USING btree ((${e}) WITH =));`,
  'CREATE TABLE … PARTITION BY': e => `CREATE TABLE nt(a int) PARTITION BY RANGE ((${e}));`,
  'ALTER … ADD COLUMN DEFAULT': e => `CREATE TABLE nt(a int); ALTER TABLE nt ADD COLUMN c int DEFAULT ${e};`,
  'ALTER … ADD COLUMN GENERATED': e => `CREATE TABLE nt(a int); ALTER TABLE nt ADD COLUMN g int GENERATED ALWAYS AS (${e}) STORED;`,
  'ALTER … ADD CONSTRAINT CHECK': e => `CREATE TABLE nt(a int); ALTER TABLE nt ADD CONSTRAINT ck CHECK (${e} > 0);`,
  'ALTER … SET DEFAULT': e => `CREATE TABLE nt(a int); ALTER TABLE nt ALTER COLUMN a SET DEFAULT ${e};`,
  'CREATE INDEX (expression)': e => `CREATE TABLE nt(a int); CREATE INDEX ON nt ((${e}));`,
  'CREATE INDEX … WHERE': e => `CREATE TABLE nt(a int); CREATE INDEX ON nt (a) WHERE ${e} > 0;`,
  'CREATE TRIGGER … WHEN': e => `CREATE TABLE nt(a int); CREATE FUNCTION tf() RETURNS trigger LANGUAGE plpgsql AS $t$ BEGIN RETURN NEW; END $t$; CREATE TRIGGER g BEFORE INSERT ON nt FOR EACH ROW WHEN (${e} > 0) EXECUTE FUNCTION tf();`,
  'CREATE FUNCTION … parameter DEFAULT': e => `CREATE FUNCTION h(x int DEFAULT ${e}) RETURNS int LANGUAGE sql AS $h$ SELECT x $h$;`
};
const RV06_NAMES = ['w_imm', 'public.w_imm', '"w_imm"', 'W_IMM', 'public."w_imm"', '"public"."w_imm"', 'w_imm /* c */'];
const RV06_SHAPES: ((n: string) => string)[] = [n => `${n}(1)`, n => `${n}(1) + 1`, n => `coalesce(${n}(1), 0)`, n => `abs(${n}(1))`, n => `(${n}(1))`, n => `CAST(${n}(1) AS int)`,
  n => `${n}(1)::int`, n => `length(${n}(1)::text)`, n => `mod(${n}(1), 7)`, n => `${n}(length('x'))`];

test('R03d/B1 RV-06 matrix: expression slots x wrappers x spellings x shapes — whatever a real PostgreSQL really executes while applying the file is refused', async () => {
  const run = await oracle();
  const rnd = prng(20261107);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
  let executed = 0, total = 0;
  const executedBySlot: Record<string, number> = {};
  const cases: [string, string, string][] = [];
  for (const slot of Object.keys(RV06_SLOTS)) for (const w of Object.keys(RV06_WRAPPERS)) cases.push([slot, w, 'w_imm(1)']);
  for (let i = 0; i < 500; i++) cases.push([pick(Object.keys(RV06_SLOTS)), pick(Object.keys(RV06_WRAPPERS)), pick(RV06_SHAPES)(pick(RV06_NAMES))]);
  for (const [slot, w, expr] of cases) {
    const sql = RV06_WIPE + RV06_WRAPPERS[w] + RV06_SLOTS[slot](expr);
    const outcome = await run(sql);
    total++;
    if (outcome === 'changed') {
      executed++;
      executedBySlot[slot] = (executedBySlot[slot] ?? 0) + 1;
      assert.ok(model(sql).length > 0, `PostgreSQL ran the hidden DML but the call model alone accepted it (ordering rule disabled):\n  slot=${slot} wrapper=${w}\n  ${expr}\n  ${sql}`);
    }
  }
  assert.ok(Object.keys(executedBySlot).length >= 4, 'the matrix must hit several distinct DDL paths that really execute (PostgreSQL 17 via PGlite): ' + JSON.stringify(executedBySlot));
  assert.ok(executed >= 100, 'executions in the corpus: ' + executed);
  console.log(`# RV-06 matrix: cases=${total} executedByPostgreSQL=${executed} slots=${JSON.stringify(executedBySlot)}`);
});

test('R03d/B1 RV-06 the file\'s own function names cannot be used, shadowed or smuggled; user and unknown calls in expressions are refused; vetted built-ins stay usable', () => {
  const A = RV06_WIPE;
  const refused: Record<string, string> = {
    'call of an in-file wrapper in DEFAULT': A + RV06_WRAPPERS['IMMUTABLE sql'] + 'CREATE TABLE nt(a int DEFAULT w_imm(1));',
    'call of the armed function itself': A + 'CREATE TABLE nt(a int DEFAULT wipe());',
    'quoted spelling': A + RV06_WRAPPERS['IMMUTABLE sql'] + 'CREATE TABLE nt(a int DEFAULT "w_imm"(1));',
    'upper-case spelling': A + RV06_WRAPPERS['IMMUTABLE sql'] + 'CREATE TABLE nt(a int DEFAULT W_IMM(1));',
    'schema-qualified spelling': A + RV06_WRAPPERS['IMMUTABLE sql'] + 'CREATE TABLE nt(a int DEFAULT public.w_imm(1));',
    'comment between name and parenthesis': A + RV06_WRAPPERS['IMMUTABLE sql'] + 'CREATE TABLE nt(a int DEFAULT w_imm/*x*/(1));',
    'nested inside a vetted built-in': A + RV06_WRAPPERS['IMMUTABLE sql'] + 'CREATE TABLE nt(a int DEFAULT abs(w_imm(1)));',
    'attribute notation on the in-file name': A + 'CREATE TABLE nt(a int, CHECK ((nt.wipe) > 0));',
    'a pre-existing user function (not visible to the scan)': A + 'CREATE TABLE nt(a int DEFAULT some_existing_wrapper(1));',
    'a pre-existing function through a schema': A + 'CREATE TABLE nt(a int DEFAULT app.helper(1));',
    'a catalog function that runs SQL': A + "CREATE TABLE nt(a int DEFAULT (query_to_xml('select 1', true, false, ''))::text::int);",
    'a built-in redefined by the file (shadowing length(int))': A + 'CREATE FUNCTION length(int) RETURNS int LANGUAGE sql IMMUTABLE AS $l$ SELECT wipe() $l$; CREATE TABLE nt(a int, CHECK (length(1) > 0));',
    'a built-in name qualified by another schema': A + 'CREATE TABLE nt(a int DEFAULT public.now());',
    'a quoted-name call of a pre-existing user function': A + 'CREATE TABLE nt(a int DEFAULT "app_helper"(1));',
    'a quoted-name call qualified by a schema': A + 'CREATE TABLE nt(a int DEFAULT "app"."helper"(1));',
    'trigger argument that is a column-like identifier, not a literal': A + 'CREATE TABLE nt(a int); CREATE FUNCTION tf() RETURNS trigger LANGUAGE plpgsql AS $t$ BEGIN RETURN NEW; END $t$; CREATE TRIGGER g BEFORE INSERT ON nt FOR EACH ROW EXECUTE FUNCTION tf(a);',
    'trigger argument that is an expression': A + 'CREATE TABLE nt(a int); CREATE FUNCTION tf() RETURNS trigger LANGUAGE plpgsql AS $t$ BEGIN RETURN NEW; END $t$; CREATE TRIGGER g BEFORE INSERT ON nt FOR EACH ROW EXECUTE FUNCTION tf(1 + 1);',
    'a nextval default (not vetted)': A + "CREATE TABLE nt(a int DEFAULT nextval('s'));",
    'OPERATOR() spelling': A + 'CREATE TABLE nt(a int DEFAULT 1 OPERATOR(public.+) 2);',
    'type-with-modifier spelling used as a call': A + 'CREATE TABLE nt(a int DEFAULT numeric(1));',
    'function head: parameter default': A + 'CREATE FUNCTION h(x int DEFAULT wipe()) RETURNS int LANGUAGE sql AS $h$ SELECT x $h$;',
    'function head: SUPPORT clause': A + 'CREATE FUNCTION h(x int) RETURNS int LANGUAGE sql SUPPORT some_support AS $h$ SELECT x $h$;',
    'function head: SQL-standard body': A + 'CREATE FUNCTION h() RETURNS int LANGUAGE sql RETURN 1;',
    'function head: BEGIN ATOMIC': A + 'CREATE FUNCTION h() RETURNS void LANGUAGE sql BEGIN ATOMIC SELECT 1; END;',
    'trigger WHEN with a user call': A + 'CREATE TABLE nt(a int); CREATE FUNCTION tf() RETURNS trigger LANGUAGE plpgsql AS $t$ BEGIN RETURN NEW; END $t$; CREATE TRIGGER g BEFORE INSERT ON nt FOR EACH ROW WHEN (other_fn(1)) EXECUTE FUNCTION tf();',
    'trigger argument that is not a literal': A + 'CREATE TABLE nt(a int); CREATE FUNCTION tf() RETURNS trigger LANGUAGE plpgsql AS $t$ BEGIN RETURN NEW; END $t$; CREATE TRIGGER g BEFORE INSERT ON nt FOR EACH ROW EXECUTE FUNCTION tf(wipe());'
  };
  for (const [name, sql] of Object.entries(refused))
    assert.ok(model(sql).length > 0, name + ' (the call model alone must refuse it; got ' + JSON.stringify(model(sql)) + ')');
  // what stays usable in an armed file: structure, vetted pure built-ins, trigger binding, relation names, types with modifiers
  const accepted: Record<string, string> = {
    'built-ins in DEFAULT / CHECK': A + "CREATE TABLE nt(id uuid DEFAULT gen_random_uuid(), at timestamptz DEFAULT now(), name text CHECK (length(btrim(name)) > 0), amt numeric(14,2) CHECK (mod(amt, 100.00) = 0));",
    'pg_catalog-qualified built-in': A + 'CREATE TABLE nt(at timestamptz DEFAULT pg_catalog.now());',
    'special forms': A + 'CREATE TABLE nt(a int, b int, CHECK (coalesce(a, b) IS NOT NULL AND (a IN (1,2) OR greatest(a, b) > 0)));',
    'foreign key, unique, primary key and index on a fresh table': A + 'CREATE TABLE np(id int PRIMARY KEY); CREATE TABLE nt(a int, b int REFERENCES np(id), UNIQUE (a, b), FOREIGN KEY (a, b) REFERENCES np (id, id)); CREATE UNIQUE INDEX ON nt USING btree (a, b) WHERE a IS NOT NULL;',
    'trigger bound to an in-file and to a pre-existing function': A + "CREATE TABLE nt(a int); CREATE FUNCTION tf() RETURNS trigger LANGUAGE plpgsql AS $t$ BEGIN RETURN NEW; END $t$; CREATE TRIGGER g1 BEFORE INSERT ON nt FOR EACH ROW EXECUTE FUNCTION tf(); CREATE TRIGGER g2 BEFORE UPDATE OR DELETE ON nt FOR EACH ROW EXECUTE FUNCTION immutable_history('a', 1);",
    'grant / revoke / comment naming the in-file functions': A + 'REVOKE ALL ON FUNCTION wipe() FROM PUBLIC; GRANT EXECUTE ON FUNCTION wipe() TO PUBLIC; COMMENT ON FUNCTION wipe() IS \'x\';',
    'function heads with typed parameters': A + 'CREATE FUNCTION h(p_id uuid, p_amt numeric(14,2), p_n varchar(20)) RETURNS TABLE (id uuid, amt numeric(14,2)) LANGUAGE sql STABLE AS $h$ SELECT p_id, p_amt $h$;'
  };
  // the order FIN has: tables, indexes and ALTER TABLE first, the functions with hidden DML bodies after them
  const armedLast = (sql: string) => (/CREATE TABLE/.test(sql) ? sql.slice(A.length) + A : sql);
  for (const [name, sql] of Object.entries(accepted))
    assert.deepEqual(destructiveStatements(armedLast(sql)), [], name);
});

test('R03d/B1 RV-06 ordering rule (second line of defence): after the first function with a hidden DML body no table, index or ALTER TABLE may follow — before it they may', async () => {
  const run = await oracle();
  const A = RV06_WIPE;
  const tables = 'CREATE TABLE nt(a int PRIMARY KEY, b text DEFAULT now()::text CHECK (length(b) > 0)); CREATE INDEX ON nt (b); ALTER TABLE nt ADD COLUMN c int;';
  const fnAfter = 'CREATE FUNCTION tf() RETURNS trigger LANGUAGE plpgsql AS $t$ BEGIN RETURN NEW; END $t$; CREATE TRIGGER g BEFORE INSERT ON nt FOR EACH ROW EXECUTE FUNCTION tf(); COMMENT ON FUNCTION wipe() IS \'x\'; REVOKE ALL ON FUNCTION wipe() FROM PUBLIC;';
  assert.deepEqual(destructiveStatements(tables + A + fnAfter), [], 'DDL first, then the armed function, then functions / triggers / comments / grants');
  assert.equal(await run(tables + A + fnAfter), 'unchanged');
  for (const [name, late] of Object.entries({ 'CREATE TABLE': 'CREATE TABLE nt2(a int);', 'CREATE INDEX': 'CREATE INDEX ON nt (a);', 'ALTER TABLE': 'ALTER TABLE nt ADD COLUMN d int;' })) {
    const sql = 'CREATE TABLE nt(a int);' + A + late;
    assert.ok(hasViolation(sql), name + ' after the armed function is refused by default');
    assert.deepEqual(model(sql).filter(n => /after the first function/.test(n)), [], name + ': … and that refusal is the ordering rule, not the call model');
  }
  // a function WITHOUT a hidden DML body does not start the ordering rule
  assert.deepEqual(destructiveStatements('CREATE FUNCTION g() RETURNS int LANGUAGE sql AS $g$ SELECT 1 $g$; CREATE TABLE nt(a int); CREATE INDEX ON nt (a); SELECT g();'), []);
});

test('R03d/B1 RV-05 (hidden bodies only): a body using MERGE, an aliased UPDATE or dynamic SQL is armed, so a call in the same file is refused — and the real database shows those bodies really change data', async () => {
  const run = await oracle();
  const wrap = (body: string) => `CREATE FUNCTION f2() RETURNS int LANGUAGE plpgsql AS $f$ BEGIN ${body} RETURN 1; END $f$; SELECT f2();`;
  const harmful: Record<string, string> = {
    'MERGE … DELETE': 'MERGE INTO t USING u ON true WHEN MATCHED THEN DELETE;',
    'MERGE … UPDATE': 'MERGE INTO t USING u ON true WHEN MATCHED THEN UPDATE SET a = 0;',
    'UPDATE with an alias, no AS': 'UPDATE t x SET a = 0;',
    'schema-qualified UPDATE with an alias': 'UPDATE public.t x SET a = 0;',
    'dynamic SQL assembled from pieces': "EXECUTE 'DEL' || 'ETE FROM t';",
    'dynamic SQL through format()': "EXECUTE format('%s %s %s', 'DELETE', 'FROM', 't');"
  };
  for (const [name, body] of Object.entries(harmful)) {
    assert.equal(await run(wrap(body)), 'changed', name + ': the oracle must show the data really changing');
    assert.ok(hasViolation(wrap(body)), name + ': a call next to this hidden body must be refused (got ' + JSON.stringify(destructiveStatements(wrap(body))) + ')');
    assert.deepEqual(destructiveStatements(wrap(body).replace('SELECT f2();', '')), [], name + ': the definition alone is still fine');
  }
  // DROP ROUTINE / DROP PROCEDURE / DROP AGGREGATE in a body arm it too (not runnable in the oracle's fixture, but the words are code)
  // MERGE on its own (no DELETE / UPDATE keyword) is still data-modifying SQL the DESTRUCTIVE list does not know: the body is armed
  assert.ok(hasViolation(wrap('MERGE INTO t USING u ON true WHEN MATCHED THEN DO NOTHING;')), 'MERGE alone arms a body');
  for (const body of ['DROP ROUTINE g();', 'DROP PROCEDURE g();', 'DROP AGGREGATE g(int);', 'ALTER TYPE x DROP ATTRIBUTE y;', 'TRUNCATE t;', 'COPY t FROM STDIN;'])
    assert.ok(hasViolation(wrap(body)), body);
  // harmless constructs the existing chain relies on do not arm a body (so calling such a function stays as permitted as before)
  for (const body of ['PERFORM 1;', 'SELECT a FROM t FOR UPDATE;', 'SELECT a FROM t FOR NO KEY UPDATE;', 'INSERT INTO t VALUES (1) ON CONFLICT DO UPDATE SET a = 1;',
    "IF TG_OP = 'DELETE' THEN RETURN 1; END IF;", "RAISE EXCEPTION 'cannot drop or delete here';", '-- DELETE FROM t;\n/* MERGE EXECUTE */ PERFORM 1;'])
    assert.deepEqual(destructiveStatements(wrap(body)), [], body);
});
