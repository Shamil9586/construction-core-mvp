/**
 * FIN-SDO-1 evidence-gap closure: FIN1-05 and FIN1-23, NATIVE PostgreSQL + real HTTP + the actual restricted FIN LOGIN.
 *
 *   FIN1-05  UNALLOCATED / NOT_SPECIFIED: non-null canonical keys; no invented contractor, no invented historical party;
 *            NOT_SPECIFIED never asserts "no contract" and is never mixed with a KNOWN contract; every invalid combination
 *            is refused with zero writes. Proved both at the DB-constraint layer and through the protected HTTP slice.
 *   FIN1-23  Read paths: one connection (tx.c), REPEATABLE READ READ ONLY, book + lines + totals from ONE snapshot while a
 *            writer commits concurrently. Includes a deterministic snapshot test, a negative control that proves the
 *            invariant checker is not vacuous, and a bounded concurrent writer/reader stress run.
 *
 * Prerequisite: run AFTER scripts/fin-sdo-1-isolated-protected-verify.ts in the same disposable database (it creates the
 * restricted FIN LOGIN, the NOLOGIN definer owner and their grants). This script only resets that LOGIN's password and creates
 * its OWN tenants/users/sessions. DISPOSABLE loopback *_test database only. Never LIVE, never intercepted.
 *
 * Every check prints PASS/FAIL; the script exits non-zero if any FAIL (all defects are recorded, not just the first).
 * Executor evidence only: not an acceptance verdict.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { Pool } from 'pg';
import { restrictedFinConnectionPool, runFinSdoSnapshotRead } from '../apps/backend/src/fin-sdo-1-db';

const url = process.env.DATABASE_URL;
if (process.env.FIN_SDO_ISOLATED_CONFIRM !== 'YES' || !url) throw Error('Requires isolated confirmation');
const dbUrl = new URL(url);
if (!['localhost', '127.0.0.1', '::1'].includes(dbUrl.hostname) || !dbUrl.pathname.endsWith('_test')) throw Error('Refuse non-test DB');

const owner = new Pool({ connectionString: url, connectionTimeoutMillis: 5000 });
const roleName = 'fin_sdo_isolated_login';
const failures: string[] = [];
async function check(label: string, fn: () => Promise<void> | void) {
  try { await fn(); console.log('PASS ' + label); }
  catch (e: any) { failures.push(label); console.log('FAIL ' + label + ' :: ' + String(e?.message ?? e).split('\n').slice(0, 6).join(' | ')); }
}

/** Exact decimal helpers: money is compared as integer kopeks parsed from NUMERIC(20,2) strings, never as float. */
function kopeks(s: string): bigint {
  const m = /^(\d+)\.(\d{2})$/.exec(s);
  if (!m) throw new Error('not a canonical NUMERIC(20,2) string: ' + s);
  return BigInt(m[1]) * 100n + BigInt(m[2]);
}

/**
 * Consistency invariants of ONE quarter-read result. A torn read (head of revision N with lines of revision N+1, or history
 * shorter than the head) violates at least one of these. Returns the list of violations (empty = consistent).
 */
function readViolations(r: any): string[] {
  const v: string[] = [];
  if (r?.status !== 'ACTIVE') return ['status is ' + r?.status];
  const h: any[] = r.history;
  if (!Array.isArray(h) || h.length === 0) return ['empty history'];
  h.forEach((x, i) => { if (x.revision_no !== i + 1) v.push('history not contiguous at index ' + i + ': ' + x.revision_no); });
  if (r.revisionNo !== h.length) v.push('revisionNo ' + r.revisionNo + ' != history length ' + h.length);
  if (r.bookVersion !== r.revisionNo) v.push('bookVersion ' + r.bookVersion + ' != revisionNo ' + r.revisionNo);
  if (r.current !== h[h.length - 1].new_total_rub) v.push('current ' + r.current + ' != last history total ' + h[h.length - 1].new_total_rub);
  if (r.original !== h[0].new_total_rub) v.push('original ' + r.original + ' != first history total ' + h[0].new_total_rub);
  let sum = 0n;
  for (const l of r.lines) {
    if (l.created_in_book_revision > r.revisionNo) v.push('line created in future revision ' + l.created_in_book_revision);
    sum += kopeks(l.amount_rub);
  }
  if (sum !== kopeks(r.current)) v.push('SUM(lines) ' + sum + ' != current total ' + kopeks(r.current));
  return v;
}

async function main() {
  const prereq = await owner.query("SELECT (SELECT count(*)::int FROM pg_roles WHERE rolname=$1) login,(SELECT count(*)::int FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.proname='fin_sdo_commit_edit_buffer' AND r.rolname='fin_sdo_definer_test') definer", [roleName]);
  assert.deepEqual(prereq.rows[0], { login: 1, definer: 1 }, 'run fin-sdo-1-isolated-protected-verify.ts first in this disposable DB');
  const password = randomBytes(38).toString('base64url'); // never printed or persisted
  await owner.query("ALTER ROLE fin_sdo_isolated_login PASSWORD '" + password + "'");
  const finUrl = new URL(url!); finUrl.username = roleName; finUrl.password = password;
  process.env.FIN_SDO_DATABASE_URL = finUrl.toString();

  const suffix = randomUUID().slice(0, 8);
  const mkTenant = async (tag: string) => (await owner.query("INSERT INTO tenants(portal,member_id,name) VALUES($1,$2,$3) RETURNING id", [`fin-gaps-${tag}-${suffix}.example.test`, `fin-gaps-${tag}-${suffix}`, 'FIN gaps ' + tag])).rows[0].id as string;
  const tenantA = await mkTenant('a');
  const tenantB = await mkTenant('b');
  async function actor(tenant: string, role: string) {
    const uid = (await owner.query('INSERT INTO users(tenant_id,bitrix_user_id,name,role) VALUES($1,$2,$3,$4) RETURNING id', [tenant, 'fin-gaps-' + randomUUID(), 'gaps ' + role, role])).rows[0].id as string;
    const token = randomBytes(32).toString('base64url');
    await owner.query("INSERT INTO sessions(tenant_id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '2 hour')", [tenant, uid, createHash('sha256').update(token).digest('hex')]);
    return { tenant, uid, token };
  }
  const a = await actor(tenantA, 'SDO');
  const gd = await actor(tenantA, 'GENERAL_DIRECTOR'); // DEC-01: read-only
  const pto = await actor(tenantA, 'PTO'); // DEC-01: no FIN access
  const b = await actor(tenantB, 'SDO');

  process.env.FIN_SDO_1_ROUTES = 'enabled';
  process.env.FIN_SDO_PROTECTED_IDENTITY_COMMANDS = 'enabled';
  process.env.AUTH_MODE = 'mock';
  process.env.MOCK_LOGIN_KEY = 'test-only-key-never-LIVE';
  process.env.APP_ORIGIN = 'http://127.0.0.1';
  const { createApp } = await import('../apps/backend/src/main');
  const app = await createApp();
  try {
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    assert.ok(address && typeof address !== 'string');
    const host = 'http://127.0.0.1:' + address.port;
    async function api(path: string, token: string, method = 'GET', payload?: unknown) {
      const r = await fetch(host + '/fin-sdo-1/' + path, { method, headers: { Authorization: 'Bearer ' + token, ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
      const text = await r.text(); let body: any = null; try { body = JSON.parse(text); } catch { /* non-JSON */ }
      return { status: r.status, body, text };
    }
    const draft = async (token: string, year: number, quarter: number, expectedBookVersion: number, lines: any[]) => {
      const r = await api('buffers', token, 'POST', { year, quarter, expectedBookVersion, lines }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body;
    };
    const commit = async (token: string, year: number, quarter: number, d: any, expectedBookVersion: number, extra: Record<string, unknown> = {}) =>
      api('commit', token, 'POST', { year, quarter, bufferId: d.bufferId, expectedBufferVersion: d.version, expectedBookVersion, effectiveOn: year + '-01-15', idempotencyKey: randomUUID(), ...extra });
    const readQ = (token: string, year: number, quarter: number) => api(`quarter?year=${year}&quarter=${quarter}`, token);

    const hs = await api('historical-subjects', a.token, 'POST', { name: 'gaps historical subject', idempotencyKey: randomUUID() });
    assert.equal(hs.status, 200, JSON.stringify(hs.body));
    const subj = hs.body.id as string;
    const hs2 = await api('historical-subjects', a.token, 'POST', { name: 'gaps historical subject 2', idempotencyKey: randomUUID() });
    const subj2 = hs2.body.id as string;
    const hp = await api('historical-parties', a.token, 'POST', { name: 'gaps historical party', idempotencyKey: randomUUID() });
    assert.equal(hp.status, 200, JSON.stringify(hp.body));
    const histParty = hp.body.id as string;

    // ---------------------------------------------------------------------------------------------------- FIN1-05
    const cnt = async (tenant: string) => (await owner.query(
      `SELECT (SELECT count(*)::int FROM contractors WHERE tenant_id=$1) contractors,
              (SELECT count(*)::int FROM fin_historical_parties WHERE tenant_id=$1) hist_parties,
              (SELECT count(*)::int FROM fin_party_scopes WHERE tenant_id=$1) party_scopes,
              (SELECT count(*)::int FROM fin_contract_scopes WHERE tenant_id=$1) contract_scopes,
              (SELECT count(*)::int FROM fin_subjects WHERE tenant_id=$1) subjects,
              (SELECT count(*)::int FROM fin_quarter_plan_books WHERE tenant_id=$1) books,
              (SELECT count(*)::int FROM fin_plan_edit_sessions WHERE tenant_id=$1) buffers`, [tenant])).rows[0];

    await check('FIN1-05 DB: party/contract scope CHECK, UNIQUE and NOT NULL constraints refuse every invented or mixed identity', async () => {
      // Dedicated tenant D: these DB-level probes commit helper rows, so they must not pre-seed tenant A for the HTTP scenarios below.
      const tenantD = await mkTenant('d');
      const dUid = (await owner.query("INSERT INTO users(tenant_id,bitrix_user_id,name,role) VALUES($1,$2,'gaps D','SDO') RETURNING id", [tenantD, 'fin-gaps-' + randomUUID()])).rows[0].id as string;
      const fakeContractor = (await owner.query("INSERT INTO contractors(tenant_id,name) VALUES($1,'gaps real contractor') RETURNING id", [tenantD])).rows[0].id as string;
      const dParty = (await owner.query("INSERT INTO fin_historical_parties(tenant_id,name,created_by) VALUES($1,'gaps D party',$2) RETURNING id", [tenantD, dUid])).rows[0].id as string;
      const refused = async (label: string, sqlstate: string, sql: string, args: any[] = []) => {
        const c = await owner.connect();
        try {
          await c.query('BEGIN');
          try { await c.query(sql, args); await c.query('COMMIT'); assert.fail('UNEXPECTED SQL SUCCESS: ' + label); }
          catch (e: any) { if (e instanceof assert.AssertionError) throw e; assert.equal(e.code, sqlstate, label + ' -> ' + e.code + ' ' + e.message); }
          finally { await c.query('ROLLBACK').catch(() => undefined); }
        } finally { c.release(); }
      };
      await refused('UNALLOCATED scope carrying a contractor id', '23514', "INSERT INTO fin_party_scopes(tenant_id,kind,core_contractor_id) VALUES($1,'UNALLOCATED',$2)", [tenantD, fakeContractor]);
      await refused('UNALLOCATED scope carrying a historical party id', '23514', "INSERT INTO fin_party_scopes(tenant_id,kind,historical_party_id) VALUES($1,'UNALLOCATED',$2)", [tenantD, dParty]);
      await refused('CORE_CONTRACTOR scope without contractor', '23514', "INSERT INTO fin_party_scopes(tenant_id,kind) VALUES($1,'CORE_CONTRACTOR')", [tenantD]);
      await refused('HISTORICAL_PARTY scope without party', '23514', "INSERT INTO fin_party_scopes(tenant_id,kind) VALUES($1,'HISTORICAL_PARTY')", [tenantD]);
      await refused('unknown party kind', '23514', "INSERT INTO fin_party_scopes(tenant_id,kind) VALUES($1,'NONE')", [tenantD]);
      await refused('a second UNALLOCATED scope in one tenant', '23505', "INSERT INTO fin_party_scopes(tenant_id,kind) VALUES($1,'UNALLOCATED'),($1,'UNALLOCATED')", [tenantD]);
      const unalloc = (await owner.query("INSERT INTO fin_party_scopes(tenant_id,kind) VALUES($1,'UNALLOCATED') ON CONFLICT DO NOTHING RETURNING id", [tenantD])).rows[0]?.id
        ?? (await owner.query("SELECT id FROM fin_party_scopes WHERE tenant_id=$1 AND kind='UNALLOCATED'", [tenantD])).rows[0].id as string;
      await refused('NOT_SPECIFIED contract that carries a number', '23514', "INSERT INTO fin_contract_scopes(tenant_id,kind,party_scope_id,number,created_by) VALUES($1,'NOT_SPECIFIED',$2,'X-1',$3)", [tenantD, unalloc, dUid]);
      await refused('KNOWN contract without number', '23514', "INSERT INTO fin_contract_scopes(tenant_id,kind,party_scope_id,created_by) VALUES($1,'KNOWN',$2,$3)", [tenantD, unalloc, dUid]);
      await refused('KNOWN contract with blank number', '23514', "INSERT INTO fin_contract_scopes(tenant_id,kind,party_scope_id,number,created_by) VALUES($1,'KNOWN',$2,'   ',$3)", [tenantD, unalloc, dUid]);
      await refused('contract without a party scope', '23502', "INSERT INTO fin_contract_scopes(tenant_id,kind,created_by) VALUES($1,'NOT_SPECIFIED',$2)", [tenantD, dUid]);
      await refused('two NOT_SPECIFIED contracts for one party scope', '23505', "INSERT INTO fin_contract_scopes(tenant_id,kind,party_scope_id,created_by) VALUES($1,'NOT_SPECIFIED',$2,$3),($1,'NOT_SPECIFIED',$2,$3)", [tenantD, unalloc, dUid]);
      await refused('two KNOWN contracts with one number for one party scope', '23505', "INSERT INTO fin_contract_scopes(tenant_id,kind,party_scope_id,number,created_by) VALUES($1,'KNOWN',$2,'D-1',$3),($1,'KNOWN',$2,'D-1',$3)", [tenantD, unalloc, dUid]);
      const foreignUnalloc = (await owner.query("INSERT INTO fin_party_scopes(tenant_id,kind) VALUES($1,'UNALLOCATED') RETURNING id", [tenantB])).rows[0].id as string;
      await refused('tenant D contract bound to tenant B party scope', '23503', "INSERT INTO fin_contract_scopes(tenant_id,kind,party_scope_id,created_by) VALUES($1,'NOT_SPECIFIED',$2,$3)", [tenantD, foreignUnalloc, dUid]);
      await refused('CORE_CONTRACTOR scope bound to another tenant contractor', '23503', "INSERT INTO fin_party_scopes(tenant_id,kind,core_contractor_id) VALUES($1,'CORE_CONTRACTOR',$2)", [tenantB, fakeContractor]);
      // Canonical key columns of a plan line are NOT NULL: no line can exist without a party scope or a contract scope.
      const nn = (await owner.query("SELECT column_name,is_nullable FROM information_schema.columns WHERE table_name='fin_quarter_plan_lines' AND column_name IN ('subject_id','party_scope_id','contract_scope_id','currency_code') ORDER BY 1")).rows;
      assert.equal(nn.length, 4); for (const r of nn) assert.equal(r.is_nullable, 'NO', r.column_name + ' must be NOT NULL');
    });

    const before5 = await cnt(tenantA);
    await check('FIN1-05 HTTP: UNALLOCATED + NOT_SPECIFIED commits with NO invented contractor, historical party or "no contract" claim', async () => {
      const d = await draft(a.token, 2050, 1, 0, [
        { historicalSubjectId: subj, partyKind: 'UNALLOCATED', contractKind: 'NOT_SPECIFIED', amountMln: '10.00' }]);
      const c = await commit(a.token, 2050, 1, d, 0);
      assert.equal(c.status, 200, JSON.stringify(c.body));
      const q = (await readQ(a.token, 2050, 1)).body;
      assert.equal(q.status, 'ACTIVE'); assert.equal(q.lines.length, 1);
      const l = q.lines[0];
      assert.equal(l.party_kind, 'UNALLOCATED'); assert.equal(l.core_contractor_id, null); assert.equal(l.historical_party_id, null);
      assert.equal(l.contract_kind, 'NOT_SPECIFIED'); assert.equal(l.contract_number, null);
      for (const k of ['party_scope_id', 'contract_scope_id', 'subject_id']) assert.match(l[k], /^[0-9a-f-]{36}$/, k + ' non-null canonical key part');
      // No wording that would turn "not specified" into "proven absence of a contract".
      assert.ok(!/no[_ ]?contract|без договора|договор[а]? нет|NONE/i.test(JSON.stringify(q)), 'payload must not claim absence of a contract');
      const after = await cnt(tenantA);
      assert.equal(after.contractors, before5.contractors, 'no contractor invented');
      assert.equal(after.hist_parties, before5.hist_parties, 'no historical party invented');
      assert.equal(after.party_scopes, before5.party_scopes + 1, 'exactly one party scope (the UNALLOCATED singleton)');
      assert.equal(after.contract_scopes, before5.contract_scopes + 1, 'exactly one NOT_SPECIFIED contract scope');
      const scopes = (await owner.query("SELECT p.kind, p.core_contractor_id, p.historical_party_id, k.kind ckind, k.number FROM fin_party_scopes p JOIN fin_contract_scopes k ON k.tenant_id=p.tenant_id AND k.party_scope_id=p.id WHERE p.tenant_id=$1 AND p.id=$2", [tenantA, l.party_scope_id])).rows;
      assert.deepEqual(scopes, [{ kind: 'UNALLOCATED', core_contractor_id: null, historical_party_id: null, ckind: 'NOT_SPECIFIED', number: null }]);
    });

    await check('FIN1-05 HTTP: NOT_SPECIFIED, a KNOWN contract (same party) and another party stay separate canonical lines; amounts never merged', async () => {
      const real = (await owner.query("INSERT INTO contractors(tenant_id,name) VALUES($1,'gaps contractor X') RETURNING id", [tenantA])).rows[0].id as string;
      const d = await draft(a.token, 2050, 2, 0, [
        { historicalSubjectId: subj2, partyKind: 'UNALLOCATED', contractKind: 'NOT_SPECIFIED', amountMln: '6.00' },
        { historicalSubjectId: subj2, partyKind: 'UNALLOCATED', contractKind: 'KNOWN', contractNumber: 'D-77', amountMln: '2.50' },
        { historicalSubjectId: subj2, partyKind: 'CORE_CONTRACTOR', partyId: real, contractKind: 'NOT_SPECIFIED', amountMln: '1.50' },
        { historicalSubjectId: subj2, partyKind: 'HISTORICAL_PARTY', partyId: histParty, contractKind: 'NOT_SPECIFIED', amountMln: '0.00' }]);
      assert.equal(d.totalRub, '10000000.00');
      const c = await commit(a.token, 2050, 2, d, 0);
      assert.equal(c.status, 200, JSON.stringify(c.body));
      const q = (await readQ(a.token, 2050, 2)).body;
      assert.equal(q.lines.length, 4);
      assert.equal(new Set(q.lines.map((l: any) => [l.subject_id, l.party_scope_id, l.contract_scope_id].join(':'))).size, 4, 'four distinct canonical keys');
      const byAmount = Object.fromEntries(q.lines.map((l: any) => [l.amount_rub, l]));
      assert.equal(byAmount['6000000.00'].contract_kind, 'NOT_SPECIFIED'); assert.equal(byAmount['6000000.00'].party_kind, 'UNALLOCATED');
      assert.equal(byAmount['2500000.00'].contract_kind, 'KNOWN'); assert.equal(byAmount['2500000.00'].contract_number, 'D-77');
      assert.equal(byAmount['2500000.00'].party_kind, 'UNALLOCATED', 'a known contract never converts UNALLOCATED into an invented contractor');
      assert.equal(byAmount['1500000.00'].core_contractor_id, real); assert.equal(byAmount['1500000.00'].contract_kind, 'NOT_SPECIFIED');
      assert.equal(byAmount['0.00'].historical_party_id, histParty);
      // Reusing UNALLOCATED/NOT_SPECIFIED in another quarter creates no second scope (canonical identity is shared, not duplicated).
      const d3 = await draft(a.token, 2050, 3, 0, [{ historicalSubjectId: subj2, partyKind: 'UNALLOCATED', contractKind: 'NOT_SPECIFIED', amountMln: '10.00' }]);
      assert.equal((await commit(a.token, 2050, 3, d3, 0)).status, 200);
      const n = (await owner.query("SELECT (SELECT count(*)::int FROM fin_party_scopes WHERE tenant_id=$1 AND kind='UNALLOCATED') u, (SELECT count(*)::int FROM fin_contract_scopes k JOIN fin_party_scopes p ON p.tenant_id=k.tenant_id AND p.id=k.party_scope_id WHERE k.tenant_id=$1 AND p.kind='UNALLOCATED' AND k.kind='NOT_SPECIFIED') ns", [tenantA])).rows[0];
      assert.deepEqual(n, { u: 1, ns: 1 });
    });

    await check('FIN1-05 HTTP: every invalid or ambiguous party/contract combination is refused with ZERO writes', async () => {
      const foreignContractor = (await owner.query("INSERT INTO contractors(tenant_id,name) VALUES($1,'gaps foreign contractor') RETURNING id", [tenantB])).rows[0].id as string;
      const cases: Array<[string, any]> = [
        ['UNALLOCATED that also names a party id', { historicalSubjectId: subj, partyKind: 'UNALLOCATED', partyId: histParty, contractKind: 'NOT_SPECIFIED', amountMln: '10.00' }],
        ['NOT_SPECIFIED that also carries a contract number', { historicalSubjectId: subj, partyKind: 'UNALLOCATED', contractKind: 'NOT_SPECIFIED', contractNumber: 'D-1', amountMln: '10.00' }],
        ['KNOWN without number', { historicalSubjectId: subj, partyKind: 'UNALLOCATED', contractKind: 'KNOWN', amountMln: '10.00' }],
        ['KNOWN with blank number', { historicalSubjectId: subj, partyKind: 'UNALLOCATED', contractKind: 'KNOWN', contractNumber: '   ', amountMln: '10.00' }],
        ['CORE_CONTRACTOR without id', { historicalSubjectId: subj, partyKind: 'CORE_CONTRACTOR', contractKind: 'NOT_SPECIFIED', amountMln: '10.00' }],
        ['CORE_CONTRACTOR of another tenant', { historicalSubjectId: subj, partyKind: 'CORE_CONTRACTOR', partyId: foreignContractor, contractKind: 'NOT_SPECIFIED', amountMln: '10.00' }],
        ['HISTORICAL_PARTY unknown id', { historicalSubjectId: subj, partyKind: 'HISTORICAL_PARTY', partyId: randomUUID(), contractKind: 'NOT_SPECIFIED', amountMln: '10.00' }],
        ['party kind NONE', { historicalSubjectId: subj, partyKind: 'NONE', contractKind: 'NOT_SPECIFIED', amountMln: '10.00' }],
        ['contract kind NONE (an explicit "no contract" claim)', { historicalSubjectId: subj, partyKind: 'UNALLOCATED', contractKind: 'NONE', amountMln: '10.00' }],
        ['missing contract kind', { historicalSubjectId: subj, partyKind: 'UNALLOCATED', amountMln: '10.00' }],
        ['missing party kind', { historicalSubjectId: subj, contractKind: 'NOT_SPECIFIED', amountMln: '10.00' }],
        ['subject given twice (core and historical)', { coreObjectId: randomUUID(), historicalSubjectId: subj, partyKind: 'UNALLOCATED', contractKind: 'NOT_SPECIFIED', amountMln: '10.00' }],
      ];
      const snapshot = await cnt(tenantA); const snapshotB = await cnt(tenantB);
      for (const [label, line] of cases) {
        const r = await api('buffers', a.token, 'POST', { year: 2051, quarter: 1, expectedBookVersion: 0, lines: [line] });
        assert.ok(r.status >= 400 && r.status < 500, label + ' -> HTTP ' + r.status + ' ' + r.text.slice(0, 120));
        console.log('OBSERVATION FIN1-05 refused: ' + label + ' -> HTTP ' + r.status + ' ' + JSON.stringify(r.body?.message));
        assert.deepEqual(await cnt(tenantA), snapshot, label + ' wrote rows');
        assert.deepEqual(await cnt(tenantB), snapshotB, label + ' touched another tenant');
      }
    });

    await check('FIN1-05 HTTP: discovery and reads never create parties, scopes or contractors (read-only)', async () => {
      const s = await cnt(tenantA);
      for (let i = 0; i < 3; i++) { assert.equal((await api('subjects', a.token)).status, 200); assert.equal((await readQ(a.token, 2050, 2)).status, 200); assert.equal((await readQ(gd.token, 2050, 2)).status, 200); }
      assert.deepEqual(await cnt(tenantA), s);
    });

    // ---------------------------------------------------------------------------------------------------- FIN1-23
    const Y = 2060; // fresh quarter with a 2-line book: 6.00 + 4.00 = 10.00
    // integer cents -> canonical 'N.NN' string (no binary floating point anywhere in the fixtures)
    const mln = (hundredths: number) => `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, '0')}`;
    const baseLines = (i: number) => [
      { historicalSubjectId: subj, partyKind: 'UNALLOCATED', contractKind: 'NOT_SPECIFIED', amountMln: mln(600 + 25 * i) },
      { historicalSubjectId: subj2, partyKind: 'UNALLOCATED', contractKind: 'NOT_SPECIFIED', amountMln: mln(400 + 25 * i) }];
    let rev = 0;
    const correct = async (i: number, quarter = 1, token = a.token) => {
      const d = await draft(token, Y, quarter, rev, baseLines(i));
      const r = await commit(token, Y, quarter, d, rev, rev === 0 ? {} : { reason: 'gaps correction ' + i });
      assert.equal(r.status, 200, JSON.stringify(r.body)); rev++;
    };
    await correct(0);

    await check('FIN1-23 deterministic: an open REPEATABLE READ READ ONLY snapshot is not torn by a concurrent committed correction (one connection)', async () => {
      const readInTx = async (tx: any) => (await tx.c.query('SELECT public.fin_sdo_read_quarter($1,$2,$3,NULL) AS result', [a.token, Y, 1])).rows[0].result;
      let during: any, firstPid: number, secondPid: number, iso: string, ro: string, writerMs = -1;
      await runFinSdoSnapshotRead(async tx => {
        iso = (await tx.c.query('SHOW transaction_isolation')).rows[0].transaction_isolation;
        ro = (await tx.c.query('SHOW transaction_read_only')).rows[0].transaction_read_only;
        firstPid = (await tx.c.query('SELECT pg_backend_pid() pid')).rows[0].pid;
        const r1 = await readInTx(tx); assert.deepEqual(readViolations(r1), []);
        const t0 = Date.now();
        await correct(1); // a DIFFERENT restricted connection commits revision 2 while this snapshot is open: must not block on us
        writerMs = Date.now() - t0;
        const r2 = await readInTx(tx);
        secondPid = (await tx.c.query('SELECT pg_backend_pid() pid')).rows[0].pid;
        during = { r1, r2 };
      });
      assert.deepEqual(during.r2, during.r1, 'the snapshot saw nothing of the concurrent commit');
      assert.equal(iso!, 'repeatable read'); assert.equal(ro!, 'on'); assert.equal(firstPid!, secondPid!, 'one connection for the whole read');
      assert.equal(during.r1.revisionNo, 1);
      assert.ok(writerMs >= 0 && writerMs < 10000, 'writer was not blocked by an open reader');
      const fresh = (await readQ(a.token, Y, 1)).body;
      assert.equal(fresh.revisionNo, 2); assert.deepEqual(readViolations(fresh), []);
    });

    await check('FIN1-23 negative control: a NON-snapshot two-statement read IS torn by the same writer (the invariant checker is not vacuous)', async () => {
      const c = await owner.connect(); // READ COMMITTED, two separate statements, no snapshot: exactly what the protected path avoids
      try {
        const head = (await c.query("SELECT revision_no, new_total_rub::text t FROM fin_quarter_book_revisions r JOIN fin_quarter_plan_books b ON b.tenant_id=r.tenant_id AND b.id=r.book_id WHERE b.tenant_id=$1 AND b.plan_year=$2 AND b.plan_quarter=1 ORDER BY revision_no DESC LIMIT 1", [tenantA, Y])).rows[0];
        await correct(2); // commits revision 3 between the two statements
        const lines = (await c.query("SELECT lr.new_amount_rub::text a FROM fin_quarter_plan_lines pl JOIN fin_quarter_plan_books b ON b.tenant_id=pl.tenant_id AND b.id=pl.book_id JOIN LATERAL (SELECT new_amount_rub FROM fin_quarter_plan_line_revisions r WHERE r.tenant_id=pl.tenant_id AND r.plan_line_id=pl.id ORDER BY line_revision_no DESC LIMIT 1) lr ON TRUE WHERE b.tenant_id=$1 AND b.plan_year=$2 AND b.plan_quarter=1", [tenantA, Y])).rows;
        const torn = { status: 'ACTIVE', history: [{ revision_no: 1, new_total_rub: head.t }], revisionNo: 1, bookVersion: 1, original: head.t, current: head.t, lines: lines.map(l => ({ created_in_book_revision: 1, amount_rub: l.a })) };
        assert.ok(head.revision_no === 2 && readViolations(torn).some(x => x.startsWith('SUM(lines)')), 'a torn read must be flagged: ' + JSON.stringify(readViolations(torn)));
      } finally { c.release(); }
    });

    await check('FIN1-23 stress: concurrent restricted-pool writer vs HTTP + direct snapshot readers (incl. read-only GENERAL_DIRECTOR): every read consistent and monotonic', async () => {
      const N = 14; let writerDone = false; const seen = new Set<number>(); let reads = 0;
      const readerErrors: string[] = [];
      const observe = (who: string, r: any, last: { n: number }) => {
        reads++;
        const v = readViolations(r); if (v.length) readerErrors.push(who + ': ' + v.join('; '));
        if (r.revisionNo < last.n) readerErrors.push(who + ': revision went backwards ' + last.n + ' -> ' + r.revisionNo);
        last.n = r.revisionNo; seen.add(r.revisionNo);
      };
      const httpReader = async (who: string, token: string) => { const last = { n: 0 }; while (!writerDone) { const r = await readQ(token, Y, 1); assert.equal(r.status, 200, r.text); observe(who, r.body, last); } const r = await readQ(token, Y, 1); observe(who, r.body, last); };
      // Two reads inside ONE snapshot with a pause between them: under REPEATABLE READ they are identical whatever the writer commits meanwhile.
      const directReader = async (who: string) => {
        const last = { n: 0 };
        while (!writerDone) {
          const [r1, r2] = await runFinSdoSnapshotRead(async tx => {
            const rd = async () => (await tx.c.query('SELECT public.fin_sdo_read_quarter($1,$2,$3,NULL) AS result', [a.token, Y, 1])).rows[0].result;
            const x = await rd(); await new Promise(res => setTimeout(res, 15)); return [x, await rd()];
          });
          if (JSON.stringify(r1) !== JSON.stringify(r2)) readerErrors.push(who + ': two reads of one snapshot differ (rev ' + r1.revisionNo + ' vs ' + r2.revisionNo + ')');
          observe(who, r1, last);
        }
      };
      const writer = (async () => { try { for (let i = 3; i < 3 + N; i++) await correct(i); } finally { writerDone = true; } })();
      await Promise.all([writer, httpReader('http-sdo-1', a.token), httpReader('http-sdo-2', a.token), httpReader('http-gd-1', gd.token), httpReader('http-gd-2', gd.token), directReader('direct-1'), directReader('direct-2')]);
      assert.deepEqual(readerErrors, [], 'inconsistent reads: ' + readerErrors.slice(0, 3).join(' | '));
      assert.ok(reads >= 60, 'enough reads overlapped the writer: ' + reads);
      assert.ok(seen.size >= 5, 'readers observed many distinct revisions while the writer ran: ' + [...seen].sort((x, y) => x - y).join(','));
      const final = (await readQ(a.token, Y, 1)).body;
      assert.equal(final.revisionNo, 3 + N); assert.deepEqual(readViolations(final), []);
      assert.equal(final.original, '10000000.00', 'original untouched by the whole run');
      console.log(`OBSERVATION FIN1-23 stress: reads=${reads} distinct_revisions=${seen.size} final_revision=${final.revisionNo}`);
    });

    await check('DEC-01 preserved under the same load: PTO denied, cross-tenant sees nothing, read-only GENERAL_DIRECTOR cannot write', async () => {
      assert.equal((await readQ(pto.token, Y, 1)).status, 403);
      const foreign = await readQ(b.token, Y, 1); assert.equal(foreign.status, 200); assert.equal(foreign.body.status, 'NO_PLAN');
      assert.ok(!foreign.text.includes('10000000.00') || foreign.body.status === 'NO_PLAN');
      const w = await api('buffers', gd.token, 'POST', { year: Y, quarter: 2, expectedBookVersion: 0, lines: baseLines(0) });
      assert.equal(w.status, 403);
      // no direct table access for the restricted login (boundary unchanged)
      try { await restrictedFinConnectionPool().query('SELECT 1 FROM public.fin_quarter_plan_books LIMIT 1'); assert.fail('direct SELECT must be denied'); }
      catch (e: any) { if (e instanceof assert.AssertionError) throw e; assert.equal(e.code, '42501'); }
    });

    await check('scope guard: this script created no FIN-2/3 object and no table outside the 12 FIN-1 tables', async () => {
      const t = (await owner.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'fin\\_%' ORDER BY 1")).rows.map(r => r.table_name);
      assert.deepEqual(t, ['fin_command_ledger', 'fin_contract_scopes', 'fin_historical_parties', 'fin_historical_subjects', 'fin_party_scopes', 'fin_plan_edit_session_lines', 'fin_plan_edit_sessions', 'fin_quarter_book_revisions', 'fin_quarter_plan_books', 'fin_quarter_plan_line_revisions', 'fin_quarter_plan_lines', 'fin_subjects']);
    });
  } finally {
    await app.close();
  }
  if (failures.length) { console.log('EVIDENCE-GAPS FAILURES: ' + failures.length + '\n - ' + failures.join('\n - ')); process.exitCode = 1; }
  else console.log('EVIDENCE-GAPS all checks PASS (executor evidence: FIN1-05 and FIN1-23; not an acceptance verdict)');
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
  await restrictedFinConnectionPool().end().catch(() => undefined);
  await owner.end();
});
