import './helpers/gpr2-isolation'; // FIRST: no backend module may load before the environment is pinned to in-memory PGlite
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  endpointById, mountedEndpoints, commandResultSchema, QUANTITY_CHANGE_REQUEST, transitionForEndpoint, Gpr2Error, type Gpr2Endpoint, type CommandResult
} from '../packages/domain/gpr2';
import { gpr2Harness, validRequest, foreignTenantObject, pilotScenario, fence, KEY, uuid, type Gpr2Harness } from './helpers/gpr2-fixtures';
import { TrustedResources, ownedParams, installHooks, recordingHooks, RESULT, type Owner } from './helpers/gpr2-resources';
import { assertInMemoryPool } from './helpers/gpr2-isolation';
import type { Pilot } from './helpers/gpr-fixtures';

/**
 * GPR-2 R01 corrective tests over the REAL backend (in-memory PGlite, mock auth, flag on) — findings R01-B01, B02, B03, B04.
 * Every test that claims "replay and execute did not run" installs recording hooks on the LIVE controller and reads their call log: the claim is a
 * measurement, not an inference from a status code.
 */
let g: Gpr2Harness;
let pilot: Pilot;
let owner: Owner;
let foreign: Awaited<ReturnType<typeof foreignTenantObject>>;
const trusted = new TrustedResources();
before(async () => {
  g = await gpr2Harness('gpr2-r01-corrective-key'); pilot = await pilotScenario(g.h); assert.equal(await assertInMemoryPool(), true);
  owner = { tenantId: await g.tenantId(), objectId: pilot.object.id };
  foreign = await foreignTenantObject();
});
after(async () => { await g?.h.close(); });

const PM = 'PROJECT_MANAGER', DEPUTY = 'DEPUTY_DIRECTOR', ADMIN = 'ADMIN';
const NOT_FOUND = { statusCode: 404, code: 'RESOURCE_NOT_FOUND', message: 'Запись не найдена' };
const strip = (b: any) => { const { requestId, ...rest } = b ?? {}; return rest; };

/** Run `body` with recording hooks installed on the live controller; always uninstalled afterwards. */
async function withHooks<T>(body: (rec: ReturnType<typeof recordingHooks>) => Promise<T>, opts: { replay?: CommandResult | null; execute?: Parameters<typeof recordingHooks>[2] } = {}): Promise<T> {
  trusted.reset();
  const rec = recordingHooks(trusted, opts.replay ?? null, opts.execute);
  const undo = await installHooks(g.h.app, rec.hooks);
  try { return await body(rec); } finally { undo(); }
}
const send = async (role: string | null, e: Gpr2Endpoint, params: Record<string, string>, tweak: (r: ReturnType<typeof validRequest>) => void = () => {}) => {
  const req = validRequest(e, params); tweak(req);
  return g.call(role ? await g.roleToken(role) : null, req.method, req.path, { body: req.body, headers: req.headers });
};
/** A raw JSON text as the body: for values JSON.stringify cannot produce (1e999) or would not (a `__proto__` key). */
const sendRaw = async (role: string, e: Gpr2Endpoint, params: Record<string, string>, text: string) => {
  const req = validRequest(e, params);
  const r = await fetch(g.h.base + req.path, { method: req.method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await g.roleToken(role), ...req.headers }, body: text });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
};
const own = (e: Gpr2Endpoint) => ownedParams(trusted, e, owner);
const rules = (b: any) => (b?.details?.violations ?? []).map((v: any) => `${v.path}:${v.rule}`).sort();

// ---------------------------------------------------------------------------------------------------------------------------------
// R01-B01
// ---------------------------------------------------------------------------------------------------------------------------------

test('R01-B01 (HTTP): impossible calendar dates answer 422 VALIDATION_FAILED / DATE_MALFORMED — never 500 — for preview and apply, start and end; neither hook runs', async () => {
  await withHooks(async rec => {
    let n = 0;
    for (const id of ['schedule.changes.preview', 'schedule.changes.apply'])
      for (const date of ['2026-13-01', '2026-00-10', '2026-01-32', '9999-99-99', '2026-02-31', '2025-02-29', '2026-04-31', '0000-01-01', '2026-1-1', '']) {
        for (const field of ['startDate', 'endDate'] as const) {
          const e = endpointById(id)!;
          const entry = { workId: uuid(), startDate: '2026-03-01', endDate: '2026-03-20', [field]: date };
          const r = await send(PM, e, own(e), x => { x.body.payload = { ...(x.body.payload as object), entries: [entry] }; });
          assert.equal(r.status, 422, `${id} ${field}=${JSON.stringify(date)}: ${JSON.stringify(r.body)}`);
          assert.equal(r.body.code, 'VALIDATION_FAILED');
          assert.deepEqual(r.body.details.violations, [{ path: `payload.entries.0.${field}`, rule: 'DATE_MALFORMED' }]);
          assert.equal(JSON.stringify(r.body).includes(date || '\u0000'), false, 'the value is not echoed');
          n++;
        }
      }
    assert.equal(n, 40);
    assert.deepEqual(rec.calls, [], 'a malformed date never reaches replay or execute');
    // positive coverage: valid civil dates (a leap day, a month end, the range limits) pass the envelope and reach the stage
    for (const [start, end] of [['2024-02-29', '2024-02-29'], ['2026-01-31', '2026-02-28'], ['0001-01-01', '9999-12-31']]) {
      const e = endpointById('schedule.changes.preview')!;
      const r = await send(PM, e, own(e), x => { x.body.payload = { entries: [{ workId: uuid(), startDate: start, endDate: end }] }; });
      assert.equal(r.status, 200, `${start}..${end}: ${JSON.stringify(r.body)}`);
    }
    assert.deepEqual(rec.calls, ['replay', 'execute', 'replay', 'execute', 'replay', 'execute']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// R01-B02
// ---------------------------------------------------------------------------------------------------------------------------------

test('R01-B02 (HTTP): PATCH quantity-change-requests/{id} — a handler that takes its row from the lifecycle edits a DRAFT, corrects a RETURNED request, and is refused for SUBMITTED and APPROVED', async () => {
  const patch = endpointById('quantity.request.patch')!;
  const states = new Map<string, string>();
  const stateOf = (state: string) => { const p = own(patch); states.set(p.id, state); return p; };
  await withHooks(async rec => {
    const call = async (state: string, role = PM) => send(role, patch, stateOf(state));
    const draft = await call('DRAFT');
    assert.equal(draft.status, 200, JSON.stringify(draft.body));
    assert.deepEqual(draft.body.warnings, [{ code: 'EDIT_IN_PLACE' }], 'DRAFT → the in-place edit row');
    assert.equal(commandResultSchema.safeParse(draft.body).success, true);
    const returned = await call('RETURNED');
    assert.equal(returned.status, 200, JSON.stringify(returned.body));
    assert.deepEqual(returned.body.warnings, [{ code: 'OPEN_NEW_SUBMISSION_VERSION' }], 'RETURNED → the correction row: a NEW submission version');
    for (const state of ['SUBMITTED', 'APPROVED']) {
      const r = await call(state);
      assert.equal(r.status, 422, state);
      assert.equal(r.body.code, 'INVALID_TRANSITION');
      assert.deepEqual(r.body.details, { machine: 'QUANTITY_CHANGE_REQUEST', from: state, command: 'quantity.request.patch' });
    }
    // after a correction the request is a DRAFT again and can be edited again, then submitted — and never edited once SUBMITTED
    const p = stateOf('RETURNED');
    assert.equal((await send(PM, patch, p)).status, 200);
    assert.equal(states.get(p.id), 'DRAFT');
    assert.equal((await send(PM, patch, p)).status, 200);
    states.set(p.id, 'SUBMITTED');
    assert.equal((await send(PM, patch, p)).status, 422);
    // the role rule is unchanged: only the quantity author edits; the reviewer, the Admin and everyone else are refused at the door
    const callsBefore = rec.calls.length;
    for (const role of [DEPUTY, ADMIN, 'PTO', 'PTO_HEAD', 'SDO', 'CONSTRUCTION_CONTROL', 'GENERAL_DIRECTOR', 'CONTRACTOR_VIEWER']) {
      const r = await call('DRAFT', role);
      assert.equal(r.status, 403, role);
      assert.equal(r.body.code, 'PERMISSION_DENIED');
    }
    assert.equal(rec.calls.length, callsBefore, 'a refused role reaches no hook');
  }, { execute: { execute: async ctx => {
    // the shape every stage handler must follow: the row comes from the lifecycle for (current state, this endpoint); it never tests the state itself
    const row = transitionForEndpoint(QUANTITY_CHANGE_REQUEST, states.get(ctx.params.id) as any, ctx.endpoint.id);
    states.set(ctx.params.id, row.to);
    return { ...RESULT, warnings: [{ code: row.effect! }] };
  } } });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// R01-B03
// ---------------------------------------------------------------------------------------------------------------------------------

const FENCED = ['quantity.request.approve', 'imports.boq.commit', 'imports.estimate-labor.commit', 'schedule.revision.approve'];
const roleOf = (id: string) => (id.endsWith('approve') ? DEPUTY : PM);

test('R01-B03 (HTTP): approve / commit without the common fence — {payload:{}} included — is 422 BEFORE replay; the spy proves replay and execute never ran', async () => {
  await withHooks(async rec => {
    for (const id of FENCED) {
      const e = endpointById(id)!;
      const cases: [string, unknown, string[]][] = [
        ['empty payload', {}, ['payload.expectedSourceVersions:FIELD_REQUIRED', 'payload.inputFingerprint:FIELD_REQUIRED']],
        ['no sources', { inputFingerprint: 'a'.repeat(64) }, ['payload.expectedSourceVersions:FIELD_REQUIRED']],
        ['empty sources', { inputFingerprint: 'a'.repeat(64), expectedSourceVersions: {} }, ['payload.expectedSourceVersions:FIELD_REQUIRED']],
        ['no fingerprint', { expectedSourceVersions: { calendar: uuid() } }, ['payload.inputFingerprint:FIELD_REQUIRED']],
        ['short fingerprint', { inputFingerprint: 'abc', expectedSourceVersions: { calendar: uuid() } }, ['payload.inputFingerprint:FIELD_TYPE']],
        ['bad source id', { inputFingerprint: 'a'.repeat(64), expectedSourceVersions: { calendar: 'x' } }, ['payload.expectedSourceVersions.calendar:ID_MALFORMED']],
        ['sources as list', { inputFingerprint: 'a'.repeat(64), expectedSourceVersions: [uuid()] }, ['payload.expectedSourceVersions:FIELD_TYPE']]
      ];
      for (const [label, payload, expected] of cases) {
        const r = await send(roleOf(id), e, own(e), x => { x.body.payload = payload; });
        assert.equal(r.status, 422, `${id} ${label}: ${JSON.stringify(r.body)}`);
        assert.equal(r.body.code, 'VALIDATION_FAILED');
        assert.deepEqual(rules(r.body), expected, `${id} ${label}`);
      }
      // the whole payload missing is refused too
      const noPayload = await send(roleOf(id), e, own(e), x => { delete x.body.payload; });
      assert.deepEqual([noPayload.status, rules(noPayload.body)], [422, ['payload:FIELD_REQUIRED']], id);
    }
    assert.deepEqual(rec.calls, [], 'not one replay, not one execute — for 32 envelope rejections');
    // positive control: the fence from the fixture reaches the stage, and the fingerprint depends on the sources it names
    const e = endpointById('imports.boq.commit')!, p = own(e);
    const a = await send(PM, e, p), b = await send(PM, e, p, x => { (x.body.payload as any).expectedSourceVersions = { calendar: uuid() }; });
    assert.deepEqual([a.status, b.status], [200, 200]);
    assert.deepEqual(rec.calls, ['replay', 'execute', 'replay', 'execute']);
    // the named source versions are part of the command identity (TD §12.4: «выбранный import/source version»): the same key with other sources is another command
    assert.notEqual(rec.seen[0].fingerprint, rec.seen[2].fingerprint);
    assert.deepEqual(Object.keys(rec.seen[0].command.payload.expectedSourceVersions).length, 2);
  });
});

test('R01-B03 (HTTP): finish-change.record-correction requires a reason — 422 before replay — and a correction with one reaches the stage', async () => {
  const e = endpointById('finish-change.record-correction')!;
  await withHooks(async rec => {
    for (const payload of [{}, { reason: '' }, { reason: '   ' }, { reason: 7 }, { reason: 'x'.repeat(2001) }, { correctedOutcome: { code: 'X' } }]) {
      const r = await send(PM, e, own(e), x => { x.body.payload = payload; });
      assert.equal(r.status, 422, JSON.stringify(payload).slice(0, 40));
      assert.deepEqual(rules(r.body), ['payload.reason:REASON_REQUIRED']);
    }
    assert.deepEqual(rec.calls, []);
    const ok = await send(PM, e, own(e), x => { x.body.payload = { reason: '  исправление  ', correctedOutcome: { code: 'X' } }; });
    assert.equal(ok.status, 200);
    assert.equal(rec.seen[0].command.payload.reason, 'исправление', 'the stage receives the trimmed reason');
    assert.deepEqual(rec.seen[0].command.payload.correctedOutcome, { code: 'X' }, 'and the deferred extension, untouched');
  });
});

test('R01-B03 (HTTP): an open payload that cannot be canonicalised is 422, not 500 — newQuantity:1.5, 1e999, deep nesting, __proto__ — and replay / execute never run', async () => {
  const create = endpointById('quantity.request.create')!;
  await withHooks(async rec => {
    const r1 = await send(PM, create, own(create), x => { x.body.payload = { newQuantity: 1.5 }; });
    assert.deepEqual([r1.status, r1.body.code, rules(r1.body)], [422, 'VALIDATION_FAILED', ['payload.newQuantity:DECIMAL_NOT_A_STRING']]);
    const raw = async (text: string) => sendRaw(PM, create, own(create), text);
    const infinite = await raw('{"expectedScopeVersion":"1","payload":{"quantity":1e999}}');
    assert.deepEqual([infinite.status, rules(infinite.body)], [422, ['payload.quantity:OUT_OF_RANGE']]);
    const big = await raw('{"expectedScopeVersion":"1","payload":{"quantity":12345678901234567890}}');
    assert.deepEqual([big.status, rules(big.body)], [422, ['payload.quantity:OUT_OF_RANGE']]);
    const proto = await raw('{"expectedScopeVersion":"1","payload":{"__proto__":{"admin":true}}}');
    assert.deepEqual([proto.status, rules(proto.body)], [422, ['payload.*:FIELD_NOT_ALLOWED']]);
    const levels = 100000;
    const deep = await raw('{"expectedScopeVersion":"1","payload":{"a":' + '['.repeat(levels) + ']'.repeat(levels) + '}}');
    assert.ok(deep.status === 422 || deep.status === 400, 'deeply nested body: a refusal, not a crash (' + deep.status + ')');
    assert.notEqual(deep.status, 500);
    assert.deepEqual(rec.calls, []);
    // a decimal STRING is what the contract asks for, and it passes
    const ok = await send(PM, create, own(create), x => { x.body.payload = { newQuantity: '1.5', note: 'x', count: 3 }; });
    assert.equal(ok.status, 200);
    assert.deepEqual(rec.calls, ['replay', 'execute']);
  });
});

test('R01-B03 (HTTP): 300 seeded random JSON payloads never produce a 500 — each is either applied (200) or refused with VALIDATION_FAILED (422)', async () => {
  let seed = 424242;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
  const leaf = () => pick<unknown>([null, true, false, 0, 1, -3, 7, 0.5, -1.25, 1e21, 123456789012345678901234567890, '', 'text', '1.50', 'ü', 9007199254740993]);
  const gen = (depth: number): unknown => rnd() < 0.5 || depth > 4 ? leaf() : rnd() < 0.5 ? Array.from({ length: Math.floor(rnd() * 4) }, () => gen(depth + 1)) : Object.fromEntries(Array.from({ length: Math.floor(rnd() * 4) }, () => [pick(['a', 'b', 'qty', 'x y', '<s>', 'k'.repeat(70)]), gen(depth + 1)]));
  const create = endpointById('quantity.request.create')!;
  const seen = new Set<number>();
  await withHooks(async () => {
    for (let i = 0; i < 300; i++) {
      const payload = rnd() < 0.2 ? gen(0) : { field: gen(0) };
      const r = await sendRaw(PM, create, own(create), JSON.stringify({ expectedScopeVersion: '1', payload }));
      seen.add(r.status);
      assert.ok(r.status === 200 || r.status === 422, `${r.status} for ${JSON.stringify(payload).slice(0, 80)}`);
      if (r.status === 422) assert.equal(r.body.code, 'VALIDATION_FAILED');
    }
  });
  assert.deepEqual([...seen].sort(), [200, 422], 'both outcomes occurred');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// R01-B04
// ---------------------------------------------------------------------------------------------------------------------------------

// the 22 mounted, id-bearing commands some ROLE can issue (the other two, review-note and mapping-reviews, are N01 default-deny: no role reaches the preflight)
const WHO: Record<string, string> = {
  'work-type.publication.request': PM, 'work-type.publication.approve': ADMIN, 'work-type.publication.reject': ADMIN, 'finish-system.preview': PM, 'finish-system.confirm': PM,
  'quantity.request.patch': PM, 'quantity.request.submit': PM, 'quantity.request.approve': DEPUTY, 'quantity.request.return': DEPUTY, 'calendar.version.patch': PM,
  'schedule.changes.preview': PM, 'schedule.changes.apply': PM, 'schedule.backplan.preview': PM, 'schedule.revision.submit': PM, 'schedule.revision.discard': PM,
  'schedule.revision.approve': DEPUTY, 'schedule.revision.return': DEPUTY, 'finish-change.record-correction': PM, 'imports.boq.allocations': PM, 'imports.boq.commit': PM,
  'imports.estimate-labor.mapping-proposals': PM, 'imports.estimate-labor.commit': PM
};

test('R01-B04: the id-bearing mounted commands are exactly the 22 this suite drives by role (+ the two N01 default-deny ones)', () => {
  const ids = mountedEndpoints().filter(e => e.resource).map(e => e.id).sort();
  assert.deepEqual(ids, [...Object.keys(WHO), 'quantity.request.review-note', 'imports.estimate-labor.mapping-reviews'].sort());
});

test('R01-B04: a well-formed id that is MISSING, another object\'s, another tenant\'s or a wrong-level aggregate is the one scope-safe 404 — and replay / execute never run (22 commands × 5 cases)', async () => {
  const kinds = new Set<string>();
  await withHooks(async rec => {
    let negatives = 0;
    for (const [id, role] of Object.entries(WHO)) {
      const e = endpointById(id)!, kind = e.resource!.kind;
      kinds.add(kind);
      const tenantRoute = e.scope === 'TENANT';
      const path = (resourceId: string) => (tenantRoute ? { id: resourceId } : { objectId: owner.objectId, id: resourceId });
      const cases: [string, string, { tenantId: string; objectId: string | null } | null][] = tenantRoute ? [
        ['missing', uuid(), null],
        ['another tenant\'s request', uuid(), { tenantId: foreign.tenant.id, objectId: null }],
        ['an object-owned aggregate behind a tenant-level route', uuid(), { tenantId: owner.tenantId, objectId: pilot.object.id }]
      ] : [
        ['missing', uuid(), null],
        ['another object of the same tenant', uuid(), { tenantId: owner.tenantId, objectId: pilot.neighbour.id }],
        ['another tenant\'s object and aggregate', uuid(), { tenantId: foreign.tenant.id, objectId: foreign.object.id }],
        ['another tenant, same object id claimed', uuid(), { tenantId: foreign.tenant.id, objectId: pilot.object.id }],
        ['a tenant-level aggregate behind an object route', uuid(), { tenantId: owner.tenantId, objectId: null }]
      ];
      for (const [label, resourceId, registered] of cases) {
        if (registered) trusted.own(kind, resourceId, registered);
        trusted.reset();
        const r = await send(role, e, path(resourceId));
        assert.equal(r.status, 404, `${id} / ${label}: ${JSON.stringify(r.body)}`);
        assert.deepEqual(strip(r.body), NOT_FOUND, `${id} / ${label}: the one body`);
        assert.deepEqual(trusted.asked, [{ kind, id: resourceId }], `${id} / ${label}: the owner was looked up exactly once, by kind and id`);
        negatives++;
      }
      // the positive control, same request shape: the owner's aggregate is let through to replay and execute
      const before = rec.calls.length;
      const okId = trusted.own(kind, uuid(), { tenantId: owner.tenantId, objectId: tenantRoute ? null : owner.objectId });
      const ok = await send(role, e, path(okId));
      assert.equal(ok.status, 200, `${id}: ${JSON.stringify(ok.body)}`);
      assert.equal(commandResultSchema.safeParse(ok.body).success, true);
      assert.deepEqual(rec.calls.slice(before), ['replay', 'execute'], id);
      assert.equal(rec.seen[rec.seen.length - 1].params.id, okId);
    }
    assert.equal(negatives, 20 * 5 + 2 * 3, 'every negative case ran: 20 object-scope commands × 5, 2 tenant-level × 3');
    assert.equal(rec.calls.filter(c => c === 'replay').length, 22, 'replay ran only for the 22 positive controls');
    assert.equal(rec.calls.filter(c => c === 'execute').length, 22);
  });
  assert.deepEqual([...kinds].sort(), ['BOQ_IMPORT', 'CALENDAR_VERSION', 'ESTIMATE_LABOR_IMPORT', 'FINISH_CHANGE_RECORD', 'FINISH_SYSTEM', 'QUANTITY_CHANGE_REQUEST', 'SCHEDULE_REVISION', 'WORK_TYPE', 'WORK_TYPE_PUBLICATION_REQUEST']);
});

test('R01-B04: tenant-level corporate publication — another tenant\'s request, and an Admin of another tenant, are 404 with no object prefix to lean on', async () => {
  const approve = endpointById('work-type.publication.approve')!;
  const outsiderAdmin = await (await import('../apps/backend/src/db')).insert((await import('../apps/backend/src/db')).pool, 'users', foreign.tenant.id, { bitrixUserId: 'outsider-admin-' + Date.now(), name: 'Админ чужого tenant', role: 'ADMIN', isActive: true });
  const outsiderToken = await g.tokenFor(outsiderAdmin);
  const ours = trusted.own('WORK_TYPE_PUBLICATION_REQUEST', uuid(), { tenantId: owner.tenantId, objectId: null });
  await withHooks(async rec => {
    const call = (token: string, id: string) => { const req = validRequest(approve, { id }); return g.call(token, req.method, req.path, { body: req.body, headers: req.headers }); };
    const theirs = await call(outsiderToken, ours);
    assert.deepEqual([theirs.status, strip(theirs.body)], [404, NOT_FOUND], 'an Admin of another tenant holds the permission and still cannot reach this tenant\'s request');
    assert.deepEqual(rec.calls, []);
    const mine = await call(await g.roleToken(ADMIN), ours);
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    assert.deepEqual(rec.calls, ['replay', 'execute']);
  });
});

test('R01-B04: the order — permission BEFORE the resolver, object scope BEFORE the resolver, resolver BEFORE the envelope, envelope BEFORE replay', async () => {
  const e = endpointById('schedule.revision.submit')!;
  await withHooks(async rec => {
    const mine = () => ownedParams(trusted, e, owner);
    // 403: a role without the grant never makes the resolver speak, whatever the resource
    trusted.reset();
    const denied = await send(DEPUTY, e, mine());
    assert.deepEqual([denied.status, denied.body.code, trusted.asked.length], [403, 'PERMISSION_DENIED', 0]);
    // 404 by object scope: another РП's object — the resolver is not asked either
    trusted.reset();
    const scope = await send(PM, e, { objectId: pilot.neighbour.id, id: trusted.own('SCHEDULE_REVISION', uuid(), { tenantId: owner.tenantId, objectId: pilot.neighbour.id }) });
    assert.deepEqual([scope.status, strip(scope.body), trusted.asked.length], [404, NOT_FOUND, 0]);
    // a malformed aggregate id is refused by syntax, before any lookup
    trusted.reset();
    const syntax = await send(PM, e, { objectId: owner.objectId, id: 'not-a-uuid' });
    assert.deepEqual([syntax.status, trusted.asked.length], [404, 0]);
    // missing resource + BAD envelope → 404, not 422: the caller learns nothing about the body of a command on an aggregate it may not touch
    trusted.reset();
    const hidden = await send(PM, e, { objectId: owner.objectId, id: uuid() }, x => { x.body = { payload: { changeReason: '' }, surprise: true }; delete x.headers['Idempotency-Key']; });
    assert.deepEqual([hidden.status, strip(hidden.body), trusted.asked.length], [404, NOT_FOUND, 1]);
    // owned resource + bad envelope → 422, the resolver having spoken once, and still no hook
    trusted.reset();
    const bad = await send(PM, e, mine(), x => { x.body = { payload: { changeReason: '' }, surprise: true }; delete x.headers['Idempotency-Key']; });
    assert.deepEqual([bad.status, bad.body.code, trusted.asked.length], [422, 'VALIDATION_FAILED', 1]);
    assert.deepEqual(rec.calls, [], 'through all of that: replay and execute never ran');
  });
});

test('R01-B04: authorization before replay covers the aggregate too — a stored result is not returned once the caller no longer owns the aggregate it was stored for', async () => {
  const e = endpointById('schedule.revision.submit')!;
  const stored: CommandResult = { ...RESULT, commandId: uuid() };
  await withHooks(async rec => {
    const params = ownedParams(trusted, e, owner);
    const first = await send(PM, e, params);
    assert.deepEqual([first.status, first.body.commandId], [200, stored.commandId]);
    assert.deepEqual(rec.calls, ['replay'], 'a stored result short-circuits execute');
    // the aggregate is re-assigned to another tenant (or forgotten): the identical request — same key, same token — is a 404 and replay is not even consulted
    for (const moved of [{ tenantId: foreign.tenant.id, objectId: foreign.object.id }, { tenantId: owner.tenantId, objectId: pilot.neighbour.id }, null]) {
      trusted.forget('SCHEDULE_REVISION', params.id);
      if (moved) trusted.own('SCHEDULE_REVISION', params.id, moved);
      const before = rec.calls.length;
      const again = await send(PM, e, params);
      assert.deepEqual([again.status, strip(again.body)], [404, NOT_FOUND]);
      assert.equal(rec.calls.length, before, 'replay was not looked up');
    }
  }, { replay: stored });
});

test('R01-B04: with the PRODUCTION default hooks (DISABLED_HOOKS) every id-bearing command is the 404 and every command without an {id} is 501 — nothing is addressable, nothing is written', async () => {
  trusted.reset();
  const { DISABLED_HOOKS } = await import('../apps/backend/src/gpr2-command-guard');
  const undo = await installHooks(g.h.app, DISABLED_HOOKS);
  try {
    const { pool } = await import('../apps/backend/src/db');
    const count = async () => Number((await pool.query('SELECT (SELECT count(*) FROM idempotent_commands) + (SELECT count(*) FROM audit_logs) + (SELECT count(*) FROM domain_events) AS n')).rows[0].n);
    const before = await count();
    let withId = 0, without = 0;
    for (const e of mountedEndpoints()) {
      if (e.id === 'quantity.request.review-note' || e.id === 'imports.estimate-labor.mapping-reviews') continue; // N01 default-deny: no role reaches the gate at all
      const role = WHO[e.id] ?? PM;
      const params = e.scope === 'OBJECT' ? { objectId: owner.objectId, id: uuid() } : { id: uuid() };
      const r = await send(role, e, params);
      if (e.resource) { assert.deepEqual([r.status, strip(r.body)], [404, NOT_FOUND], e.id); withId++; }
      else { assert.deepEqual([r.status, r.body.code], [501, 'COMMAND_NOT_ENABLED'], e.id); without++; }
    }
    assert.deepEqual([withId, without], [22, 8]);
    assert.equal(await count(), before, 'no ledger, audit or event row was written');
  } finally { undo(); }
});

test('R01-B04: a resolver that throws is not an answer — the call fails closed (500 without detail), and neither replay nor execute ran', async () => {
  const e = endpointById('quantity.request.submit')!;
  const boom = { resolve: async () => { throw new Error('owner lookup unavailable: secret-detail-123'); } };
  const rec = recordingHooks(boom);
  const undo = await installHooks(g.h.app, rec.hooks);
  try {
    const r = await send(PM, e, { objectId: owner.objectId, id: uuid() });
    assert.equal(r.status, 500);
    assert.equal(JSON.stringify(r.body).includes('secret-detail-123'), false, 'no internals on the wire');
    assert.deepEqual(rec.calls, []);
  } finally { undo(); }
});

test('R01-B04 / success contract: an applied command answers 200 with the CommandResult envelope (a POST would default to 201)', async () => {
  await withHooks(async () => {
    for (const id of ['quantity.request.submit', 'schedule.revision.submit', 'work-type.create', 'imports.boq.allocations', 'quantity.request.patch']) {
      const e = endpointById(id)!;
      const r = await send(PM, e, own(e));
      assert.equal(r.status, 200, `${e.method} ${e.path}`);
      assert.equal(commandResultSchema.safeParse(r.body).success, true, id);
    }
  });
});

test('KEY fixtures are well formed and distinct (guards the helpers this suite relies on)', () => {
  assert.notEqual(KEY(1), KEY(2));
  assert.equal(Object.keys(fence()).length, 2);
  assert.ok(new Gpr2Error('RESOURCE_NOT_FOUND').status === 404);
});
