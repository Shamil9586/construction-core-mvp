import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { makeUser, orgExpectation } from './helpers/pbx3-fixtures';

/**
 * ORG-1 — REAL PostgreSQL evidence for the organizational-membership invariants (PGlite is a
 * single connection and proves nothing about overlap). A dedicated fresh database is created
 * for this file and dropped afterwards. ORG-1 adds NO migration: the chain must still end at 017.
 *
 * Connection: E2E_DATABASE_URL (admin-capable) or postgresql://postgres:local-test-only@127.0.0.1:5432/postgres.
 */
const ADMIN_URL = process.env.E2E_DATABASE_URL ?? 'postgresql://postgres:local-test-only@127.0.0.1:5432/postgres';
const DB_NAME = 'org1_' + Math.random().toString(36).slice(2, 10);
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
  process.env.MOCK_LOGIN_KEY = 'org1-pg-key';
  const { migrate } = await import('../scripts/migrate');
  const { seed } = await import('../scripts/seed');
  const db = await import('../apps/backend/src/db');
  const { OrgStructureService } = await import('../apps/backend/src/org-structure-service');
  await migrate();
  const tenant = await seed();
  const deputy = await db.one(db.pool, "SELECT * FROM users WHERE tenant_id=$1 AND role='DEPUTY_DIRECTOR'", [tenant.id]);
  ctx = { db, svc: new OrgStructureService(), tenant, deputy };
});
after(async () => {
  await ctx?.db.pool.end();
  await sleep(300);
  await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  await admin.end();
});
const client = async () => { const c = new Client({ connectionString: dbUrl() }); await c.connect(); return c; };
const codeOf = async (p: Promise<unknown>) => { try { await p; return null; } catch (e: any) { return e.code ?? e.status ?? e.message; } };
const active = async (member: string, fn: string) => (await ctx.db.pool.query("SELECT * FROM functional_team_memberships WHERE member_user_id=$1 AND function_code=$2 AND ended_at IS NULL", [member, fn])).rows;

test('A no ORG-1 migration: ORG-1 adds none (017 stays the last pre-PBX-5A file), and the existing table already admits every function code', async () => {
  const files = (await import('node:fs')).readdirSync('infra').filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  assert.equal(files[16], '017_remove_legacy_director_roles.sql');
  assert.deepEqual(files.slice(17), ['018_bitrix_notification_outbox.sql', '019_pto_work_assignments.sql']); // 019: PILOT-W01 PTO work handoff
  const c = await client();
  try {
    for (const fn of ['PTO', 'CONSTRUCTION_CONTROL', 'SDO', 'PROJECT_MANAGEMENT']) {
      await c.query('BEGIN');
      await c.query('INSERT INTO functional_team_memberships(tenant_id,function_code,manager_user_id,member_user_id,assigned_by) VALUES($1,$2,$3,$4,$3)', [ctx.tenant.id, fn, ctx.deputy.id, (await makeUser('A ' + fn, 'PTO')).id]);
      await c.query('ROLLBACK');
    }
  } finally { await c.end(); }
});

test('B stale replacement row on real PostgreSQL: X/v1 replaced by Y/v1; stale transfer AND end naming X/v1 are refused and Y stays active', async () => {
  const [h1, h2, h3] = await Promise.all([1, 2, 3].map((i) => makeUser('B Нач. ' + i, 'PTO_HEAD')));
  const e = await makeUser('B Инж.', 'PTO');
  const X = await ctx.svc.assign(ctx.deputy, 'PTO', { memberUserId: e.id, managerUserId: h1.id });
  const Y = await ctx.svc.transfer(ctx.deputy, 'PTO', { memberUserId: e.id, managerUserId: h2.id, reason: 'r', expectedAssignmentId: X.id, expectedVersion: X.version });
  assert.equal(X.version, 1); assert.equal(Y.version, 1);
  assert.equal(await codeOf(ctx.svc.transfer(ctx.deputy, 'PTO', { memberUserId: e.id, managerUserId: h3.id, reason: 'r', expectedAssignmentId: X.id, expectedVersion: 1 })), 409);
  assert.equal(await codeOf(ctx.svc.end(ctx.deputy, 'PTO', { memberUserId: e.id, reason: 'r', expectedAssignmentId: X.id, expectedVersion: 1 })), 409);
  const now = await active(e.id, 'PTO');
  assert.equal(now.length, 1); assert.equal(now[0].id, Y.id); assert.equal(now[0].manager_user_id, h2.id);
});

test('C racing identical commands built from the same read: exactly one transfer wins, the loser is a conflict and leaves no extra row', async () => {
  const heads = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => makeUser('C Нач. ' + i, 'SDO_HEAD')));
  const e = await makeUser('C Инж.', 'SDO');
  const X = await ctx.svc.assign(ctx.deputy, 'SDO', { memberUserId: e.id, managerUserId: heads[0].id });
  const res = await Promise.allSettled(heads.slice(1).map((h) => ctx.svc.transfer(ctx.deputy, 'SDO', { memberUserId: e.id, managerUserId: h.id, reason: 'гонка', expectedAssignmentId: X.id, expectedVersion: 1 })));
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, 1);
  for (const r of res) if (r.status === 'rejected') assert.equal((r.reason as any).status, 409, 'losers: conflict, never a 500/unique violation');
  const rows = (await ctx.db.pool.query("SELECT * FROM functional_team_memberships WHERE member_user_id=$1", [e.id])).rows;
  assert.equal(rows.length, 2); assert.equal(rows.filter((r: any) => r.ended_at === null).length, 1);
});

test('D racing end vs transfer on the same expected row: serialised, one wins, no active+ended anomaly', async () => {
  for (let i = 0; i < 8; i++) {
    const h1 = await makeUser('D Нач. ' + i, 'CONSTRUCTION_CONTROL_HEAD'), h2 = await makeUser('D Нач.2 ' + i, 'CONSTRUCTION_CONTROL_HEAD'), e = await makeUser('D Инж. ' + i, 'CONSTRUCTION_CONTROL');
    const X = await ctx.svc.assign(ctx.deputy, 'CONSTRUCTION_CONTROL', { memberUserId: e.id, managerUserId: h1.id });
    const [t, en] = await Promise.allSettled([
      ctx.svc.transfer(ctx.deputy, 'CONSTRUCTION_CONTROL', { memberUserId: e.id, managerUserId: h2.id, reason: 'перевод', expectedAssignmentId: X.id, expectedVersion: 1 }),
      ctx.svc.end(ctx.deputy, 'CONSTRUCTION_CONTROL', { memberUserId: e.id, reason: 'выход', expectedAssignmentId: X.id, expectedVersion: 1 }),
    ]);
    assert.equal([t, en].filter((r) => r.status === 'fulfilled').length, 1, 'exactly one of end/transfer applies');
    const loser = [t, en].find((r) => r.status === 'rejected') as PromiseRejectedResult;
    assert.equal((loser.reason as any).status, 409);
    const a = await active(e.id, 'CONSTRUCTION_CONTROL');
    assert.equal(a.length, t.status === 'fulfilled' ? 1 : 0);
  }
});

test('E partial unique index is still the native backstop: a writer bypassing the service cannot create a second active manager', async () => {
  const h1 = await makeUser('E Нач. 1', 'PTO_HEAD'), h2 = await makeUser('E Нач. 2', 'PTO_HEAD'), e = await makeUser('E Инж.', 'PTO');
  await ctx.svc.assign(ctx.deputy, 'PTO', { memberUserId: e.id, managerUserId: h1.id });
  const c = await client();
  try {
    await assert.rejects(c.query("INSERT INTO functional_team_memberships(tenant_id,function_code,manager_user_id,member_user_id,assigned_by) VALUES($1,'PTO',$2,$3,$4)", [ctx.tenant.id, h2.id, e.id, ctx.deputy.id]), (err: any) => err.code === '23505');
  } finally { await c.end(); }
});

test('F history is append-only on native PostgreSQL: no delete, no rewrite of ended rows or identity columns', async () => {
  const h1 = await makeUser('F Нач. 1', 'DEPUTY_DIRECTOR'), h2 = await makeUser('F Нач. 2', 'DEPUTY_DIRECTOR'), pm = await makeUser('F РП', 'PROJECT_MANAGER');
  const X = await ctx.svc.assign(ctx.deputy, 'PROJECT_MANAGEMENT', { memberUserId: pm.id, managerUserId: h1.id });
  await ctx.svc.transfer(ctx.deputy, 'PROJECT_MANAGEMENT', { memberUserId: pm.id, managerUserId: h2.id, reason: 'Перевод РП', expectedAssignmentId: X.id, expectedVersion: 1 });
  const c = await client();
  try {
    for (const [sql, args] of [
      ['DELETE FROM functional_team_memberships WHERE id=$1', [X.id]],
      ['UPDATE functional_team_memberships SET end_reason=$2 WHERE id=$1', [X.id, 'rewrite']],
      ['UPDATE functional_team_memberships SET manager_user_id=$2 WHERE id=$1', [X.id, h2.id]],
      ['UPDATE functional_team_memberships SET function_code=\'PTO\' WHERE id=$1', [X.id]],
    ] as const) await assert.rejects(c.query(sql, args as any), (err: any) => err.code === '23514', sql);
    const live = (await active(pm.id, 'PROJECT_MANAGEMENT'))[0];
    await assert.rejects(c.query('DELETE FROM functional_team_memberships WHERE id=$1', [live.id]), (err: any) => err.code === '23514', 'active row cannot be deleted either');
  } finally { await c.end(); }
  const reasons = (await ctx.db.pool.query('SELECT end_reason FROM functional_team_memberships WHERE member_user_id=$1 AND ended_at IS NOT NULL', [pm.id])).rows.map((r: any) => r.end_reason);
  assert.deepEqual(reasons, ['Перевод РП']);
});

test('G organizational commands never write object assignment, handover or object rows (row counts and РП unchanged on native PostgreSQL)', async () => {
  const h1 = await makeUser('G Нач. 1', 'PTO_HEAD'), h2 = await makeUser('G Нач. 2', 'PTO_HEAD'), e = await makeUser('G Инж.', 'PTO');
  const obj = (await ctx.db.pool.query('SELECT id FROM objects WHERE tenant_id=$1 ORDER BY external_code LIMIT 1', [ctx.tenant.id])).rows[0].id;
  const { ObjectTeamService } = await import('../apps/backend/src/team-service');
  const team = new ObjectTeamService();
  await team.assignObjectLead(ctx.deputy, obj, { leadUserId: h1.id });
  await team.assignOrgMember(ctx.deputy, { memberUserId: e.id, managerUserId: h1.id });
  await team.redistribute(ctx.deputy, { reason: 'setup', orgTransfers: [], orgEnds: [], leadChanges: [], memberEnds: [], memberAdds: [{ objectId: obj, memberUserId: e.id }], handovers: [] });
  const snap = async () => JSON.stringify(await Promise.all(['object_function_lead_assignments', 'object_function_member_assignments', 'object_function_handovers'].map(async (t) => (await ctx.db.pool.query(`SELECT * FROM ${t} ORDER BY id`)).rows)).then(async (x) => [...x, (await ctx.db.pool.query('SELECT id,project_manager_id,version FROM objects ORDER BY id')).rows]));
  const before = await snap();
  await ctx.svc.transfer(ctx.deputy, 'PTO', { memberUserId: e.id, managerUserId: h2.id, reason: 'перевод', ...(await orgExpectation(e.id)) });
  await ctx.svc.end(ctx.deputy, 'PTO', { memberUserId: e.id, reason: 'выход', ...(await orgExpectation(e.id)) });
  assert.equal(await snap(), before);
});
