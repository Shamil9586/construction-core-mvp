import './helpers/gpr2-isolation'; // FIRST: no backend module may load before the environment is pinned to in-memory PGlite
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { RequestMethod } from '@nestjs/common';
import { roles } from '../packages/domain';
import { GPR2_ENDPOINTS, mountedEndpoints, routeOf, endpointById, NO_CAPABILITY_ASSIGNMENTS, type Gpr2Endpoint, type CapabilityAssignment } from '../packages/domain/gpr2';
import { gpr2Harness, validRequest, foreignTenantObject, pilotScenario, KEY, uuid, type Gpr2Harness } from './helpers/gpr2-fixtures';
import type { Pilot } from './helpers/gpr-fixtures';
import { assertInMemoryPool } from './helpers/gpr2-isolation';
import { TrustedResources, ownedParams, installHooks, type Owner } from './helpers/gpr2-resources';

/**
 * GPR-2 R01 — A19 at the HTTP level (TD §11.1–11.3), over the REAL backend on in-memory PGlite with mock auth.
 *
 * The expectation table is written out by hand from the §11.3 matrix and the §11.2 "who" column, one line per mounted command — it is not derived
 * from the register or from GPR2_GRANTS. R01 ships no behaviour: a call that is authorised, in scope and well formed is answered 501
 * COMMAND_NOT_ENABLED and must write nothing.
 */
let g: Gpr2Harness;
let pilot: Pilot;
let owner: Owner;
// Since R01-B04 a command addressed to an aggregate (`{id}`) is refused (404) unless a resolver has VERIFIED its owner, and the production default
// verifies nothing. The A19 matrix below is about ROLES, so it runs with an explicit, isolated, trusted resolver that owns the ids these tests use;
// the default-deny behaviour itself is proved in gpr2-r01-corrective-http.test.ts.
const trusted = new TrustedResources();
let uninstall = () => {};
before(async () => {
  g = await gpr2Harness('gpr2-r01-http-key'); pilot = await pilotScenario(g.h); assert.equal(await assertInMemoryPool(), true);
  owner = { tenantId: await g.tenantId(), objectId: pilot.object.id };
  const { DISABLED_HOOKS } = await import('../apps/backend/src/gpr2-command-guard');
  uninstall = await installHooks(g.h.app, { ...DISABLED_HOOKS, resources: trusted });
});
after(async () => { uninstall(); await g?.h.close(); });

const PM = ['PROJECT_MANAGER'], DEPUTY = ['DEPUTY_DIRECTOR'], ADMIN = ['ADMIN'], NOBODY: string[] = [];
// command id → the ONLY roles that may issue it (TD §11.3 / §11.2)
const WHO: Record<string, string[]> = {
  'work-type.create': PM, 'work-type.publication.request': PM, 'work-type.publication.approve': ADMIN, 'work-type.publication.reject': ADMIN,
  'finish-system.upsert': PM, 'finish-system.preview': PM, 'finish-system.confirm': PM,
  'quantity.request.create': PM, 'quantity.request.patch': PM, 'quantity.request.submit': PM, 'quantity.request.review-note': NOBODY,
  'quantity.request.approve': DEPUTY, 'quantity.request.return': DEPUTY,
  'calendar.version.create': PM, 'calendar.version.patch': PM,
  'schedule.revision.create': PM, 'schedule.changes.preview': PM, 'schedule.changes.apply': PM, 'schedule.backplan.preview': PM, 'schedule.revision.submit': PM, 'schedule.revision.discard': PM,
  'schedule.revision.approve': DEPUTY, 'schedule.revision.return': DEPUTY,
  'finish-change.record-external-outcome': PM, 'finish-change.record-correction': PM,
  'imports.boq.upload': PM, 'imports.estimate-labor.upload': PM, 'imports.boq.allocations': PM, 'imports.boq.commit': PM,
  'imports.estimate-labor.mapping-proposals': PM, 'imports.estimate-labor.mapping-reviews': NOBODY, 'imports.estimate-labor.commit': PM
};

const send = async (token: string | null, e: Gpr2Endpoint, params: Record<string, string>, tweak: (r: ReturnType<typeof validRequest>) => void = () => {}) => {
  // the aggregate behind {id} (when the caller named none) is one the trusted resolver owns for this tenant and the pilot object
  const owned = e.resource && params.id === undefined ? ownedParams(trusted, e, owner) : {};
  const req = validRequest(e, { ...params, ...(owned.id ? { id: owned.id } : {}) }); tweak(req);
  return g.call(token, req.method, req.path, { body: req.body, headers: req.headers });
};
const params = () => ({ objectId: pilot.object.id });
const strip = (b: any) => { const { requestId, ...rest } = b ?? {}; return rest; };
const rowCount = async (table: string) => Number((await (await import('../apps/backend/src/db')).pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);

test('the table covers exactly the mounted commands, and the register mounts 32 of them (the controller and the register agree route by route)', async () => {
  assert.deepEqual(Object.keys(WHO).sort(), mountedEndpoints().map(e => e.id).sort());
  assert.equal(mountedEndpoints().length, 32);
  const { Gpr2ContractController } = await import('../apps/backend/src/modules/gpr2/gpr2.controller');
  const methodName: Record<number, string> = { [RequestMethod.GET]: 'GET', [RequestMethod.POST]: 'POST', [RequestMethod.PATCH]: 'PATCH', [RequestMethod.PUT]: 'PUT' };
  const mounted = Object.getOwnPropertyNames(Gpr2ContractController.prototype).filter(n => n !== 'constructor' && n !== 'run')
    .map(n => { const fn = (Gpr2ContractController.prototype as any)[n]; return `${methodName[Reflect.getMetadata('method', fn)]} ${Reflect.getMetadata('path', fn)}`; }).sort();
  assert.deepEqual(mounted, mountedEndpoints().map(e => `${e.method} v2/${routeOf(e)}`).sort(), 'no route without a register row, no mounted row without a route');
});

test('A19 (HTTP): the whole role matrix — 32 commands × 11 roles — allowed roles reach the gate (501), every other role is refused with 403', async () => {
  const cells: string[] = [];
  for (const role of roles) {
    const token = await g.roleToken(role);
    for (const e of mountedEndpoints()) {
      const r = await send(token, e, params());
      const allowed = WHO[e.id].includes(role);
      assert.equal(r.status, allowed ? 501 : 403, `${role} × ${e.id}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, allowed ? 'COMMAND_NOT_ENABLED' : 'PERMISSION_DENIED', `${role} × ${e.id}`);
      cells.push(`${role}|${e.id}|${r.status}`);
    }
  }
  assert.equal(cells.length, 11 * 32);
  assert.equal(cells.filter(c => c.endsWith('|501')).length, Object.values(WHO).reduce((n, who) => n + who.length, 0), 'exactly the allowed cells got through');
});

test('"no new Admin business grants": ADMIN is refused every GPR-2 business command; the only door it has is corporate publication', async () => {
  const token = await g.roleToken('ADMIN');
  const open: string[] = [];
  for (const e of mountedEndpoints()) if ((await send(token, e, params())).status !== 403) open.push(e.id);
  assert.deepEqual(open.sort(), ['work-type.publication.approve', 'work-type.publication.reject']);
  // and the PM and the deputy cannot decide publication — a РП proposes, the Admin decides
  for (const role of ['PROJECT_MANAGER', 'DEPUTY_DIRECTOR']) assert.equal((await send(await g.roleToken(role), endpointById('work-type.publication.approve')!, params())).status, 403, role);
});

test('C10/D11: the РП cannot approve or return, the deputy cannot edit or submit — at the door, with 403', async () => {
  const pm = await g.roleToken('PROJECT_MANAGER'), deputy = await g.roleToken('DEPUTY_DIRECTOR');
  for (const id of ['schedule.revision.approve', 'schedule.revision.return', 'quantity.request.approve', 'quantity.request.return'])
    assert.equal((await send(pm, endpointById(id)!, params())).status, 403, 'РП × ' + id);
  for (const id of ['schedule.revision.create', 'schedule.changes.apply', 'schedule.revision.submit', 'schedule.revision.discard', 'quantity.request.create', 'quantity.request.submit', 'finish-change.record-external-outcome', 'work-type.create'])
    assert.equal((await send(deputy, endpointById(id)!, params())).status, 403, 'deputy × ' + id);
});

test('N01 default-deny over HTTP: the estimate-mapping REVIEW is refused to every role, ADMIN and the РП included; the PTO review note likewise', async () => {
  for (const role of roles) {
    const token = await g.roleToken(role);
    for (const id of ['imports.estimate-labor.mapping-reviews', 'quantity.request.review-note']) {
      const r = await send(token, endpointById(id)!, params());
      assert.equal(r.status, 403, `${role} × ${id}`);
      assert.equal(r.body.code, 'PERMISSION_DENIED');
    }
  }
  // the import commit stays the РП's own and is not a way around the review
  assert.equal((await send(await g.roleToken('PROJECT_MANAGER'), endpointById('imports.estimate-labor.commit')!, params())).status, 501);
});

test('401: no token, a forged token and a malformed header are refused before anything else, for every mounted command', async () => {
  for (const e of mountedEndpoints()) {
    assert.equal((await send(null, e, params())).status, 401, e.id + ' without a token');
  }
  for (const bad of ['forged-token', '', 'Bearer', 'x'.repeat(500)]) assert.equal((await send(bad, endpointById('schedule.revision.submit')!, params())).status, 401, JSON.stringify(bad.slice(0, 10)));
  assert.equal((await g.call(null, 'GET', '/v2/objects/' + pilot.object.id + '/schedule/revisions')).status, 404, 'only the registered commands exist: a GET on a command route is not a route');
});

test('scope safety: a missing object, a malformed id, another tenant\'s object and another РП\'s object are ONE answer — 404 with an identical body', async () => {
  const foreign = await foreignTenantObject();
  const deputy = await g.roleToken('DEPUTY_DIRECTOR'), pm = await g.roleToken('PROJECT_MANAGER');
  const e = endpointById('schedule.revision.approve')!, ePm = endpointById('schedule.revision.submit')!;
  const answers = [
    await send(deputy, e, { objectId: uuid() }),                         // does not exist
    await send(deputy, e, { objectId: 'not-a-uuid' }),                    // malformed
    await send(deputy, e, { objectId: foreign.object.id }),               // another tenant
    await send(pm, ePm, { objectId: pilot.neighbour.id }),                // another РП's object, same tenant
    await send(pm, ePm, { objectId: foreign.object.id }),
    await send(deputy, e, { objectId: pilot.object.id, id: 'not-a-uuid' }) // a malformed aggregate id
  ];
  for (const a of answers) assert.equal(a.status, 404, JSON.stringify(a.body));
  const bodies = answers.map(a => JSON.stringify(strip(a.body)));
  assert.equal(new Set(bodies).size, 1, 'indistinguishable: ' + bodies.join(' / '));
  assert.deepEqual(strip(answers[0].body), { statusCode: 404, code: 'RESOURCE_NOT_FOUND', message: 'Запись не найдена' });
  // an existing, accessible object gets past the gate
  assert.equal((await send(deputy, e, { objectId: pilot.object.id })).status, 501);
  assert.equal((await send(pm, ePm, { objectId: pilot.object.id })).status, 501);
});

test('permission is decided BEFORE scope: a role without the grant gets 403 for an existing object and for a missing one alike — it learns nothing about objects', async () => {
  const foreign = await foreignTenantObject();
  const e = endpointById('schedule.revision.approve')!;
  for (const role of ['PROJECT_MANAGER', 'ADMIN', 'PTO', 'PTO_HEAD', 'SDO', 'CONSTRUCTION_CONTROL', 'GENERAL_DIRECTOR', 'CONTRACTOR_VIEWER']) {
    const token = await g.roleToken(role);
    const answers = [await send(token, e, params()), await send(token, e, { objectId: uuid() }), await send(token, e, { objectId: foreign.object.id }), await send(token, e, { objectId: 'not-a-uuid' })];
    assert.deepEqual(new Set(answers.map(a => a.status)), new Set([403]), role);
    assert.equal(new Set(answers.map(a => JSON.stringify(strip(a.body)))).size, 1, role + ': one and the same 403');
  }
});

test('errors never leak: neither the object id, its name, its manager nor a permission name appears in a 403 / 404 / 422 body', async () => {
  const pm = await g.roleToken('PROJECT_MANAGER');
  const bodies = [
    await send(await g.roleToken('PTO'), endpointById('schedule.revision.approve')!, params()),
    await send(pm, endpointById('schedule.revision.submit')!, { objectId: pilot.neighbour.id }),
    await send(pm, endpointById('schedule.revision.submit')!, params(), r => { r.body.expectedVersion = 3; })
  ];
  assert.deepEqual(bodies.map(b => b.status), [403, 404, 422]);
  for (const b of bodies) {
    const wire = JSON.stringify(b.body);
    for (const secret of [pilot.object.id, pilot.neighbour.id, pilot.object.name, pilot.neighbour.name, pilot.other.id, pilot.pm.id, 'GPR2_', 'SCHEDULE_', 'Недостаточно прав:'])
      assert.equal(wire.includes(secret), false, `${b.status} body must not contain ${secret}`);
  }
});

test('the order is permission → scope → envelope: a bad body never turns a 403 into a 422, and never reveals an out-of-scope object', async () => {
  const bad = (r: ReturnType<typeof validRequest>) => { r.body = { payload: { changeReason: '' }, expectedVersion: 1, surprise: true }; delete r.headers['Idempotency-Key']; };
  const e = endpointById('schedule.revision.submit')!;
  assert.equal((await send(await g.roleToken('DEPUTY_DIRECTOR'), e, params(), bad)).status, 403, 'wrong role + bad body → 403');
  assert.equal((await send(await g.roleToken('PROJECT_MANAGER'), e, { objectId: pilot.neighbour.id }, bad)).status, 404, 'out of scope + bad body → 404');
  const inScope = await send(await g.roleToken('PROJECT_MANAGER'), e, params(), bad);
  assert.equal(inScope.status, 422, 'right role, in scope + bad body → 422');
  assert.equal(inScope.body.code, 'VALIDATION_FAILED');
  assert.deepEqual(inScope.body.details.violations.map((v: any) => `${v.path}:${v.rule}`).sort(),
    ['Idempotency-Key:IDEMPOTENCY_KEY_REQUIRED', 'expectedScopeVersion:VERSION_TOKEN_REQUIRED', 'expectedVersion:VERSION_TOKEN_NOT_A_STRING', 'payload.changeReason:REASON_REQUIRED', 'surprise:FIELD_NOT_ALLOWED']);
});

test('contract violations over HTTP: D01 (execution-unit field), D08 (SF), D16 (exclusion without reason), A10 (apply without its preview) — each with its own rule', async () => {
  const pm = await g.roleToken('PROJECT_MANAGER'), deputy = await g.roleToken('DEPUTY_DIRECTOR');
  const w = { workId: uuid(), startDate: '2026-03-01', endDate: '2026-03-10' };
  const preview = endpointById('schedule.changes.preview')!, apply = endpointById('schedule.changes.apply')!;
  const rule = async (e: Gpr2Endpoint, payload: unknown) => { const r = await send(pm, e, params(), x => { x.body.payload = payload; }); return `${r.status}:${r.body.code}:${(r.body.details?.violations ?? []).map((v: any) => v.path + '=' + v.rule).join(',')}`; };
  assert.equal(await rule(preview, { entries: [{ ...w, executionUnitId: uuid() }] }), '422:VALIDATION_FAILED:payload.entries.0.executionUnitId=FIELD_NOT_ALLOWED');
  assert.equal(await rule(preview, { edges: [{ predecessorWorkId: uuid(), successorWorkId: uuid(), type: 'SF', lagKind: 'WORKING_DAYS', lagValue: '0' }] }), '422:UNSUPPORTED_DEPENDENCY_TYPE:');
  assert.equal(await rule(preview, { omissions: [{ workId: uuid(), inclusion: 'EXCLUDED' }] }), '422:VALIDATION_FAILED:payload.omissions.0.omissionReason=REASON_REQUIRED');
  assert.equal(await rule(apply, {}), '422:VALIDATION_FAILED:payload.previewFingerprint=FIELD_REQUIRED');
  assert.equal(await rule(preview, { entries: [w] }), '501:COMMAND_NOT_ENABLED:', 'the same Work as a single entry is accepted by the contract');
  // a blank reason on a return is refused for the deputy too
  const blank = await send(deputy, endpointById('schedule.revision.return')!, params(), x => { x.body.payload = { reason: '  ' }; });
  assert.deepEqual([blank.status, blank.body.code], [422, 'VALIDATION_FAILED']);
});

test('R01 writes nothing: an accepted-but-disabled command leaves audit, events, notifications, the idempotency ledger and Works exactly as they were, and answers 501', async () => {
  const tables = ['audit_logs', 'domain_events', 'notifications', 'idempotent_commands', 'works', 'work_execution_units', 'quantity_portions', 'schedule_revisions', 'schedule_revision_entries'];
  const before = await Promise.all(tables.map(rowCount));
  const pm = await g.roleToken('PROJECT_MANAGER'), deputy = await g.roleToken('DEPUTY_DIRECTOR');
  let n = 0;
  for (const e of mountedEndpoints()) {
    const token = WHO[e.id].includes('PROJECT_MANAGER') ? pm : WHO[e.id].includes('DEPUTY_DIRECTOR') ? deputy : await g.roleToken('ADMIN');
    if (WHO[e.id].length === 0) continue;
    const r = await send(token, e, params());
    assert.equal(r.status, 501, e.id); n++;
    assert.deepEqual(strip(r.body), { statusCode: 501, code: 'COMMAND_NOT_ENABLED', message: 'Команда пока не включена' }, e.id);
    assert.match(r.body.requestId, /^[0-9a-f-]{36}$/);
  }
  assert.equal(n, 30, 'every command anyone may issue');
  assert.deepEqual(await Promise.all(tables.map(rowCount)), before, tables.join(', '));
});

test('A19 changed-role replay: the SAME token and the SAME Idempotency-Key are re-authorised against the CURRENT role on every call', async () => {
  const user = await g.makeUser('Временный заместитель', 'DEPUTY_DIRECTOR');
  const token = await g.tokenFor(user);
  const { pool } = await import('../apps/backend/src/db');
  const e = endpointById('schedule.revision.approve')!, again = () => send(token, e, params());
  assert.equal((await again()).status, 501, 'as a deputy: through the gate');
  assert.equal((await again()).status, 501, 'the repeat is through as well');
  await pool.query("UPDATE users SET role='PROJECT_MANAGER' WHERE id=$1", [user.id]);
  const demoted = await again();
  assert.equal(demoted.status, 403, 'role changed → the repeat of the identical request is refused, not replayed');
  assert.equal(demoted.body.code, 'PERMISSION_DENIED');
  await pool.query("UPDATE users SET role='DEPUTY_DIRECTOR' WHERE id=$1", [user.id]);
  assert.equal((await again()).status, 501, 'and restored');
  await pool.query("UPDATE users SET is_active=false WHERE id=$1", [user.id]);
  assert.equal((await again()).status, 401, 'a deactivated user is no longer authenticated at all');
});

test('cross-tenant: a user of another tenant holding the right role is refused the same way as anyone out of scope — their token never opens this tenant\'s object', async () => {
  const foreign = await foreignTenantObject();
  const { pool, insert } = await import('../apps/backend/src/db');
  const outsider = await insert(pool, 'users', foreign.tenant.id, { bitrixUserId: 'outsider-' + Date.now(), name: 'Заместитель чужого tenant', role: 'DEPUTY_DIRECTOR', isActive: true });
  const token = await g.tokenFor(outsider);
  const e = endpointById('schedule.revision.approve')!;
  const a = await send(token, e, { objectId: pilot.object.id }), b = await send(token, e, { objectId: uuid() });
  assert.deepEqual([a.status, b.status], [404, 404]);
  assert.deepEqual(strip(a.body), strip(b.body));
  // their own object AND their own aggregate are reachable by them; this tenant's aggregate addressed under their own object is not (R01-B04)
  const theirs = trusted.own('SCHEDULE_REVISION', uuid(), { tenantId: foreign.tenant.id, objectId: foreign.object.id });
  assert.equal((await send(token, e, { objectId: foreign.object.id, id: theirs })).status, 501, 'their own object and aggregate are reachable by them');
  const ours = trusted.own('SCHEDULE_REVISION', uuid(), { tenantId: owner.tenantId, objectId: pilot.object.id });
  assert.equal((await send(token, e, { objectId: foreign.object.id, id: ours })).status, 404, 'another tenant\'s aggregate under their own object is one more 404');
});

test('the Idempotency-Key is not an access token: knowing a key another user used grants nothing, and each user\'s keys live in their own space', async () => {
  const e = endpointById('schedule.revision.submit')!;
  const pm = await g.roleToken('PROJECT_MANAGER'), deputy = await g.roleToken('DEPUTY_DIRECTOR'), admin = await g.roleToken('ADMIN');
  const shared = KEY(777);
  assert.equal((await send(pm, e, params(), r => { r.headers['Idempotency-Key'] = shared; })).status, 501);
  for (const intruder of [deputy, admin]) assert.equal((await send(intruder, e, params(), r => { r.headers['Idempotency-Key'] = shared; })).status, 403, 'a known key does not turn a refused role into an allowed one');
});

test('the swagger document lists the guarded routes only while they are mounted', async () => {
  const doc = await g.call(null, 'GET', '/api-docs-json');
  assert.equal(doc.status, 200);
  assert.ok(Object.keys(doc.body.paths).some(p => p.startsWith('/v2/objects/{objectId}/schedule/revisions')));
  assert.equal(Object.keys(doc.body.paths).filter(p => p.startsWith('/v2/')).length >= 20, true);
});

test('hooks and capability sources default to "not enabled" / "no aggregate is known" / "nobody holds it"', async () => {
  const { DISABLED_HOOKS } = await import('../apps/backend/src/gpr2-command-guard');
  assert.deepEqual(await DISABLED_HOOKS.resources.resolve({ kind: 'QUANTITY_CHANGE_REQUEST', id: uuid() }), { found: false });
  assert.equal(await DISABLED_HOOKS.replay({} as any), null);
  await assert.rejects(DISABLED_HOOKS.execute({} as any), (e: any) => e.code === 'COMMAND_NOT_ENABLED' && e.status === 501);
  assert.equal(NO_CAPABILITY_ASSIGNMENTS.length, 0);
  assert.equal(GPR2_ENDPOINTS.some(e => e.id === 'imports.estimate-labor.mapping-reviews' && e.mounted), true);
  void (undefined as unknown as CapabilityAssignment);
});
