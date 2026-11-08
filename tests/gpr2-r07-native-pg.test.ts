import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createIsolatedDatabase, recordEvidence, scrubConnectionEnvironment, Session, until, advisoryHolders, isBlockedOnLock, settle, type IsolatedDatabase } from './helpers/gpr2-native-pg';
import { pilotScenario } from './helpers/gpr-fixtures';
import { tokenFor } from './helpers/pbx3-fixtures';
import { foreignTenantObject } from './helpers/gpr2-fixtures';
import { contentHash, gpr2RoleMatrix, Gpr2Permission } from '../packages/domain/gpr2';
import { roles } from '../packages/domain';

/**
 * GPR-2 R07 — the claims PGlite cannot carry, on NATIVE PostgreSQL (the isolated cluster `gpr2-p1-isolated`, ONE fresh `gpr2_p1_*` database for this file;
 * never LIVE, never an inherited DATABASE_URL — the helper refuses anything else). R07a–d, A04 / A06 / A07 / A19 / A30.
 *
 * WHAT IS ENFORCED WHERE (the contract these tests pin; coordinator disposition D-1 / R07-REV-03 asked for it to be stated):
 *   DATABASE (must hold for any writer, including direct SQL by the application role)
 *     - R06b freeze: an allocation pointer WITHOUT a request is refused once any fact / SC / customer evidence exists            (N5, D4)
 *     - protected Work floor under a request-bound pointer, and "no closing allocation"                                          (N3, D8)
 *     - a request-bound pointer needs a request of THIS Work, one version per (Work, request), history rows immutable           (D2b, D2c, D5)
 *     - a reduced Work needs a coherent allocation snapshot                                                                      (D6)
 *     - the per-portion protected floor of a request-bound allocation                                                            (D3  = R07-REV-03 b)
 *     - the provenance of "APPROVED" (the request really was submitted and decided by someone else)                              (D1  = R07-REV-03 a)
 *     - a request-bound version is built on the source version the request was written against                                   (D2a = R07-REV-03 request/version mismatch)
 *   HTTP / SERVICE (guarded /v2): roles, tenant / object scope, author != approver, auth-before-replay                           (A19)
 *   FACT WRITERS: a new fact is serialised with approval by the object coordination lock; they are the only writers of facts       (N2)
 *
 * The three tests marked R07-REV-03 assert the FAIL-CLOSED behaviour. If the database accepts the forgery, they FAIL: that is the finding (R07-REV-03
 * stays OPEN), not a test to skip, weaken or "fix" by accepting the observed behaviour. Every race is staged with a barrier PostgreSQL itself reports
 * (a granted / waiting advisory lock on the object's coordination key, a backend waiting on a lock) — never with a sleep.
 */
scrubConnectionEnvironment();

const KEY = randomUUID();
const D = (sql: string) => `SELECT md5(coalesce(string_agg(t::text,'|' ORDER BY t::text),'')) AS d, count(*)::int AS n FROM (${sql}) t`;

let db: IsolatedDatabase;
let observer: Session;
let pool: any, one: any;
let coordinationKey: (tenant: string, object: string) => bigint;
let readMigrationFiles: any, planMigrationsOnDatabase: any, migrateFn: any;
let api: any, base = '';
let token = '';
let preUpgrade: any;
const live = { tenant: '', object: '' };

before(async () => {
    db = await createIsolatedDatabase('r07');
    process.env.DATABASE_URL = db.url;
    process.env.AUTH_MODE = 'mock';
    process.env.MOCK_LOGIN_KEY = KEY;
    process.env.GPR2_CONTRACT_ROUTES = 'enabled'; // must be set before main.ts is imported (the module list is fixed at import)
    process.env.RATE_LIMIT_MAX = '100000';
    process.env.AUTH_RATE_LIMIT_MAX = '100000';
    delete process.env.DB_MODE;
    ({ pool, one } = await import('../apps/backend/src/db'));
    ({ coordinationKey } = await import('../apps/backend/src/coordination-lock'));
    ({ readMigrationFiles } = await import('../scripts/migration-runner'));
    ({ migrate: migrateFn, planMigrationsOnDatabase } = await import('../scripts/migrate') as any);
    const { seed } = await import('../scripts/seed');
    observer = await Session.open(db.url, 'r07-observer');
    await migrateFn({ through: 37 });
    await seed();
    const PROTECTED: Record<string, string> = {
        works: 'SELECT row_to_json(w)::text FROM works w', weu: 'SELECT row_to_json(u)::text FROM work_execution_units u', portions: 'SELECT row_to_json(p)::text FROM quantity_portions p',
        confirmations: 'SELECT row_to_json(c)::text FROM portion_quantity_confirmations c', progress: 'SELECT row_to_json(p)::text FROM work_progress p',
        currentQuantity: 'SELECT row_to_json(q)::text FROM work_current_quantity q', quantityVersions: 'SELECT row_to_json(v)::text FROM work_quantity_versions v',
        allocationVersions: "SELECT (to_jsonb(a) - 'approved_request_id')::text FROM work_allocation_versions a", allocationLines: 'SELECT row_to_json(l)::text FROM work_allocation_lines l',
        currentAllocation: 'SELECT row_to_json(a)::text FROM work_current_allocation a', users: 'SELECT row_to_json(u)::text FROM users u', objects: 'SELECT row_to_json(o)::text FROM objects o',
        ledger: "SELECT version||':'||coalesce(checksum,'')||':'||coalesce(migration_class,'') FROM schema_migrations WHERE version<=37"
    };
    const digests: Record<string, any> = {};
    for (const [k, sql] of Object.entries(PROTECTED))
        digests[k] = (await pool.query(D(sql))).rows[0];
    const guardOid = (await pool.query("SELECT oid::int AS oid FROM pg_proc WHERE proname='r06b_pointer_guard'")).rows;
    const triggerFn = (await pool.query("SELECT tgfoid::int AS oid FROM pg_trigger WHERE tgname='r06b_pointer_validate' AND NOT tgisinternal")).rows;
    const guardDef = (await pool.query("SELECT pg_get_functiondef(oid) AS def FROM pg_proc WHERE proname='r06b_pointer_guard'")).rows[0].def as string;
    preUpgrade = { PROTECTED, digests, guardOid, triggerFn, guardDef };
});

after(async () => {
    await api?.close().catch(() => undefined);
    await observer?.close();
    await pool?.end().catch(() => undefined);
    await db?.drop();
});

// ------------------------------------------------------------------------------------------------------------------------------------------------
// 037 -> 038 on a seeded database; everything else builds on it
// ------------------------------------------------------------------------------------------------------------------------------------------------
let upgradeRun: Promise<any> | undefined;
const upgraded = () => (upgradeRun ??= (async () => {
    const plan = await planMigrationsOnDatabase();
    assert.deepEqual(plan.pending.map((p: any) => [p.version, p.class]), [[38, 'additive']], 'exactly 038 is pending on a 037 database, and it is additive');
    const applied = await migrateFn();
    assert.deepEqual(applied.applied.map((a: any) => a.version), [38]);
    return { plan, applied };
})());

test('N1 037 -> 038 native upgrade: only 038 applies, no protected row changes, ledger/checksum recorded, re-run is a no-op, an edited 038 would be refused', async () => {
    const { plan } = await upgraded();
    const { PROTECTED, digests } = preUpgrade;
    for (const [k, sql] of Object.entries(PROTECTED as Record<string, string>))
        assert.deepEqual((await pool.query(D(sql))).rows[0], digests[k], 'protected data unchanged by 038: ' + k);
    const file = readMigrationFiles('infra').find((f: any) => f.version === 38);
    const row = (await pool.query('SELECT version, checksum, migration_class FROM schema_migrations WHERE version=38')).rows[0];
    assert.equal(row.migration_class, 'additive'); assert.equal(row.checksum, file.checksum); assert.match(row.checksum, /^[0-9a-f]{64}$/);
    assert.equal((await migrateFn()).applied.length, 0, 're-run is a no-op');
    assert.deepEqual((await planMigrationsOnDatabase()).pending, [], 'nothing pending afterwards');
    // CREATE OR REPLACE FUNCTION keeps the function's identity and its trigger: same OID, the trigger still calls it, the body is the new one.
    const guardOid = (await pool.query("SELECT oid::int AS oid FROM pg_proc WHERE proname='r06b_pointer_guard'")).rows;
    const triggerFn = (await pool.query("SELECT tgfoid::int AS oid FROM pg_trigger WHERE tgname='r06b_pointer_validate' AND NOT tgisinternal")).rows;
    assert.deepEqual(guardOid, preUpgrade.guardOid); assert.deepEqual(triggerFn, preUpgrade.triggerFn); assert.equal(triggerFn[0].oid, guardOid[0].oid);
    const def = (await pool.query("SELECT pg_get_functiondef(oid) AS def FROM pg_proc WHERE proname='r06b_pointer_guard'")).rows[0].def as string;
    assert.ok(!preUpgrade.guardDef.includes('R07:') && def.includes('R07: allocation pointer requires approved quantity request'), 'the body really was replaced');
    assert.ok(def.includes('R06B: allocation is frozen after confirmed evidence'), 'and the R06b freeze message and predicate are still in it');
    // The forward-only rollback contract (D-1): an applied 038 is protected by its checksum; editing it is refused, never silently re-applied.
    try {
        await pool.query("UPDATE schema_migrations SET checksum=repeat('0',64) WHERE version=38");
        await assert.rejects(planMigrationsOnDatabase(), (e: any) => e?.code === 'MIGRATION_CHANGED_AFTER_APPLY');
    } finally { await pool.query('UPDATE schema_migrations SET checksum=$1 WHERE version=38', [file.checksum]); }
    assert.deepEqual((await planMigrationsOnDatabase()).pending, []);
    recordEvidence('r07-native-upgrade', { cluster: db.evidence, from: 37, applied: [38], pending: plan.pending, checksum: row.checksum, protectedUnchanged: Object.keys(digests), guardFunctionOid: guardOid[0].oid });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------
// the world: the real backend over this database, the pilot scenario, helpers
// ------------------------------------------------------------------------------------------------------------------------------------------------
type World = Awaited<ReturnType<typeof pilotScenario>> & { pmTok: string; deputyTok: string };
let worldRun: Promise<World> | undefined;
async function raw(path: string, body?: any) {
    const r = await fetch(base + '/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, data: (await r.json().catch(() => null)) as any };
}
async function req(path: string, body?: any, expected = body === undefined ? 200 : 201) {
    const r = await raw(path, body);
    if (r.status !== expected) throw new Error(`${path}: expected ${expected}, got ${r.status}: ${JSON.stringify(r.data)}`);
    return r.data;
}
const harness = { raw, req, login: async (role: string) => { const d = await req('auth/mock', { role, key: KEY }, 201); token = d.token; return d.user; }, as: async (user: any) => { token = await tokenFor(user); return user; } };
async function roleToken(role: string) { const r = await fetch(`${base}/auth/mock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role, key: KEY }) }); return (await r.json()).token as string; }
async function call(tok: string | null, method: string, path: string, opts: { body?: unknown; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}), ...opts.headers };
    const r = await fetch(base + '/' + path.replace(/^\//, ''), { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
}
const world = (): Promise<World> => (worldRun ??= (async () => {
    await upgraded();
    const { createApp } = await import('../apps/backend/src/main');
    api = await createApp();
    await api.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${api.getHttpServer().address().port}`;
    const w = await pilotScenario(harness as any);
    live.tenant = w.pm.tenantId; live.object = w.object.id;
    return { ...w, pmTok: await tokenFor(w.pm), deputyTok: await roleToken('DEPUTY_DIRECTOR') };
})());

const row = async (sql: string, args: any[] = []) => (await pool.query(sql, args)).rows[0];
const all = async (sql: string, args: any[] = []) => (await pool.query(sql, args)).rows;
const rpath = (W: World) => `/v2/objects/${W.object.id}/quantity-change-requests`;
const cmd = (W: World, tok: string, method: string, suffix: string, body: any, key: string = randomUUID()) => call(tok, method, rpath(W) + suffix, { body, headers: { 'Idempotency-Key': key } });
const scopeVersion = async (W: World) => String((await row('SELECT scope_version FROM work_scope_state WHERE tenant_id=$1 AND object_id=$2', [W.pm.tenantId, W.object.id])).scope_version);
const currentVersion = async (workId: string) => (await row('SELECT approved_version_id AS id FROM work_current_quantity WHERE work_id=$1', [workId])).id as string;
const currentQuantity = async (workId: string) => (await row('SELECT v.quantity::text AS q FROM work_current_quantity p JOIN work_quantity_versions v ON v.id=p.approved_version_id WHERE p.work_id=$1', [workId])).q as string;
const rpFacts = async (portionId: string) => (await all("SELECT id, quantity::text AS quantity FROM portion_quantity_confirmations WHERE portion_id=$1 AND source='RP_FACT' ORDER BY id", [portionId]));

async function mkWork(W: World, name: string, quantity: number, units: { quantity: number; portions: number[] }[] = []) {
    await harness.as(W.pm);
    const work = await req('works', { objectId: W.object.id, workTypeId: W.plaster.id, contractorId: W.contractors[0].id, responsibleUserId: W.pm.id, name, unit: 'м²', plannedQuantity: quantity, plannedStartDate: '2026-03-01', plannedFinishDate: '2026-04-30', estimatedCost: '100000' });
    const made: { unit: any; portions: any[] }[] = [];
    for (const [i, u] of units.entries()) {
        const unit = await req('execution-units', { objectWorkId: work.id, workTypeId: W.plaster.id, contractorId: W.contractors[0].id, unit: 'м²', plannedQuantity: u.quantity, location: name + ' зона ' + (i + 1) });
        const portions: any[] = [];
        for (const [j, q] of u.portions.entries()) portions.push(await req(`execution-units/${unit.id}/portions`, { label: name + ' участок ' + (i + 1) + '.' + (j + 1), plannedQuantity: q }));
        made.push({ unit, portions });
    }
    return { work, units: made };
}
/** The real RP fact route (POST portions/:id/fact), with an explicit token so it can run next to another call. */
async function reportFactHttp(W: World, portionId: string, quantity: number | string) {
    const snap = await call(W.pmTok, 'GET', 'snapshot');
    const portion = snap.body.portions.find((p: any) => p.id === portionId);
    return call(W.pmTok, 'POST', `portions/${portionId}/fact`, { body: { quantity, version: portion.version, comment: 'Факт РП (R07 native)' } });
}
/** create + submit a quantity request; returns the id and the exact approve / return bodies for the submitted snapshot. */
async function submitted(W: World, workId: string, newQuantity: string, extra: Record<string, unknown> = {}) {
    const source = await currentVersion(workId); const scope = await scopeVersion(W); const fp = randomUUID().replace(/-/g, '').repeat(2);
    const c = await cmd(W, W.pmTok, 'POST', '', { expectedScopeVersion: scope, payload: { workId, newQuantity, reason: 'R07 native ' + newQuantity, inputFingerprint: fp, expectedSourceVersions: { quantity: source }, ...extra } });
    assert.equal(c.status, 200, JSON.stringify(c.body)); const id = c.body.resultIds[0] as string;
    const s = await cmd(W, W.pmTok, 'POST', `/${id}/submit`, { expectedVersion: '1', expectedScopeVersion: scope, payload: { inputFingerprint: fp, expectedSourceVersions: { quantity: source } } });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    const saved = await row('SELECT payload FROM gpr2_quantity_submissions WHERE request_id=$1 AND number=1', [id]);
    return { id, source, scope, approve: { expectedVersion: '2', expectedScopeVersion: scope, payload: { inputFingerprint: contentHash(saved.payload), expectedSourceVersions: { quantity: source } } } };
}
const approve = (W: World, r: { id: string; approve: any }, tok = W.deputyTok) => cmd(W, tok, 'POST', `/${r.id}/approve`, r.approve);
const allocationFor = (units: { unit: any; portions: any[] }[], quantities: number[][]) => ({ expectedVersionId: null, units: units.map((u, i) => ({
    executionUnitId: u.unit.id, quantity: String(quantities[i].reduce((s, q) => s + q, 0)), portions: u.portions.map((p, j) => ({ portionId: p.id, quantity: String(quantities[i][j]) })) })) });

/** A direct-SQL transaction as the application role; resolves with the COMMIT outcome so a deferred guard can be asserted. */
async function directSql(steps: (c: any) => Promise<void>): Promise<{ committed: boolean; error?: any }> {
    const c = await pool.connect();
    try {
        await c.query('BEGIN');
        await steps(c);
        await c.query('COMMIT');
        return { committed: true };
    } catch (error) {
        await c.query('ROLLBACK').catch(() => undefined);
        return { committed: false, error };
    } finally { c.release(); }
}
const forgeRequest = (c: any, W: World, workId: string, quantityVersionId: string, quantity: number, state = 'APPROVED') => c.query(
    `INSERT INTO gpr2_quantity_requests(tenant_id,object_id,work_id,state,proposed_quantity,quantity_version_id,reason,author_id) VALUES($1,$2,$3,$4,$5,$6,'direct SQL (R07 native)',$7) RETURNING id`,
    [W.pm.tenantId, W.object.id, workId, state, quantity, quantityVersionId, W.pm.id]).then((r: any) => r.rows[0].id as string);
const forgeVersion = (c: any, W: World, workId: string, sequence: number, quantity: number, requestId: string, previousId: string) => c.query(
    `INSERT INTO work_quantity_versions(tenant_id,object_id,work_id,sequence,quantity,unit,source_kind,approved_request_id,previous_id,created_by) VALUES($1,$2,$3,$4,$5,'м²','APPROVED_REQUEST',$6,$7,$8) RETURNING id`,
    [W.pm.tenantId, W.object.id, workId, sequence, quantity, requestId, previousId, W.pm.id]).then((r: any) => r.rows[0].id as string);
const movePointer = (c: any, workId: string, versionId: string) => c.query('UPDATE work_current_quantity SET approved_version_id=$1 WHERE work_id=$2', [versionId, workId]);
/**
 * R07-REV-03a (migration 038): a bare `state='APPROVED'` is refused by the database now, so a test that wants to show a DIFFERENT guard (the protected floor,
 * the coherent allocation snapshot, the stale source) must first give the forged request a complete and consistent history: the strongest forgery a writer with
 * the application role can make (its own residual boundary, stated in 038 and in the report). The deciding user is looked up by the caller BEFORE the transaction.
 */
const deciderId = async (W: World) => (await row("SELECT id FROM users WHERE tenant_id=$1 AND role='DEPUTY_DIRECTOR' AND is_active=true ORDER BY created_at LIMIT 1", [W.pm.tenantId])).id as string;
const approveBySql = async (c: any, requestId: string, decider: string) => {
    const r = (await c.query('SELECT tenant_id,object_id,submission_number FROM gpr2_quantity_requests WHERE id=$1', [requestId])).rows[0];
    await c.query("UPDATE gpr2_quantity_requests SET state='APPROVED',decided_by=$2 WHERE id=$1", [requestId, decider]);
    await c.query("INSERT INTO gpr2_quantity_events(tenant_id,object_id,request_id,submission_number,action,actor_id) VALUES($1,$2,$3,$4,'APPROVE',$5)", [r.tenant_id, r.object_id, requestId, r.submission_number, decider]);
};
const fabricateApproved = async (c: any, W: World, workId: string, source: string, quantity: number, decider: string, allocation: any = null) => {
    const id = (await c.query(`INSERT INTO gpr2_quantity_requests(tenant_id,object_id,work_id,proposed_quantity,quantity_version_id,reason,author_id,allocation) VALUES($1,$2,$3,$4,$5,'direct SQL (R07 native)',$6,$7::jsonb) RETURNING id`,
        [W.pm.tenantId, W.object.id, workId, quantity, source, W.pm.id, allocation === null ? null : JSON.stringify(allocation)])).rows[0].id as string;
    const payload: any = { workId, newQuantity: String(quantity), quantityVersionId: source, reason: 'direct SQL (R07 native)' };
    if (allocation !== null) payload.allocation = allocation;
    await c.query('INSERT INTO gpr2_quantity_submissions(tenant_id,object_id,request_id,number,payload,submitted_by) VALUES($1,$2,$3,1,$4::jsonb,$5)', [W.pm.tenantId, W.object.id, id, JSON.stringify(payload), W.pm.id]);
    await c.query("INSERT INTO gpr2_quantity_events(tenant_id,object_id,request_id,submission_number,action,actor_id) VALUES($1,$2,$3,1,'SUBMIT',$4)", [W.pm.tenantId, W.object.id, id, W.pm.id]);
    await c.query("UPDATE gpr2_quantity_requests SET state='SUBMITTED',submitter_id=$2,submission_number=1 WHERE id=$1", [id, W.pm.id]);
    await approveBySql(c, id, decider);
    return id;
};

// ------------------------------------------------------------------------------------------------------------------------------------------------
// N3 / A04 — the exact protected floor, and HTTP-level evidence that the committed state is what the request said
// ------------------------------------------------------------------------------------------------------------------------------------------------
test('N3 1000 -> 800: fact 800 is accepted, fact 850 is refused with the version and quantity untouched, and the committed state matches the request exactly', async () => {
    const W = await world();
    const ok = await mkWork(W, 'R07N floor 800', 1000, [{ quantity: 1000, portions: [1000] }]);
    await reportFactHttp(W, ok.units[0].portions[0].id, 800).then(r => assert.ok(r.status < 300, JSON.stringify(r.body)));
    const before = await currentVersion(ok.work.id);
    const granted = await submitted(W, ok.work.id, '800', { allocation: allocationFor(ok.units, [[800]]) });
    const done = await approve(W, granted);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(await currentQuantity(ok.work.id), '800.0000');
    const after = await row('SELECT v.sequence, v.previous_id, v.approved_request_id, v.source_kind FROM work_current_quantity p JOIN work_quantity_versions v ON v.id=p.approved_version_id WHERE p.work_id=$1', [ok.work.id]);
    assert.deepEqual([after.sequence, after.previous_id, after.approved_request_id, after.source_kind], [2, before, granted.id, 'APPROVED_REQUEST']);
    assert.equal((await rpFacts(ok.units[0].portions[0].id)).length, 1, 'the reported RP fact is the only RP_FACT: the excluded 200 was never written as one');

    const bad = await mkWork(W, 'R07N floor 850', 1000, [{ quantity: 1000, portions: [1000] }]);
    await reportFactHttp(W, bad.units[0].portions[0].id, 850).then(r => assert.ok(r.status < 300, JSON.stringify(r.body)));
    const priorBad = await currentVersion(bad.work.id);
    const refused = await submitted(W, bad.work.id, '800', { allocation: allocationFor(bad.units, [[800]]) });
    const res = await approve(W, refused);
    assert.equal(res.status, 422, JSON.stringify(res.body)); assert.equal(res.body.code, 'BELOW_PROTECTED_QUANTITY');
    assert.equal(await currentVersion(bad.work.id), priorBad); assert.equal(await currentQuantity(bad.work.id), '1000.0000');
    assert.equal((await row('SELECT count(*)::int AS n FROM work_quantity_versions WHERE work_id=$1', [bad.work.id])).n, 1, 'no version was written');
    assert.equal((await row('SELECT state FROM gpr2_quantity_requests WHERE id=$1', [refused.id])).state, 'SUBMITTED', 'the request stays SUBMITTED');
});

// ------------------------------------------------------------------------------------------------------------------------------------------------
// N2 / A06 / A30 — a real SHARED fact writer against the EXCLUSIVE approve on two real connections, in BOTH orders
// ------------------------------------------------------------------------------------------------------------------------------------------------
type Order = 'approve-first' | 'fact-first';
async function race(order: Order, fact: number) {
    const W = await world();
    const w = await mkWork(W, `R07N race ${order} ${fact}`, 1000, [{ quantity: 1000, portions: [1000] }]);
    const portion = w.units[0].portions[0];
    const request = await submitted(W, w.work.id, '800', { allocation: allocationFor(w.units, [[800]]) });
    const key = coordinationKey(W.pm.tenantId, W.object.id);
    const holders = () => advisoryHolders(observer.client, key);
    const blocker = await Session.open(db.url, `r07-blocker-${order}-${fact}`);
    let first: Promise<any>, second: Promise<any>;
    try {
        await blocker.begin();
        if (order === 'approve-first') {
            // The approve takes the EXCLUSIVE coordination lock first (its first statement) and is then held on the Work row by the blocker.
            await blocker.query('SELECT id FROM works WHERE id=$1 FOR UPDATE', [w.work.id]);
            first = settle(approve(W, request));
            await until(async () => { const e = (await holders()).find(h => h.granted && /Exclusive/.test(h.mode)); return !!e && await isBlockedOnLock(observer.client, e.pid); }, 'the approve to hold the EXCLUSIVE coordination lock while waiting on the Work row');
            second = settle(reportFactHttp(W, portion.id, fact));
            await until(async () => (await holders()).some(h => !h.granted && /Share/.test(h.mode)), 'the real RP fact writer to queue for the SHARED coordination lock behind the approve');
        } else {
            // The real fact writer takes the SHARED coordination lock first and is then held on the portion row by the blocker.
            await blocker.query('SELECT id FROM quantity_portions WHERE id=$1 FOR UPDATE', [portion.id]);
            first = settle(reportFactHttp(W, portion.id, fact));
            await until(async () => { const s = (await holders()).find(h => h.granted && /Share/.test(h.mode)); return !!s && await isBlockedOnLock(observer.client, s.pid); }, 'the real RP fact writer to hold the SHARED coordination lock while waiting on the portion row');
            second = settle(approve(W, request));
            await until(async () => (await holders()).some(h => !h.granted && /Exclusive/.test(h.mode)), 'the approve to queue for the EXCLUSIVE coordination lock behind the fact writer');
        }
        await blocker.rollback();
    } finally { await blocker.rollback().catch(() => undefined); await blocker.close(); }
    const [a, f] = order === 'approve-first' ? [await first, await second] : [await second, await first];
    const approveRes = a.ok ? a.value : { status: -1, body: String(a.error) }, factRes = f.ok ? f.value : { status: -1, body: String(f.error) };
    const quantity = Number(await currentQuantity(w.work.id));
    const facts = await rpFacts(portion.id); const maxFact = facts.reduce((m, x) => Math.max(m, Number(x.quantity)), 0);
    const holdersAfter = await holders();
    return { w: { ...w, pmTokForRead: W.pmTok }, request, approveRes, factRes, quantity, facts, maxFact, holdersAfter };
}
const BARRIER_NOTE = 'both writers were proved queued on the coordination lock before the first was released';
for (const [order, fact] of [['approve-first', 800], ['fact-first', 800], ['approve-first', 850], ['fact-first', 850]] as [Order, number][]) {
    test(`N2 race ${order}, new fact ${fact}: one linearisation, approval never below an earlier fact, a later fact is surfaced (not clamped), no partial change, no deadlock (${BARRIER_NOTE})`, async () => {
        const r = await race(order, fact);
        assert.equal(r.holdersAfter.length, 0, 'no coordination lock is left held');
        // The guarantee R07 gives: an approval never commits BELOW a fact that was committed before it (the floor is read under the exclusive lock).
        // A fact that commits AFTER the approval is not refused by any fact writer (they only ever write facts); the approved design (R06 / TD 6.1,
        // projection.ts) makes the resulting state visible as INTEGRITY_CONFLICT and never clamps it. Both outcomes are asserted below.
        const read = await call(r.w.pmTokForRead, 'GET', `/objects/${live.object}/works/${r.w.work.id}/quantity`);
        assert.equal(read.status, 200, JSON.stringify(read.body));
        const conflict = r.quantity < r.maxFact;
        assert.equal(read.body.integrityState, conflict ? 'INTEGRITY_CONFLICT' : 'CONSISTENT', JSON.stringify(read.body));
        assert.equal(read.body.currentQuantity, r.quantity.toFixed(4)); assert.equal(read.body.factQuantity, r.maxFact.toFixed(4), 'the fact is shown as recorded, never clamped to the quantity');
        const approved = r.approveRes.status === 200;
        assert.equal(r.quantity, approved ? 800 : 1000, 'the approval is all-or-nothing');
        assert.equal((await row('SELECT count(*)::int AS n FROM work_quantity_versions WHERE work_id=$1', [r.w.work.id])).n, approved ? 2 : 1);
        assert.equal((await row('SELECT count(*)::int AS n FROM gpr2_quantity_events WHERE request_id=$1 AND action=\'APPROVE\'', [r.request.id])).n, approved ? 1 : 0);
        if (order === 'fact-first') {
            // The fact committed first, so the approval saw it.
            assert.equal(r.factRes.status < 300, true, JSON.stringify(r.factRes.body));
            assert.equal(r.maxFact, fact);
            if (fact === 850) { assert.equal(r.approveRes.status, 422, JSON.stringify(r.approveRes.body)); assert.equal(r.approveRes.body.code, 'BELOW_PROTECTED_QUANTITY'); }
            else assert.equal(r.approveRes.status, 200, JSON.stringify(r.approveRes.body));
        } else {
            // The approval committed first (no fact existed yet), so the later fact must respect the NEW quantity.
            assert.equal(r.approveRes.status, 200, JSON.stringify(r.approveRes.body));
            assert.equal(r.factRes.status < 300, true, JSON.stringify(r.factRes.body));
            assert.equal(r.maxFact, fact);
            assert.equal(r.quantity < r.maxFact, fact === 850, 'only the 850 fact, which arrived after the approval, is above the new quantity: that is the surfaced INTEGRITY_CONFLICT');
        }
        recordEvidence(`r07-native-race-${order}-${fact}`, { cluster: r.w.work.id && db.evidence, order, newFact: fact, approve: r.approveRes.status, fact: r.factRes.status, finalQuantity: r.quantity, recordedRpFact: r.maxFact });
    });
}

// ------------------------------------------------------------------------------------------------------------------------------------------------
// N5 — the R06b freeze, untouched for a pointer WITHOUT a request, against the real PostgreSQL 16 function that 038 replaced
// ------------------------------------------------------------------------------------------------------------------------------------------------
test('N5 R06b regression: without a request the allocation pointer is still frozen by any evidence, and still free before any evidence', async () => {
    const W = await world();
    const w = await mkWork(W, 'R07N R06b regression', 10, [{ quantity: 6, portions: [4] }]);
    const { replaceWorkAllocation } = await import('../apps/backend/src/gpr2-r06b-allocation');
    const { session, hash } = await import('../apps/backend/src/security');
    const login = await session(W.pm);
    const unit = w.units[0].unit, portion = w.units[0].portions[0];
    const good = await replaceWorkAllocation(W.pm, W.object.id, w.work.id, { expectedVersionId: null, units: [{ executionUnitId: unit.id, quantity: '6', portions: [{ portionId: portion.id, quantity: '4' }] }] }, hash(login.token));
    assert.equal(good.unallocatedQuantity, '4.0000', 'before any evidence the R06b path works exactly as before');
    const second = await replaceWorkAllocation(W.pm, W.object.id, w.work.id, { expectedVersionId: good.versionId, units: [{ executionUnitId: unit.id, quantity: '5', portions: [{ portionId: portion.id, quantity: '4' }] }] }, hash(login.token));
    assert.equal(second.allocatedQuantity, '5.0000', 'and it can still replace the snapshot while no evidence exists');
    // evidence arrives through the real fact route
    await reportFactHttp(W, portion.id, 2).then(r => assert.ok(r.status < 300, JSON.stringify(r.body)));
    const pointer = (await row('SELECT version_id FROM work_current_allocation WHERE work_id=$1', [w.work.id])).version_id;
    const frozen = await directSql(async c => {
        const next = (await c.query(`INSERT INTO work_allocation_versions(tenant_id,object_id,work_id,sequence,previous_id,quantity_version_id,unit,created_by)
            SELECT $1,$2,$3,3,$4,approved_version_id,'м²',$5 FROM work_current_quantity WHERE work_id=$3 RETURNING id`, [W.pm.tenantId, W.object.id, w.work.id, pointer, W.pm.id])).rows[0].id;
        await c.query('UPDATE work_current_allocation SET version_id=$1 WHERE work_id=$2', [next, w.work.id]);
    });
    assert.equal(frozen.committed, false); assert.match(String(frozen.error), /allocation is frozen after confirmed evidence/);
    assert.equal((await row('SELECT version_id FROM work_current_allocation WHERE work_id=$1', [w.work.id])).version_id, pointer);
    const viaService = await settle(replaceWorkAllocation(W.pm, W.object.id, w.work.id, { expectedVersionId: pointer, units: [{ executionUnitId: unit.id, quantity: '5', portions: [{ portionId: portion.id, quantity: '4' }] }] }, hash(login.token)));
    assert.equal(viaService.ok, false, 'the R06b service path is refused too');
});

// ------------------------------------------------------------------------------------------------------------------------------------------------
// D — direct SQL as the application role. D2b / D2c / D5 / D6 / D8 hold today; D1 / D2a / D3 are the R07-REV-03 probes (fail closed).
// ------------------------------------------------------------------------------------------------------------------------------------------------
test('D8 direct SQL: even a request with a complete forged history cannot carry the pointer below the protected floor of a real RP fact', async () => {
    const W = await world();
    const w = await mkWork(W, 'R07D8 floor', 1000, [{ quantity: 1000, portions: [1000] }]);
    await reportFactHttp(W, w.units[0].portions[0].id, 850).then(r => assert.ok(r.status < 300, JSON.stringify(r.body)));
    const prior = await currentVersion(w.work.id); const decider = await deciderId(W);
    const out = await directSql(async c => {
        const id = await fabricateApproved(c, W, w.work.id, prior, 800, decider); // a request with a complete, consistent forged history
        const v = await forgeVersion(c, W, w.work.id, 2, 800, id, prior);
        await movePointer(c, w.work.id, v);
    });
    assert.equal(out.committed, false, 'the database refuses a pointer below a real RP fact even for a request with a complete forged history');
    assert.match(String(out.error), /BELOW_PROTECTED_QUANTITY/);
    assert.equal(await currentVersion(w.work.id), prior);
});

test('D2b direct SQL: an APPROVED request of another Work cannot move this Work\'s pointer', async () => {
    const W = await world();
    const a = await mkWork(W, 'R07D2b A', 1000), b = await mkWork(W, 'R07D2b B', 1000);
    const approved = await submitted(W, a.work.id, '900');
    assert.equal((await approve(W, approved)).status, 200);
    const priorB = await currentVersion(b.work.id);
    const out = await directSql(async c => { const v = await forgeVersion(c, W, b.work.id, 2, 900, approved.id, priorB); await movePointer(c, b.work.id, v); });
    assert.equal(out.committed, false);
    assert.equal(await currentVersion(b.work.id), priorB);
});

test('D2c direct SQL: a consumed request cannot be replayed for a second version of the same Work', async () => {
    const W = await world();
    const a = await mkWork(W, 'R07D2c', 1000);
    const approved = await submitted(W, a.work.id, '900');
    assert.equal((await approve(W, approved)).status, 200);
    const now = await currentVersion(a.work.id);
    const out = await directSql(async c => { const v = await forgeVersion(c, W, a.work.id, 3, 800, approved.id, now); await movePointer(c, a.work.id, v); });
    assert.equal(out.committed, false); assert.match(String(out.error), /gpr2_r07_one_version_per_work_request|duplicate key/);
    assert.equal(await currentVersion(a.work.id), now);
});

test('D6 direct SQL: a reduced Work with larger WEU plans needs a coherent allocation snapshot at commit', async () => {
    const W = await world();
    const w = await mkWork(W, 'R07D6 reduced', 1000, [{ quantity: 900, portions: [900] }]);
    const request = await submitted(W, w.work.id, '800');
    assert.equal((await approve(W, request)).status, 422, 'the service refuses it first');
    const prior = await currentVersion(w.work.id); const decider = await deciderId(W);
    const out = await directSql(async c => {
        await approveBySql(c, request.id, decider);
        const v = await forgeVersion(c, W, w.work.id, 2, 800, request.id, prior);
        await movePointer(c, w.work.id, v);
    });
    assert.equal(out.committed, false); assert.match(String(out.error), /coherent allocation snapshot/);
    assert.equal(await currentVersion(w.work.id), prior);
});

test('D5 history is immutable: no UPDATE or DELETE of submissions, events, invalidations or recalculations (surface headers and effects: see N7)', async () => {
    const W = await world();
    const w = await mkWork(W, 'R07D5 history', 1000);
    const r = await submitted(W, w.work.id, '900');
    assert.equal((await approve(W, r)).status, 200);
    for (const [table, column] of [['gpr2_quantity_submissions', 'submitted_at'], ['gpr2_quantity_events', 'created_at'], ['gpr2_schedule_basis_invalidations', 'created_at'], ['gpr2_labor_coverage_recalculations', 'created_at']] as const) {
        assert.ok((await row(`SELECT count(*)::int AS n FROM ${table} WHERE request_id=$1`, [r.id])).n >= 1, table + ' has a row for the approved request');
        await assert.rejects(pool.query(`DELETE FROM ${table} WHERE request_id=$1`, [r.id]), /immutable/, table + ' DELETE');
        await assert.rejects(pool.query(`UPDATE ${table} SET ${column}=now() WHERE request_id=$1`, [r.id]), /immutable/, table + ' UPDATE');
        assert.ok((await row(`SELECT count(*)::int AS n FROM ${table} WHERE request_id=$1`, [r.id])).n >= 1, table + ' still has its row');
    }
    assert.equal((await row('SELECT state FROM gpr2_quantity_requests WHERE id=$1', [r.id])).state, 'APPROVED');
});

test('R07-REV-03a direct SQL: a request that was never submitted or decided cannot be forged to APPROVED and then move the pointer', async () => {
    const W = await world();
    const w = await mkWork(W, 'R07REV03a forged', 1000);
    const prior = await currentVersion(w.work.id);
    const out = await directSql(async c => {
        const id = await forgeRequest(c, W, w.work.id, prior, 700, 'APPROVED'); // no submission, no event, no decided_by, never SUBMITTED
        const v = await forgeVersion(c, W, w.work.id, 2, 700, id, prior);
        await movePointer(c, w.work.id, v);
    });
    const submissions = (await row('SELECT count(*)::int AS n FROM gpr2_quantity_submissions s JOIN gpr2_quantity_requests r ON r.id=s.request_id WHERE r.work_id=$1', [w.work.id])).n;
    assert.equal(out.committed, false, `R07-REV-03a OPEN: the database accepted an APPROVED request with ${submissions} submissions and no decision; the pointer now reads ${await currentQuantity(w.work.id)}`);
});

test('R07-REV-03b direct SQL: a request cannot be applied on top of a quantity version it was not written against', async () => {
    const W = await world();
    const w = await mkWork(W, 'R07REV03b stale source', 1000);
    const v1 = await currentVersion(w.work.id);
    const stale = await submitted(W, w.work.id, '700');                    // written and submitted against v1 ...
    const mover = await submitted(W, w.work.id, '950');                    // ... another request is approved first and moves the pointer to v2
    assert.equal((await approve(W, mover)).status, 200);
    const v2 = await currentVersion(w.work.id); assert.notEqual(v2, v1);
    assert.equal((await approve(W, stale)).status, 409, 'the service refuses the stale request');
    const out = await directSql(async c => {
        await c.query("UPDATE gpr2_quantity_requests SET state='APPROVED' WHERE id=$1", [stale.id]);
        const v = await forgeVersion(c, W, w.work.id, 3, 700, stale.id, v2);   // built on v2 although the request's source is v1
        await movePointer(c, w.work.id, v);
    });
    assert.equal(out.committed, false, `R07-REV-03b OPEN: the database applied a request written against ${v1} on top of ${v2}; the pointer now reads ${await currentQuantity(w.work.id)}`);
});

test('R07-REV-03c direct SQL: an allocation of an approved request cannot put a portion below its own protected evidence although the Work total is fine', async () => {
    const W = await world();
    const w = await mkWork(W, 'R07REV03c portion floor', 1000, [{ quantity: 600, portions: [600] }, { quantity: 400, portions: [400] }]);
    const [a, b] = w.units;
    await reportFactHttp(W, a.portions[0].id, 600).then(r => assert.ok(r.status < 300, JSON.stringify(r.body)));
    const legit = await submitted(W, w.work.id, '700', { allocation: allocationFor(w.units, [[600], [100]]) });
    assert.equal((await approve(W, legit)).status, 200, 'a legitimate approval that respects the 600 on portion A');
    const pointer = (await row('SELECT version_id FROM work_current_allocation WHERE work_id=$1', [w.work.id])).version_id;
    const qv = await currentVersion(w.work.id);
    const out = await directSql(async c => {
        // a second allocation version bound to the SAME genuinely approved request and the current quantity version: only the portion floor is at stake
        const next = (await c.query(`INSERT INTO work_allocation_versions(tenant_id,object_id,work_id,sequence,previous_id,quantity_version_id,unit,created_by,approved_request_id)
            VALUES($1,$2,$3,2,$4,$5,'м²',$6,$7) RETURNING id`, [W.pm.tenantId, W.object.id, w.work.id, pointer, qv, W.pm.id, legit.id])).rows[0].id;
        const line = (unit: any, q: number, portion?: any) => c.query(`INSERT INTO work_allocation_lines(tenant_id,object_id,work_id,version_id,execution_unit_id,portion_id,quantity,unit) VALUES($1,$2,$3,$4,$5,$6,$7,'м²')`,
            [W.pm.tenantId, W.object.id, w.work.id, next, unit.unit.id, portion?.id ?? null, q]);
        await line(a, 500); await line(a, 500, a.portions[0]);                 // portion A: 500 < its 600 RP fact
        await line(b, 200); await line(b, 200, b.portions[0]);                 // total 700 = the approved Work quantity
        await c.query('UPDATE work_current_allocation SET version_id=$1 WHERE work_id=$2', [next, w.work.id]);
    });
    assert.equal(out.committed, false, `R07-REV-03c OPEN: the database accepted portion A at 500 below its 600 RP fact (Work total 700 >= floor 600)`);
    assert.equal((await row('SELECT version_id FROM work_current_allocation WHERE work_id=$1', [w.work.id])).version_id, pointer);
});

test('R07-REV-03a native lifecycle: a request cannot be born decided, skip SUBMITTED, be approved by its author, be edited after submission, or carry a pointer without its events', async () => {
    const W = await world();
    const w = await mkWork(W, 'R07REV03a structure', 1000);
    const decider = await deciderId(W); const source = await currentVersion(w.work.id);
    const insert = `INSERT INTO gpr2_quantity_requests(tenant_id,object_id,work_id,state,proposed_quantity,quantity_version_id,reason,author_id,submission_number,submitter_id,decided_by) VALUES($1,$2,$3,$7,900,$4,'direct',$5,$6,$8,$9)`;
    const base = [W.pm.tenantId, W.object.id, w.work.id, source, W.pm.id, 0];
    await assert.rejects(pool.query(insert, [...base, 'APPROVED', null, null]), /starts as an undecided DRAFT/);
    await assert.rejects(pool.query(insert, [...base, 'DRAFT', null, decider]), /starts as an undecided DRAFT/);
    const draft = await row(`INSERT INTO gpr2_quantity_requests(tenant_id,object_id,work_id,proposed_quantity,quantity_version_id,reason,author_id) VALUES($1,$2,$3,900,$4,'direct',$5) RETURNING id`, [W.pm.tenantId, W.object.id, w.work.id, source, W.pm.id]);
    await assert.rejects(pool.query("UPDATE gpr2_quantity_requests SET state='SUBMITTED',submitter_id=author_id,submission_number=1 WHERE id=$1", [draft.id]), /needs the author's submission snapshot/);
    await assert.rejects(pool.query("UPDATE gpr2_quantity_requests SET state='APPROVED',decided_by=$2 WHERE id=$1", [draft.id, decider]), /invalid quantity request transition DRAFT -> APPROVED/);
    await assert.rejects(pool.query(`INSERT INTO gpr2_quantity_submissions(tenant_id,object_id,request_id,number,payload,submitted_by) VALUES($1,$2,$3,1,'{}',$4)`, [W.pm.tenantId, W.object.id, draft.id, decider]), /only from the author's DRAFT, in sequence/);
    // a really submitted request, through the API
    const r = await submitted(W, w.work.id, '900');
    await assert.rejects(pool.query('UPDATE gpr2_quantity_requests SET proposed_quantity=1 WHERE id=$1', [r.id]), /a submitted request is not edited/);
    await assert.rejects(pool.query("UPDATE gpr2_quantity_requests SET state='APPROVED' WHERE id=$1", [r.id]), /needs the submitted snapshot and a decider/);
    await assert.rejects(pool.query("UPDATE gpr2_quantity_requests SET state='APPROVED',decided_by=author_id WHERE id=$1", [r.id]), /author or submitter cannot approve/);
    await assert.rejects(pool.query("UPDATE gpr2_quantity_requests SET state='DRAFT' WHERE id=$1", [r.id]), /invalid quantity request transition SUBMITTED -> DRAFT/);
    // decided by somebody else but WITHOUT the APPROVE event: refused at COMMIT by the pointer guard
    const out = await directSql(async c => {
        await c.query("UPDATE gpr2_quantity_requests SET state='APPROVED',decided_by=$2 WHERE id=$1", [r.id, decider]);
        const v = await forgeVersion(c, W, w.work.id, 2, 900, r.id, source); await movePointer(c, w.work.id, v);
    });
    assert.equal(out.committed, false); assert.match(String(out.error), /provenance incomplete \(no SUBMIT \/ APPROVE event/);
    assert.equal(await currentVersion(w.work.id), source); assert.equal((await row('SELECT state FROM gpr2_quantity_requests WHERE id=$1', [r.id])).state, 'SUBMITTED');
    // and the legitimate approval of that very request still works; an APPROVED request is final
    assert.equal((await approve(W, r)).status, 200);
    assert.equal(await currentQuantity(w.work.id), '900.0000');
    await assert.rejects(pool.query('UPDATE gpr2_quantity_requests SET reason=\'после\' WHERE id=$1', [r.id]), /a submitted request is not edited/);
    await assert.rejects(pool.query('UPDATE gpr2_quantity_requests SET version=version+1 WHERE id=$1', [r.id]), /invalid quantity request transition APPROVED -> APPROVED/);
});

test('R07-REV-03b isolated: with a COMPLETE forged approval history only the source-version binding is left, and it refuses a stale request and a wrong chain', async () => {
    const W = await world();
    const w = await mkWork(W, 'R07REV03b isolated', 1000);
    const v1 = await currentVersion(w.work.id); const decider = await deciderId(W);
    const stale = await submitted(W, w.work.id, '700');          // written and submitted against v1
    const mover = await submitted(W, w.work.id, '950');          // approved first: the pointer moves to v2
    assert.equal((await approve(W, mover)).status, 200);
    const v2 = await currentVersion(w.work.id); assert.notEqual(v2, v1);
    // (1) the stale request gets a complete approval history, then is applied on top of v2
    const a = await directSql(async c => {
        await approveBySql(c, stale.id, decider);
        const v = await forgeVersion(c, W, w.work.id, 3, 700, stale.id, v2); await movePointer(c, w.work.id, v);
    });
    assert.equal(a.committed, false); assert.match(String(a.error), /request is stale for this Work/);
    // (2) a fabricated request written against the CURRENT version, but the new version is chained onto an older one
    const b = await directSql(async c => {
        const id = await fabricateApproved(c, W, w.work.id, v2, 600, decider);
        const v = await forgeVersion(c, W, w.work.id, 3, 600, id, v1); await movePointer(c, w.work.id, v);
    });
    assert.equal(b.committed, false); assert.match(String(b.error), /advance the pointer being replaced by one/);
    // (3) a version whose quantity differs from what the request asked for
    const c3 = await directSql(async c => {
        const id = await fabricateApproved(c, W, w.work.id, v2, 600, decider);
        const v = await forgeVersion(c, W, w.work.id, 3, 599, id, v2); await movePointer(c, w.work.id, v);
    });
    assert.equal(c3.committed, false); assert.match(String(c3.error), /request is stale for this Work \(source version or approved quantity differs\)/);
    assert.equal(await currentVersion(w.work.id), v2); assert.equal(await currentQuantity(w.work.id), '950.0000');
    // (4) the same request can still be applied the legitimate way when it is current: nothing legitimate was lost
    const ok = await submitted(W, w.work.id, '900');
    assert.equal((await approve(W, ok)).status, 200); assert.equal(await currentQuantity(w.work.id), '900.0000');
});

test('R07-REV-03c variants: the per-portion floor also holds for INTERNAL_SC evidence, for a missing portion line, and an allocation exactly at the floor is accepted', async () => {
    const W = await world();
    const w = await mkWork(W, 'R07REV03c variants', 1000, [{ quantity: 600, portions: [600] }, { quantity: 400, portions: [400] }]);
    const [a, b] = w.units; const decider = await deciderId(W);
    // INTERNAL_SC evidence of 600 on portion A (not an RP fact): inserted as the R06b native test does
    await pool.query(`INSERT INTO portion_quantity_confirmations(tenant_id,portion_id,source,quantity,recorded_by) VALUES($1,$2,'INTERNAL_SC',600,$3)`, [W.pm.tenantId, a.portions[0].id, W.pm.id]);
    const source = await currentVersion(w.work.id);
    const lines = (below: boolean) => ({ expectedVersionId: null, units: [
        { executionUnitId: a.unit.id, quantity: below ? '500' : '600', portions: [{ portionId: a.portions[0].id, quantity: below ? '500' : '600' }] },
        { executionUnitId: b.unit.id, quantity: below ? '200' : '100', portions: [{ portionId: b.portions[0].id, quantity: below ? '200' : '100' }] }] });
    // a fully fabricated approval with portion A at 500 < 600: refused by the portion floor alone (the Work total 700 is above the Work floor 600)
    const bad = await directSql(async c => {
        const id = await fabricateApproved(c, W, w.work.id, source, 700, decider, lines(true));
        const v = await forgeVersion(c, W, w.work.id, 2, 700, id, source); await movePointer(c, w.work.id, v);
        const al = (await c.query(`INSERT INTO work_allocation_versions(tenant_id,object_id,work_id,sequence,previous_id,quantity_version_id,unit,created_by,approved_request_id) VALUES($1,$2,$3,1,NULL,$4,'м²',$5,$6) RETURNING id`, [W.pm.tenantId, W.object.id, w.work.id, v, W.pm.id, id])).rows[0].id;
        for (const [u, q, p] of [[a, 500, null], [a, 500, a.portions[0]], [b, 200, null], [b, 200, b.portions[0]]] as any[])
            await c.query(`INSERT INTO work_allocation_lines(tenant_id,object_id,work_id,version_id,execution_unit_id,portion_id,quantity,unit) VALUES($1,$2,$3,$4,$5,$6,$7,'м²')`, [W.pm.tenantId, W.object.id, w.work.id, al, u.unit.id, p?.id ?? null, q]);
        await c.query('INSERT INTO work_current_allocation(tenant_id,object_id,work_id,version_id) VALUES($1,$2,$3,$4)', [W.pm.tenantId, W.object.id, w.work.id, al]);
    });
    assert.equal(bad.committed, false); assert.match(String(bad.error), /a portion is allocated below its own protected evidence/);
    // the service refuses the same request, and the committed state is unchanged
    const viaApi = await submitted(W, w.work.id, '700', { allocation: lines(true) });
    const refused = await approve(W, viaApi); assert.equal(refused.status, 422, JSON.stringify(refused.body)); assert.equal(refused.body.code, 'BELOW_PROTECTED_QUANTITY');
    // an allocation that omits portion A altogether counts as zero for it
    const omit = await submitted(W, w.work.id, '700', { allocation: { expectedVersionId: null, units: [{ executionUnitId: b.unit.id, quantity: '700', portions: [{ portionId: b.portions[0].id, quantity: '400' }] }] } });
    assert.equal((await approve(W, omit)).status, 422);
    assert.equal(await currentVersion(w.work.id), source);
    // exactly at the floor is accepted by the service AND by the database (nothing legitimate was lost)
    const exact = await submitted(W, w.work.id, '700', { allocation: lines(false) });
    assert.equal((await approve(W, exact)).status, 200);
    assert.equal(await currentQuantity(w.work.id), '700.0000');
    assert.equal((await row('SELECT count(*)::int AS n FROM work_allocation_versions WHERE work_id=$1', [w.work.id])).n, 1);
});

test('R07-REV-03b surface sibling and allocation binding: a sibling version must match its recorded effect, and an allocation must belong to the request that made the current quantity', async () => {
    const W = await world();
    const decider = await deciderId(W);
    // (1) a MAIN group: the request is really submitted; its approval is completed by SQL; the SIBLING version disagrees with the effect recorded for it
    const g = await surfaceGroup(W, 'R07B3S', false);
    const [primary, sibling] = g.main;
    const effects = g.main.map((x: any) => ({ stageOccurrenceId: x.occurrence_id, workId: x.work_id, oldQuantity: '1000', newQuantity: '800' }));
    const group = await submitted(W, primary.work_id, '800', { surface: { areaScopeId: g.floor, previousQuantity: '1000', newQuantity: '800', stageEffects: effects } });
    const pSource = await currentVersion(primary.work_id), sSource = await currentVersion(sibling.work_id);
    const forge = (siblingQuantity: number, effectOld: number) => directSql(async c => {
        await approveBySql(c, group.id, decider);
        const pv = await forgeVersion(c, W, primary.work_id, 2, 800, group.id, pSource); await movePointer(c, primary.work_id, pv);
        const header = (await c.query(`INSERT INTO gpr2_surface_changes(tenant_id,object_id,request_id,area_scope_id,previous_quantity,new_quantity,delta,unit) VALUES($1,$2,$3,$4,1000,800,-200,'м²') RETURNING id`, [W.pm.tenantId, W.object.id, group.id, g.floor])).rows[0].id;
        for (const [b, oldQ, newQ] of [[primary, 1000, 800], [sibling, effectOld, 800]] as any[])
            await c.query(`INSERT INTO gpr2_surface_effects(tenant_id,object_id,surface_change_id,stage_occurrence_id,work_id,old_quantity,new_quantity) VALUES($1,$2,$3,$4,$5,$6,$7)`, [W.pm.tenantId, W.object.id, header, b.occurrence_id, b.work_id, oldQ, newQ]);
        const sv = await forgeVersion(c, W, sibling.work_id, 2, siblingQuantity, group.id, sSource); await movePointer(c, sibling.work_id, sv);
    });
    const wrongNew = await forge(500, 1000);      // the sibling version says 500, its effect says 1000 -> 800
    assert.equal(wrongNew.committed, false); assert.match(String(wrongNew.error), /surface effect is stale for this Work/);
    const wrongOld = await forge(800, 900);       // the effect claims the sibling was at 900, it was at 1000
    assert.equal(wrongOld.committed, false); assert.match(String(wrongOld.error), /surface effect is stale for this Work/);
    assert.equal(await currentVersion(primary.work_id), pSource); assert.equal(await currentVersion(sibling.work_id), sSource);
    assert.equal((await approve(W, group)).status, 200, 'the legitimate group still applies, nothing was lost');
    assert.equal(await currentQuantity(sibling.work_id), '800.0000');

    // (2) an allocation of an EARLIER approved request cannot be attached to the quantity version a LATER request made
    const w = await mkWork(W, 'R07B3S allocation binding', 1000, [{ quantity: 1000, portions: [1000] }]);
    const first = await submitted(W, w.work.id, '900', { allocation: allocationFor(w.units, [[900]]) });
    assert.equal((await approve(W, first)).status, 200);
    const allocation1 = (await row('SELECT version_id FROM work_current_allocation WHERE work_id=$1', [w.work.id])).version_id as string;
    const second = await submitted(W, w.work.id, '800', { allocation: { expectedVersionId: allocation1, units: [{ executionUnitId: w.units[0].unit.id, quantity: '800', portions: [{ portionId: w.units[0].portions[0].id, quantity: '800' }] }] } });
    assert.equal((await approve(W, second)).status, 200);
    const allocation2 = (await row('SELECT version_id FROM work_current_allocation WHERE work_id=$1', [w.work.id])).version_id as string;
    const current = await currentVersion(w.work.id);
    const mixed = await directSql(async c => {
        // sequence 3, bound to the CURRENT quantity version but to the FIRST (genuinely approved) request
        const al = (await c.query(`INSERT INTO work_allocation_versions(tenant_id,object_id,work_id,sequence,previous_id,quantity_version_id,unit,created_by,approved_request_id) VALUES($1,$2,$3,3,$4,$5,'м²',$6,$7) RETURNING id`, [W.pm.tenantId, W.object.id, w.work.id, allocation2, current, W.pm.id, first.id])).rows[0].id;
        await c.query(`INSERT INTO work_allocation_lines(tenant_id,object_id,work_id,version_id,execution_unit_id,portion_id,quantity,unit) VALUES($1,$2,$3,$4,$5,NULL,800,'м²'),($1,$2,$3,$4,$5,$6,800,'м²')`, [W.pm.tenantId, W.object.id, w.work.id, al, w.units[0].unit.id, w.units[0].portions[0].id]);
        await c.query('UPDATE work_current_allocation SET version_id=$1 WHERE work_id=$2', [al, w.work.id]);
    });
    assert.equal(mixed.committed, false); assert.match(String(mixed.error), /allocation pointer requires approved quantity request/);
    assert.equal((await row('SELECT version_id FROM work_current_allocation WHERE work_id=$1', [w.work.id])).version_id, allocation2);
});

// ------------------------------------------------------------------------------------------------------------------------------------------------
// A07 / C06 — the atomic MAIN surface group on native PostgreSQL; LOCAL 150; an exclusion is not a fact
// ------------------------------------------------------------------------------------------------------------------------------------------------
async function surfaceGroup(W: World, tag: string, local: boolean) {
    const area = async (body: any) => { const r = await call(W.pmTok, 'POST', `/v2/objects/${W.object.id}/area-scopes`, { body: { payload: body }, headers: { 'Idempotency-Key': randomUUID() } }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.resultIds[0] as string; };
    const building = await area({ kind: 'BUILDING', code: tag + '-B', name: 'Корпус ' + tag });
    const floor = await area({ parentId: building, kind: 'FLOOR', code: tag + '-F', name: 'Этаж ' + tag, measureQuantity: '1000', measureUnit: 'м²' });
    const stages: any[] = [{ occurrenceKey: tag + '-A', position: 1, workTypeId: W.plaster.id, required: true, measureScope: 'MAIN', measureUnit: 'м²' }, { occurrenceKey: tag + '-M', position: 2, workTypeId: W.plaster.id, required: true, measureScope: 'MAIN', measureUnit: 'м²' }];
    if (local) stages.push({ occurrenceKey: tag + '-L', position: 3, workTypeId: W.plaster.id, required: true, measureScope: 'LOCAL', measureUnit: 'м²' });
    const sys = await call(W.pmTok, 'POST', `/v2/objects/${W.object.id}/finish-systems`, { body: { payload: { finishType: { code: tag + '-FIN', name: 'Отделка ' + tag }, stages } }, headers: { 'Idempotency-Key': randomUUID() } });
    assert.equal(sys.status, 200, JSON.stringify(sys.body)); const [finishTypeId, systemVersionId] = sys.body.resultIds;
    const generation: any = { systemVersionId, areaScopeIds: [floor], ...(local ? { localQuantities: [{ occurrenceKey: tag + '-L', areaScopeId: floor, quantity: '150' }] } : {}) };
    const preview = await call(W.pmTok, 'POST', `/v2/objects/${W.object.id}/finish-systems/${finishTypeId}/preview`, { body: { expectedVersion: '1', payload: generation } });
    assert.equal(preview.status, 200, JSON.stringify(preview.body)); assert.equal(preview.body.preview.canConfirm, true, JSON.stringify(preview.body.preview));
    const pv = preview.body.preview;
    const confirm = await call(W.pmTok, 'POST', `/v2/objects/${W.object.id}/finish-systems/${finishTypeId}/confirm`, { body: { expectedVersion: '1', expectedScopeVersion: pv.scopeVersion, payload: { ...generation, previewFingerprint: pv.previewFingerprint, expectedSourceVersions: { systemVersion: systemVersionId } } }, headers: { 'Idempotency-Key': randomUUID() } });
    assert.equal(confirm.status, 200, JSON.stringify(confirm.body));
    const bindings = await all('SELECT occurrence_id, work_id, measure_scope FROM work_scope_bindings WHERE area_scope_id=$1 ORDER BY occurrence_id', [floor]);
    return { floor, main: bindings.filter((b: any) => b.measure_scope === 'MAIN'), local: bindings.filter((b: any) => b.measure_scope === 'LOCAL'), all: bindings };
}
const surfaceState = async (workIds: string[]) => ({
    versions: await all('SELECT work_id, count(*)::int AS n FROM work_quantity_versions WHERE work_id=ANY($1) GROUP BY work_id ORDER BY work_id', [workIds]),
    pointers: await all('SELECT work_id, approved_version_id FROM work_current_quantity WHERE work_id=ANY($1) ORDER BY work_id', [workIds]),
    effects: (await row('SELECT count(*)::int AS n FROM gpr2_surface_effects WHERE work_id=ANY($1)', [workIds])).n,
    invalidations: (await row('SELECT count(*)::int AS n FROM gpr2_schedule_basis_invalidations WHERE work_id=ANY($1)', [workIds])).n,
    labor: (await row('SELECT count(*)::int AS n FROM gpr2_labor_coverage_recalculations WHERE work_id=ANY($1)', [workIds])).n
});
const factTables = async () => ({
    confirmations: (await pool.query(D('SELECT row_to_json(c)::text FROM portion_quantity_confirmations c'))).rows[0], rp: (await pool.query(D("SELECT row_to_json(c)::text FROM portion_quantity_confirmations c WHERE c.source='RP_FACT'"))).rows[0],
    progress: (await pool.query(D('SELECT row_to_json(w)::text FROM work_progress w'))).rows[0], actual: (await pool.query(D("SELECT id::text||':'||actual_quantity::text FROM works"))).rows[0]
});

test('N7 atomic MAIN group: a protected sibling, and a database error in the middle of the batch, each roll back EVERY row and event; a clean batch then applies all of it', async () => {
    const W = await world();
    const g = await surfaceGroup(W, 'N7', false);
    const [primary, sibling] = g.main; const ids = g.main.map((b: any) => b.work_id);
    const initial = await currentVersion(primary.work_id); const baseline = await surfaceState(ids);
    const effects = g.main.map((x: any) => ({ stageOccurrenceId: x.occurrence_id, workId: x.work_id, oldQuantity: '1000', newQuantity: '800' }));
    const group = await submitted(W, primary.work_id, '800', { surface: { areaScopeId: g.floor, previousQuantity: '1000', newQuantity: '800', stageEffects: effects } });
    // (1) application-level rejection: the sibling carries 850 of protected fact
    await pool.query('UPDATE works SET actual_quantity=850 WHERE id=$1', [sibling.work_id]);
    const refused = await approve(W, group);
    assert.equal(refused.status, 422, JSON.stringify(refused.body)); assert.equal(refused.body.code, 'BELOW_PROTECTED_QUANTITY');
    assert.deepEqual(await surfaceState(ids), baseline, 'rollback of the sibling floor refusal leaves no version, pointer move, effect, invalidation or recalculation');
    assert.equal((await row('SELECT count(*)::int AS n FROM gpr2_surface_changes WHERE request_id=$1', [group.id])).n, 0);
    assert.equal((await row("SELECT count(*)::int AS n FROM gpr2_quantity_events WHERE request_id=$1 AND action='APPROVE'", [group.id])).n, 0);
    assert.equal((await row('SELECT state FROM gpr2_quantity_requests WHERE id=$1', [group.id])).state, 'SUBMITTED');
    // (2) database-level failure DURING the batch: the sibling gets a WEU plan above the new quantity, which the service does not look at for a sibling but the
    //     deferred pointer guard refuses at COMMIT — after the primary version, surface rows and events were already written inside the transaction.
    await pool.query('UPDATE works SET actual_quantity=0 WHERE id=$1', [sibling.work_id]);
    await pool.query(`INSERT INTO work_execution_units(tenant_id,object_work_id,work_type_id,contractor_id,unit,planned_quantity) SELECT w.tenant_id,w.id,w.work_type_id,$2,w.unit,900 FROM works w WHERE w.id=$1`, [sibling.work_id, W.contractors[0].id]);
    const mid = await approve(W, group);
    assert.ok(mid.status >= 400, JSON.stringify(mid.body));
    assert.deepEqual(await surfaceState(ids), baseline, 'a database error at COMMIT rolls back the whole group: the primary Work, the sibling and every R07 row');
    assert.equal((await row('SELECT count(*)::int AS n FROM gpr2_surface_changes WHERE request_id=$1', [group.id])).n, 0);
    assert.equal((await row('SELECT state FROM gpr2_quantity_requests WHERE id=$1', [group.id])).state, 'SUBMITTED');
    assert.equal(await currentVersion(primary.work_id), initial);
    // (3) a clean group (another area) then applies everything at once
    const clean = await surfaceGroup(W, 'N7C', false); const cids = clean.main.map((b: any) => b.work_id);
    const cEffects = clean.main.map((x: any) => ({ stageOccurrenceId: x.occurrence_id, workId: x.work_id, oldQuantity: '1000', newQuantity: '800' }));
    const ok = await submitted(W, clean.main[0].work_id, '800', { surface: { areaScopeId: clean.floor, previousQuantity: '1000', newQuantity: '800', stageEffects: cEffects } });
    assert.equal((await approve(W, ok)).status, 200);
    for (const id of cids) assert.equal(await currentQuantity(id), '800.0000');
    assert.equal((await row('SELECT count(*)::int AS n FROM gpr2_surface_effects e JOIN gpr2_surface_changes s ON s.id=e.surface_change_id WHERE s.request_id=$1', [ok.id])).n, 2);
    assert.equal((await row('SELECT count(*)::int AS n FROM gpr2_schedule_basis_invalidations WHERE request_id=$1', [ok.id])).n, 2);
    assert.equal((await row('SELECT count(*)::int AS n FROM gpr2_labor_coverage_recalculations WHERE request_id=$1', [ok.id])).n, 2);
    // the surface header and its effects are append-only too
    await assert.rejects(pool.query('DELETE FROM gpr2_surface_effects WHERE surface_change_id IN (SELECT id FROM gpr2_surface_changes WHERE request_id=$1)', [ok.id]), /immutable/);
    await assert.rejects(pool.query('UPDATE gpr2_surface_effects SET new_quantity=1 WHERE surface_change_id IN (SELECT id FROM gpr2_surface_changes WHERE request_id=$1)', [ok.id]), /immutable/);
    await assert.rejects(pool.query('DELETE FROM gpr2_surface_changes WHERE request_id=$1', [ok.id]), /immutable/);
    await assert.rejects(pool.query('UPDATE gpr2_surface_changes SET new_quantity=1 WHERE request_id=$1', [ok.id]), /immutable/);
});

test('N7 LOCAL 150 stays 150 on native PostgreSQL: a refused and an applied MAIN group never touch it, and it cannot be dragged into the MAIN group', async () => {
    const W = await world();
    const g = await surfaceGroup(W, 'N7L', true);
    assert.equal(g.main.length, 2); assert.equal(g.local.length, 1);
    const lw = g.local[0].work_id as string; const [primary, sibling] = g.main;
    assert.equal(await currentQuantity(lw), '150.0000');
    const baseline = { state: await surfaceState([lw]), version: await currentVersion(lw), quantity: await currentQuantity(lw), alloc: (await row('SELECT count(*)::int AS n FROM work_allocation_versions WHERE work_id=$1', [lw])).n };
    const local = async () => ({ state: await surfaceState([lw]), version: await currentVersion(lw), quantity: await currentQuantity(lw), alloc: (await row('SELECT count(*)::int AS n FROM work_allocation_versions WHERE work_id=$1', [lw])).n });
    const effects = g.main.map((x: any) => ({ stageOccurrenceId: x.occurrence_id, workId: x.work_id, oldQuantity: '1000', newQuantity: '800' }));
    const group = await submitted(W, primary.work_id, '800', { surface: { areaScopeId: g.floor, previousQuantity: '1000', newQuantity: '800', stageEffects: effects } });
    await pool.query('UPDATE works SET actual_quantity=850 WHERE id=$1', [sibling.work_id]);
    assert.equal((await approve(W, group)).status, 422);
    assert.deepEqual(await local(), baseline, 'unchanged after the REFUSED approval');
    await pool.query('UPDATE works SET actual_quantity=800 WHERE id=$1', [sibling.work_id]);
    assert.equal((await approve(W, group)).status, 200);
    for (const b of g.main) assert.equal(await currentQuantity(b.work_id), '800.0000');
    assert.deepEqual(await local(), baseline, 'unchanged after the APPLIED approval (same version, no effect / invalidation / recalculation / allocation)');
    const current = await currentVersion(primary.work_id);
    const dragged = g.all.map((x: any) => ({ stageOccurrenceId: x.occurrence_id, workId: x.work_id, oldQuantity: '800', newQuantity: '700' }));
    const bad = await submitted(W, primary.work_id, '700', { surface: { areaScopeId: g.floor, previousQuantity: '800', newQuantity: '700', stageEffects: dragged } });
    const beforeBad = await surfaceState(g.main.map((b: any) => b.work_id));
    const res = await approve(W, bad);
    assert.equal(res.status, 422, JSON.stringify(res.body)); assert.equal(res.body.code, 'CROSS_SCOPE_REFERENCE');
    assert.deepEqual(await local(), baseline); assert.deepEqual(await surfaceState(g.main.map((b: any) => b.work_id)), beforeBad); assert.equal(await currentVersion(primary.work_id), current);
});

test('N8 an exclusion never writes RP_FACT on native PostgreSQL: a real RP fact stays byte-identical across a refused and an applied approval', async () => {
    const W = await world();
    const w = await mkWork(W, 'R07N8 exclusion', 1000, [{ quantity: 1000, portions: [1000] }]);
    const portion = w.units[0].portions[0];
    await reportFactHttp(W, portion.id, 300).then(r => assert.ok(r.status < 300, JSON.stringify(r.body)));
    const rp = await rpFacts(portion.id); assert.equal(rp.length, 1);
    const low = await submitted(W, w.work.id, '250', { allocation: allocationFor(w.units, [[250]]) });
    const beforeRefused = await factTables();
    const refused = await approve(W, low);
    assert.equal(refused.status, 422, JSON.stringify(refused.body)); assert.equal(refused.body.code, 'BELOW_PROTECTED_QUANTITY');
    assert.deepEqual(await factTables(), beforeRefused, 'a refused exclusion leaves every fact table byte-identical');
    const ok = await submitted(W, w.work.id, '800', { allocation: allocationFor(w.units, [[800]]) });
    const beforeApplied = await factTables();
    assert.equal((await approve(W, ok)).status, 200);
    assert.equal(await currentQuantity(w.work.id), '800.0000');
    assert.deepEqual(await factTables(), beforeApplied, 'an applied exclusion leaves every fact table byte-identical');
    assert.deepEqual(await rpFacts(portion.id), rp, 'the only RP_FACT is the reported 300: none of 200, none of 800');
    assert.equal((await row("SELECT count(*)::int AS n FROM portion_quantity_confirmations WHERE portion_id=$1 AND source<>'RP_FACT'", [portion.id])).n, 0);
    assert.equal((await row("SELECT count(*)::int AS n FROM gpr2_quantity_events WHERE request_id=$1 AND action='APPROVE'", [ok.id])).n, 1, 'not vacuous: the approval wrote its own rows');
});

// ------------------------------------------------------------------------------------------------------------------------------------------------
// A19 — the authority matrix through HTTP on native PostgreSQL
// ------------------------------------------------------------------------------------------------------------------------------------------------
test('A19 the role matrix: only РП authors, only the Deputy approves or returns, nobody holds the PTO review note by default, ADMIN holds no implicit grant', async () => {
    const W = await world();
    const matrix = gpr2RoleMatrix();
    for (const role of roles) {
        assert.equal(matrix[role].includes(Gpr2Permission.QUANTITY_AUTHOR), role === 'PROJECT_MANAGER', role + ' QUANTITY_AUTHOR');
        assert.equal(matrix[role].includes(Gpr2Permission.QUANTITY_REVIEW), role === 'DEPUTY_DIRECTOR', role + ' QUANTITY_REVIEW');
        assert.equal(matrix[role].includes(Gpr2Permission.QUANTITY_REVIEW_NOTE), false, role + ' QUANTITY_REVIEW_NOTE');
    }
    const w = await mkWork(W, 'R07A19 matrix', 1000);
    const source = await currentVersion(w.work.id), scope = await scopeVersion(W);
    const proposal = (quantity: string) => ({ expectedScopeVersion: scope, payload: { workId: w.work.id, newQuantity: quantity, reason: 'A19', inputFingerprint: 'a'.repeat(64), expectedSourceVersions: { quantity: source } } });
    const before = (await row('SELECT count(*)::int AS n FROM gpr2_quantity_requests')).n;
    for (const role of roles) {
        const res = await cmd(W, role === 'PROJECT_MANAGER' ? W.pmTok : await roleToken(role), 'POST', '', proposal('900'));
        if (role === 'PROJECT_MANAGER') assert.equal(res.status, 200, JSON.stringify(res.body));
        else assert.equal(res.status, 403, role + ' must not author: ' + JSON.stringify(res.body));
    }
    assert.equal((await row('SELECT count(*)::int AS n FROM gpr2_quantity_requests')).n, before + 1, 'exactly one request exists: the one the РП created');
    const r = await submitted(W, w.work.id, '850');
    for (const role of roles) {
        if (role === 'DEPUTY_DIRECTOR') continue;
        const tok = role === 'PROJECT_MANAGER' ? W.pmTok : await roleToken(role);
        assert.equal((await approve(W, r, tok)).status, 403, role + ' must not approve');
        assert.equal((await cmd(W, tok, 'POST', `/${r.id}/return`, { expectedVersion: '2', payload: { reason: 'нет права' } })).status, 403, role + ' must not return');
    }
    for (const role of roles) assert.equal((await cmd(W, role === 'PROJECT_MANAGER' ? W.pmTok : await roleToken(role), 'POST', `/${r.id}/review-notes`, { expectedVersion: '2', payload: { reason: 'заметка ПТО' } })).status, 403, role + ' holds no review-note grant by default');
    assert.equal((await row('SELECT state FROM gpr2_quantity_requests WHERE id=$1', [r.id])).state, 'SUBMITTED', 'every refused attempt left the request untouched');
    assert.equal((await approve(W, r)).status, 200, 'the Deputy approves without any PTO review note: the optional review is not a gate');
});

test('A19 scope: another object, another tenant, and a request path of a different object are all refused; the author cannot approve; authorization precedes idempotency replay', async () => {
    const W = await world();
    const w = await mkWork(W, 'R07A19 scope', 1000);
    const r = await submitted(W, w.work.id, '900');
    // the same request id under a DIFFERENT object of the same tenant: nested ownership, scope-safe 404
    const other = await call(W.deputyTok, 'POST', `/v2/objects/${W.neighbour.id}/quantity-change-requests/${r.id}/approve`, { body: r.approve, headers: { 'Idempotency-Key': randomUUID() } });
    assert.equal(other.status, 404, JSON.stringify(other.body));
    // a project manager who is not assigned to this object
    const otherPm = await tokenFor(W.other);
    const wrongObject = await cmd(W, otherPm, 'POST', '', { expectedScopeVersion: await scopeVersion(W), payload: { workId: w.work.id, newQuantity: '800', reason: 'чужой объект', inputFingerprint: 'a'.repeat(64), expectedSourceVersions: { quantity: await currentVersion(w.work.id) } } });
    assert.ok([403, 404].includes(wrongObject.status), JSON.stringify(wrongObject.body));
    // a manager of another tenant
    const foreign = await foreignTenantObject();
    const foreignTok = await tokenFor(foreign.manager);
    const crossTenant = await cmd(W, foreignTok, 'POST', '', { expectedScopeVersion: await scopeVersion(W), payload: { workId: w.work.id, newQuantity: '800', reason: 'чужой tenant', inputFingerprint: 'a'.repeat(64), expectedSourceVersions: { quantity: await currentVersion(w.work.id) } } });
    assert.ok([403, 404].includes(crossTenant.status), JSON.stringify(crossTenant.body));
    const crossApprove = await call(foreignTok, 'POST', `/v2/objects/${W.object.id}/quantity-change-requests/${r.id}/approve`, { body: r.approve, headers: { 'Idempotency-Key': randomUUID() } });
    assert.ok([403, 404].includes(crossApprove.status), JSON.stringify(crossApprove.body));
    assert.equal((await row('SELECT state FROM gpr2_quantity_requests WHERE id=$1', [r.id])).state, 'SUBMITTED');
    // the author cannot approve their own request even if their role later changes to the approving role
    await pool.query("UPDATE users SET role='DEPUTY_DIRECTOR' WHERE id=$1", [W.pm.id]);
    try {
        const self = await approve(W, r, W.pmTok);
        assert.equal(self.status, 422, JSON.stringify(self.body)); assert.equal(self.body.code, 'SEPARATION_OF_DUTIES');
    } finally { await pool.query("UPDATE users SET role='PROJECT_MANAGER' WHERE id=$1", [W.pm.id]); }
    // authorization before replay: a successful command replays for the same key, but not after the role was revoked
    const key = randomUUID(); const source = await currentVersion(w.work.id); const scope = await scopeVersion(W);
    const body = { expectedScopeVersion: scope, payload: { workId: w.work.id, newQuantity: '880', reason: 'replay', inputFingerprint: 'c'.repeat(64), expectedSourceVersions: { quantity: source } } };
    const first = await cmd(W, W.pmTok, 'POST', '', body, key); assert.equal(first.status, 200, JSON.stringify(first.body));
    const same = await cmd(W, W.pmTok, 'POST', '', body, key); assert.equal(same.status, 200); assert.deepEqual(same.body.resultIds, first.body.resultIds, 'the same key replays the same result');
    await pool.query("UPDATE users SET role='GENERAL_DIRECTOR' WHERE id=$1", [W.pm.id]);
    try {
        const revoked = await cmd(W, W.pmTok, 'POST', '', body, key);
        assert.equal(revoked.status, 403, 'after revocation the replay is refused BEFORE it can return the stored result: ' + JSON.stringify(revoked.body));
    } finally { await pool.query("UPDATE users SET role='PROJECT_MANAGER' WHERE id=$1", [W.pm.id]); }
    assert.equal((await row('SELECT count(*)::int AS n FROM gpr2_quantity_requests WHERE reason=$1', ['replay'])).n, 1, 'one request, however many times the key was sent');
});
