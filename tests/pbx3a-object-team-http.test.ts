import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeUser, tokenFor, orgExpectation } from './helpers/pbx3-fixtures';

/**
 * PBX-3A — Object Responsibility & Team Redistribution (PTO vertical), HTTP level over the real
 * backend on PGlite. Native-PostgreSQL overlap/concurrency evidence lives in
 * tests/pbx3a-object-team-postgres.test.ts.
 *
 * The centrepiece is the mandatory Kuznetsov / Smirnov / Ivanov acceptance scenario.
 */
const dt = (delta: number) => new Date(Date.now() + delta * 86400000).toISOString().slice(0, 10);

async function harness() {
  delete process.env.DATABASE_URL;
  process.env.AUTH_MODE = 'mock';
  process.env.MOCK_LOGIN_KEY = 'pbx3a-http-key';
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
  async function raw(path: string, body?: any, tok = token) {
    const r = await fetch(base + '/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, data: await r.json().catch(() => null) as any };
  }
  async function req(path: string, body?: any, expected = body === undefined ? 200 : 201) {
    const r = await raw(path, body);
    assert.equal(r.status, expected, path + ': ' + JSON.stringify(r.data));
    return r.data;
  }
  async function login(role: string) { const d = await req('auth/mock', { role, key: 'pbx3a-http-key' }); token = d.token; return d.user; }
  async function as(user: any) { token = await tokenFor(user); return user; }
  return { app, req, raw, login, as, get token() { return token; } };
}

const DEPUTY = 'DEPUTY_DIRECTOR';

async function makeObject(h: any, name: string) {
  const pm = await h.login('PROJECT_MANAGER');
  const dict = await h.req('dictionaries');
  const contractors = await h.req('contractors');
  await h.login('DEPUTY_DIRECTOR'); // OBJ-1: object creation is Deputy/Admin authority (setup only; next line restores PM)
  const o = await h.req('objects', { externalCode: 'PBX3-' + name + '-' + Date.now() + Math.random().toString(36).slice(2, 6), name, address: 'Тест, 1', organizationName: 'ООО СЗ', projectManagerId: pm.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [contractors[0].id] });
  await h.login('PROJECT_MANAGER');
  const work = await h.req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, responsibleUserId: pm.id, name: 'Работа ' + name, unit: 'м²', plannedQuantity: 100, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '20000' });
  return { o, work };
}
/** Replace the current object lead, naming the exact assignment being replaced (PBX3A-R01). */
async function replaceLead(h: any, objectId: string, body: any, expected = 201) {
  const cur = (await h.req(`objects/${objectId}/function-team/pto`)).current.lead;
  return h.raw(`objects/${objectId}/function-team/pto/lead`, { ...body, expectedAssignmentId: cur.assignmentId, expectedVersion: cur.version }).then((r: any) => { assert.equal(r.status, expected, JSON.stringify(r.data)); return r.data; });
}
const names = (team: any) => team.current.members.map((m: any) => m.name).sort();

/* ===================================================================== *
 * Mandatory acceptance scenario                                          *
 * ===================================================================== */
test('PBX-3A acceptance: Kuznetsov leaves; lead replacement alone keeps members; Akhmetov/Orlov swap is atomic; old heads lose authority', async () => {
  const h = await harness();
  try {
    const kuznetsov = await makeUser('Кузнецов', 'PTO_HEAD'), smirnov = await makeUser('Смирнов', 'PTO_HEAD'), ivanov = await makeUser('Иванов', 'PTO_HEAD');
    const petrov = await makeUser('Петров', 'PTO'), sidorov = await makeUser('Сидоров', 'PTO'), akhmetov = await makeUser('Ахметов', 'PTO'), orlov = await makeUser('Орлов', 'PTO');
    const objs: any[] = [];
    for (const n of [1, 2, 3, 4, 5]) objs.push(await makeObject(h, 'Объект ' + n));
    const [o1, o2, o3, o4, o5] = objs.map(x => x.o);
    const deputy = await h.login(DEPUTY);

    // ---- initial state, entirely through Deputy commands ----
    for (const m of [petrov, sidorov, akhmetov, orlov])
      await h.req('function-teams/pto/org-members', { memberUserId: m.id, managerUserId: kuznetsov.id });
    for (const [o, lead] of [[o1, smirnov], [o2, smirnov], [o3, kuznetsov], [o4, kuznetsov], [o5, ivanov]] as any[])
      await h.req(`objects/${o.id}/function-team/pto/lead`, { leadUserId: lead.id });
    await h.req('function-teams/pto/redistribute', { reason: 'Начальная расстановка', memberAdds: [{ objectId: o3.id, memberUserId: petrov.id }, { objectId: o3.id, memberUserId: sidorov.id }, { objectId: o3.id, memberUserId: akhmetov.id }, { objectId: o4.id, memberUserId: orlov.id }] }, 201);
    let t3 = await h.req(`objects/${o3.id}/function-team/pto`), t4 = await h.req(`objects/${o4.id}/function-team/pto`);
    assert.equal(t3.current.lead.name, 'Кузнецов');
    assert.deepEqual(names(t3), ['Ахметов', 'Петров', 'Сидоров']);
    assert.deepEqual(names(t4), ['Орлов']);

    // Work + a package responsibility created BEFORE the swap (historical attribution must survive).
    await h.as(kuznetsov);
    const pkgBefore = await h.req('documentation-packages', { objectWorkId: objs[2].work.id, responsibleUserId: akhmetov.id });
    assert.equal(pkgBefore.responsibleUserId, akhmetov.id);

    // ---- Kuznetsov leaves: lead replacement ALONE ----
    await h.login(DEPUTY);
    const memberRowsBefore = async () => (await import('../apps/backend/src/db')).rows((await import('../apps/backend/src/db')).pool, "SELECT id,object_id,member_user_id,version,started_at,ended_at FROM object_function_member_assignments WHERE function_code='PTO' ORDER BY id");
    const before = await memberRowsBefore();
    const l3 = await replaceLead(h, o3.id, { leadUserId: smirnov.id, reason: 'Увольнение Кузнецова' });
    const l4 = await replaceLead(h, o4.id, { leadUserId: ivanov.id, reason: 'Увольнение Кузнецова' });
    assert.equal(l3.previousLead.leadUserId, kuznetsov.id);
    assert.ok(l3.handover && l4.handover, 'lead replacement creates a handover record');
    const after = await memberRowsBefore();
    assert.deepEqual(after, before, 'lead replacement must not touch a single object member row (PBX3-D01)');
    t3 = await h.req(`objects/${o3.id}/function-team/pto`); t4 = await h.req(`objects/${o4.id}/function-team/pto`);
    assert.equal(t3.current.lead.name, 'Смирнов'); assert.equal(t4.current.lead.name, 'Иванов');
    assert.deepEqual(names(t3), ['Ахметов', 'Петров', 'Сидоров']);
    assert.deepEqual(names(t4), ['Орлов']);
    assert.ok(t3.current.members.every((m: any) => m.orgManagerName === 'Кузнецов' && m.inherited === true), 'inherited members are valid, only informational');
    assert.equal(t3.history.leads.length, 1); assert.equal(t3.history.leads[0].name, 'Кузнецов');

    // Kuznetsov's organizational team is untouched by the object-lead change and is now "unresolved" once he is deactivated.
    const { pool } = await import('../apps/backend/src/db');
    await pool.query('UPDATE users SET is_active=false WHERE id=$1', [kuznetsov.id]);
    const ov = await h.req('function-teams/pto/overview');
    const unresolvedOrg = ov.unresolved.filter((u: any) => u.kind === 'ORG_MANAGER_UNAVAILABLE');
    assert.equal(unresolvedOrg.length, 4, 'former team surfaced for redistribution, not auto-assigned');
    assert.ok(unresolvedOrg.every((u: any) => u.managerName === 'Кузнецов'));
    const kzHead = ov.heads.find((x: any) => x.userId === kuznetsov.id);
    assert.equal(kzHead.orgMembers.length, 4, 'history/assignments preserved after deactivation');

    // ---- historical rows snapshot, then Ivanov wants Akhmetov instead of Orlov: ONE redistribution ----
    const ended = async () => (await import('../apps/backend/src/db')).rows(pool, "SELECT * FROM object_function_lead_assignments WHERE ended_at IS NOT NULL ORDER BY id");
    const endedLeadsBefore = JSON.stringify(await ended());
    const swap = await h.req('function-teams/pto/redistribute', {
      reason: 'Иванову нужен Ахметов вместо Орлова',
      orgTransfers: await Promise.all([[akhmetov, ivanov], [orlov, smirnov], [petrov, smirnov], [sidorov, smirnov]].map(async ([m, mg]) => ({ memberUserId: m.id, toManagerUserId: mg.id, ...(await orgExpectation(m.id)) }))),
      memberEnds: [{ objectId: o3.id, memberUserId: akhmetov.id }, { objectId: o4.id, memberUserId: orlov.id }],
      memberAdds: [{ objectId: o4.id, memberUserId: akhmetov.id }, { objectId: o3.id, memberUserId: orlov.id }],
      handovers: [{ objectId: o3.id, outgoingUserId: akhmetov.id, incomingUserId: orlov.id }, { objectId: o4.id, outgoingUserId: orlov.id, incomingUserId: akhmetov.id, note: 'Передать контекст по АОСР' }],
    }, 201);
    assert.equal(swap.handovers.length, 2);
    t3 = await h.req(`objects/${o3.id}/function-team/pto`); t4 = await h.req(`objects/${o4.id}/function-team/pto`);
    assert.equal(t3.current.lead.name, 'Смирнов'); assert.deepEqual(names(t3), ['Орлов', 'Петров', 'Сидоров']);
    assert.equal(t4.current.lead.name, 'Иванов'); assert.deepEqual(names(t4), ['Ахметов']);
    assert.equal(JSON.stringify(await ended()), endedLeadsBefore, 'closed lead history is byte-for-byte unchanged');
    assert.equal(t3.history.members.some((m: any) => m.name === 'Ахметов'), true, 'Akhmetov\'s Object 3 assignment kept as history');
    assert.ok(t3.handovers.some((x: any) => x.outgoingName === 'Ахметов' && x.incomingName === 'Орлов'));
    assert.ok(t4.handovers.some((x: any) => x.outgoingName === 'Орлов' && x.incomingName === 'Ахметов'));

    // ---- authorization proof after the completed swap ----
    await h.as(smirnov);
    assert.equal((await h.raw(`objects/${o3.id}/function-team/pto/members`, { memberUserId: akhmetov.id })).status, 403, 'Smirnov cannot add Akhmetov (org team = Ivanov)');
    assert.equal((await h.raw(`objects/${o3.id}/function-team/pto/members/${akhmetov.id}/end`, {})).status, 400, 'Smirnov cannot manage Akhmetov on Object 3 (no longer a member)');
    assert.equal((await h.raw('documentation-packages', { objectWorkId: objs[2].work.id, responsibleUserId: akhmetov.id })).status, 400, 'Smirnov cannot assign Akhmetov responsibility on Object 3');
    await h.req('documentation-packages', { objectWorkId: objs[2].work.id, responsibleUserId: orlov.id }); // Orlov now valid on Object 3
    await h.as(ivanov);
    assert.equal((await h.raw(`objects/${o4.id}/function-team/pto/members`, { memberUserId: orlov.id })).status, 403, 'Ivanov cannot add Orlov (org team = Smirnov)');
    assert.equal((await h.raw(`objects/${o4.id}/function-team/pto/members/${orlov.id}/end`, {})).status, 400);
    assert.equal((await h.raw('documentation-packages', { objectWorkId: objs[3].work.id, responsibleUserId: orlov.id })).status, 400, 'Ivanov cannot assign Orlov responsibility on Object 4');
    await h.req('documentation-packages', { objectWorkId: objs[3].work.id, responsibleUserId: akhmetov.id });
    // Akhmetov (now Object 4 member) lost Object 3 entirely; Orlov lost Object 4.
    await h.as(akhmetov);
    assert.equal((await h.raw(`objects/${o3.id}`)).status, 403);
    assert.equal((await h.raw(`objects/${o4.id}`)).status, 200);
    await h.as(orlov);
    assert.equal((await h.raw(`objects/${o4.id}`)).status, 403);

    // ---- historical attribution unchanged ----
    const pkgAfter = (await pool.query('SELECT * FROM documentation_packages WHERE id=$1', [pkgBefore.id])).rows[0];
    assert.equal(pkgAfter.responsible_user_id, akhmetov.id, 'historical package attribution never rewritten');

    // ---- no percentages / resource allocation anywhere in the model ----
    const cols = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name IN ('functional_team_memberships','object_function_lead_assignments','object_function_member_assignments','object_function_handovers')")).rows.map((r: any) => r.column_name);
    assert.equal(cols.filter((c: string) => /percent|allocation|workload|share|fte|hours/.test(c)).length, 0);
    assert.ok(Object.keys(swap).every(k => !/percent|allocation/.test(k)));
    void deputy; void o1; void o2; void o5;
  } finally { await h.app.close(); }
});

/* ===================================================================== *
 * Backend / domain                                                       *
 * ===================================================================== */
test('PBX-3A permission matrix: only Deputy/Admin manage; PTO_HEAD only own object; PTO/GD/others denied', async () => {
  const h = await harness();
  try {
    const head = await makeUser('Начальник А', 'PTO_HEAD'), eng = await makeUser('Инженер А', 'PTO');
    const { o } = await makeObject(h, 'Матрица');
    await h.login(DEPUTY);
    await h.req('function-teams/pto/org-members', { memberUserId: eng.id, managerUserId: head.id });
    await h.req(`objects/${o.id}/function-team/pto/lead`, { leadUserId: head.id });
    const redistribute = { reason: 'r', memberAdds: [{ objectId: o.id, memberUserId: eng.id }] };
    const cases: [string, string | any, string, any, number][] = [
      // [role/actor, path, body, expected] — writes
      ['GENERAL_DIRECTOR', null, 'function-teams/pto/org-members', { memberUserId: eng.id, managerUserId: head.id }, 403],
      ['GENERAL_DIRECTOR', null, 'function-teams/pto/redistribute', redistribute, 403],
      ['GENERAL_DIRECTOR', null, `objects/${o.id}/function-team/pto/lead`, { leadUserId: head.id }, 403],
      ['PTO', null, 'function-teams/pto/org-members', { memberUserId: eng.id, managerUserId: head.id }, 403],
      ['PTO', null, `objects/${o.id}/function-team/pto/members`, { memberUserId: eng.id }, 403],
      ['PTO_HEAD', null, 'function-teams/pto/redistribute', redistribute, 403],
      ['PTO_HEAD', null, `objects/${o.id}/function-team/pto/lead`, { leadUserId: head.id }, 403],
      ['PTO_HEAD', null, 'function-teams/pto/org-members', { memberUserId: eng.id, managerUserId: head.id }, 403],
      ['PROJECT_MANAGER', null, 'function-teams/pto/redistribute', redistribute, 403],
      ['SDO', null, `objects/${o.id}/function-team/pto/members`, { memberUserId: eng.id }, 403],
      ['DEPUTY_DIRECTOR', null, `objects/${o.id}/function-team/pto/members`, { memberUserId: eng.id }, 403], // Deputy moves members via redistribute, never the head action
    ];
    for (const [role, , path, body, expected] of cases) {
      await h.login(role);
      const r = await h.raw(path, body);
      assert.equal(r.status, expected, `${role} POST ${path}: ${JSON.stringify(r.data)}`);
    }
    // reads: oversight roles see the overview; PTO/PTO_HEAD do not; PM has no team read at all
    for (const [role, status] of [['DEPUTY_DIRECTOR', 200], ['GENERAL_DIRECTOR', 200], ['ADMIN', 200], ['PTO_HEAD', 403], ['PTO', 403], ['PROJECT_MANAGER', 403], ['SDO', 403], ['CONSTRUCTION_CONTROL', 403]] as const) {
      await h.login(role);
      assert.equal((await h.raw('function-teams/pto/overview')).status, status, role + ' overview');
    }
    // ADMIN override on every write
    await h.login('ADMIN');
    await h.req('function-teams/pto/redistribute', redistribute);
    const t = await h.req(`objects/${o.id}/function-team/pto`);
    assert.deepEqual(names(t), ['Инженер А']);
    // Deputy holds NO ordinary PTO operational permission merely because of management authority
    await h.login(DEPUTY);
    const { work } = { work: (await h.req(`objects/${o.id}/works`))[0] };
    assert.equal((await h.raw('documentation-packages', { objectWorkId: work.id, responsibleUserId: eng.id })).status, 403);
  } finally { await h.app.close(); }
});

test('PBX-3A validation: exact roles, same tenant, active users, no self-management, no role inference', async () => {
  const h = await harness();
  try {
    const head = await makeUser('Начальник Б', 'PTO_HEAD'), head2 = await makeUser('Начальник Б2', 'PTO_HEAD'), eng = await makeUser('Инженер Б', 'PTO'), inactiveEng = await makeUser('Уволен', 'PTO', { active: false }), inactiveHead = await makeUser('Уволен-нач', 'PTO_HEAD', { active: false });
    const sdo = await makeUser('СДО Б', 'SDO');
    const { pool, insert } = await import('../apps/backend/src/db');
    const other = (await pool.query("INSERT INTO tenants(portal,member_id,name) VALUES('other.local','other-member','Другой') RETURNING id")).rows[0];
    const foreign = await insert(pool, 'users', other.id, { bitrixUserId: 'f1', name: 'Чужой', role: 'PTO' });
    const foreignHead = await insert(pool, 'users', other.id, { bitrixUserId: 'f2', name: 'Чужой нач', role: 'PTO_HEAD' });
    const { o } = await makeObject(h, 'Валидация');
    await h.login(DEPUTY);
    const org = async (m: string, mg: string) => h.raw('function-teams/pto/org-members', { memberUserId: m, managerUserId: mg, ...(m === eng.id && alreadyAssigned ? await orgExpectation(m) : {}) });
    let alreadyAssigned = false;
    assert.equal((await org(eng.id, eng.id)).status, 400, 'self-management');
    assert.equal((await org(eng.id, sdo.id)).status, 400, 'manager must be PTO_HEAD');
    assert.equal((await org(head.id, head2.id)).status, 400, 'a PTO_HEAD is not a PTO engineer member');
    assert.equal((await org(inactiveEng.id, head.id)).status, 400, 'inactive member');
    assert.equal((await org(eng.id, inactiveHead.id)).status, 400, 'inactive manager');
    assert.equal((await org(foreign.id, head.id)).status, 404, 'cross-tenant member');
    assert.equal((await org(eng.id, foreignHead.id)).status, 404, 'cross-tenant manager');
    await h.req('function-teams/pto/org-members', { memberUserId: eng.id, managerUserId: head.id });
    alreadyAssigned = true;
    assert.equal((await org(eng.id, head.id)).status, 400, 'already in that team');
    const lead = (u: string) => h.raw(`objects/${o.id}/function-team/pto/lead`, { leadUserId: u });
    assert.equal((await lead(eng.id)).status, 400, 'lead must be PTO_HEAD, engineer refused');
    assert.equal((await lead(sdo.id)).status, 400);
    assert.equal((await lead(inactiveHead.id)).status, 400);
    assert.equal((await lead(foreignHead.id)).status, 404);
    assert.equal((await h.raw(`objects/${o.id}/function-team/pto/lead`, { leadUserId: head.id, tenantId: other.id })).status, 400, 'strict body: no client tenantId');
    assert.equal((await h.raw(`objects/${o.id}/function-team/pto/lead`, { leadUserId: head.id, functionCode: 'SDO' })).status, 400, 'strict body: function is fixed server-side');
    await lead(head.id);
    // member validation through redistribute
    const add = (m: string) => h.raw('function-teams/pto/redistribute', { reason: 'r', memberAdds: [{ objectId: o.id, memberUserId: m }] });
    assert.equal((await add(head.id)).status, 400, 'PTO_HEAD cannot be an object member');
    assert.equal((await add(inactiveEng.id)).status, 400);
    assert.equal((await add(foreign.id)).status, 404);
    assert.equal((await h.raw('function-teams/pto/redistribute', { reason: 'r', memberAdds: [{ objectId: '00000000-0000-4000-8000-000000000000', memberUserId: eng.id }] })).status, 404);
    // nothing leaked from any refused call
    const rowsN = (await pool.query("SELECT count(*)::int n FROM object_function_member_assignments WHERE object_id=$1", [o.id])).rows[0].n;
    assert.equal(rowsN, 0);
    // Bitrix descriptive fields are irrelevant: the users row can carry a scary position, it grants nothing
    await pool.query("UPDATE users SET position='Начальник ПТО', department_id='PTO' WHERE id=$1", [eng.id]);
    await h.login('PTO');
    assert.equal((await h.raw(`objects/${o.id}/function-team/pto/members`, { memberUserId: eng.id })).status, 403);
  } finally { await h.app.close(); }
});

test('PBX-3A head rules: head adds only from OWN org team, may remove inherited members, cannot touch objects it does not lead', async () => {
  const h = await harness();
  try {
    const head = await makeUser('Нач. В', 'PTO_HEAD'), other = await makeUser('Нач. В2', 'PTO_HEAD');
    const own = await makeUser('Свой', 'PTO'), inherited = await makeUser('Унаследованный', 'PTO'), foreignEng = await makeUser('Чужой инженер', 'PTO'), inactiveOwn = await makeUser('Свой-уволен', 'PTO');
    const { o } = await makeObject(h, 'Правила головы'), { o: o2 } = await makeObject(h, 'Другой объект');
    await h.login(DEPUTY);
    for (const [m, mg] of [[own, head], [inherited, other], [foreignEng, other], [inactiveOwn, head]] as any[])
      await h.req('function-teams/pto/org-members', { memberUserId: m.id, managerUserId: mg.id });
    await h.req(`objects/${o.id}/function-team/pto/lead`, { leadUserId: head.id });
    await h.req(`objects/${o2.id}/function-team/pto/lead`, { leadUserId: other.id });
    await h.req('function-teams/pto/redistribute', { reason: 'seed', memberAdds: [{ objectId: o.id, memberUserId: inherited.id }] });
    await (await import('../apps/backend/src/db')).pool.query('UPDATE users SET is_active=false WHERE id=$1', [inactiveOwn.id]);

    await h.as(head);
    const add = (objectId: string, m: any) => h.raw(`objects/${objectId}/function-team/pto/members`, { memberUserId: m.id });
    assert.equal((await add(o.id, foreignEng)).status, 403, 'cannot take another head\'s engineer');
    assert.equal((await add(o.id, inactiveOwn)).status, 400, 'target must be active');
    assert.equal((await add(o2.id, own)).status, 403, 'not the lead of Object 2');
    assert.equal((await add(o.id, own)).status, 201);
    assert.equal((await add(o.id, own)).status, 400, 'already an active member (no duplicate)');
    // inherited member (org manager = other head) can be removed by the current object head
    const ended = await h.req(`objects/${o.id}/function-team/pto/members/${inherited.id}/end`, { reason: 'Не нужен на объекте' }, 201);
    assert.ok(ended.endedAt && ended.endedBy === head.id);
    // ... and this did not alter anyone's organizational team
    await h.login(DEPUTY);
    const ov = await h.req('function-teams/pto/overview');
    assert.equal(ov.heads.find((x: any) => x.userId === other.id).orgMembers.length, 2);
    await replaceLead(h, o.id, { leadUserId: other.id });
    // Head of another object cannot remove members from Object 1; the replaced head loses all authority there
    await h.as(head);
    assert.equal((await h.raw(`objects/${o.id}/function-team/pto/members/${own.id}/end`, {})).status, 403, 'replaced head has no authority on Object 1 any more');
    assert.equal((await add(o.id, own)).status, 403);
    // PTO_HEAD replaced on one object keeps his organizational team (D04)
    await h.login(DEPUTY);
    const ov2 = await h.req('function-teams/pto/overview');
    assert.equal(ov2.heads.find((x: any) => x.userId === head.id).orgMembers.length, 2);
    const t = await h.req(`objects/${o.id}/function-team/pto`);
    assert.deepEqual(names(t), ['Свой'], 'existing object members stay after a lead replacement (own remains)');
  } finally { await h.app.close(); }
});

test('PBX-3A redistribution is atomic: a failing later operation rolls back every earlier one', async () => {
  const h = await harness();
  try {
    const a1 = await makeUser('Нач. Г1', 'PTO_HEAD'), a2 = await makeUser('Нач. Г2', 'PTO_HEAD'), e1 = await makeUser('Инж. Г1', 'PTO'), e2 = await makeUser('Инж. Г2', 'PTO');
    const { o } = await makeObject(h, 'Атомарность');
    const { pool } = await import('../apps/backend/src/db');
    await h.login(DEPUTY);
    await h.req('function-teams/pto/org-members', { memberUserId: e1.id, managerUserId: a1.id });
    await h.req(`objects/${o.id}/function-team/pto/lead`, { leadUserId: a1.id });
    const snap = async () => JSON.stringify([(await pool.query('SELECT * FROM functional_team_memberships ORDER BY id')).rows, (await pool.query('SELECT * FROM object_function_lead_assignments ORDER BY id')).rows, (await pool.query('SELECT * FROM object_function_member_assignments ORDER BY id')).rows, (await pool.query('SELECT * FROM object_function_handovers ORDER BY id')).rows]);
    const before = await snap();
    const bad = await h.raw('function-teams/pto/redistribute', {
      reason: 'half-swap attempt',
      orgTransfers: [{ memberUserId: e1.id, toManagerUserId: a2.id, ...(await orgExpectation(e1.id)) }],
      leadChanges: [{ objectId: o.id, leadUserId: a2.id }],
      memberAdds: [{ objectId: o.id, memberUserId: e2.id }, { objectId: o.id, memberUserId: '00000000-0000-4000-8000-000000000001' }], // unknown user -> 404 at the very end
    });
    assert.equal(bad.status, 404);
    assert.equal(await snap(), before, 'nothing changed: no half-swap');
    // duplicate / conflicting commands are refused before touching anything
    assert.equal((await h.raw('function-teams/pto/redistribute', { reason: 'r', leadChanges: [{ objectId: o.id, leadUserId: a2.id }, { objectId: o.id, leadUserId: a1.id }] })).status, 400);
    assert.equal((await h.raw('function-teams/pto/redistribute', { reason: 'r' })).status, 400, 'empty command');
    assert.equal(await snap(), before);
  } finally { await h.app.close(); }
});

test('PBX-3A handover: incoming acknowledges; outgoing/others cannot; Deputy/Admin administrative completion needs a reason; never blocks the assignment', async () => {
  const h = await harness();
  try {
    const head1 = await makeUser('Нач. Д1', 'PTO_HEAD'), head2 = await makeUser('Нач. Д2', 'PTO_HEAD'), head3 = await makeUser('Нач. Д3', 'PTO_HEAD');
    const { o } = await makeObject(h, 'Передача');
    await h.login(DEPUTY);
    await h.req(`objects/${o.id}/function-team/pto/lead`, { leadUserId: head1.id });
    const r1 = await replaceLead(h, o.id, { leadUserId: head2.id, reason: 'Ротация' });
    // effective immediately, handover still OPEN
    const t = await h.req(`objects/${o.id}/function-team/pto`);
    assert.equal(t.current.lead.userId, head2.id);
    assert.equal(r1.handover.status, 'OPEN');
    assert.equal((await h.raw(`function-handovers/${r1.handover.id}/acknowledge`, { version: r1.handover.version })).status, 403, 'Deputy is not the incoming employee');
    await h.as(head1);
    assert.equal((await h.raw(`function-handovers/${r1.handover.id}/acknowledge`, { version: r1.handover.version })).status, 403, 'outgoing employee cannot acknowledge');
    assert.equal((await h.raw(`function-handovers/${r1.handover.id}/admin-complete`, { version: 1, reason: 'x' })).status, 403);
    await h.as(head2);
    assert.equal((await h.raw(`function-handovers/${r1.handover.id}/acknowledge`, { version: 99 })).status, 409, 'optimistic version');
    const ack = await h.req(`function-handovers/${r1.handover.id}/acknowledge`, { version: r1.handover.version });
    assert.equal(ack.status, 'ACKNOWLEDGED'); assert.equal(ack.acknowledgedBy, head2.id);
    assert.equal((await h.raw(`function-handovers/${r1.handover.id}/acknowledge`, { version: ack.version })).status, 400, 'already done');
    // outgoing user inactive -> administrative completion
    await h.login(DEPUTY);
    const r2 = await replaceLead(h, o.id, { leadUserId: head3.id });
    await (await import('../apps/backend/src/db')).pool.query('UPDATE users SET is_active=false WHERE id=$1', [head2.id]);
    assert.equal((await h.raw(`function-handovers/${r2.handover.id}/admin-complete`, { version: r2.handover.version })).status, 400, 'reason mandatory');
    assert.equal((await h.raw(`function-handovers/${r2.handover.id}/admin-complete`, { version: r2.handover.version, reason: '   ' })).status, 400, 'blank reason refused');
    const done = await h.req(`function-handovers/${r2.handover.id}/admin-complete`, { version: r2.handover.version, reason: 'Сотрудник уволен, подтвердить невозможно' });
    assert.equal(done.status, 'ADMIN_COMPLETED'); assert.equal(done.administrativeCompletionReason, 'Сотрудник уволен, подтвердить невозможно');
    assert.equal((await h.raw(`function-handovers/${r2.handover.id}/admin-complete`, { version: done.version, reason: 'again' })).status, 400);
    const mine = (await h.req('function-handovers')).filter((x: any) => x.objectId === o.id);
    assert.equal(mine.length, 2);
    await h.as(head3);
    const own = await h.req('function-handovers');
    assert.equal(own.length, 1, 'non-oversight users see only their own handovers');
    assert.equal(own[0].incomingUserId, head3.id);
  } finally { await h.app.close(); }
});

test('PBX-3A PTO object scope: PTO/PTO_HEAD operate only on assigned objects; packages/reads follow assignments; ADMIN overrides', async () => {
  const h = await harness();
  try {
    const head = await makeUser('Нач. Е', 'PTO_HEAD'), notLead = await makeUser('Нач. Е2', 'PTO_HEAD'), eng = await makeUser('Инж. Е', 'PTO'), stranger = await makeUser('Инж. Е2', 'PTO');
    const A = await makeObject(h, 'Объект А'), B = await makeObject(h, 'Объект Б');
    await h.login(DEPUTY);
    await h.req('function-teams/pto/org-members', { memberUserId: eng.id, managerUserId: head.id });
    await h.req(`objects/${A.o.id}/function-team/pto/lead`, { leadUserId: head.id });
    await h.req(`objects/${B.o.id}/function-team/pto/lead`, { leadUserId: notLead.id });
    await h.req('function-teams/pto/redistribute', { reason: 'seed', memberAdds: [{ objectId: A.o.id, memberUserId: eng.id }] });
    const pkg = (_: string, work: any, resp: any) => h.raw('documentation-packages', { objectWorkId: work.id, responsibleUserId: resp.id });
    // head: leads A only
    await h.as(head);
    assert.equal((await pkg('', B.work, eng)).status, 403, 'head is not lead of B');
    assert.equal((await pkg('', A.work, stranger)).status, 400, 'responsible must be on the object\'s PTO team');
    const p = await h.req('documentation-packages', { objectWorkId: A.work.id, responsibleUserId: eng.id });
    await h.req('documentation-packages', { objectWorkId: A.work.id, responsibleUserId: head.id }).catch(() => undefined);
    // engineer: member of A only
    await h.as(eng);
    assert.equal((await pkg('', B.work, eng)).status, 403);
    assert.equal((await h.raw(`documentation-packages/${p.id}/status`, { status: 'PREPARING', version: p.version })).status, 201);
    await h.as(stranger);
    assert.equal((await h.raw(`documentation-packages/${p.id}/status`, { status: 'PRESENTED', version: 2 })).status, 403, 'unassigned PTO blocked on object A writes');
    // reads: object list is the assigned scope
    await h.as(head); assert.deepEqual((await h.req('objects')).map((x: any) => x.id), [A.o.id]);
    await h.as(eng); assert.deepEqual((await h.req('objects')).map((x: any) => x.id), [A.o.id]);
    await h.as(stranger); assert.deepEqual(await h.req('objects'), []);
    assert.equal((await h.raw(`objects/${B.o.id}`)).status, 403);
    // leadership oversight keeps the whole portfolio (read-only)
    await h.login('GENERAL_DIRECTOR'); assert.equal((await h.req('objects')).length >= 2, true);
    await h.login(DEPUTY); assert.equal((await h.req('objects')).length >= 2, true);
    // ADMIN override on operational writes, but the responsible must still be on the team
    await h.login('ADMIN');
    assert.equal((await h.raw('documentation-packages', { objectWorkId: B.work.id, responsibleUserId: eng.id })).status, 400);
    assert.equal((await h.raw('documentation-packages', { objectWorkId: B.work.id, responsibleUserId: notLead.id })).status, 201);
    // Edit responsible on an existing package: new responsible must also be current on the team
    await h.as(head);
    const edited = (r: any) => h.raw(`documentation-packages/${p.id}/edit`, r);
    const cur = (await h.req('documentation-packages')).find?.((x: any) => x.id === p.id) ?? p;
    assert.equal((await edited({ responsibleUserId: stranger.id, version: cur.version })).status, 400);
    // remove eng from A; head can no longer make eng responsible (D08) while history stays
    await h.req(`objects/${A.o.id}/function-team/pto/members/${eng.id}/end`, {}, 201);
    assert.equal((await h.raw('documentation-packages', { objectWorkId: A.work.id, responsibleUserId: eng.id })).status, 400);
    await h.as(eng);
    assert.equal((await h.raw(`objects/${A.o.id}`)).status, 403, 'removed engineer loses object access at once');
    const { pool } = await import('../apps/backend/src/db');
    assert.equal((await pool.query('SELECT responsible_user_id FROM documentation_packages WHERE id=$1', [p.id])).rows[0].responsible_user_id, eng.id, 'existing attribution untouched');
  } finally { await h.app.close(); }
});

test('PBX-3A history is append-only and deactivation only surfaces unresolved assignments (never rewrites)', async () => {
  const h = await harness();
  try {
    const head = await makeUser('Нач. Ж', 'PTO_HEAD'), eng = await makeUser('Инж. Ж', 'PTO');
    const { o } = await makeObject(h, 'История');
    const { pool } = await import('../apps/backend/src/db');
    await h.login(DEPUTY);
    await h.req('function-teams/pto/org-members', { memberUserId: eng.id, managerUserId: head.id });
    await h.req(`objects/${o.id}/function-team/pto/lead`, { leadUserId: head.id });
    await h.req('function-teams/pto/redistribute', { reason: 'seed', memberAdds: [{ objectId: o.id, memberUserId: eng.id }] });
    await h.req('function-teams/pto/redistribute', { reason: 'уход', memberEnds: [{ objectId: o.id, memberUserId: eng.id }] });
    await assert.rejects(pool.query('DELETE FROM object_function_member_assignments'), /append-only/);
    await assert.rejects(pool.query("UPDATE object_function_member_assignments SET member_user_id=assigned_by WHERE ended_at IS NOT NULL"), /already ended|immutable/);
    await assert.rejects(pool.query('DELETE FROM functional_team_memberships'), /append-only/);
    await assert.rejects(pool.query('DELETE FROM object_function_lead_assignments'), /append-only/);
    await assert.rejects(pool.query('DELETE FROM object_function_handovers'), /append-only/);
    // re-adding after ending creates a NEW row; the old one stays
    await h.req('function-teams/pto/redistribute', { reason: 'возврат', memberAdds: [{ objectId: o.id, memberUserId: eng.id }] });
    const t = await h.req(`objects/${o.id}/function-team/pto`);
    assert.equal(t.current.members.length, 1); assert.equal(t.history.members.length, 1);
    // deactivate the engineer: the row remains active-assignment history-wise and shows up as unresolved; org end resolves it
    await pool.query('UPDATE users SET is_active=false WHERE id=$1', [eng.id]);
    const ov = await h.req('function-teams/pto/overview');
    assert.ok(ov.unresolved.some((u: any) => u.kind === 'OBJECT_MEMBER_UNAVAILABLE' && u.userId === eng.id));
    assert.ok(ov.unresolved.some((u: any) => u.kind === 'ORG_MEMBER_UNAVAILABLE' && u.userId === eng.id));
    await h.req('function-teams/pto/redistribute', { reason: 'уволен', orgEnds: [{ memberUserId: eng.id, ...(await orgExpectation(eng.id)) }], memberEnds: [{ objectId: o.id, memberUserId: eng.id }] });
    const ov2 = await h.req('function-teams/pto/overview');
    assert.equal(ov2.unresolved.filter((u: any) => u.userId === eng.id).length, 0);
    assert.equal((await pool.query('SELECT count(*)::int n FROM object_function_member_assignments WHERE member_user_id=$1', [eng.id])).rows[0].n, 2, 'both historical rows preserved');
  } finally { await h.app.close(); }
});

test('PBX-3A my-team: PTO_HEAD sees «Моя команда ПТО» + «Команда объекта»; engineer sees own objects', async () => {
  const h = await harness();
  try {
    const head = await makeUser('Нач. З', 'PTO_HEAD'), e1 = await makeUser('Инж. З1', 'PTO'), e2 = await makeUser('Инж. З2', 'PTO');
    const { o } = await makeObject(h, 'Моя команда');
    await h.login(DEPUTY);
    for (const e of [e1, e2]) await h.req('function-teams/pto/org-members', { memberUserId: e.id, managerUserId: head.id });
    await h.req(`objects/${o.id}/function-team/pto/lead`, { leadUserId: head.id });
    await h.as(head);
    await h.req(`objects/${o.id}/function-team/pto/members`, { memberUserId: e1.id }, 201);
    const my = await h.req('function-teams/pto/my-team');
    assert.deepEqual(my.orgTeam.map((x: any) => x.name).sort(), ['Инж. З1', 'Инж. З2']);
    assert.deepEqual(my.orgTeam.find((x: any) => x.userId === e1.id).onObjectIds, [o.id]);
    assert.deepEqual(my.orgTeam.find((x: any) => x.userId === e2.id).onObjectIds, []);
    assert.equal(my.objects.length, 1); assert.deepEqual(my.objects[0].members.map((m: any) => m.name), ['Инж. З1']);
    await h.as(e1);
    const mine = await h.req('function-teams/pto/my-team');
    assert.equal(mine.orgManager.name, 'Нач. З'); assert.equal(mine.objects.length, 1); assert.deepEqual(mine.orgTeam, []);
    await h.as(e2);
    assert.equal((await h.req('function-teams/pto/my-team')).objects.length, 0);
    await h.login(DEPUTY);
    assert.equal((await h.raw('function-teams/pto/my-team')).status, 400);
  } finally { await h.app.close(); }
});
