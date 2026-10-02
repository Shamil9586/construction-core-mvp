import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { makeUser, assignPtoToObject, actorByRole, tenantId } from './helpers/pbx3-fixtures';

/**
 * PILOT-W01 UI03 — REAL PostgreSQL evidence for migration 019 (pto_work_assignments) and for the
 * handoff's concurrency behaviour. A dedicated fresh database is created so "fresh migrations
 * through 019" is literally true, and dropped afterwards (same harness as pbx3a-object-team-postgres).
 */
const ADMIN_URL = process.env.E2E_DATABASE_URL ?? 'postgresql://postgres:local-test-only@127.0.0.1:5432/postgres';
const DB_NAME = 'w01_' + Math.random().toString(36).slice(2, 10);
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
  process.env.MOCK_LOGIN_KEY = 'w01-pg-key';
  const { migrate } = await import('../scripts/migrate');
  const { seed } = await import('../scripts/seed');
  const db = await import('../apps/backend/src/db');
  const { PtoWorkAssignmentService } = await import('../apps/backend/src/pto-work-assignment-service');
  await migrate();
  const tenant = await seed();
  ctx = { db, svc: new PtoWorkAssignmentService(), tenant };
});
after(async () => {
  await ctx?.db.pool.end();
  await sleep(300);
  await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  await admin.end();
});
const client = async () => { const c = new Client({ connectionString: dbUrl() }); await c.connect(); return c; };

test('A1 fresh native chain 1 -> 019 recorded; rerun under the repository runner is a no-op', async () => {
  const c = await client();
  try {
    const files = (await import('node:fs')).readdirSync('infra').filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
    assert.ok(files.includes('019_pto_work_assignments.sql'));
    const first = (await c.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map((r) => r.version);
    assert.deepEqual(first, files.map((f) => Number(f.split('_')[0])));
    const { migrate } = await import('../scripts/migrate');
    await migrate();
    assert.deepEqual((await c.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map((r) => r.version), first);
  } finally { await c.end(); }
});

test('A2 exact schema: one ACTIVE row per work, tenant-scoped composite FKs, append-only history', async () => {
  const c = await client();
  try {
    const idx = (await c.query("SELECT indexdef FROM pg_indexes WHERE indexname='pto_work_assignments_one_active'")).rows[0]?.indexdef as string;
    assert.match(idx, /UNIQUE INDEX .* ON public\.pto_work_assignments USING btree \(tenant_id, object_work_id\) WHERE \(ended_at IS NULL\)/);
    const fks = (await c.query("SELECT pg_get_constraintdef(oid) def, confrelid::regclass::text ref FROM pg_constraint WHERE contype='f' AND conrelid='pto_work_assignments'::regclass")).rows.filter((f) => f.ref !== 'tenants');
    assert.equal(fks.length, 5);
    for (const f of fks) assert.match(f.def, /FOREIGN KEY \(tenant_id, \w+\) REFERENCES \w+\(tenant_id, id\)/, f.def);
    assert.equal((await c.query("SELECT count(*)::int n FROM pto_work_assignments")).rows[0].n, 0, 'migration writes no rows (no seed/backfill)');
    assert.equal((await c.query("SELECT count(*)::int n FROM pg_trigger WHERE tgrelid='pto_work_assignments'::regclass AND NOT tgisinternal")).rows[0].n, 1);
  } finally { await c.end(); }
});

async function setup(name: string) {
  const { db } = ctx;
  const t = await tenantId();
  const pm = await actorByRole('PROJECT_MANAGER');
  const contractor = await db.one(db.pool, 'SELECT id FROM contractors WHERE tenant_id=$1 LIMIT 1', [t]);
  const wt = await db.one(db.pool, 'SELECT id FROM work_types WHERE tenant_id=$1 LIMIT 1', [t]);
  const obj = await db.insert(db.pool, 'objects', t, { externalCode: 'W01PG-' + name + Date.now(), name, address: 'a', organizationName: 'o', projectManagerId: pm.id, startDate: '2026-01-01', plannedFinishDate: '2026-12-31', contractValue: '1' });
  const work = await db.insert(db.pool, 'works', t, { objectId: obj.id, workTypeId: wt.id, contractorId: contractor.id, responsibleUserId: pm.id, name: 'Работа ' + name, unit: 'м²', plannedQuantity: 500, plannedStartDate: '2026-01-01', plannedFinishDate: '2026-12-31', estimatedCost: '1' });
  const head = await makeUser('Нач ' + name, 'PTO_HEAD');
  const e1 = await makeUser('Инж1 ' + name, 'PTO'), e2 = await makeUser('Инж2 ' + name, 'PTO');
  await assignPtoToObject(obj.id, { lead: head, member: e1 });
  await assignPtoToObject(obj.id, { lead: head, member: e2 });
  return { obj, work, head, e1, e2 };
}

test('B1 native: history is append-only; a second ACTIVE row for the same work and cross-tenant references are refused', async () => {
  const s = await setup('B1');
  await ctx.svc.assign(s.head, s.work.id, { assigneeUserId: s.e1.id });
  const c = await client();
  try {
    await assert.rejects(c.query('DELETE FROM pto_work_assignments WHERE object_work_id=$1', [s.work.id]), /append-only/);
    await assert.rejects(c.query('UPDATE pto_work_assignments SET assignee_user_id=$2 WHERE object_work_id=$1', [s.work.id, s.e2.id]), /immutable/);
    await assert.rejects(c.query('INSERT INTO pto_work_assignments(tenant_id,object_id,object_work_id,assignee_user_id,assigned_by) VALUES($1,$2,$3,$4,$5)', [await tenantId(), s.obj.id, s.work.id, s.e2.id, s.head.id]), /pto_work_assignments_one_active/);
    const other = await c.query("INSERT INTO tenants(portal,member_id,name) VALUES($1,$2,'x') RETURNING id", ['w01pg-' + Date.now() + '.local', 'w01pg-' + Date.now()]);
    await assert.rejects(c.query('INSERT INTO pto_work_assignments(tenant_id,object_id,object_work_id,assignee_user_id,assigned_by) VALUES($1,$2,$3,$4,$5)', [other.rows[0].id, s.obj.id, s.work.id, s.e1.id, s.head.id]), /foreign key/);
    assert.equal((await c.query('SELECT count(*)::int n FROM documentation_packages WHERE object_work_id=$1', [s.work.id])).rows[0].n, 0, 'handoff creates no package');
  } finally { await c.end(); }
});

test('B2 native concurrency: simultaneous handoffs of one work to different engineers leave exactly one ACTIVE assignment and a consistent history', async () => {
  const s = await setup('B2');
  const results = await Promise.allSettled([
    ctx.svc.assign(s.head, s.work.id, { assigneeUserId: s.e1.id }),
    ctx.svc.assign(s.head, s.work.id, { assigneeUserId: s.e2.id }),
    ctx.svc.assign(s.head, s.work.id, { assigneeUserId: s.e1.id }),
    ctx.svc.assign(s.head, s.work.id, { assigneeUserId: s.e2.id }),
  ]);
  assert.ok(results.every((r) => r.status === 'fulfilled'), JSON.stringify(results.filter((r) => r.status === 'rejected')));
  const rows = (await ctx.db.pool.query('SELECT assignee_user_id,ended_at FROM pto_work_assignments WHERE object_work_id=$1', [s.work.id])).rows;
  assert.equal(rows.filter((r: any) => r.ended_at === null).length, 1, 'exactly one ACTIVE row');
  assert.equal(rows.filter((r: any) => r.ended_at !== null).length, rows.length - 1);
  assert.equal((await ctx.db.pool.query('SELECT count(*)::int n FROM documentation_packages WHERE object_work_id=$1', [s.work.id])).rows[0].n, 0);
});

test('B3 native concurrency: package creation racing a reassignment — the winner is consistent, the old assignee never gets a package after losing the assignment', async () => {
  const s = await setup('B3');
  await ctx.svc.assign(s.head, s.work.id, { assigneeUserId: s.e1.id });
  const { ProductionService } = await import('../apps/backend/src/service');
  const prod = new ProductionService();
  const [create, reassign] = await Promise.allSettled([
    prod.createDocumentationPackage(s.e1, { objectWorkId: s.work.id }),
    ctx.svc.assign(s.head, s.work.id, { assigneeUserId: s.e2.id }),
  ]);
  const pkgs = (await ctx.db.pool.query('SELECT responsible_user_id FROM documentation_packages WHERE object_work_id=$1', [s.work.id])).rows;
  const active = (await ctx.db.pool.query('SELECT assignee_user_id FROM pto_work_assignments WHERE object_work_id=$1 AND ended_at IS NULL', [s.work.id])).rows;
  assert.equal(active.length, 1);
  if (create.status === 'fulfilled') {
    // package first: reassignment must have been refused (a package exists) and e1 stays the assignee
    assert.equal(reassign.status, 'rejected'); assert.equal(active[0].assignee_user_id, s.e1.id); assert.equal(pkgs.length, 1);
  } else {
    // reassignment first: e1 lost the action, no package for anyone
    assert.equal(reassign.status, 'fulfilled'); assert.equal(active[0].assignee_user_id, s.e2.id); assert.equal(pkgs.length, 0);
  }
});
