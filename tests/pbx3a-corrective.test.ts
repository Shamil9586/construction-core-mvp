import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeUser, tokenFor } from './helpers/pbx3-fixtures';

/**
 * PBX-3A corrective patch — R01 (lead expectedVersion honoured) and R02 (engineer replacement requires
 * handover coverage; handover-only command is not empty). HTTP level over the real backend on PGlite.
 */
const dt = (delta: number) => new Date(Date.now() + delta * 86400000).toISOString().slice(0, 10);

async function harness() {
  delete process.env.DATABASE_URL;
  process.env.AUTH_MODE = 'mock';
  process.env.MOCK_LOGIN_KEY = 'pbx3a-corrective-key';
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
  async function login(role: string) { const d = await req('auth/mock', { role, key: 'pbx3a-corrective-key' }); token = d.token; return d.user; }
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
const names = (team: any) => team.current.members.map((m: any) => m.name).sort();


async function state() {
  const { pool } = await import('../apps/backend/src/db');
  const q = async (t: string) => JSON.stringify((await pool.query(`SELECT * FROM ${t} ORDER BY id`)).rows);
  return [await q('functional_team_memberships'), await q('object_function_lead_assignments'), await q('object_function_member_assignments'), await q('object_function_handovers'), await q('audit_logs')].join('|');
}

test('PBX3A-R01: lead replacement is gated by assignment identity + version — stale view of a replaced assignment returns 409 with zero mutation', async () => {
  const h = await harness();
  try {
    const smirnov = await makeUser('R01 Смирнов', 'PTO_HEAD'), ivanov = await makeUser('R01 Иванов', 'PTO_HEAD'), kuznetsov = await makeUser('R01 Кузнецов', 'PTO_HEAD');
    const { o } = await makeObject(h, 'R01');
    await h.login(DEPUTY);
    const path = `objects/${o.id}/function-team/pto/lead`;
    // A: initial assignment needs no precondition
    const a = (await h.req(path, { leadUserId: smirnov.id })).lead;
    assert.equal(a.version, 1);
    // a replacement that does not identify the current assignment is refused (no write)
    const before0 = await state();
    assert.equal((await h.raw(path, { leadUserId: ivanov.id })).status, 400);
    assert.equal((await h.raw(path, { leadUserId: ivanov.id, expectedVersion: 1 })).status, 400);
    assert.equal(await state(), before0);
    // B: replace Smirnov -> Ivanov naming A / version 1
    const rb = await h.req(path, { leadUserId: ivanov.id, expectedAssignmentId: a.id, expectedVersion: 1 });
    const b = rb.lead;
    assert.notEqual(b.id, a.id);
    assert.equal(b.version, 1, 'the new active row ALSO has version 1 — version alone cannot detect the replacement');
    assert.ok(rb.handover);
    // C: stale caller still holding A / version 1 tries Smirnov-view -> Kuznetsov: 409, nothing changes
    const before = await state();
    const stale = await h.raw(path, { leadUserId: kuznetsov.id, expectedAssignmentId: a.id, expectedVersion: 1 });
    assert.equal(stale.status, 409, JSON.stringify(stale.data));
    assert.equal(await state(), before, 'lead assignments, handovers and audit_logs are all unchanged');
    // right assignment, wrong version is also 409
    assert.equal((await h.raw(path, { leadUserId: kuznetsov.id, expectedAssignmentId: b.id, expectedVersion: 2 })).status, 409);
    assert.equal(await state(), before);
    // D: a fresh caller naming B / version 1 succeeds
    const rd = await h.req(path, { leadUserId: kuznetsov.id, expectedAssignmentId: b.id, expectedVersion: 1 });
    assert.equal(rd.previousLead.id, b.id); assert.equal(rd.lead.leadUserId, kuznetsov.id); assert.ok(rd.handover);
  } finally { await h.app.close(); }
});

test('PBX3A-R02: engineer replacement on an object needs handover coverage; add-only / remove-only / handover-only are allowed', async () => {
  const h = await harness();
  try {
    const head = await makeUser('R02 Нач.', 'PTO_HEAD'), a = await makeUser('R02 A', 'PTO'), b = await makeUser('R02 B', 'PTO'), c = await makeUser('R02 C', 'PTO');
    const { o } = await makeObject(h, 'R02');
    await h.login(DEPUTY);
    await h.req(`objects/${o.id}/function-team/pto/lead`, { leadUserId: head.id });
    const cmd = (x: any) => h.raw('function-teams/pto/redistribute', { reason: 'r02', ...x });
    assert.equal((await cmd({ memberAdds: [{ objectId: o.id, memberUserId: a.id }] })).status, 201, 'addition-only needs no handover');
    const before = await state();
    const swap = { memberEnds: [{ objectId: o.id, memberUserId: a.id }], memberAdds: [{ objectId: o.id, memberUserId: b.id }] };
    assert.equal((await cmd(swap)).status, 400, 'replacement without handover');
    assert.equal(await state(), before, 'rejected before any mutation');
    // partial coverage: a -> b covered, c added but uncovered
    const partial = { memberEnds: swap.memberEnds, memberAdds: [{ objectId: o.id, memberUserId: b.id }, { objectId: o.id, memberUserId: c.id }], handovers: [{ objectId: o.id, outgoingUserId: a.id, incomingUserId: b.id }] };
    assert.equal((await cmd(partial)).status, 400, 'every added engineer needs coverage');
    // a handover on a different object does not cover this one
    assert.equal(await state(), before);
    const full = { ...partial, handovers: [...partial.handovers, { objectId: o.id, outgoingUserId: a.id, incomingUserId: c.id }] };
    assert.equal((await cmd(full)).status, 201, 'full coverage succeeds');
    const t = await h.req(`objects/${o.id}/function-team/pto`);
    assert.deepEqual(names(t), ['R02 B', 'R02 C']);
    // removal-only allowed
    assert.equal((await cmd({ memberEnds: [{ objectId: o.id, memberUserId: c.id }] })).status, 201, 'removal-only needs no handover');
    // handover-only + reason is not an empty command (participant validation retained)
    const ho = await cmd({ handovers: [{ objectId: o.id, outgoingUserId: a.id, incomingUserId: b.id, note: 'фиксация' }] });
    assert.equal(ho.status, 201); assert.equal(ho.data.handovers.length, 1);
    assert.equal((await cmd({ handovers: [{ objectId: o.id, outgoingUserId: a.id, incomingUserId: c.id }] })).status, 400, 'incoming must still be current on the object');
    assert.equal((await cmd({})).status, 400, 'a truly empty command is still refused');
  } finally { await h.app.close(); }
});
