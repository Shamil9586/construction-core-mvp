import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeUser, tokenFor } from './helpers/pbx3-fixtures';

/**
 * PILOT-W01 UI02/UI03 — PTO work handoff («Передать в работу») over the real backend on PGlite.
 *
 *   Object A → PTO_HEAD A → team A → engineers A1, A2
 *   Object B → PTO_HEAD B → team B → engineer B1
 *   Object C → no PTO_HEAD at all;  Object D → PTO_HEAD D with no engineers
 *   U: PTO user in no team, X: PTO user of ANOTHER tenant.
 *
 * Eligibility is object → assigned PTO_HEAD → functional team → engineer, computed once on the
 * server (resolvePtoWorkEligibility) and used by BOTH the read model and the write validation.
 */
const dt = (delta: number) => new Date(Date.now() + delta * 86400000).toISOString().slice(0, 10);

async function harness() {
  delete process.env.DATABASE_URL;
  process.env.AUTH_MODE = 'mock';
  process.env.MOCK_LOGIN_KEY = 'pilot-w01-key';
  process.env.DB_MODE = 'pglite';
  process.env.PGLITE_DIR = 'memory://';
  const { migrate } = await import('../scripts/migrate');
  const { seed } = await import('../scripts/seed');
  const { createApp } = await import('../apps/backend/src/main');
  await migrate();
  await seed();
  const app = await createApp();
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  let token = '';
  async function raw(path: string, body?: any) {
    const r = await fetch(base + '/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, data: (await r.json().catch(() => null)) as any };
  }
  async function req(path: string, body?: any, expected = body === undefined ? 200 : 201) {
    const r = await raw(path, body);
    assert.equal(r.status, expected, path + ': ' + JSON.stringify(r.data));
    return r.data;
  }
  async function login(role: string) { const d = await req('auth/mock', { role, key: 'pilot-w01-key' }); token = d.token; return d.user; }
  async function as(user: any) { token = await tokenFor(user); return user; }
  return { app, req, raw, login, as };
}

async function makeObject(h: any, name: string) {
  const pm = await h.login('PROJECT_MANAGER');
  const dict = await h.req('dictionaries');
  const contractors = await h.req('contractors');
  await h.login('DEPUTY_DIRECTOR');
  const o = await h.req('objects', { externalCode: 'W01-' + name + '-' + Date.now() + Math.random().toString(36).slice(2, 6), name, address: 'Тест, 1', organizationName: 'ООО СЗ', projectManagerId: pm.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [contractors[0].id] });
  await h.login('PROJECT_MANAGER');
  const work = await h.req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, responsibleUserId: pm.id, name: 'Штукатурка ' + name, unit: 'м²', plannedQuantity: 500, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '20000' });
  return { o, work };
}

async function scenario() {
  const h = await harness();
  const { pool, one, insert } = await import('../apps/backend/src/db');
  const headA = await makeUser('Начальник А', 'PTO_HEAD'), headB = await makeUser('Начальник Б', 'PTO_HEAD'), headD = await makeUser('Начальник Д', 'PTO_HEAD');
  const A1 = await makeUser('Инженер А1', 'PTO'), A2 = await makeUser('Инженер А2', 'PTO'), B1 = await makeUser('Инженер Б1', 'PTO'), U = await makeUser('Инженер без команды', 'PTO');
  const tenantB = await one(pool, "INSERT INTO tenants(portal,member_id,name) VALUES($1,$2,'Другой тенант') RETURNING *", ['w01-other-' + Date.now() + '.local', 'w01-other-' + Date.now() + Math.random()]);
  const X = await makeUser('Инженер чужого тенанта', 'PTO', { tenant: tenantB.id });
  const A = await makeObject(h, 'A'), B = await makeObject(h, 'B'), C = await makeObject(h, 'C'), D = await makeObject(h, 'D');
  await h.login('DEPUTY_DIRECTOR');
  for (const [m, mg] of [[A1, headA], [A2, headA], [B1, headB]]) await h.req('function-teams/pto/org-members', { memberUserId: m.id, managerUserId: mg.id });
  for (const [o, lead] of [[A, headA], [B, headB], [D, headD]] as any[]) await h.req(`objects/${o.o.id}/function-team/pto/lead`, { leadUserId: lead.id });
  await h.req('function-teams/pto/redistribute', { reason: 'seed', memberAdds: [{ objectId: A.o.id, memberUserId: A1.id }, { objectId: A.o.id, memberUserId: A2.id }, { objectId: B.o.id, memberUserId: B1.id }] });
  const handoff = (work: any, who: any) => h.raw(`works/${work.id}/pto-assignment`, { assigneeUserId: who.id });
  const view = (work: any) => h.req(`works/${work.id}/pto-assignment`);
  const counts = async (workId: string) => ({
    packages: (await pool.query('SELECT count(*)::int n FROM documentation_packages WHERE object_work_id=$1', [workId])).rows[0].n,
    history: (await pool.query('SELECT count(*)::int n FROM documentation_package_status_history h JOIN documentation_packages p ON p.id=h.documentation_package_id WHERE p.object_work_id=$1', [workId])).rows[0].n,
  });
  return { h, pool, one, insert, headA, headB, headD, A1, A2, B1, U, X, A, B, C, D, handoff, view, counts };
}
const names = (v: any) => v.eligible.map((e: any) => e.name).sort();

test('UI02 eligibility: only head A\'s team on object A — not B1, not unrelated or cross-tenant PTO users', async () => {
  const s = await scenario();
  try {
    await s.h.as(s.headA);
    const v = await s.view(s.A.work);
    assert.deepEqual(names(v), ['Инженер А1', 'Инженер А2']);
    assert.equal(v.head.id, s.headA.id);
    assert.equal(v.canAssign, true);
    for (const excluded of [s.B1, s.U, s.X, s.headA, s.headB]) assert.ok(!v.eligible.some((e: any) => e.id === excluded.id), excluded.name);
    // only the assigner receives the list; an engineer and a read-only role never do
    await s.h.as(s.A1);
    const ev = await s.view(s.A.work);
    assert.deepEqual(ev.eligible, []); assert.equal(ev.canAssign, false);
    await s.h.login('GENERAL_DIRECTOR');
    const gv = await s.view(s.A.work);
    assert.deepEqual(gv.eligible, []); assert.equal(gv.canAssign, false); assert.equal(gv.canCreatePackage, false);
    // another head cannot even read object A's handoff model
    await s.h.as(s.headB);
    assert.equal((await s.h.raw(`works/${s.A.work.id}/pto-assignment`)).status, 403);
  } finally { await s.h.app.close(); }
});

test('UI02 eligibility: no assigned PTO_HEAD => empty, never tenant-wide; head without team engineers => empty', async () => {
  const s = await scenario();
  try {
    await s.h.login('ADMIN');
    const c = await s.view(s.C.work);
    assert.equal(c.head, null); assert.deepEqual(c.eligible, []);
    assert.equal((await s.handoff(s.C.work, s.A1)).status, 400);
    assert.equal((await s.handoff(s.C.work, s.U)).status, 400);
    const d = await s.view(s.D.work);
    assert.equal(d.head.id, s.headD.id); assert.deepEqual(d.eligible, []);
    assert.equal((await s.handoff(s.D.work, s.A1)).status, 400);
    // a team member who is NOT a current object member is not eligible (cannot act on the object)
    await s.h.login('DEPUTY_DIRECTOR');
    await s.h.req('function-teams/pto/org-members', { memberUserId: s.U.id, managerUserId: s.headA.id });
    await s.h.as(s.headA);
    assert.deepEqual(names(await s.view(s.A.work)), ['Инженер А1', 'Инженер А2']);
    assert.equal((await s.handoff(s.A.work, s.U)).status, 400);
  } finally { await s.h.app.close(); }
});

test('UI03 handoff authorization: head A -> A1/A2 only; B1, other head, engineers, cross-tenant and invalid ids are rejected', async () => {
  const s = await scenario();
  try {
    await s.h.as(s.headA);
    assert.equal((await s.handoff(s.A.work, s.B1)).status, 400, 'B1 is on another team');
    assert.equal((await s.handoff(s.A.work, s.X)).status, 400, 'cross-tenant user');
    assert.equal((await s.handoff(s.A.work, { id: '00000000-0000-0000-0000-000000000000' })).status, 400);
    assert.equal((await s.handoff(s.A.work, s.headB)).status, 400, 'a PTO_HEAD is never an assignee');
    assert.equal((await s.handoff(s.B.work, s.B1)).status, 403, 'head A does not lead object B');
    assert.equal((await s.handoff(s.A.work, s.A1)).status, 201);
    assert.equal((await s.handoff(s.A.work, s.A1)).status, 201, 'same engineer again is an idempotent no-op');
    assert.equal((await s.pool.query('SELECT count(*)::int n FROM pto_work_assignments WHERE object_work_id=$1', [s.A.work.id])).rows[0].n, 1);
    assert.equal((await s.handoff(s.A.work, s.A2)).status, 201, 'head A may change to another eligible engineer before any package');
    await s.h.as(s.headB);
    assert.equal((await s.handoff(s.A.work, s.A1)).status, 403, 'head B cannot hand off object A work');
    await s.h.as(s.A1);
    assert.equal((await s.handoff(s.A.work, s.A1)).status, 403, 'an ordinary PTO engineer cannot assign');
    await s.h.login('PROJECT_MANAGER');
    assert.equal((await s.handoff(s.A.work, s.A1)).status, 403);
    await s.h.login('DEPUTY_DIRECTOR');
    assert.equal((await s.handoff(s.A.work, s.A1)).status, 403);
    // ADMIN keeps the existing override but eligibility still applies
    await s.h.login('ADMIN');
    assert.equal((await s.handoff(s.A.work, s.B1)).status, 400);
    assert.equal((await s.handoff(s.A.work, s.A1)).status, 201);
  } finally { await s.h.app.close(); }
});

test('UI03 hard acceptance: handoff persists an assignment but creates NO package, DRAFT or workflow state', async () => {
  const s = await scenario();
  try {
    const before = await s.counts(s.A.work.id);
    assert.deepEqual(before, { packages: 0, history: 0 });
    await s.h.as(s.headA);
    assert.equal((await s.handoff(s.A.work, s.A1)).status, 201);
    assert.deepEqual(await s.counts(s.A.work.id), before, 'package count and status history unchanged');
    const row = (await s.pool.query('SELECT * FROM pto_work_assignments WHERE object_work_id=$1 AND ended_at IS NULL', [s.A.work.id])).rows[0];
    assert.equal(row.assignee_user_id, s.A1.id); assert.equal(row.assigned_by, s.headA.id);
    const v = await s.view(s.A.work);
    assert.equal(v.assignment.assigneeName, 'Инженер А1'); assert.equal(v.packageCount, 0);
    assert.equal(v.canCreatePackage, false, 'the head does not get the engineer action');
    assert.equal(v.canReassign, true);
    // the same view for the engineers: only the assigned one may create
    await s.h.as(s.A1); assert.equal((await s.view(s.A.work)).canCreatePackage, true);
    await s.h.as(s.A2); const a2 = await s.view(s.A.work); assert.equal(a2.canCreatePackage, false); assert.equal(a2.assignment.assigneeName, 'Инженер А1');
  } finally { await s.h.app.close(); }
});

test('UI03 package creation is enforced on the backend by the persisted assignment', async () => {
  const s = await scenario();
  try {
    const create = (work: any, responsibleUserId?: string) => s.h.raw('documentation-packages', { objectWorkId: work.id, ...(responsibleUserId ? { responsibleUserId } : {}) });
    // no assignment yet: nobody on the engineer path can create
    await s.h.as(s.A1);
    assert.equal((await create(s.A.work, s.A1.id)).status, 403, 'unassigned work: even a team member is refused');
    await s.h.as(s.headA);
    assert.equal((await s.handoff(s.A.work, s.A1)).status, 201);
    assert.equal((await create(s.A.work, s.A1.id)).status, 403, 'PTO_HEAD does not use the engineer create path');
    await s.h.as(s.A2);
    assert.equal((await create(s.A.work, s.A2.id)).status, 403, 'A2 is not the assignee');
    assert.equal((await create(s.A.work)).status, 403);
    await s.h.as(s.B1);
    assert.equal((await create(s.A.work, s.B1.id)).status, 403, 'B1 is not on object A at all');
    await s.h.as(s.A1);
    assert.equal((await create(s.A.work, s.A2.id)).status, 403, 'client cannot substitute another responsible');
    assert.equal((await create(s.A.work, s.headA.id)).status, 403);
    assert.deepEqual(await s.counts(s.A.work.id), { packages: 0, history: 0 });
    const ok = await create(s.A.work); // responsible derived server-side
    assert.equal(ok.status, 201, JSON.stringify(ok.data));
    assert.equal(ok.data.responsibleUserId, s.A1.id); assert.equal(ok.data.createdBy, s.A1.id); assert.equal(ok.data.status, 'DRAFT');
    assert.equal((await create(s.A.work, s.A1.id)).status, 201, 'existing rule: a work may have further packages; same assignee');
    // after a package exists, the existing responsible-change semantics are untouched and reassignment is not supported
    await s.h.as(s.headA);
    assert.equal((await s.handoff(s.A.work, s.A2)).status, 400, 'no reassignment after package creation (separate product decision)');
    const v = await s.view(s.A.work);
    assert.equal(v.assignment.assigneeName, 'Инженер А1'); assert.equal(v.packageCount, 2); assert.equal(v.canReassign, false);
    // ADMIN: existing explicit path; once an assignment exists it may only name the assignee
    await s.h.login('ADMIN');
    assert.equal((await create(s.A.work, s.A2.id)).status, 403);
    assert.equal((await create(s.A.work, s.A1.id)).status, 201);
    // reassignment before any package: the new assignee, not the old one, may create
    await s.h.as(s.headB);
    assert.equal((await s.handoff(s.B.work, s.B1)).status, 201);
    await s.h.as(s.headA);
    const s2 = await scenarioReassign(s);
    assert.ok(s2);
  } finally { await s.h.app.close(); }
});

async function scenarioReassign(s: any) {
  // fresh work on object A via the PM, so no package exists yet
  const dict = await s.h.login('PROJECT_MANAGER').then(() => s.h.req('dictionaries'));
  const contractors = await s.h.req('contractors');
  const pm = await s.h.login('PROJECT_MANAGER');
  const w = await s.h.req('works', { objectId: s.A.o.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, responsibleUserId: pm.id, name: 'Вторая работа', unit: 'м²', plannedQuantity: 10, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '1' });
  const create = (who: any) => s.h.as(who).then(() => s.h.raw('documentation-packages', { objectWorkId: w.id }));
  await s.h.as(s.headA);
  assert.equal((await s.handoff(w, s.A1)).status, 201);
  assert.equal((await s.handoff(w, s.A2)).status, 201);
  const rows = (await s.pool.query('SELECT assignee_user_id,ended_at,end_reason FROM pto_work_assignments WHERE object_work_id=$1 ORDER BY started_at', [w.id])).rows;
  assert.equal(rows.length, 2); assert.ok(rows[0].ended_at && rows[0].end_reason === 'REASSIGNED'); assert.equal(rows[1].ended_at, null);
  assert.equal((await create(s.A1)).status, 403, 'previous assignee loses the action');
  const made = await create(s.A2);
  assert.equal(made.status, 201); assert.equal(made.data.responsibleUserId, s.A2.id);
  // history is append-only
  await assert.rejects(() => s.pool.query('DELETE FROM pto_work_assignments WHERE object_work_id=$1', [w.id]), /append-only/);
  return true;
}
