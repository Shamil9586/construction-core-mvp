import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeUser, tokenFor } from './helpers/pbx3-fixtures';

/**
 * PILOT-W01 — a PTO handoff is WORK-scoped and only EFFECTIVE while current. Real HTTP authorization paths over the real
 * backend on PGlite (no resolver-only assertions).
 *
 *   Object A: PTO_HEAD A; team A = A1, A2 (A3 for the membership case); NO engineer is an object PTO member unless a test says so.
 *   W01 -> A1, W02 -> A2 (each with its own package), W03/W04 for the access-loss cases.
 */
const dt = (delta: number) => new Date(Date.now() + delta * 86400000).toISOString().slice(0, 10);
const DEPUTY = 'DEPUTY_DIRECTOR';

async function harness() {
  delete process.env.DATABASE_URL;
  process.env.AUTH_MODE = 'mock';
  process.env.MOCK_LOGIN_KEY = 'pilot-w01-scope-key';
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
  async function login(role: string) { const d = await req('auth/mock', { role, key: 'pilot-w01-scope-key' }); token = d.token; return d.user; }
  async function as(user: any) { token = await tokenFor(user); return user; }
  return { app, req, raw, login, as };
}

async function scenario() {
  const h = await harness();
  const db = await import('../apps/backend/src/db');
  const headA = await makeUser('Начальник А', 'PTO_HEAD');
  const A1 = await makeUser('Инженер А1', 'PTO'), A2 = await makeUser('Инженер А2', 'PTO'), A3 = await makeUser('Инженер А3', 'PTO');
  const pm = await h.login('PROJECT_MANAGER');
  const dict = await h.req('dictionaries');
  const contractors = await h.req('contractors');
  await h.login(DEPUTY);
  const o = await h.req('objects', { externalCode: 'W01SCOPE-' + Date.now() + Math.random().toString(36).slice(2, 6), name: 'Объект A', address: 'Тест, 1', organizationName: 'ООО СЗ', projectManagerId: pm.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [contractors[0].id] });
  for (const m of [A1, A2, A3]) await h.req('function-teams/pto/org-members', { memberUserId: m.id, managerUserId: headA.id });
  await h.req(`objects/${o.id}/function-team/pto/lead`, { leadUserId: headA.id });
  await h.login('PROJECT_MANAGER');
  const mkWork = async (name: string) => {
    const work = await h.req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, responsibleUserId: pm.id, name, unit: 'м²', plannedQuantity: 500, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '20000' });
    const unit = await h.req('execution-units', { objectWorkId: work.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, unit: 'м²', plannedQuantity: 500 });
    const portion = await h.req(`execution-units/${unit.id}/portions`, { label: 'Участок ' + name, plannedQuantity: 200 });
    return { work, unit, portion };
  };
  const W01 = await mkWork('W01'), W02 = await mkWork('W02'), W03 = await mkWork('W03'), W04 = await mkWork('W04');
  const handoff = async (w: any, who: any, expected = 201) => { await h.as(headA); return h.req(`works/${w.work.id}/pto-assignment`, { assigneeUserId: who.id }, expected); };
  const create = (w: any, who: any, responsible?: string) => h.as(who).then(() => h.raw('documentation-packages', { objectWorkId: w.work.id, ...(responsible ? { responsibleUserId: responsible } : {}) }));
  const view = (w: any, who: any) => h.as(who).then(() => h.raw(`works/${w.work.id}/pto-assignment`));
  const leaveTeam = async (who: any) => {
    const cur = await db.one(db.pool, 'SELECT id,version FROM functional_team_memberships WHERE member_user_id=$1 AND ended_at IS NULL', [who.id]);
    await h.login(DEPUTY);
    await h.req('function-teams/pto/redistribute', { reason: 'leaves', orgEnds: [{ memberUserId: who.id, expectedAssignmentId: cur.id, expectedVersion: cur.version }] });
  };
  return { h, db, headA, A1, A2, A3, o, W01, W02, W03, W04, handoff, create, view, leaveTeam };
}

test('A/F: W01 vs W02 on the same object — exact-work scope for every read, snapshot and package operation', async () => {
  const s = await scenario();
  try {
    const { h } = s;
    await s.handoff(s.W01, s.A1); await s.handoff(s.W02, s.A2);
    const p2 = (await s.create(s.W02, s.A2)).data; assert.equal(p2.responsibleUserId, s.A2.id);
    await h.req(`documentation-packages/${p2.id}/portions`, { quantityPortionId: s.W02.portion.id });
    const doc2 = await h.req(`documentation-packages/${p2.id}/documents`, { type: 'AOSR' });
    const p1r = await s.create(s.W01, s.A1); assert.equal(p1r.status, 201); const p1 = p1r.data;
    assert.equal(p1.responsibleUserId, s.A1.id);

    // A1 operates W01 end to end
    await h.as(s.A1);
    assert.equal((await s.view(s.W01, s.A1)).status, 200);
    assert.equal((await h.raw(`works/${s.W01.work.id}`)).status, 200);
    await h.req(`documentation-packages/${p1.id}/portions`, { quantityPortionId: s.W01.portion.id });
    await h.req(`documentation-packages/${p1.id}/documents`, { type: 'AOSR' });
    assert.equal((await h.raw(`documentation-packages/${p1.id}/status`, { status: 'PREPARING', version: p1.version })).status, 201);

    // ... and nothing of W02 (read endpoints)
    assert.equal((await s.view(s.W02, s.A1)).status, 403);
    assert.equal((await h.raw(`works/${s.W02.work.id}`)).status, 403);
    assert.equal((await h.raw(`works/${s.W02.work.id}/progress`)).status, 403);
    assert.equal((await h.raw(`works/${s.W02.work.id}/transition`)).status, 403);
    // ... (package operations on W02)
    assert.equal((await s.create(s.W02, s.A1)).status, 403, 'A1 cannot create a W02 package');
    assert.equal((await h.raw(`documentation-packages/${p2.id}/edit`, { responsibleUserId: s.A2.id, version: p2.version })).status, 403, 'edit');
    assert.equal((await h.raw(`documentation-packages/${p2.id}/status`, { status: 'PREPARING', version: p2.version })).status, 403, 'transition');
    assert.equal((await h.raw(`documentation-packages/${p2.id}/portions`, { quantityPortionId: s.W02.portion.id })).status, 403, 'portion link');
    assert.equal((await h.raw(`documentation-packages/${p2.id}/documents`, { type: 'ACT_CERTIFICATE' })).status, 403, 'document create');
    assert.equal((await h.raw(`documentation-documents/${doc2.id}/versions`, { storageProvider: 'NONE' })).status, 403, 'document version');
    assert.equal((await h.raw(`documentation-packages/${p2.id}/handoff-to-sdo`, { version: p2.version })).status, 403, 'handoff to SDO');
    assert.equal((await h.raw(`documentation-packages/${p2.id}/customer-acceptance`, { version: p2.version, acceptedDate: dt(0) })).status, 403, 'customer acceptance');
    assert.equal((await h.raw(`documentation-packages/${p2.id}/correction`, { version: p2.version })).status, 403, 'pre-handoff correction');
    const before = (await s.db.pool.query('SELECT status,version FROM documentation_packages WHERE id=$1', [p2.id])).rows[0];
    assert.deepEqual(before, { status: 'DRAFT', version: p2.version }, 'W02 package untouched');

    // snapshot: object shell navigable, W01 data only
    await h.as(s.A1);
    const snap = await h.req('snapshot');
    assert.deepEqual(snap.objects.map((x: any) => x.id), [s.o.id], 'object A stays navigable');
    assert.deepEqual(snap.works.map((w: any) => w.id), [s.W01.work.id]);
    assert.deepEqual(snap.executionUnits.map((u: any) => u.id), [s.W01.unit.id]);
    assert.deepEqual(snap.portions.map((p: any) => p.id), [s.W01.portion.id]);
    assert.deepEqual(snap.documentationPackages.map((p: any) => p.id), [p1.id]);
    assert.ok(snap.documentationDocuments.every((d: any) => d.documentationPackageId === p1.id) && snap.documentationDocuments.length >= 1);
    assert.ok(!JSON.stringify(snap).includes(s.W02.work.id) && !JSON.stringify(snap).includes(p2.id) && !JSON.stringify(snap).includes(s.W02.portion.id), 'no W02 identifier anywhere in the snapshot');
    assert.ok(snap.documentationAttentionQueue.every((q: any) => q.objectWorkId === s.W01.work.id));
    assert.equal((await h.raw('documentation-packages')).data.some((p: any) => p.objectWorkId === s.W02.work.id), false);
    assert.equal((await h.raw(`objects/${s.o.id}/works`)).data.some((w: any) => w.id === s.W02.work.id), false);
    // roles with legitimate broader access are unchanged: head sees both works, deputy sees everything
    await h.as(s.headA);
    assert.equal((await h.req('snapshot')).works.filter((w: any) => w.objectId === s.o.id).length, 4);
    await h.login(DEPUTY);
    assert.equal((await h.req('snapshot')).works.filter((w: any) => w.objectId === s.o.id).length, 4);
  } finally { await s.h.app.close(); }
});

test('B: reassignment W01 A1 -> A2 — A1 loses access immediately (read, create, mutate), A2 gains it', async () => {
  const s = await scenario();
  try {
    const { h } = s;
    await s.handoff(s.W03, s.A1);
    assert.equal((await s.view(s.W03, s.A1)).data.canCreatePackage, true);
    assert.equal((await h.raw('snapshot')).data.works.some((w: any) => w.id === s.W03.work.id), true);
    await s.handoff(s.W03, s.A2); // reassign before any package
    // A1: no access anywhere, no create
    assert.equal((await s.view(s.W03, s.A1)).status, 403);
    assert.equal((await h.raw(`works/${s.W03.work.id}`)).status, 403);
    assert.deepEqual((await h.req('snapshot')).objects, [], 'A1 has no remaining source of object access');
    assert.equal((await s.create(s.W03, s.A1)).status, 403);
    assert.equal((await s.create(s.W03, s.A1, s.A1.id)).status, 403);
    // A2: gains it
    const v2 = await s.view(s.W03, s.A2); assert.equal(v2.status, 200); assert.equal(v2.data.canCreatePackage, true);
    assert.equal((await h.raw('snapshot')).data.works.some((w: any) => w.id === s.W03.work.id), true);
    // ADMIN may only name the CURRENT assignee
    await h.login('ADMIN');
    assert.equal((await h.raw('documentation-packages', { objectWorkId: s.W03.work.id, responsibleUserId: s.A1.id })).status, 403);
    // package operations after supersession (state the API itself cannot reach once a package exists, so forced at row level):
    // A2 holds a package on W03, then its assignment is superseded by a row for A3 — A2's old assignment must authorize nothing.
    const made = await s.create(s.W03, s.A2); assert.equal(made.status, 201);
    const db = s.db;
    await db.pool.query("UPDATE pto_work_assignments SET ended_at=clock_timestamp(),ended_by=assigned_by,end_reason='REASSIGNED',version=version+1 WHERE object_work_id=$1 AND ended_at IS NULL", [s.W03.work.id]);
    await db.pool.query('INSERT INTO pto_work_assignments(tenant_id,object_id,object_work_id,assignee_user_id,assigned_by) SELECT tenant_id,object_id,$1,$2,assigned_by FROM pto_work_assignments WHERE object_work_id=$1 LIMIT 1', [s.W03.work.id, s.A3.id]);
    await h.as(s.A2);
    assert.equal((await h.raw(`documentation-packages/${made.data.id}/status`, { status: 'PREPARING', version: made.data.version })).status, 403, 'old assignee cannot mutate');
    assert.equal((await h.raw(`documentation-packages/${made.data.id}/documents`, { type: 'AOSR' })).status, 403);
    await h.as(s.A3);
    assert.equal((await h.raw(`documentation-packages/${made.data.id}/status`, { status: 'PREPARING', version: made.data.version })).status, 201, 'new effective assignee can');
  } finally { await s.h.app.close(); }
});

test('C/E: assigned A1 leaves the head\'s team — every handoff-derived power ends immediately, ADMIN cannot use the stale row', async () => {
  const s = await scenario();
  try {
    const { h } = s;
    await s.handoff(s.W01, s.A1);
    const made = await s.create(s.W01, s.A1); assert.equal(made.status, 201); const p = made.data;
    await h.as(s.A1);
    assert.equal((await h.raw(`documentation-packages/${p.id}/status`, { status: 'PREPARING', version: p.version })).status, 201, 'precondition: A1 operates the package');
    await s.leaveTeam(s.A1);
    // A1 (the ACTUAL assignee, no object membership): nothing left
    await h.as(s.A1);
    assert.equal((await s.view(s.W01, s.A1)).status, 403);
    assert.deepEqual((await h.req('snapshot')).objects, []);
    assert.equal((await s.create(s.W01, s.A1)).status, 403, 'package creation denied');
    assert.equal((await h.raw(`documentation-packages/${p.id}/documents`, { type: 'AOSR' })).status, 403, 'package mutation denied');
    assert.equal((await h.raw(`documentation-packages/${p.id}/status`, { status: 'READY_FOR_PRESENTATION', version: p.version + 1 })).status, 403);
    assert.equal((await h.raw(`documentation-packages/${p.id}/edit`, { responsibleUserId: s.A1.id, version: p.version + 1 })).status, 403);
    // the read model no longer reports A1 as a valid assignee (head, admin, deputy views)
    for (const who of ['head', 'ADMIN', DEPUTY]) {
      if (who === 'head') await h.as(s.headA); else await h.login(who);
      const v = (await h.req(`works/${s.W01.work.id}/pto-assignment`));
      assert.equal(v.assignment, null, who + ': stale assignment is not effective'); assert.equal(v.canCreatePackage, false, who);
      assert.ok(!v.eligible.some((e: any) => e.id === s.A1.id), who);
    }
    // ADMIN cannot create naming A1, nor without a responsible (no effective assignment)
    await h.login('ADMIN');
    assert.equal((await h.raw('documentation-packages', { objectWorkId: s.W01.work.id, responsibleUserId: s.A1.id })).status, 403);
    assert.equal((await h.raw('documentation-packages', { objectWorkId: s.W01.work.id })).status, 403);
    // E: inactive assignee is equally ineffective
    await s.handoff(s.W04, s.A2);
    await s.db.pool.query('UPDATE users SET is_active=false WHERE id=$1', [s.A2.id]);
    await h.login('ADMIN');
    assert.equal((await h.raw('documentation-packages', { objectWorkId: s.W04.work.id, responsibleUserId: s.A2.id })).status, 403);
    assert.equal((await h.raw('documentation-packages', { objectWorkId: s.W04.work.id })).status, 403);
    assert.equal((await h.req(`works/${s.W04.work.id}/pto-assignment`)).canCreatePackage, false);
  } finally { await s.h.app.close(); }
});

test('D: object membership does NOT revive a stale handoff — A1 (member + assigned W03) leaves the team', async () => {
  const s = await scenario();
  try {
    const { h } = s;
    await h.login(DEPUTY);
    await h.req('function-teams/pto/redistribute', { reason: 'member', memberAdds: [{ objectId: s.o.id, memberUserId: s.A1.id }] });
    await s.handoff(s.W03, s.A1);
    assert.equal((await s.view(s.W03, s.A1)).data.canCreatePackage, true, 'precondition');
    await s.leaveTeam(s.A1);
    assert.equal((await s.db.pool.query("SELECT count(*)::int n FROM object_function_member_assignments WHERE member_user_id=$1 AND ended_at IS NULL", [s.A1.id])).rows[0].n, 1, 'A1 still holds PBX-3A object membership (unchanged semantics)');
    // generic PBX-3A object access remains ...
    await h.as(s.A1);
    assert.equal((await h.raw(`objects/${s.o.id}`)).status, 200);
    const v = await s.view(s.W03, s.A1);
    assert.equal(v.status, 200);
    // ... but the stale handoff is worthless: not effective, cannot create, ADMIN cannot create for A1
    assert.equal(v.data.assignment, null); assert.equal(v.data.canCreatePackage, false);
    assert.equal((await s.create(s.W03, s.A1)).status, 403);
    assert.equal((await s.create(s.W03, s.A1, s.A1.id)).status, 403);
    await h.login('ADMIN');
    assert.equal((await h.raw('documentation-packages', { objectWorkId: s.W03.work.id, responsibleUserId: s.A1.id })).status, 403);
    assert.equal((await s.db.pool.query('SELECT count(*)::int n FROM documentation_packages WHERE object_work_id=$1', [s.W03.work.id])).rows[0].n, 0, 'no package slipped through');
    // the head can hand the work to someone who is eligible now, and only that engineer may create
    await s.handoff(s.W03, s.A2);
    assert.equal((await s.create(s.W03, s.A1)).status, 403);
    assert.equal((await s.create(s.W03, s.A2)).status, 201);
  } finally { await s.h.app.close(); }
});
