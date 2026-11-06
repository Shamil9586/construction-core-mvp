/**
 * FIN-SDO-1 FIN1-25 native gate: numbered-migration integration. DISPOSABLE loopback *_test PostgreSQL only; never LIVE.
 *
 *   FIN1-25 (architecture v0.9): "HEAD re-checked; number allocated by the coordinator; additive/safe/checksum/gap; old migrations immutable;
 *   no startup migrations; separate DB/CI evidence."
 *
 * Phases (each prints PASS/FAIL markers and exits non-zero on any FAIL; all failures are recorded, not just the first):
 *   pre     DB migrated through the last GPR migration (FIN_SEQ_PRE_COUNT, default 39), FIN NOT yet applied:
 *             ledger is 1..N sequential; no fin_* object exists; application BOOT writes nothing (no startup migration) and the FIN routes
 *             are off by default; the non-FIN catalog fingerprint is saved to $FIN_SEQ_EVIDENCE_DIR/catalog-pre.json.
 *   post    DB migrated through FIN (N+1 = 040): ledger 1..N+1 sequential, rows 1..N byte-for-byte unchanged (checksums), the FIN row is
 *             `additive` with the checksum of the file in infra/ and a body identical to design/fin-sdo-1/schema-UNNUMBERED.sql (only the
 *             leading comment block may differ); the NON-FIN catalog fingerprint equals the saved one (FIN altered nothing outside fin_*);
 *             FIN security catalog: 12 SECURITY DEFINER commands with pinned search_path and no PUBLIC EXECUTE, no PUBLIC table privilege,
 *             no RLS/policy, no dynamic SQL, DML only on fin_* tables, no foreign key INTO fin_* from outside, FKs OUT only to the 4 core tables.
 *   rerun   `npm run db:migrate` again is a no-op: exit 0, ledger identical.
 *   tamper  a changed ledger checksum for the FIN row makes the runner REFUSE (MIGRATION_CHANGED_AFTER_APPLY); restored afterwards.
 *
 * Executor evidence only. It does not allocate or publish a migration number: the numbered file must already exist in the candidate
 * (a separate, coordinator-authorized step), otherwise `post` FAILS closed with "no FIN migration in infra/".
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';

const url = process.env.DATABASE_URL;
if (process.env.FIN_SDO_ISOLATED_CONFIRM !== 'YES' || !url) throw Error('Requires isolated confirmation');
const dbUrl = new URL(url);
if (!['localhost', '127.0.0.1', '::1'].includes(dbUrl.hostname) || !dbUrl.pathname.endsWith('_test')) throw Error('Refuse non-test DB');
const phase = process.argv[2];
if (!['pre', 'post', 'rerun', 'tamper'].includes(phase)) throw Error('usage: fin-sdo-1-isolated-sequence-verify.ts <pre|post|rerun|tamper>');
const PRE = Number(process.env.FIN_SEQ_PRE_COUNT ?? 39);
const EV = process.env.FIN_SEQ_EVIDENCE_DIR ?? 'fin-seq-evidence';
mkdirSync(EV, { recursive: true });
const SNAP = path.join(EV, 'catalog-pre.json');

const owner = new Pool({ connectionString: url, connectionTimeoutMillis: 5000 });
const failures: string[] = [];
async function check(label: string, fn: () => Promise<void> | void) {
  try { await fn(); console.log('PASS ' + label); }
  catch (e: any) { failures.push(label); console.log('FAIL ' + label + ' :: ' + String(e?.message ?? e).split('\n').slice(0, 8).join(' | ')); }
}
const sha = (s: string) => createHash('sha256').update(s.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
const ledger = async () => (await owner.query('SELECT version,file_name,migration_class,checksum FROM schema_migrations ORDER BY version')).rows as Array<{ version: number; file_name: string | null; migration_class: string | null; checksum: string | null }>;
const finObjects = async () => (await owner.query(`SELECT
   (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname LIKE 'fin\\_%') relations,
   (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'fin\\_%') functions`)).rows[0] as { relations: number; functions: number };

/** Deterministic fingerprint of EVERYTHING that is not a fin_* object. Sections are hashed separately so a mismatch names its cause. */
async function nonFinFingerprint(): Promise<Record<string, string>> {
  const q = async (sql: string) => (await owner.query(sql)).rows.map(r => Object.values(r).join('|')).sort().join('\n');
  const notFinTable = `c.relname NOT LIKE 'fin\\_%'`;
  const sections: Record<string, string> = {
    columns: await q(`SELECT table_name,column_name,data_type,is_nullable,coalesce(column_default,''),coalesce(character_maximum_length::text,''),coalesce(numeric_precision::text,'') FROM information_schema.columns WHERE table_schema='public' AND table_name NOT LIKE 'fin\\_%'`),
    constraints: await q(`SELECT c.relname,k.conname,k.contype,pg_get_constraintdef(k.oid) FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND ${notFinTable}`),
    indexes: await q(`SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename NOT LIKE 'fin\\_%'`),
    triggers: await q(`SELECT c.relname,t.tgname,pg_get_triggerdef(t.oid),t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname='public' AND ${notFinTable}`),
    functions: await q(`SELECT p.proname,pg_get_function_identity_arguments(p.oid),md5(p.prosrc),p.prosecdef,coalesce(p.proconfig::text,''),coalesce(p.proacl::text,''),r.rolname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner WHERE n.nspname='public' AND p.proname NOT LIKE 'fin\\_%'`),
    views: await q(`SELECT c.relname,md5(pg_get_viewdef(c.oid)) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('v','m') AND ${notFinTable}`),
    sequences: await q(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='S' AND ${notFinTable}`),
    table_acl_rls: await q(`SELECT c.relname,coalesce(c.relacl::text,''),c.relrowsecurity,c.relforcerowsecurity,r.rolname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname='public' AND c.relkind='r' AND ${notFinTable}`),
    policies: await q(`SELECT schemaname,tablename,policyname,cmd,qual FROM pg_policies WHERE tablename NOT LIKE 'fin\\_%'`),
    extensions: await q(`SELECT extname,extversion FROM pg_extension`),
    event_triggers: await q(`SELECT evtname,evtevent FROM pg_event_trigger`),
    types: await q(`SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typtype IN ('e','d','c') AND t.typname NOT LIKE 'fin\\_%' AND t.typname NOT LIKE '\\_%' AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.reltype=t.oid)`),
  };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(sections)) out[k] = sha(v);
  out.ALL = sha(Object.values(out).join(','));
  return out;
}

function runMigrator(extraEnv: Record<string, string> = {}) {
  const r = spawnSync('npm', ['run', 'db:migrate', '--silent'], { env: { ...process.env, ...extraEnv }, encoding: 'utf8', timeout: 120000 });
  writeFileSync(path.join(EV, `migrate-${phase}-${Date.now()}.log`), `exit=${r.status}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}\n`);
  return r;
}

async function main() {
  if (phase === 'pre') {
    await check(`FIN1-25 pre: ledger is exactly 1..${PRE}, sequential, no gap, no FIN row`, async () => {
      const l = await ledger();
      assert.equal(l.length, PRE); l.forEach((r, i) => assert.equal(r.version, i + 1, 'gap at ' + (i + 1)));
      assert.ok(!l.some(r => /fin_sdo/i.test(r.file_name ?? '')), 'a FIN migration is already in the ledger');
      assert.ok(l.slice(25).every(r => r.migration_class === 'additive' || r.migration_class === 'contract') && l.slice(25).every(r => !!r.checksum), 'post-legacy rows carry class + checksum');
    });
    await check('FIN1-25 pre: no fin_* relation or function exists before the FIN migration', async () => {
      assert.deepEqual(await finObjects(), { relations: 0, functions: 0 });
    });
    const before = { ledger: await ledger(), fin: await finObjects(), fp: await nonFinFingerprint() };
    await check('FIN1-25 pre: application BOOT writes nothing — no startup migration, ledger and catalog unchanged; FIN routes OFF by default (404)', async () => {
      delete process.env.FIN_SDO_1_ROUTES;
      process.env.AUTH_MODE = 'mock'; process.env.MOCK_LOGIN_KEY = 'test-only-key-never-LIVE'; process.env.APP_ORIGIN = 'http://127.0.0.1';
      const { createApp } = await import('../apps/backend/src/main');
      const app = await createApp();
      try {
        await app.listen(0, '127.0.0.1');
        const a = app.getHttpServer().address(); assert.ok(a && typeof a !== 'string');
        const r = await fetch(`http://127.0.0.1:${a.port}/fin-sdo-1/subjects`, { headers: { Authorization: 'Bearer ' + 'x'.repeat(43) } });
        assert.equal(r.status, 404, 'FIN routes must not exist unless FIN_SDO_1_ROUTES=enabled');
        const h = await fetch(`http://127.0.0.1:${a.port}/health`).catch(() => null);
        console.log('OBSERVATION FIN1-25 boot: /fin-sdo-1/subjects -> 404; /health -> ' + (h ? h.status : 'unreachable'));
      } finally { await app.close(); }
      assert.deepEqual(await ledger(), before.ledger, 'boot changed the migration ledger');
      assert.deepEqual(await finObjects(), before.fin);
      assert.deepEqual(await nonFinFingerprint(), before.fp, 'boot changed the catalog');
    });
    await check('FIN1-25 pre: with routes ON but NO schema and NO restricted DSN the FIN API fails closed (no 2xx, no catalog change)', async () => {
      process.env.FIN_SDO_1_ROUTES = 'enabled'; process.env.FIN_SDO_PROTECTED_IDENTITY_COMMANDS = 'enabled'; delete process.env.FIN_SDO_DATABASE_URL;
      // main.ts reads FIN_SDO_1_ROUTES at module load: the first import (routes off) is cached, so this check uses a fresh process.
      const r = spawnSync(process.execPath, ['--import', 'tsx', '-e', `
        process.env.FIN_SDO_1_ROUTES='enabled';process.env.FIN_SDO_PROTECTED_IDENTITY_COMMANDS='enabled';process.env.AUTH_MODE='mock';process.env.MOCK_LOGIN_KEY='test-only-key-never-LIVE';process.env.APP_ORIGIN='http://127.0.0.1';delete process.env.FIN_SDO_DATABASE_URL;
        (async()=>{const {createApp}=await import('./apps/backend/src/main');const app=await createApp();await app.listen(0,'127.0.0.1');const a=app.getHttpServer().address();
        const res=await fetch('http://127.0.0.1:'+a.port+'/fin-sdo-1/subjects',{headers:{Authorization:'Bearer '+'x'.repeat(43)}});console.log('STATUS='+res.status);await app.close();})().catch(e=>{console.log('ERR='+e.message);process.exit(0)})`],
        { env: process.env, encoding: 'utf8', timeout: 60000 });
      const m = /STATUS=(\d+)/.exec(r.stdout); assert.ok(m, 'no status: ' + r.stdout.slice(-300) + r.stderr.slice(-300));
      console.log('OBSERVATION FIN1-25 routes-on/no-schema: HTTP ' + m![1]);
      const st = Number(m![1]);
      assert.ok([401, 403, 500, 503].includes(st), 'routes-on without schema/DSN must fail closed with 401/403/500/503, got ' + st);
      assert.deepEqual(await ledger(), before.ledger); assert.deepEqual(await nonFinFingerprint(), before.fp);
    });
    writeFileSync(SNAP, JSON.stringify({ at: new Date().toISOString(), pre_count: PRE, ledger: before.ledger, fingerprint: before.fp }, null, 1));
    console.log('OBSERVATION FIN1-25 pre: non-FIN catalog fingerprint ALL=' + before.fp.ALL);
  }

  if (phase === 'post') {
    const snap = JSON.parse(readFileSync(SNAP, 'utf8'));
    const files = readdirSync('infra').filter(f => /^\d+_.*\.sql$/.test(f)).sort();
    const finFile = files.find(f => /^\d+_fin_sdo_1_.*\.sql$/.test(f));
    await check('FIN1-25 post: the candidate carries exactly one numbered FIN migration, directly after the last GPR migration (no gap, no reuse)', () => {
      assert.ok(finFile, 'no FIN migration in infra/ (numbering is a coordinator decision; this gate fails closed until it exists)');
      assert.equal(Number(finFile!.split('_')[0]), PRE + 1, 'FIN number must be ' + (PRE + 1));
      assert.equal(files.length, PRE + 1); files.forEach((f, i) => assert.equal(Number(f.split('_')[0]), i + 1, 'file sequence gap at ' + f));
    });
    await check(`FIN1-25 post: ledger is 1..${PRE + 1} sequential; rows 1..${PRE} are byte-for-byte what they were before FIN (immutability)`, async () => {
      const l = await ledger(); assert.equal(l.length, PRE + 1); l.forEach((r, i) => assert.equal(r.version, i + 1));
      assert.deepEqual(l.slice(0, PRE), snap.ledger, 'an older ledger row changed');
    });
    await check('FIN1-25 post: FIN ledger row is class additive, checksum = sha256 of the infra file, body identical to the reviewed UNNUMBERED schema', async () => {
      const row = (await ledger())[PRE]; assert.equal(row.file_name, finFile); assert.equal(row.migration_class, 'additive');
      const text = readFileSync(path.join('infra', finFile!), 'utf8');
      assert.equal(row.checksum, sha(text), 'ledger checksum != file checksum');
      const body = (t: string) => t.split('\n').filter((l, i, a) => !(a.slice(0, i + 1).every(x => /^\s*--/.test(x) && !/migration-class/.test(x)))).join('\n');
      assert.equal(sha(body(text)), sha(body(readFileSync('design/fin-sdo-1/schema-UNNUMBERED.sql', 'utf8'))), 'numbered body differs from the reviewed UNNUMBERED schema');
      assert.match(text.split('\n').slice(0, 8).join('\n'), /^\s*--\s*migration-class\s*:\s*additive\s*$/m);
    });
    await check('FIN1-25 post: FIN altered NOTHING outside fin_* (tables, columns, constraints, indexes, triggers, functions, views, ACL/RLS, policies, extensions) — fingerprint equals the pre-FIN snapshot', async () => {
      const now = await nonFinFingerprint(); const diff = Object.keys(snap.fingerprint).filter(k => snap.fingerprint[k] !== now[k]);
      assert.deepEqual(diff, [], 'non-FIN catalog changed in: ' + diff.join(','));
    });
    await check('FIN1-25 post: exactly the 12 FIN-1 tables and no FIN-2/3 relation exist', async () => {
      const t = (await owner.query(`SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','v','m','S','p') AND c.relname LIKE 'fin\\_%' AND c.relkind='r' ORDER BY 1`)).rows.map(r => r.relname);
      assert.deepEqual(t, ['fin_command_ledger', 'fin_contract_scopes', 'fin_historical_parties', 'fin_historical_subjects', 'fin_party_scopes', 'fin_plan_edit_session_lines', 'fin_plan_edit_sessions', 'fin_quarter_book_revisions', 'fin_quarter_plan_books', 'fin_quarter_plan_line_revisions', 'fin_quarter_plan_lines', 'fin_subjects']);
    });
    await check('FIN1-25 security: 12 SECURITY DEFINER commands, search_path pinned to pg_catalog,pg_temp, no PUBLIC EXECUTE, no dynamic SQL', async () => {
      const f = (await owner.query(`SELECT p.proname,p.prosecdef,p.proconfig,p.prosrc,has_function_privilege('public',p.oid,'EXECUTE') pub FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'fin\\_%'`)).rows;
      const def = f.filter(x => x.prosecdef); assert.equal(def.length, 12, 'SECURITY DEFINER count');
      for (const x of def) {
        assert.ok((x.proconfig ?? []).some((c: string) => /^search_path=pg_catalog, pg_temp$/.test(c)), x.proname + ' search_path not pinned: ' + JSON.stringify(x.proconfig));
        assert.equal(x.pub, false, x.proname + ' is executable by PUBLIC');
      }
      for (const x of f) assert.ok(!/\bEXECUTE\b/i.test(x.prosrc.replace(/--[^\n]*/g, '')), x.proname + ' uses dynamic SQL (EXECUTE)');
    });
    await check('FIN1-25 security: DML inside FIN functions targets only fin_* tables; no GRANT to PUBLIC; no table privilege for PUBLIC; no RLS/policy; no foreign key INTO fin_* from outside; FKs OUT only to tenants/users/objects/contractors', async () => {
      const src = (await owner.query(`SELECT p.proname,p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'fin\\_%'`)).rows;
      for (const x of src) {
        const targets = [...x.prosrc.matchAll(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:ONLY\s+)?((?:public\.)?[a-z_][a-z0-9_]*)/gi)].map(m => m[1].replace(/^public\./i, '').toLowerCase());
        const bad = targets.filter(t => !t.startsWith('fin_')); assert.deepEqual(bad, [], x.proname + ' writes a non-FIN table: ' + bad.join(','));
      }
      const tbl = (await owner.query(`SELECT c.relname,c.relrowsecurity,c.relacl,(SELECT bool_or(has_table_privilege('public',c.oid,p)) FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p) pub FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname LIKE 'fin\\_%'`)).rows;
      assert.equal(tbl.length, 12); for (const t of tbl) { assert.equal(t.pub, false, t.relname + ' has a PUBLIC privilege'); assert.equal(t.relrowsecurity, false, t.relname + ' RLS state (FIN isolation is definer-function + composite tenant FKs, not RLS)'); }
      assert.equal((await owner.query(`SELECT count(*)::int n FROM pg_policies WHERE tablename LIKE 'fin\\_%'`)).rows[0].n, 0);
      const into = (await owner.query(`SELECT c.relname src,t.relname dst FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_class t ON t.oid=k.confrelid WHERE k.contype='f' AND t.relname LIKE 'fin\\_%' AND c.relname NOT LIKE 'fin\\_%'`)).rows; assert.deepEqual(into, [], 'a non-FIN table references FIN');
      const out = (await owner.query(`SELECT DISTINCT t.relname dst FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_class t ON t.oid=k.confrelid WHERE k.contype='f' AND c.relname LIKE 'fin\\_%' AND t.relname NOT LIKE 'fin\\_%' ORDER BY 1`)).rows.map(r => r.dst);
      assert.deepEqual(out, ['contractors', 'objects', 'tenants', 'users']);
      const trg = (await owner.query(`SELECT c.relname,p.proname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_proc p ON p.oid=t.tgfoid WHERE NOT t.tgisinternal AND p.proname LIKE 'fin\\_%' AND c.relname NOT LIKE 'fin\\_%'`)).rows; assert.deepEqual(trg, [], 'a FIN trigger function is attached to a non-FIN table');
    });
    await check('FIN1-25 scope: FIN migration touches no GPR/F8.3/production object — no fin_* function body references them', async () => {
      const src = (await owner.query(`SELECT p.proname,p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'fin\\_%'`)).rows;
      for (const x of src) assert.ok(!/\b(gpr2_|work_quantity|work_allocation|work_execution|technical_release|production_|f8_|sdo_closing|inspections?\b)/i.test(x.prosrc), x.proname + ' references a GPR/production/F8.3 object');
    });
  }

  if (phase === 'rerun') {
    await check('FIN1-25 rerun: running the migrator again is a no-op (exit 0, ledger identical)', async () => {
      const before = await ledger(); const r = runMigrator(); assert.equal(r.status, 0, 'rerun exit ' + r.status + ' ' + r.stderr.slice(-300));
      assert.deepEqual(await ledger(), before);
    });
  }

  if (phase === 'tamper') {
    await check('FIN1-25 tamper: a changed ledger checksum for the FIN row is REFUSED by the runner (MIGRATION_CHANGED_AFTER_APPLY) and the ledger is restored', async () => {
      const l = await ledger(); const row = l[PRE]; assert.ok(row.checksum);
      await owner.query('UPDATE schema_migrations SET checksum=$1 WHERE version=$2', ['0'.repeat(64), PRE + 1]);
      try {
        const r = runMigrator(); assert.notEqual(r.status, 0, 'runner accepted a tampered ledger checksum');
        assert.match(r.stdout + r.stderr, /MIGRATION_CHANGED_AFTER_APPLY/);
      } finally { await owner.query('UPDATE schema_migrations SET checksum=$1 WHERE version=$2', [row.checksum, PRE + 1]); }
      assert.deepEqual(await ledger(), l); const ok = runMigrator(); assert.equal(ok.status, 0, 'runner does not recover after restore');
    });
  }

  if (failures.length) { console.log(`SEQUENCE[${phase}] FAILURES: ${failures.length}\n - ` + failures.join('\n - ')); process.exitCode = 1; }
  else console.log(`SEQUENCE[${phase}] all checks PASS (executor evidence for FIN1-25; not an acceptance verdict)`);
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { await owner.end(); });
