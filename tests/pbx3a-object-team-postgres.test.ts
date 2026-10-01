import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { makeUser, orgExpectation } from './helpers/pbx3-fixtures';

/**
 * PBX-3A — REAL PostgreSQL evidence (PGlite is single-connection and proves nothing about
 * overlap). A dedicated fresh database is created for this file so "fresh migrations through
 * the new migration" is literally true, and dropped afterwards.
 *
 * Connection: E2E_DATABASE_URL (admin-capable) or the local cluster
 * postgresql://postgres:local-test-only@127.0.0.1:5432/postgres.
 */
const ADMIN_URL = process.env.E2E_DATABASE_URL ?? 'postgresql://postgres:local-test-only@127.0.0.1:5432/postgres';
const DB_NAME = 'pbx3a_' + Math.random().toString(36).slice(2, 10);
const dbUrl = () => { const u = new URL(ADMIN_URL); u.pathname = '/' + DB_NAME; return u.toString(); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let admin: Client;
let ctx: any;

before(async () => {
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB_NAME} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`);
  process.env.DB_MODE = 'postgres';
  process.env.DATABASE_URL = dbUrl();
  process.env.AUTH_MODE = 'mock';
  process.env.MOCK_LOGIN_KEY = 'pbx3a-pg-key';
  const { migrate } = await import('../scripts/migrate');
  const { seed } = await import('../scripts/seed');
  const db = await import('../apps/backend/src/db');
  const { ObjectTeamService } = await import('../apps/backend/src/team-service');
  await migrate();
  const tenant = await seed();
  const deputy = await db.one(db.pool, "SELECT * FROM users WHERE tenant_id=$1 AND role='DEPUTY_DIRECTOR'", [tenant.id]);
  const objects = await db.rows(db.pool, 'SELECT id FROM objects WHERE tenant_id=$1 ORDER BY external_code', [tenant.id]);
  ctx = { db, svc: new ObjectTeamService(), tenant, deputy, objects: objects.map((o: any) => o.id) };
});
after(async () => {
  await ctx?.db.pool.end();
  await sleep(300);
  await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  await admin.end();
});

const client = async () => { const c = new Client({ connectionString: dbUrl() }); await c.connect(); return c; };
const emptyCmd = { orgTransfers: [], orgEnds: [], leadChanges: [], memberEnds: [], memberAdds: [], handovers: [] };
const cmd = (o: any) => ({ reason: 'pg test', ...emptyCmd, ...o });
const codeOf = async (p: Promise<unknown>) => { try { await p; return null; } catch (e: any) { return e.code ?? e.status ?? e.message; } };

/* --------------------------------------------------------------------- *
 * A. Migration                                                           *
 * --------------------------------------------------------------------- */
test('A1 fresh native chain 1 -> 016 recorded; rerun under the repository runner is a no-op', async () => {
  const c = await client();
  try {
    const files = (await import('node:fs')).readdirSync('infra').filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
    assert.ok(files.includes('016_object_team_foundation.sql'));
    const first = (await c.query('SELECT version, applied_at FROM schema_migrations ORDER BY version')).rows;
    assert.deepEqual(first.map((r) => r.version), files.map((f) => Number(f.split('_')[0])));
    const { migrate } = await import('../scripts/migrate');
    await migrate();
    const second = (await c.query('SELECT version, applied_at FROM schema_migrations ORDER BY version')).rows;
    assert.deepEqual(second, first, 'rerun applies nothing and rewrites nothing');
    assert.equal((await c.query('SELECT count(*)::int n FROM schema_migrations WHERE version=16')).rows[0].n, 1);
  } finally { await c.end(); }
});

test('A2 exact schema: partial unique indexes, tenant-scoped FKs, no member->lead reference, no percentage columns', async () => {
  const c = await client();
  try {
    const idx = async (name: string) => (await c.query('SELECT indexdef FROM pg_indexes WHERE indexname=$1', [name])).rows[0]?.indexdef as string;
    assert.match(await idx('functional_team_memberships_one_active_manager'), /UNIQUE INDEX .* ON public\.functional_team_memberships USING btree \(tenant_id, function_code, member_user_id\) WHERE \(ended_at IS NULL\)/);
    assert.match(await idx('object_function_lead_one_active'), /UNIQUE INDEX .* ON public\.object_function_lead_assignments USING btree \(tenant_id, object_id, function_code\) WHERE \(ended_at IS NULL\)/);
    assert.match(await idx('object_function_member_one_active'), /UNIQUE INDEX .* ON public\.object_function_member_assignments USING btree \(tenant_id, object_id, function_code, member_user_id\) WHERE \(ended_at IS NULL\)/);
    const fks = (await c.query("SELECT conrelid::regclass::text t, confrelid::regclass::text ref, pg_get_constraintdef(oid) def FROM pg_constraint WHERE contype='f' AND conrelid::regclass::text IN ('functional_team_memberships','object_function_lead_assignments','object_function_member_assignments','object_function_handovers')")).rows;
    const tenantFks = fks.filter((f) => f.ref !== 'tenants');
    assert.ok(tenantFks.length >= 16);
    for (const f of tenantFks) assert.match(f.def, /FOREIGN KEY \(tenant_id, \w+\) REFERENCES \w+\(tenant_id, id\)/, f.t + ': ' + f.def);
    assert.equal(fks.filter((f) => f.t === 'object_function_member_assignments' && /lead/.test(f.ref)).length, 0, 'no reference from member assignments to a lead assignment');
    const cols = (await c.query("SELECT column_name FROM information_schema.columns WHERE table_name IN ('functional_team_memberships','object_function_lead_assignments','object_function_member_assignments','object_function_handovers')")).rows.map((r) => r.column_name);
    assert.equal(cols.filter((x) => /percent|allocation|workload|share|hours|fte/.test(x)).length, 0);
    // additive: pre-016 tables untouched — spot check
    assert.equal((await c.query("SELECT count(*)::int n FROM information_schema.columns WHERE table_name='users' AND column_name IN ('manager_id','pto_head_id')")).rows[0].n, 0);
  } finally { await c.end(); }
});

test('A3 native constraints: tenant-scoped FK, self-manager CHECK, single active row, append-only triggers', async () => {
  const c = await client();
  try {
    const t = ctx.tenant.id, [o1, o2] = ctx.objects;
    const h1 = await makeUser('PG Нач. 1', 'PTO_HEAD'), e1 = await makeUser('PG Инж. 1', 'PTO'), e2 = await makeUser('PG Инж. 2', 'PTO');
    const t2 = (await c.query("INSERT INTO tenants(portal,member_id,name) VALUES('pg-other','pg-other-m','Other') RETURNING id")).rows[0].id;
    const foreign = (await c.query("INSERT INTO users(tenant_id,bitrix_user_id,name,role) VALUES($1,'pgf','Foreign','PTO') RETURNING id", [t2])).rows[0].id;
    const state = async (fn: () => Promise<unknown>) => { try { await fn(); return 'ok'; } catch (e: any) { return e.code; } };
    const insOrg = (mgr: string, mem: string, ten = t) => c.query("INSERT INTO functional_team_memberships(tenant_id,function_code,manager_user_id,member_user_id,assigned_by) VALUES($1,'PTO',$2,$3,$4)", [ten, mgr, mem, ctx.deputy.id]);
    assert.equal(await state(() => insOrg(h1.id, foreign)), '23503', 'cross-tenant member refused by the composite FK');
    assert.equal(await state(() => insOrg(foreign, e1.id)), '23503', 'cross-tenant manager refused');
    assert.equal(await state(() => insOrg(e1.id, e1.id)), '23514', 'manager = member refused');
    assert.equal(await state(() => c.query("INSERT INTO functional_team_memberships(tenant_id,function_code,manager_user_id,member_user_id,assigned_by) VALUES($1,'BOGUS',$2,$3,$4)", [t, h1.id, e1.id, ctx.deputy.id])), '23514', 'unknown function_code refused');
    assert.equal(await state(() => insOrg(h1.id, e1.id)), 'ok');
    assert.equal(await state(() => insOrg(h1.id, e1.id)), '23505', 'one active manager per member');
    // tenant-scoped object FK
    assert.equal(await state(() => c.query("INSERT INTO object_function_lead_assignments(tenant_id,object_id,function_code,lead_user_id,assigned_by) VALUES($1,$2,'PTO',$3,$4)", [t2, o1, foreign, foreign])), '23503', 'object of another tenant refused');
    const insLead = (obj: string, lead: string) => c.query("INSERT INTO object_function_lead_assignments(tenant_id,object_id,function_code,lead_user_id,assigned_by) VALUES($1,$2,'PTO',$3,$4)", [t, obj, lead, ctx.deputy.id]);
    assert.equal(await state(() => insLead(o1, h1.id)), 'ok');
    assert.equal(await state(() => insLead(o1, h1.id)), '23505', 'one active lead per object');
    assert.equal(await state(() => insLead(o2, h1.id)), 'ok', 'the same lead may lead several objects');
    const insMem = (obj: string, m: string) => c.query("INSERT INTO object_function_member_assignments(tenant_id,object_id,function_code,member_user_id,assigned_by) VALUES($1,$2,'PTO',$3,$4)", [t, obj, m, ctx.deputy.id]);
    assert.equal(await state(() => insMem(o1, e1.id)), 'ok');
    assert.equal(await state(() => insMem(o1, e1.id)), '23505', 'one active member row per object/member');
    assert.equal(await state(() => insMem(o2, e1.id)), 'ok', 'a user may work on multiple objects');
    assert.equal(await state(() => insMem(o1, e2.id)), 'ok');
    // append-only
    assert.equal(await state(() => c.query('DELETE FROM object_function_member_assignments')), '23514');
    assert.equal(await state(() => c.query('DELETE FROM object_function_lead_assignments')), '23514');
    assert.equal(await state(() => c.query('DELETE FROM functional_team_memberships')), '23514');
    assert.equal(await state(() => c.query("UPDATE object_function_member_assignments SET member_user_id=$1 WHERE member_user_id=$2", [e2.id, e1.id])), '23514', 'identity columns of an active row cannot be rewritten');
    assert.equal(await state(() => c.query("UPDATE object_function_lead_assignments SET lead_user_id=$1 WHERE object_id=$2 AND ended_at IS NULL", [e2.id, o1])), '23514');
    assert.equal(await state(() => c.query("UPDATE functional_team_memberships SET manager_user_id=$1 WHERE member_user_id=$2", [e2.id, e1.id])), '23514');
    assert.equal(await state(() => c.query("UPDATE object_function_member_assignments SET ended_at=clock_timestamp(),ended_by=$1,end_reason='t',version=version+1 WHERE member_user_id=$2 AND object_id=$3", [ctx.deputy.id, e2.id, o1])), 'ok', 'ending is the one allowed change');
    assert.equal(await state(() => c.query("UPDATE object_function_member_assignments SET end_reason='rewrite' WHERE member_user_id=$1 AND object_id=$2", [e2.id, o1])), '23514', 'an ended row is immutable');
  } finally { await c.end(); }
});

/* --------------------------------------------------------------------- *
 * B. Native overlap / concurrency                                        *
 * --------------------------------------------------------------------- */
test('B1 raw overlap: a second active-lead INSERT blocks on the first uncommitted row, then fails 23505 after commit', async () => {
  const [o] = ctx.objects.slice(2, 3);
  const h1 = await makeUser('B1 Нач. 1', 'PTO_HEAD'), h2 = await makeUser('B1 Нач. 2', 'PTO_HEAD');
  const a = await client(), b = await client();
  try {
    const ins = (c: Client, lead: string) => c.query("INSERT INTO object_function_lead_assignments(tenant_id,object_id,function_code,lead_user_id,assigned_by) VALUES($1,$2,'PTO',$3,$4)", [ctx.tenant.id, o, lead, ctx.deputy.id]);
    await a.query('BEGIN'); await ins(a, h1.id);
    let settled = false;
    const pending = ins(b, h2.id).then(() => { settled = true; return 'ok'; }, (e: any) => { settled = true; return e.code; });
    await sleep(400);
    assert.equal(settled, false, 'the overlapping insert is genuinely blocked behind the uncommitted row');
    await a.query('COMMIT');
    assert.equal(await pending, '23505');
    assert.equal((await a.query("SELECT count(*)::int n FROM object_function_lead_assignments WHERE object_id=$1 AND ended_at IS NULL", [o])).rows[0].n, 1);
  } finally { await a.end(); await b.end(); }
});

test('B2 concurrent lead replacements on one object serialise: exactly one active lead, every other row ended, members untouched', async () => {
  const o = ctx.objects[3];
  const heads = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map((i) => makeUser('B2 Нач. ' + i, 'PTO_HEAD')));
  const eng = await makeUser('B2 Инж.', 'PTO');
  await ctx.svc.redistribute(ctx.deputy, cmd({ memberAdds: [{ objectId: o, memberUserId: eng.id }] }));
  const memberBefore = (await ctx.db.pool.query('SELECT * FROM object_function_member_assignments WHERE object_id=$1', [o])).rows;
  const results = await Promise.allSettled(heads.map((h) => ctx.svc.redistribute(ctx.deputy, cmd({ leadChanges: [{ objectId: o, leadUserId: h.id }] }))));
  const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
  assert.equal(failed.length, 0, 'serialised, not failed: ' + failed.map((f) => f.reason?.message ?? f.reason?.code).join(', '));
  const rows = (await ctx.db.pool.query("SELECT * FROM object_function_lead_assignments WHERE object_id=$1 AND function_code='PTO'", [o])).rows;
  assert.equal(rows.filter((r: any) => r.ended_at === null).length, 1);
  assert.equal(rows.filter((r: any) => r.ended_at !== null).length, rows.length - 1);
  assert.deepEqual((await ctx.db.pool.query('SELECT * FROM object_function_member_assignments WHERE object_id=$1', [o])).rows, memberBefore, 'no cascade to members');
});

test('B3 concurrent unconditional org assignments of one member to different heads: exactly one wins, no blind transfer (ORG-1)', async () => {
  const heads = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => makeUser('B3 Нач. ' + i, 'PTO_HEAD')));
  const eng = await makeUser('B3 Инж.', 'PTO');
  const res = await Promise.allSettled(heads.map((h) => ctx.svc.assignOrgMember(ctx.deputy, { memberUserId: eng.id, managerUserId: h.id })));
  // ORG-1: replacing an existing membership needs expectedAssignmentId+expectedVersion, so the five losers are refused (400)
  // instead of silently replacing the winner.
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, 1);
  for (const r of res) if (r.status === 'rejected') assert.equal((r.reason as any).status, 400);
  const rows = (await ctx.db.pool.query("SELECT * FROM functional_team_memberships WHERE member_user_id=$1", [eng.id])).rows;
  assert.equal(rows.filter((r: any) => r.ended_at === null).length, 1);
  assert.equal(rows.length, 1);
});

test('B4 two redistributions adding the same member to the same object: one wins, the loser leaves NO partial change', async () => {
  const o = ctx.objects[4];
  const h1 = await makeUser('B4 Нач. 1', 'PTO_HEAD'), h2 = await makeUser('B4 Нач. 2', 'PTO_HEAD'), eng = await makeUser('B4 Инж.', 'PTO'), other = await makeUser('B4 Инж. 2', 'PTO');
  await ctx.svc.assignOrgMember(ctx.deputy, { memberUserId: other.id, managerUserId: h1.id });
  const exp = await orgExpectation(other.id);
  const a = ctx.svc.redistribute(ctx.deputy, cmd({ memberAdds: [{ objectId: o, memberUserId: eng.id }], orgTransfers: [{ memberUserId: other.id, toManagerUserId: h2.id, ...exp }] }));
  const b = ctx.svc.redistribute(ctx.deputy, cmd({ memberAdds: [{ objectId: o, memberUserId: eng.id }], orgTransfers: [{ memberUserId: other.id, toManagerUserId: h1.id, ...exp }] }));
  const [ra, rb] = await Promise.allSettled([a, b]);
  assert.equal([ra, rb].filter((r) => r.status === 'fulfilled').length, 1, 'exactly one redistribution succeeds');
  const rows = (await ctx.db.pool.query("SELECT * FROM object_function_member_assignments WHERE object_id=$1 AND member_user_id=$2", [o, eng.id])).rows;
  assert.equal(rows.length, 1);
  const winnerManager = (await ctx.db.pool.query("SELECT manager_user_id FROM functional_team_memberships WHERE member_user_id=$1 AND ended_at IS NULL", [other.id])).rows[0].manager_user_id;
  const winnerIsA = ra.status === 'fulfilled';
  assert.equal(winnerManager, winnerIsA ? h2.id : h1.id, 'the loser\'s organizational transfer did not leak');
  const orgRows = (await ctx.db.pool.query('SELECT count(*)::int n FROM functional_team_memberships WHERE member_user_id=$1', [other.id])).rows[0].n;
  assert.equal(orgRows, winnerIsA ? 2 : 1, 'only the winner\'s transfer created history rows');
});

test('B5 native backstop: an uncommitted foreign row that pre-checks cannot see still aborts the WHOLE redistribution (no half-swap)', async () => {
  const o = ctx.objects[5];
  const h1 = await makeUser('B5 Нач. 1', 'PTO_HEAD'), h2 = await makeUser('B5 Нач. 2', 'PTO_HEAD'), x = await makeUser('B5 Инж. X', 'PTO'), y = await makeUser('B5 Инж. Y', 'PTO');
  await ctx.svc.assignOrgMember(ctx.deputy, { memberUserId: x.id, managerUserId: h1.id });
  const snap = async () => JSON.stringify([(await ctx.db.pool.query('SELECT * FROM functional_team_memberships WHERE member_user_id=$1 ORDER BY id', [x.id])).rows, (await ctx.db.pool.query('SELECT * FROM object_function_member_assignments WHERE object_id=$1 ORDER BY id', [o])).rows, (await ctx.db.pool.query('SELECT * FROM object_function_lead_assignments WHERE object_id=$1 ORDER BY id', [o])).rows, (await ctx.db.pool.query('SELECT * FROM object_function_handovers WHERE object_id=$1 ORDER BY id', [o])).rows]);
  const before = await snap();
  const rogue = await client();
  try {
    // A writer that bypasses the service (and its advisory locks) holds an UNCOMMITTED active row for (o, y).
    await rogue.query('BEGIN');
    await rogue.query("INSERT INTO object_function_member_assignments(tenant_id,object_id,function_code,member_user_id,assigned_by) VALUES($1,$2,'PTO',$3,$4)", [ctx.tenant.id, o, y.id, ctx.deputy.id]);
    let settled = false;
    const p = ctx.svc.redistribute(ctx.deputy, cmd({ orgTransfers: [{ memberUserId: x.id, toManagerUserId: h2.id, ...(await orgExpectation(x.id)) }], leadChanges: [{ objectId: o, leadUserId: h2.id }], memberAdds: [{ objectId: o, memberUserId: y.id }] })).then(() => { settled = true; return null; }, (e: any) => { settled = true; return e.code; });
    await sleep(500);
    assert.equal(settled, false, 'the redistribution has already applied its earlier steps and is blocked on the unique index');
    await rogue.query('COMMIT');
    assert.equal(await p, '23505');
    // Everything the redistribution did before failing is rolled back; only the rogue row exists.
    const after = JSON.parse(await snap());
    assert.deepEqual(after[0], JSON.parse(before)[0], 'organizational transfer rolled back');
    assert.deepEqual(after[2], JSON.parse(before)[2], 'lead change rolled back');
    assert.equal(after[1].length, 1, 'only the rogue member row exists');
  } finally { await rogue.end(); }
});

test('B6 opposite-order overlapping redistributions never deadlock or 500 (deterministic lock/processing order)', async () => {
  const [o1, o2] = ctx.objects.slice(6, 8);
  const hs = await Promise.all([1, 2, 3, 4].map((i) => makeUser('B6 Нач. ' + i, 'PTO_HEAD')));
  for (let round = 0; round < 12; round++) {
    const a = ctx.svc.redistribute(ctx.deputy, cmd({ leadChanges: [{ objectId: o1, leadUserId: hs[round % 4].id }, { objectId: o2, leadUserId: hs[(round + 1) % 4].id }] }));
    const b = ctx.svc.redistribute(ctx.deputy, cmd({ leadChanges: [{ objectId: o2, leadUserId: hs[(round + 2) % 4].id }, { objectId: o1, leadUserId: hs[(round + 3) % 4].id }] }));
    const res = await Promise.allSettled([a, b]);
    for (const r of res) if (r.status === 'rejected') assert.equal((r.reason as any).status, 400, 'only benign business refusals, never a deadlock/500: ' + ((r.reason as any).code ?? (r.reason as any).message));
    for (const o of [o1, o2]) assert.equal((await ctx.db.pool.query("SELECT count(*)::int n FROM object_function_lead_assignments WHERE object_id=$1 AND ended_at IS NULL", [o])).rows[0].n, 1);
  }
});

test('B7 head add/remove racing a Deputy swap: authorization is re-validated under the same locks', async () => {
  const o = ctx.objects[8];
  const h1 = await makeUser('B7 Нач. 1', 'PTO_HEAD'), h2 = await makeUser('B7 Нач. 2', 'PTO_HEAD'), eng = await makeUser('B7 Инж.', 'PTO');
  await ctx.svc.assignOrgMember(ctx.deputy, { memberUserId: eng.id, managerUserId: h1.id });
  await ctx.svc.assignObjectLead(ctx.deputy, o, { leadUserId: h1.id });
  // Fire both together; whatever the serial order, the invariants must hold.
  const headAdd = ctx.svc.addObjectMember(h1, o, { memberUserId: eng.id });
  const swap = ctx.svc.redistribute(ctx.deputy, cmd({ orgTransfers: [{ memberUserId: eng.id, toManagerUserId: h2.id, ...(await orgExpectation(eng.id)) }], leadChanges: [{ objectId: o, leadUserId: h2.id }] }));
  const [a, b] = await Promise.allSettled([headAdd, swap]);
  assert.equal(b.status, 'fulfilled');
  const active = (await ctx.db.pool.query("SELECT count(*)::int n FROM object_function_member_assignments WHERE object_id=$1 AND member_user_id=$2 AND ended_at IS NULL", [o, eng.id])).rows[0].n;
  if (a.status === 'fulfilled') assert.equal(active, 1, 'head add ran first: member stays (D01: lead replacement does not remove members)');
  else { assert.equal(active, 0); assert.equal((a.reason as any).status, 403, 'head add ran after the swap: no longer lead / no longer own team'); }
  // After the swap the old head can never (re)add.
  assert.equal(await codeOf(ctx.svc.addObjectMember(h1, o, { memberUserId: eng.id })), 403);
});
