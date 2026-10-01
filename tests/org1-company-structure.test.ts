import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeUser, tokenFor, tenantId, actorByRole } from './helpers/pbx3-fixtures';

/**
 * ORG-1 — Company Structure & Functional Teams, HTTP level over the real backend on PGlite.
 * Native-PostgreSQL concurrency/history evidence: tests/org1-company-structure-postgres.test.ts.
 */
const dt = (delta: number) => new Date(Date.now() + delta * 86400000).toISOString().slice(0, 10);
let app: any, base = '', db: any;

before(async () => {
  delete process.env.DATABASE_URL;
  process.env.AUTH_MODE = 'mock';
  process.env.MOCK_LOGIN_KEY = 'org1-http-key';
  process.env.RATE_LIMIT_MAX = '100000';
  process.env.DB_MODE = 'pglite';
  process.env.PGLITE_DIR = 'memory://';
  const { migrate } = await import('../scripts/migrate');
  const { seed } = await import('../scripts/seed');
  const { createApp } = await import('../apps/backend/src/main');
  db = await import('../apps/backend/src/db');
  await migrate();
  await seed();
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
});
after(async () => { await app?.close(); });

async function call(user: any, path: string, body?: any) {
  const r = await fetch(base + '/api/'.replace('/api/', '/') + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (await tokenFor(user)) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, data: (await r.json().catch(() => null)) as any };
}
async function ok(user: any, path: string, body?: any) {
  const r = await call(user, path, body);
  assert.equal(r.status, body === undefined ? 200 : 201, path + ': ' + JSON.stringify(r.data));
  return r.data;
}
const deputy = () => actorByRole('DEPUTY_DIRECTOR');
const admin = () => actorByRole('ADMIN');
const fnGroup = (ov: any, fn: string) => ov.functions.find((f: any) => f.functionCode === fn);
const manager = (ov: any, fn: string, id: string) => fnGroup(ov, fn).managers.find((m: any) => m.userId === id);
async function current(memberId: string, fn: string) {
  return db.one(db.pool, 'SELECT * FROM functional_team_memberships WHERE tenant_id=$1 AND function_code=$2 AND member_user_id=$3 AND ended_at IS NULL', [await tenantId(), fn, memberId]);
}
const exp = async (memberId: string, fn: string) => { const c = await current(memberId, fn); return { expectedAssignmentId: c.id, expectedVersion: c.version }; };
async function makeObject(name: string, pmId: string) {
  return db.insert(db.pool, 'objects', await tenantId(), { externalCode: 'ORG1-' + name + '-' + Math.random().toString(36).slice(2, 8), name, address: 'Тест, 1', organizationName: 'ООО СЗ', projectManagerId: pmId, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000' });
}
const snapshot = async (sql: string) => JSON.stringify((await db.pool.query(sql)).rows);

test('A/B/C PTO: initial assignment (reasonless), transfer Head1 -> Head2 and end all go through the bounded API', async () => {
  const d = await deputy();
  const h1 = await makeUser('А Нач. 1', 'PTO_HEAD'), h2 = await makeUser('А Нач. 2', 'PTO_HEAD'), e = await makeUser('А Инж.', 'PTO');
  let ov = await ok(d, 'org-structure');
  assert.ok(fnGroup(ov, 'PTO').unassigned.some((x: any) => x.userId === e.id), 'unassigned before assignment');
  const first = await ok(d, 'org-structure/PTO/assign', { memberUserId: e.id, managerUserId: h1.id });
  assert.equal(first.version, 1);
  ov = await ok(d, 'org-structure');
  assert.ok(!fnGroup(ov, 'PTO').unassigned.some((x: any) => x.userId === e.id));
  assert.deepEqual(manager(ov, 'PTO', h1.id).orgMembers.map((m: any) => m.userId), [e.id]);
  const asg = manager(ov, 'PTO', h1.id).orgMembers[0].assignment;
  assert.deepEqual(asg, { assignmentId: first.id, version: 1 });
  const second = await ok(d, 'org-structure/PTO/transfer', { memberUserId: e.id, managerUserId: h2.id, reason: '  Перераспределение нагрузки  ', expectedAssignmentId: asg.assignmentId, expectedVersion: asg.version });
  assert.notEqual(second.id, first.id);
  const old = await db.one(db.pool, 'SELECT * FROM functional_team_memberships WHERE id=$1', [first.id]);
  assert.equal(old.endReason, 'Перераспределение нагрузки', 'trimmed business reason is what is persisted');
  assert.ok(old.endedAt);
  ov = await ok(d, 'org-structure');
  assert.deepEqual(manager(ov, 'PTO', h2.id).orgMembers.map((m: any) => m.userId), [e.id]);
  assert.equal(manager(ov, 'PTO', h1.id).orgMembers.length, 0);
  await ok(d, 'org-structure/PTO/end', { memberUserId: e.id, reason: 'Увольнение', ...(await exp(e.id, 'PTO')) });
  assert.equal(await current(e.id, 'PTO'), undefined);
  ov = await ok(d, 'org-structure');
  assert.ok(fnGroup(ov, 'PTO').unassigned.some((x: any) => x.userId === e.id), 'back to «Без руководителя»');
  // Admin is the system override with the same authority.
  await ok(await admin(), 'org-structure/PTO/assign', { memberUserId: e.id, managerUserId: h1.id });
});

test('D transfer/end without a real business reason are rejected and nothing is persisted (no fallback reason)', async () => {
  const d = await deputy();
  const h1 = await makeUser('Д Нач. 1', 'SDO_HEAD'), h2 = await makeUser('Д Нач. 2', 'SDO_HEAD'), e = await makeUser('Д Инж.', 'SDO');
  await ok(d, 'org-structure/SDO/assign', { memberUserId: e.id, managerUserId: h1.id });
  const x = await exp(e.id, 'SDO');
  for (const reason of [undefined, '', '   ', '\n\t']) {
    for (const [path, body] of [['transfer', { memberUserId: e.id, managerUserId: h2.id }], ['end', { memberUserId: e.id }]] as const)
      assert.equal((await call(d, `org-structure/SDO/${path}`, { ...body, ...x, ...(reason === undefined ? {} : { reason }) })).status, 400, `${path} reason=${JSON.stringify(reason)}`);
  }
  // Service level too (not only the DTO): a direct call with a blank reason is refused.
  const { OrgStructureService } = await import('../apps/backend/src/org-structure-service');
  await assert.rejects(new OrgStructureService().end(d, 'SDO', { memberUserId: e.id, reason: '  ', expectedAssignmentId: x.expectedAssignmentId, expectedVersion: x.expectedVersion }), (err: any) => err.status === 400);
  const still = await current(e.id, 'SDO');
  assert.equal(still.id, x.expectedAssignmentId);
  assert.equal((await db.pool.query("SELECT count(*)::int n FROM functional_team_memberships WHERE end_reason IN ('TRANSFER','ORG_END') OR (ended_at IS NOT NULL AND (end_reason IS NULL OR length(trim(end_reason))=0)) AND member_user_id=$1", [e.id])).rows[0].n, 0);
  // Legacy PTO redistribute path obeys the same rule (blank reason is already a DTO error; an existing membership needs its expectation).
  const ph = await makeUser('Д ПТО Нач.', 'PTO_HEAD'), ph2 = await makeUser('Д ПТО Нач. 2', 'PTO_HEAD'), pe = await makeUser('Д ПТО', 'PTO');
  await ok(d, 'function-teams/pto/org-members', { memberUserId: pe.id, managerUserId: ph.id });
  const empty = { orgTransfers: [], orgEnds: [], leadChanges: [], memberEnds: [], memberAdds: [], handovers: [] };
  assert.equal((await call(d, 'function-teams/pto/redistribute', { ...empty, reason: '   ', orgEnds: [{ memberUserId: pe.id, ...(await exp(pe.id, 'PTO')) }] })).status, 400);
  assert.equal((await call(d, 'function-teams/pto/redistribute', { ...empty, reason: 'ок', orgEnds: [{ memberUserId: pe.id }] })).status, 400, 'existing membership needs expectation');
  assert.equal((await call(d, 'function-teams/pto/org-members', { memberUserId: pe.id, managerUserId: ph2.id, expectedVersion: 1 })).status, 400, 'version-only legacy mutation refused');
  assert.equal((await call(d, 'function-teams/pto/org-members', { memberUserId: pe.id, managerUserId: ph2.id, ...(await exp(pe.id, 'PTO')) })).status, 400, 'legacy transfer without reason refused');
  await ok(d, 'function-teams/pto/org-members', { memberUserId: pe.id, managerUserId: ph2.id, reason: 'Реорганизация', ...(await exp(pe.id, 'PTO')) });
});

test('E/F stale client: X/v1 replaced by Y/v1, a stale transfer/end targeting X/v1 never ends Y; version alone is not accepted', async () => {
  const d = await deputy();
  const h1 = await makeUser('Е Нач. 1', 'CONSTRUCTION_CONTROL_HEAD'), h2 = await makeUser('Е Нач. 2', 'CONSTRUCTION_CONTROL_HEAD'), h3 = await makeUser('Е Нач. 3', 'CONSTRUCTION_CONTROL_HEAD'), e = await makeUser('Е Инж.', 'CONSTRUCTION_CONTROL');
  const X = await ok(d, 'org-structure/CONSTRUCTION_CONTROL/assign', { memberUserId: e.id, managerUserId: h1.id });
  assert.equal(X.version, 1);
  const Y = await ok(d, 'org-structure/CONSTRUCTION_CONTROL/transfer', { memberUserId: e.id, managerUserId: h2.id, reason: 'Первый перевод', expectedAssignmentId: X.id, expectedVersion: 1 });
  assert.equal(Y.version, 1, 'replacement row starts at the SAME numeric version as X');
  const stale = { memberUserId: e.id, expectedAssignmentId: X.id, expectedVersion: 1, reason: 'Устаревший клиент' };
  assert.equal((await call(d, 'org-structure/CONSTRUCTION_CONTROL/transfer', { ...stale, managerUserId: h3.id })).status, 409);
  assert.equal((await call(d, 'org-structure/CONSTRUCTION_CONTROL/end', stale)).status, 409);
  const after = await current(e.id, 'CONSTRUCTION_CONTROL');
  assert.equal(after.id, Y.id, 'Y is still the active membership');
  assert.equal(after.managerUserId, h2.id);
  assert.equal(after.endedAt ?? null, null);
  // Wrong version on the RIGHT id is also a conflict; identity is never enough on its own either.
  assert.equal((await call(d, 'org-structure/CONSTRUCTION_CONTROL/end', { memberUserId: e.id, reason: 'x', expectedAssignmentId: Y.id, expectedVersion: 2 })).status, 409);
  // Version-only / id-only mutation of an existing membership is not accepted.
  assert.equal((await call(d, 'org-structure/CONSTRUCTION_CONTROL/end', { memberUserId: e.id, reason: 'x', expectedVersion: 1 })).status, 400);
  assert.equal((await call(d, 'org-structure/CONSTRUCTION_CONTROL/end', { memberUserId: e.id, reason: 'x', expectedAssignmentId: Y.id })).status, 400);
  const { OrgStructureService } = await import('../apps/backend/src/org-structure-service');
  await assert.rejects((new OrgStructureService() as any).transfer(d, 'CONSTRUCTION_CONTROL', { memberUserId: e.id, managerUserId: h3.id, reason: 'x', expectedVersion: 1 }), (err: any) => err.status === 400, 'service-level version-only refused');
  // Initial assignment of an already-assigned employee is a conflict, not a silent transfer.
  assert.equal((await call(d, 'org-structure/CONSTRUCTION_CONTROL/assign', { memberUserId: e.id, managerUserId: h3.id })).status, 409);
  // Stale client holding an expectation for an employee that has since been ended.
  await ok(d, 'org-structure/CONSTRUCTION_CONTROL/end', { memberUserId: e.id, reason: 'Завершено', expectedAssignmentId: Y.id, expectedVersion: 1 });
  assert.equal((await call(d, 'org-structure/CONSTRUCTION_CONTROL/end', { memberUserId: e.id, reason: 'Повтор', expectedAssignmentId: Y.id, expectedVersion: 1 })).status, 409);
  assert.equal((await call(d, 'org-structure/CONSTRUCTION_CONTROL/transfer', { memberUserId: e.id, managerUserId: h3.id, reason: 'Повтор', expectedAssignmentId: Y.id, expectedVersion: 1 })).status, 409);
});

test('G/H organizational transfer/end never cascades into object lead/member rows, РП or handovers', async () => {
  const d = await deputy();
  const h1 = await makeUser('Г Нач. 1', 'PTO_HEAD'), h2 = await makeUser('Г Нач. 2', 'PTO_HEAD'), e = await makeUser('Г Инж.', 'PTO'), pm = await makeUser('Г РП', 'PROJECT_MANAGER');
  const o = await makeObject('Каскад', pm.id);
  const { ObjectTeamService } = await import('../apps/backend/src/team-service');
  const svc = new ObjectTeamService();
  await svc.assignObjectLead(d, o.id, { leadUserId: h1.id });
  await svc.assignOrgMember(d, { memberUserId: e.id, managerUserId: h1.id });
  await svc.redistribute(d, { reason: 'setup', orgTransfers: [], orgEnds: [], leadChanges: [], memberEnds: [], memberAdds: [{ objectId: o.id, memberUserId: e.id }], handovers: [] });
  const state = () => Promise.all(['object_function_lead_assignments', 'object_function_member_assignments', 'object_function_handovers'].map((t) => snapshot(`SELECT * FROM ${t} ORDER BY id`))).then(async (x) => [...x, await snapshot(`SELECT id,project_manager_id,version FROM objects ORDER BY id`)].join('|'));
  const before = await state();
  await ok(d, 'org-structure/PTO/transfer', { memberUserId: e.id, managerUserId: h2.id, reason: 'Смена руководителя', ...(await exp(e.id, 'PTO')) });
  assert.equal(await state(), before, 'transfer: no object lead/member/handover/РП change');
  await ok(d, 'org-structure/PTO/end', { memberUserId: e.id, reason: 'Выход из команды', ...(await exp(e.id, 'PTO')) });
  assert.equal(await state(), before, 'end: no object lead/member/handover/РП change');
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM object_function_member_assignments WHERE member_user_id=$1 AND ended_at IS NULL', [e.id])).rows[0].n, 1, 'still on the object');
});

test('I/J/K PROJECT_MANAGEMENT: Deputy -> РП is a real stored relation; it never touches objects.project_manager_id or object_function_*', async () => {
  const d = await deputy();
  const d1 = await makeUser('И Зам 1', 'DEPUTY_DIRECTOR'), d2 = await makeUser('И Зам 2', 'DEPUTY_DIRECTOR'), pm = await makeUser('И РП', 'PROJECT_MANAGER');
  const o1 = await makeObject('РП-1', pm.id), o2 = await makeObject('РП-2', pm.id);
  let ov = await ok(d, 'org-structure');
  assert.ok(fnGroup(ov, 'PROJECT_MANAGEMENT').unassigned.some((u: any) => u.userId === pm.id), '«Без руководителя»');
  const rpUnassigned = fnGroup(ov, 'PROJECT_MANAGEMENT').unassigned.find((u: any) => u.userId === pm.id);
  assert.deepEqual(rpUnassigned.objects.map((o: any) => o.objectId).sort(), [o1.id, o2.id].sort(), 'authoritative object РП source is displayed even without an org manager');
  const objectsBefore = await snapshot('SELECT id,project_manager_id,version,updated_at FROM objects ORDER BY id');
  const lanesBefore = await snapshot("SELECT * FROM object_function_lead_assignments UNION ALL SELECT id,tenant_id,object_id,function_code,member_user_id,assigned_by,started_at,ended_at,ended_by,end_reason,version FROM object_function_member_assignments");
  const a = await ok(d, 'org-structure/PROJECT_MANAGEMENT/assign', { memberUserId: pm.id, managerUserId: d1.id });
  assert.equal(a.functionCode, 'PROJECT_MANAGEMENT');
  await ok(d, 'org-structure/PROJECT_MANAGEMENT/transfer', { memberUserId: pm.id, managerUserId: d2.id, reason: 'Передача РП другому заместителю', expectedAssignmentId: a.id, expectedVersion: 1 });
  assert.equal(await snapshot('SELECT id,project_manager_id,version,updated_at FROM objects ORDER BY id'), objectsBefore, 'objects untouched (incl. projectManagerId/version)');
  assert.equal(await snapshot("SELECT * FROM object_function_lead_assignments UNION ALL SELECT id,tenant_id,object_id,function_code,member_user_id,assigned_by,started_at,ended_at,ended_by,end_reason,version FROM object_function_member_assignments"), lanesBefore);
  assert.equal((await db.pool.query("SELECT count(*)::int n FROM object_function_lead_assignments WHERE function_code='PROJECT_MANAGEMENT'")).rows[0].n, 0, 'RP responsibility is NOT duplicated into object_function_*');
  ov = await ok(d, 'org-structure');
  const mgr = manager(ov, 'PROJECT_MANAGEMENT', d2.id);
  assert.deepEqual(mgr.orgMembers.map((m: any) => m.userId), [pm.id]);
  assert.deepEqual(mgr.orgMembers[0].objects.map((o: any) => o.relation), ['PROJECT_MANAGER', 'PROJECT_MANAGER']);
  assert.equal(mgr.objectCount, 2);
  assert.ok(ov.management.deputies.some((x: any) => x.userId === d2.id && x.projectManagerCount === 1));
});

test('L inactive manager / member: relationship is surfaced as unresolved, nobody is moved, cleanup stays possible', async () => {
  const d = await deputy();
  const h1 = await makeUser('Л Нач. 1', 'PTO_HEAD'), h2 = await makeUser('Л Нач. 2', 'PTO_HEAD'), e1 = await makeUser('Л Инж. 1', 'PTO'), e2 = await makeUser('Л Инж. 2', 'PTO');
  await ok(d, 'org-structure/PTO/assign', { memberUserId: e1.id, managerUserId: h1.id });
  await ok(d, 'org-structure/PTO/assign', { memberUserId: e2.id, managerUserId: h1.id });
  await db.pool.query('UPDATE users SET is_active=false WHERE id=$1', [h1.id]);
  const e2row = await current(e2.id, 'PTO');
  let ov = await ok(d, 'org-structure');
  const m = manager(ov, 'PTO', h1.id);
  assert.equal(m.isActive, false);
  assert.deepEqual(m.orgMembers.map((x: any) => x.userId).sort(), [e1.id, e2.id].sort(), 'still under the inactive manager, history intact');
  assert.equal(fnGroup(ov, 'PTO').unresolved.filter((u: any) => u.kind === 'MANAGER_UNAVAILABLE' && u.managerUserId === h1.id).length, 2);
  assert.equal((await current(e2.id, 'PTO')).id, e2row.id, 'no guessed successor / automatic reassignment');
  assert.ok(!fnGroup(ov, 'PTO').unassigned.some((x: any) => x.userId === e1.id));
  // Deputy decides: transfer one to an active head, end the other. Both work although the OLD manager is inactive.
  await ok(d, 'org-structure/PTO/transfer', { memberUserId: e1.id, managerUserId: h2.id, reason: 'Начальник недоступен', ...(await exp(e1.id, 'PTO')) });
  await ok(d, 'org-structure/PTO/end', { memberUserId: e2.id, reason: 'Начальник недоступен', ...(await exp(e2.id, 'PTO')) });
  // An inactive manager can never be a NEW target; an inactive employee can still be ended.
  const e3 = await makeUser('Л Инж. 3', 'PTO');
  assert.equal((await call(d, 'org-structure/PTO/assign', { memberUserId: e3.id, managerUserId: h1.id })).status, 400);
  await ok(d, 'org-structure/PTO/assign', { memberUserId: e3.id, managerUserId: h2.id });
  await db.pool.query('UPDATE users SET is_active=false WHERE id=$1', [e3.id]);
  ov = await ok(d, 'org-structure');
  assert.ok(fnGroup(ov, 'PTO').unresolved.some((u: any) => u.kind === 'MEMBER_UNAVAILABLE' && u.memberUserId === e3.id));
  await ok(d, 'org-structure/PTO/end', { memberUserId: e3.id, reason: 'Сотрудник уволен', ...(await exp(e3.id, 'PTO')) });
  ov = await ok(d, 'org-structure');
  assert.ok(!fnGroup(ov, 'PTO').unresolved.some((u: any) => u.memberUserId === e3.id));
});

test('M/N/O authorization: full read GD/Deputy/Admin; heads only own team; engineers and РП denied; GD cannot mutate', async () => {
  const d = await deputy();
  const ph = await makeUser('М ПТО Нач.', 'PTO_HEAD'), ph2 = await makeUser('М ПТО Нач. 2', 'PTO_HEAD'), pe = await makeUser('М ПТО', 'PTO'), pe2 = await makeUser('М ПТО 2', 'PTO'), pe3 = await makeUser('М ПТО 3', 'PTO');
  const sh = await makeUser('М СДО Нач.', 'SDO_HEAD'), se = await makeUser('М СДО', 'SDO');
  const ch = await makeUser('М СК Нач.', 'CONSTRUCTION_CONTROL_HEAD'), ce = await makeUser('М СК', 'CONSTRUCTION_CONTROL');
  await ok(d, 'org-structure/PTO/assign', { memberUserId: pe.id, managerUserId: ph.id });
  await ok(d, 'org-structure/PTO/assign', { memberUserId: pe2.id, managerUserId: ph2.id });
  await ok(d, 'org-structure/SDO/assign', { memberUserId: se.id, managerUserId: sh.id });
  await ok(d, 'org-structure/CONSTRUCTION_CONTROL/assign', { memberUserId: ce.id, managerUserId: ch.id });
  // Full readers.
  for (const [role, canManage] of [['GENERAL_DIRECTOR', false], ['DEPUTY_DIRECTOR', true], ['ADMIN', true]] as const) {
    const ov = await ok(await actorByRole(role), 'org-structure');
    assert.equal(ov.scope, 'FULL'); assert.equal(ov.canManage, canManage);
    assert.deepEqual(ov.functions.map((f: any) => f.functionCode), ['PTO', 'CONSTRUCTION_CONTROL', 'SDO', 'PROJECT_MANAGEMENT']);
    assert.ok(ov.management.deputies.length > 0);
    const asg = manager(ov, 'PTO', ph.id).orgMembers[0].assignment;
    assert.equal(asg !== null, canManage, `${role}: assignment id/version exposed only to a caller who may mutate`);
    assert.ok(Array.isArray((await ok(await actorByRole(role), 'org-structure/history')))); 
  }
  // GENERAL_DIRECTOR: read-only.
  const gd = await actorByRole('GENERAL_DIRECTOR');
  assert.equal((await call(gd, 'org-structure/PTO/assign', { memberUserId: pe3.id, managerUserId: ph.id })).status, 403);
  assert.equal((await call(gd, 'org-structure/PTO/transfer', { memberUserId: pe.id, managerUserId: ph2.id, reason: 'x', ...(await exp(pe.id, 'PTO')) })).status, 403);
  assert.equal((await call(gd, 'org-structure/PTO/end', { memberUserId: pe.id, reason: 'x', ...(await exp(pe.id, 'PTO')) })).status, 403);
  // Functional heads: own contour/team only, never company-wide, never mutation.
  const own = await ok(ph, 'org-structure');
  assert.equal(own.scope, 'OWN_TEAM'); assert.equal(own.canManage, false); assert.equal(own.management, null);
  assert.deepEqual(own.functions.map((f: any) => f.functionCode), ['PTO']);
  assert.deepEqual(own.functions[0].managers.map((x: any) => x.userId), [ph.id]);
  assert.deepEqual(own.functions[0].managers[0].orgMembers.map((x: any) => x.userId), [pe.id]);
  assert.equal(own.functions[0].managers[0].orgMembers[0].assignment, null, 'a head is never handed assignment ids');
  assert.deepEqual(own.functions[0].unassigned, []);
  assert.ok(!JSON.stringify(own).includes(pe2.id) && !JSON.stringify(own).includes(ph2.id), 'no other PTO team leaks');
  const sOwn = await ok(sh, 'org-structure'), cOwn = await ok(ch, 'org-structure');
  assert.deepEqual(sOwn.functions.map((f: any) => f.functionCode), ['SDO']); assert.deepEqual(sOwn.functions[0].managers[0].orgMembers.map((x: any) => x.userId), [se.id]);
  assert.deepEqual(cOwn.functions.map((f: any) => f.functionCode), ['CONSTRUCTION_CONTROL']); assert.deepEqual(cOwn.functions[0].managers[0].orgMembers.map((x: any) => x.userId), [ce.id]);
  const hist = await ok(ph, 'org-structure/history');
  assert.ok(hist.length > 0 && hist.every((h: any) => h.functionCode === 'PTO' && [h.managerUserId, h.previousManagerUserId, h.nextManagerUserId].includes(ph.id)));
  assert.equal((await call(ph, 'org-structure/history?functionCode=SDO')).status, 403);
  assert.equal((await call(ph, 'org-structure/PTO/transfer', { memberUserId: pe.id, managerUserId: ph2.id, reason: 'x', ...(await exp(pe.id, 'PTO')) })).status, 403, 'no cross-team transfer');
  assert.equal((await call(ph, 'org-structure/PTO/assign', { memberUserId: pe3.id, managerUserId: ph.id })).status, 403);
  assert.equal((await call(ph, 'org-structure/PTO/end', { memberUserId: pe.id, reason: 'x', ...(await exp(pe.id, 'PTO')) })).status, 403);
  // Ordinary engineers, РП and the external role: no company-wide screen, no API.
  for (const u of [pe, se, ce, await actorByRole('PROJECT_MANAGER'), await actorByRole('CONTRACTOR_VIEWER')]) {
    assert.equal((await call(u, 'org-structure')).status, 403, u.role);
    assert.equal((await call(u, 'org-structure/history')).status, 403, u.role);
    assert.equal((await call(u, 'org-structure/PTO/assign', { memberUserId: pe3.id, managerUserId: ph.id })).status, 403, u.role);
  }
  assert.equal((await fetch(base + '/org-structure')).status, 401);
});

test('P exact role pair per function code (all four), in both directions', async () => {
  const d = await deputy();
  const pairs: Record<string, [string, string]> = { PTO: ['PTO_HEAD', 'PTO'], CONSTRUCTION_CONTROL: ['CONSTRUCTION_CONTROL_HEAD', 'CONSTRUCTION_CONTROL'], SDO: ['SDO_HEAD', 'SDO'], PROJECT_MANAGEMENT: ['DEPUTY_DIRECTOR', 'PROJECT_MANAGER'] };
  const roles = [...new Set(Object.values(pairs).flat()), 'GENERAL_DIRECTOR', 'ADMIN'];
  const pool: Record<string, any> = {};
  for (const r of roles) pool[r] = await makeUser('Р ' + r, r);
  for (const [fn, [mgrRole, memRole]] of Object.entries(pairs)) {
    for (const mr of roles) for (const er of roles) {
      if (mr === mgrRole && er === memRole) continue;
      const res = await call(d, `org-structure/${fn}/assign`, { memberUserId: pool[er].id, managerUserId: pool[mr].id });
      assert.equal(res.status, 400, `${fn}: manager ${mr} / member ${er} must be refused`);
    }
    const fresh = await makeUser('Р сотрудник ' + fn, memRole), freshMgr = await makeUser('Р рук ' + fn, mgrRole);
    await ok(d, `org-structure/${fn}/assign`, { memberUserId: fresh.id, managerUserId: freshMgr.id });
    const sameRoleTarget = await makeUser('Р рук2 ' + fn, mgrRole);
    // Transfer target is validated against the same exact pair.
    const wrong = await call(d, `org-structure/${fn}/transfer`, { memberUserId: fresh.id, managerUserId: pool[mgrRole === 'PTO_HEAD' ? 'SDO_HEAD' : 'PTO_HEAD'].id, reason: 'x', ...(await exp(fresh.id, fn)) });
    assert.equal(wrong.status, 400, fn + ' transfer to wrong-role manager');
    await ok(d, `org-structure/${fn}/transfer`, { memberUserId: fresh.id, managerUserId: sameRoleTarget.id, reason: 'ok', ...(await exp(fresh.id, fn)) });
  }
  // Unknown function code and a self-assignment.
  assert.equal((await call(d, 'org-structure/TECHNICAL/assign', { memberUserId: pool.PTO.id, managerUserId: pool.PTO_HEAD.id })).status, 400);
  assert.equal((await call(d, 'org-structure/PTO/assign', { memberUserId: pool.PTO.id, managerUserId: pool.PTO.id })).status, 400);
});

test('Q tenant isolation: cross-tenant ids are rejected and foreign people never appear in the read model or history', async () => {
  const d = await deputy();
  const t2 = (await db.pool.query("INSERT INTO tenants(portal,member_id,name) VALUES('org1-other.local','org1-other-member','Другой') RETURNING id")).rows[0];
  const fHead = await makeUser('Ч Нач.', 'PTO_HEAD', { tenant: t2.id }), fEng = await makeUser('Ч Инж.', 'PTO', { tenant: t2.id });
  const fHead2 = await makeUser('Ч Нач. 2', 'PTO_HEAD', { tenant: t2.id });
  const fDeputy = await makeUser('Ч Зам', 'DEPUTY_DIRECTOR', { tenant: t2.id }), fPm = await makeUser('Ч РП', 'PROJECT_MANAGER', { tenant: t2.id });
  const h = await makeUser('Ч Нач. свой', 'PTO_HEAD'), e = await makeUser('Ч Инж. свой', 'PTO');
  // Foreign tenant's own deputy manages it with the same API (tenant comes from the session).
  const fd = fDeputy; (fd as any).role = 'DEPUTY_DIRECTOR';
  const foreignAsg = await ok(fd, 'org-structure/PTO/assign', { memberUserId: fEng.id, managerUserId: fHead.id });
  assert.equal(foreignAsg.tenantId, t2.id);
  await ok(fd, 'org-structure/PROJECT_MANAGEMENT/assign', { memberUserId: fPm.id, managerUserId: fDeputy.id });
  await ok(d, 'org-structure/PTO/assign', { memberUserId: e.id, managerUserId: h.id });
  assert.equal((await call(d, 'org-structure/PTO/assign', { memberUserId: fEng.id, managerUserId: h.id })).status, 404, 'foreign member');
  assert.equal((await call(d, 'org-structure/PTO/assign', { memberUserId: (await makeUser('Ч Инж. 2', 'PTO')).id, managerUserId: fHead.id })).status, 404, 'foreign manager');
  assert.equal((await call(d, 'org-structure/PTO/transfer', { memberUserId: fEng.id, managerUserId: h.id, reason: 'x', expectedAssignmentId: foreignAsg.id, expectedVersion: 1 })).status, 404, 'foreign member + foreign assignment id');
  assert.equal((await call(d, 'org-structure/PTO/end', { memberUserId: fEng.id, reason: 'x', expectedAssignmentId: foreignAsg.id, expectedVersion: 1 })).status, 404, 'cannot end another tenant membership');
  assert.ok(await db.one(db.pool, 'SELECT 1 FROM functional_team_memberships WHERE id=$1 AND ended_at IS NULL', [foreignAsg.id]), 'foreign membership untouched');
  assert.equal((await call(d, 'org-structure/PTO/transfer', { memberUserId: e.id, managerUserId: fHead2.id, reason: 'x', expectedAssignmentId: foreignAsg.id, expectedVersion: 1 })).status, 404);
  const ov = JSON.stringify(await ok(d, 'org-structure')), hist = JSON.stringify(await ok(d, 'org-structure/history'));
  for (const id of [fHead.id, fEng.id, fDeputy.id, fPm.id, foreignAsg.id]) { assert.ok(!ov.includes(id), 'overview leaks ' + id); assert.ok(!hist.includes(id), 'history leaks ' + id); }
  const fov = JSON.stringify(await ok(fd, 'org-structure'));
  assert.ok(!fov.includes(e.id) && !fov.includes(h.id), 'the other tenant sees nothing of ours');
  assert.equal((await call(d, 'org-structure/history?memberUserId=' + fEng.id)).data.length, 0);
});

test('R history is append-only and readable: function, employee, old/new manager, reason, actor, timestamps', async () => {
  const d = await deputy(), a = await admin();
  const h1 = await makeUser('Я Нач. 1', 'PTO_HEAD'), h2 = await makeUser('Я Нач. 2', 'PTO_HEAD'), e = await makeUser('Я Инж.', 'PTO');
  const r1 = await ok(d, 'org-structure/PTO/assign', { memberUserId: e.id, managerUserId: h1.id });
  const r2 = await ok(a, 'org-structure/PTO/transfer', { memberUserId: e.id, managerUserId: h2.id, reason: 'Причина перевода', expectedAssignmentId: r1.id, expectedVersion: 1 });
  await ok(d, 'org-structure/PTO/end', { memberUserId: e.id, reason: 'Причина выхода', expectedAssignmentId: r2.id, expectedVersion: 1 });
  const hist = await ok(d, `org-structure/history?functionCode=PTO&memberUserId=${e.id}`);
  assert.equal(hist.length, 2);
  const [newest, oldest] = hist;
  assert.equal(oldest.managerUserId, h1.id); assert.equal(oldest.previousManagerUserId, null); assert.equal(oldest.nextManagerUserId, h2.id);
  assert.equal(oldest.reason, 'Причина перевода'); assert.equal(oldest.endedByName, a.name); assert.equal(oldest.startedByName, d.name); assert.ok(oldest.startedAt && oldest.endedAt);
  assert.equal(newest.managerUserId, h2.id); assert.equal(newest.previousManagerUserId, h1.id); assert.equal(newest.nextManagerUserId, null);
  assert.equal(newest.reason, 'Причина выхода'); assert.equal(newest.active, false); assert.equal(newest.memberName, e.name); assert.equal(newest.functionCode, 'PTO');
  // Native triggers: no physical delete, no rewrite of an ended row, no rewrite of identity columns.
  const reject = async (sql: string, args: any[]) => { await assert.rejects(db.pool.query(sql, args), (err: any) => err.code === '23514' || /immutable|append-only/.test(err.message)); };
  await reject('DELETE FROM functional_team_memberships WHERE id=$1', [r1.id]);
  await reject('UPDATE functional_team_memberships SET end_reason=$2 WHERE id=$1', [r1.id, 'rewrite']);
  await reject('UPDATE functional_team_memberships SET manager_user_id=$2 WHERE id=$1', [r1.id, h2.id]);
  await reject('UPDATE functional_team_memberships SET started_at=now() WHERE id=$1', [r1.id]);
  const rows = (await db.pool.query('SELECT id,manager_user_id,end_reason FROM functional_team_memberships WHERE member_user_id=$1 ORDER BY started_at', [e.id])).rows;
  assert.deepEqual(rows.map((x: any) => x.end_reason), ['Причина перевода', 'Причина выхода']);
  // The first row is still the one the first command created.
  assert.equal(rows[0].id, r1.id);
});

test('object summaries: org manager != object lead is shown as inherited / different team (valid state), РП objects shown next to the relation', async () => {
  const d = await deputy();
  const h1 = await makeUser('О Нач. 1', 'PTO_HEAD'), h2 = await makeUser('О Нач. 2', 'PTO_HEAD'), e = await makeUser('О Инж.', 'PTO'), e2 = await makeUser('О Инж. 2', 'PTO'), pm = await makeUser('О РП', 'PROJECT_MANAGER');
  const o = await makeObject('Унаследованный', pm.id);
  const { ObjectTeamService } = await import('../apps/backend/src/team-service');
  const svc = new ObjectTeamService();
  await svc.assignOrgMember(d, { memberUserId: e.id, managerUserId: h1.id });
  await svc.assignOrgMember(d, { memberUserId: e2.id, managerUserId: h2.id });
  await svc.assignObjectLead(d, o.id, { leadUserId: h2.id });
  await svc.redistribute(d, { reason: 'setup', orgTransfers: [], orgEnds: [], leadChanges: [], memberEnds: [], memberAdds: [{ objectId: o.id, memberUserId: e.id }, { objectId: o.id, memberUserId: e2.id }], handovers: [] });
  const ov = await ok(d, 'org-structure');
  const inherited = manager(ov, 'PTO', h1.id).orgMembers.find((m: any) => m.userId === e.id).objects[0];
  assert.deepEqual({ r: inherited.relation, lead: inherited.objectLeadUserId, diff: inherited.differentOrgTeam, name: inherited.name }, { r: 'MEMBER', lead: h2.id, diff: true, name: 'Унаследованный' });
  const same = manager(ov, 'PTO', h2.id).orgMembers.find((m: any) => m.userId === e2.id).objects[0];
  assert.equal(same.differentOrgTeam, false);
  const led = manager(ov, 'PTO', h2.id);
  assert.deepEqual(led.ledObjects.map((x: any) => x.objectId), [o.id]); assert.equal(led.objectCount, 1);
  assert.equal(manager(ov, 'PTO', h1.id).objectCount, 0);
  assert.equal(JSON.stringify(ov).includes('"function_code"'), false, 'read model never exposes storage names');
});

test('request bodies are strict: tenantId / assignedBy / functionCode cannot be injected', async () => {
  const d = await deputy();
  const h = await makeUser('Ст Нач.', 'PTO_HEAD'), e = await makeUser('Ст Инж.', 'PTO');
  for (const extra of [{ tenantId: await tenantId() }, { assignedBy: d.id }, { functionCode: 'SDO' }, { managerUserId2: 'x' }])
    assert.equal((await call(d, 'org-structure/PTO/assign', { memberUserId: e.id, managerUserId: h.id, ...extra })).status, 400, JSON.stringify(extra));
  const r = await ok(d, 'org-structure/PTO/assign', { memberUserId: e.id, managerUserId: h.id });
  assert.equal(r.assignedBy, d.id); assert.equal(r.functionCode, 'PTO');
});
