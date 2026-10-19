import './helpers/gpr2-isolation'; // FIRST: no backend module may load before the environment is pinned to in-memory PGlite
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { RequestMethod } from '@nestjs/common';
import { buildGpr2OpenApi, mountedEndpoints, routeOf, endpointById, Gpr2Error, GPR2_ENDPOINTS, parseCommand, type Gpr2Endpoint } from '../packages/domain/gpr2';
import { gpr2Harness, validRequest, pilotScenario, KEY, uuid, type Gpr2Harness } from './helpers/gpr2-fixtures';
import { TrustedResources, ownedParams, installHooks, recordingHooks, type Owner } from './helpers/gpr2-resources';
import { assertInMemoryPool } from './helpers/gpr2-isolation';
import { accepts, validate } from './helpers/gpr2-json-schema';
import type { Pilot } from './helpers/gpr-fixtures';

/**
 * GPR-2 R01 — ONE authoritative contract (finding R01-B05). The document the running application SERVES at /api-docs-json is read over HTTP and
 * held to (a) the register-derived contract, operation by operation, and (b) the actual behaviour of the live routes, in both directions:
 * what the document accepts, the server accepts; what the document refuses, the server refuses with 422. The schema validator that decides
 * "the document accepts" is independent of the parsers (tests/helpers/gpr2-json-schema.ts).
 */
let g: Gpr2Harness;
let pilot: Pilot;
let owner: Owner;
let served: any;
const trusted = new TrustedResources();
let undo = () => {};
before(async () => {
  g = await gpr2Harness('gpr2-r01-openapi-key'); pilot = await pilotScenario(g.h); assert.equal(await assertInMemoryPool(), true);
  owner = { tenantId: await g.tenantId(), objectId: pilot.object.id };
  const res = await g.call(null, 'GET', '/api-docs-json');
  assert.equal(res.status, 200);
  served = res.body;
  undo = await installHooks(g.h.app, recordingHooks(trusted).hooks);
});
after(async () => { undo(); await g?.h.close(); });

const derived: any = buildGpr2OpenApi({ mountedOnly: true });
const PM = 'PROJECT_MANAGER';
const ROLE: Record<string, string> = { 'work-type.publication.approve': 'ADMIN', 'work-type.publication.reject': 'ADMIN', 'quantity.request.approve': 'DEPUTY_DIRECTOR', 'quantity.request.return': 'DEPUTY_DIRECTOR',
  'schedule.revision.approve': 'DEPUTY_DIRECTOR', 'schedule.revision.return': 'DEPUTY_DIRECTOR' };
// the two N01 default-deny commands have no role that reaches the body; they are checked at the document level only
const REACHABLE = () => mountedEndpoints().filter(e => e.id !== 'quantity.request.review-note' && e.id !== 'imports.estimate-labor.mapping-reviews');
const servedOp = (e: Gpr2Endpoint) => served.paths['/v2' + e.path][e.method.toLowerCase()];
const bodySchemaOf = (e: Gpr2Endpoint) => servedOp(e).requestBody.content['application/json'].schema;
const call = async (e: Gpr2Endpoint, role: string | null, params: Record<string, string>, body: unknown, headers: Record<string, string>) => {
  const req = validRequest(e, params);
  return g.call(role ? await g.roleToken(role) : null, req.method, req.path, { body, headers });
};

// ---------------------------------------------------------------------------------------------------------------------------------
// (a) the served document IS the derived contract
// ---------------------------------------------------------------------------------------------------------------------------------

test('R01-B05: the LIVE /api-docs-json carries every mounted /v2 operation exactly as the register-derived contract states it — no more, no fewer, operation by operation', () => {
  const servedV2 = Object.fromEntries(Object.entries(served.paths).filter(([p]) => p === '/v2' || p.startsWith('/v2/')));
  assert.deepEqual(Object.keys(servedV2).sort(), Object.keys(derived.paths).sort(), 'the same set of paths');
  assert.deepEqual(servedV2, derived.paths, 'and every path item is identical');
  let operations = 0;
  for (const e of mountedEndpoints()) { assert.deepEqual(servedOp(e), derived.paths['/v2' + e.path][e.method.toLowerCase()], e.id); operations++; }
  assert.equal(operations, 32);
  // nothing that is not mounted leaks into the served document
  for (const e of GPR2_ENDPOINTS.filter(x => !x.mounted)) assert.equal(served.paths['/v2' + e.path]?.[e.method.toLowerCase()], undefined, e.id + ' is catalogued, not mounted');
  for (const [name, schema] of Object.entries(derived.components.schemas)) assert.deepEqual(served.components.schemas[name], schema, 'schema ' + name);
  assert.deepEqual(served.components.securitySchemes.bearerAuth, derived.components.securitySchemes.bearerAuth);
  assert.deepEqual(served['x-error-status'], derived['x-error-status']);
  assert.deepEqual(JSON.parse(JSON.stringify(served)), served, 'plain JSON');
});

test('R01-B05: the served operations are the controller\'s real routes — method, path and a unique operationId from the register for each of the 32', () => {
  const methodName: Record<number, string> = { [RequestMethod.GET]: 'get', [RequestMethod.POST]: 'post', [RequestMethod.PATCH]: 'patch', [RequestMethod.PUT]: 'put' };
  return import('../apps/backend/src/modules/gpr2/gpr2.controller').then(({ Gpr2ContractController }) => {
    const routes = Object.getOwnPropertyNames(Gpr2ContractController.prototype).filter(n => n !== 'constructor' && n !== 'run').map(n => {
      const fn = (Gpr2ContractController.prototype as any)[n];
      return `${methodName[Reflect.getMetadata('method', fn)]} /${Reflect.getMetadata('path', fn).replace(/:(\w+)/g, '{$1}')}`;
    }).sort();
    const doc = Object.entries(served.paths).filter(([p]) => p.startsWith('/v2/')).flatMap(([p, item]: [string, any]) => Object.keys(item).map(m => `${m} ${p}`)).sort();
    assert.deepEqual(doc, routes, 'what is documented is what is routed');
    const ids = Object.values(served.paths).flatMap((item: any) => Object.values(item).map((op: any) => op.operationId));
    assert.equal(new Set(ids).size, ids.length, 'operationIds are unique across the whole served document');
    assert.deepEqual(mountedEndpoints().map(e => e.id).sort(), Object.entries(served.paths).filter(([p]) => p.startsWith('/v2/')).flatMap(([, item]: [string, any]) => Object.values(item).map((op: any) => op.operationId)).sort());
  });
});

test('R01-B05: schedule.revision.submit in the served document — operationId, UUID path parameters, Idempotency-Key, body envelope, success 200 and the error set', () => {
  const e = endpointById('schedule.revision.submit')!;
  const op = servedOp(e);
  assert.equal(op.operationId, 'schedule.revision.submit');
  const params = op.parameters.map((p: any) => `${p.in}:${p.name}:${p.required}:${p.schema.format}`);
  assert.deepEqual(params, ['path:objectId:true:uuid', 'path:id:true:uuid', 'header:Idempotency-Key:true:uuid']);
  assert.equal(op.requestBody.required, true);
  const body = bodySchemaOf(e);
  assert.deepEqual([...body.required].sort(), ['expectedScopeVersion', 'expectedVersion', 'payload']);
  assert.equal(body.additionalProperties, false);
  assert.deepEqual(body.properties.expectedVersion, { $ref: '#/components/schemas/VersionToken' });
  assert.deepEqual(body.properties.payload, { $ref: '#/components/schemas/ScheduleSubmitPayload' });
  assert.deepEqual(Object.keys(op.responses).sort(), ['200', '401', '403', '404', '409', '422', '501']);
  assert.equal(op.responses['201'], undefined, 'a command that is applied answers 200, not the POST default');
  assert.deepEqual(op.responses['200'].content['application/json'].schema, { $ref: '#/components/schemas/CommandResult' });
  assert.deepEqual(op['x-lifecycle-transitions'], [{ lifecycle: 'GPR_REVISION', command: 'submit', from: 'DRAFT', to: 'SUBMITTED', effect: null }]);
  assert.deepEqual(op['x-authorization'], { type: 'PERMISSION', permission: 'GPR2_SCHEDULE_AUTHOR' });
  assert.deepEqual(op.security, [{ bearerAuth: [] }]);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// (b) bidirectional conformance with the running server
// ---------------------------------------------------------------------------------------------------------------------------------

type Mutation = { label: string; mutate: (r: { body: Record<string, unknown>; headers: Record<string, string> }) => void };
const mutationsOf = (e: Gpr2Endpoint): Mutation[] => {
  const out: Mutation[] = [
    { label: 'unchanged', mutate: () => {} },
    { label: 'no payload', mutate: r => { delete r.body.payload; } },
    { label: 'payload is a string', mutate: r => { r.body.payload = 'x'; } },
    { label: 'payload is an array', mutate: r => { r.body.payload = []; } },
    { label: 'payload is null', mutate: r => { r.body.payload = null; } },
    { label: 'unknown top-level field', mutate: r => { r.body.surprise = 1; } },
    { label: 'unused scope token', mutate: r => { if (!e.scopeFence) r.body.expectedScopeVersion = '1'; else r.body.surprise2 = '1'; } }
  ];
  if (e.aggregateVersion) out.push(
    { label: 'no expectedVersion', mutate: r => { delete r.body.expectedVersion; } },
    { label: 'expectedVersion as number', mutate: r => { r.body.expectedVersion = 1; } },
    { label: 'expectedVersion with leading zero', mutate: r => { r.body.expectedVersion = '01'; } },
    { label: 'expectedVersion of 19 digits', mutate: r => { r.body.expectedVersion = '9'.repeat(19); } },
    { label: 'expectedVersion of 18 digits', mutate: r => { r.body.expectedVersion = '9'.repeat(18); } },
    { label: 'expectedVersion zero', mutate: r => { r.body.expectedVersion = '0'; } });
  else out.push({ label: 'unused aggregate token', mutate: r => { r.body.expectedVersion = '1'; } });
  if (e.scopeFence) out.push(
    { label: 'no expectedScopeVersion', mutate: r => { delete r.body.expectedScopeVersion; } },
    { label: 'expectedScopeVersion negative', mutate: r => { r.body.expectedScopeVersion = '-1'; } },
    { label: 'expectedScopeVersion decimal', mutate: r => { r.body.expectedScopeVersion = '1.0'; } });
  return out;
};

test('R01-B05: for every mounted command, a request body is accepted by the served schema EXACTLY when the live route accepts it — 30 commands × the same mutation set', async () => {
  let compared = 0, accepted = 0, refused = 0;
  for (const e of REACHABLE()) {
    const schema = bodySchemaOf(e);
    for (const m of mutationsOf(e)) {
      const params = ownedParams(trusted, e, owner);
      const req = validRequest(e, params); m.mutate(req);
      const docAccepts = accepts(schema, req.body, served);
      const r = await g.call(await g.roleToken(ROLE[e.id] ?? PM), req.method, req.path, { body: req.body, headers: req.headers });
      assert.ok(r.status === 200 || r.status === 422, `${e.id} / ${m.label}: unexpected ${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(r.status === 200, docAccepts, `${e.id} / ${m.label}: the document says ${docAccepts ? 'valid' : 'invalid'}, the server answered ${r.status} ${JSON.stringify(r.body?.details ?? r.body).slice(0, 160)}`);
      compared++; if (docAccepts) accepted++; else refused++;
    }
  }
  assert.ok(compared > 300 && accepted >= 30 && refused > 200, `${compared} compared, ${accepted} accepted, ${refused} refused`);
});

test('R01-B05: the Idempotency-Key header — required exactly where the document says, uuid-formatted, and a pure preview may omit it but not send a bad one', async () => {
  for (const e of REACHABLE()) {
    const param = servedOp(e).parameters.find((p: any) => p.name === 'Idempotency-Key');
    assert.ok(param, e.id);
    assert.equal(param.required, e.idempotent, e.id);
    assert.equal(param.in, 'header');
    for (const [label, value] of [['absent', undefined], ['empty', ''], ['not a uuid', 'abc'], ['uuid', KEY(9)], ['upper-case uuid', KEY(9).toUpperCase()]] as const) {
      const params = ownedParams(trusted, e, owner), req = validRequest(e, params);
      delete req.headers['Idempotency-Key'];
      if (value !== undefined) req.headers['Idempotency-Key'] = value;
      const docAccepts = value === undefined ? !param.required : validate(param.schema, value, served).length === 0; // an EMPTY header is a value, and not a uuid (R01-B05-R2)
      const r = await g.call(await g.roleToken(ROLE[e.id] ?? PM), req.method, req.path, { body: req.body, headers: req.headers });
      assert.equal(r.status === 200, docAccepts, `${e.id} / header ${label}: ${r.status}`);
    }
  }
});

test('R01-B05: path parameters are UUIDs in the document and in the router — a non-UUID id or objectId is the scope-safe 404, a UUID in any letter case is accepted', async () => {
  for (const e of REACHABLE().filter(x => x.resource)) {
    const params = ownedParams(trusted, e, owner);
    const upper = { ...params, id: params.id.toUpperCase(), ...(params.objectId ? { objectId: params.objectId.toUpperCase() } : {}) };
    assert.equal((await call(e, ROLE[e.id] ?? PM, upper, validRequest(e, upper).body, validRequest(e, upper).headers)).status, 200, e.id + ' upper-case ids');
    const bad = { ...params, id: 'not-a-uuid' };
    assert.equal((await call(e, ROLE[e.id] ?? PM, bad, validRequest(e, bad).body, validRequest(e, bad).headers)).status, 404, e.id + ' malformed id');
  }
  for (const e of mountedEndpoints()) for (const p of servedOp(e).parameters.filter((x: any) => x.in === 'path')) assert.deepEqual(p.schema, { type: 'string', format: 'uuid' }, `${e.id} ${p.name}`);
});

test('R01-B05: the typed payloads — document and parser agree on a corpus of valid and invalid values (dates, decimals, edges, omissions, fences, reasons)', async () => {
  const W = uuid(), V = (n: number) => `0000000${n}-0000-4000-8000-000000000000`.slice(-36);
  const entry = (over: Record<string, unknown> = {}) => ({ workId: W, startDate: '2026-03-01', endDate: '2026-03-20', ...over });
  const edge = (over: Record<string, unknown> = {}) => ({ predecessorWorkId: V(1), successorWorkId: V(2), type: 'FS', lagKind: 'WORKING_DAYS', lagValue: '0', ...over });
  const fenceOf = (over: Record<string, unknown> = {}) => ({ inputFingerprint: 'a'.repeat(64), expectedSourceVersions: { calendar: V(3) }, ...over });
  const cases: [string, string, unknown][] = [];
  const add = (id: string, label: string, ...payloads: unknown[]) => payloads.forEach((p, i) => cases.push([id, `${label} #${i}`, p]));
  const preview = 'schedule.changes.preview';
  add(preview, 'entries ok', { entries: [entry()] }, { entries: [entry({ startDate: '2024-02-29', endDate: '2024-02-29' })] }, { entries: [entry({ sortOrder: 0, sectionNodeId: null })] }, { entries: [entry({ sectionNodeId: V(4) })] }, {}, { entries: [] });
  add(preview, 'dates bad', ...['2026-13-01', '2026-00-10', '2026-01-32', '9999-99-99', '2026-02-31', '2025-02-29', '0000-01-01', '2026-1-1', '2026-03-01T00:00:00Z', ' 2026-03-01', ''].map(d => ({ entries: [entry({ startDate: d })] })));
  add(preview, 'entry shape bad', { entries: [entry({ executionUnitId: V(5) })] }, { entries: [{ workId: W, startDate: '2026-03-01' }] }, { entries: [entry({ sortOrder: -1 })] }, { entries: [entry({ sortOrder: 1.5 })] }, { entries: [entry({ workId: 'x' })] }, { entries: 'x' });
  add(preview, 'edges', { edges: [edge()] }, { edges: [edge({ type: 'SS' })] }, { edges: [edge({ type: 'FF', lagKind: 'ELAPSED_HOURS', lagValue: '48.5' })] }, { edges: [edge({ lagValue: '0.123456789012' })] },
    { edges: [edge({ type: 'SF' })] }, { edges: [edge({ type: 'XX' })] }, { edges: [edge({ lagValue: 48 })] }, { edges: [edge({ lagValue: '-1' })] }, { edges: [edge({ lagValue: '-0' })] }, { edges: [edge({ lagValue: '1.0000000000001' })] },
    { edges: [edge({ lagValue: '1e3' })] }, { edges: [edge({ lagKind: 'CALENDAR_DAYS' })] }, { edges: [edge({ reason: '  why ' })] }, { edges: [edge({ reason: '   ' })] }); // (a Work depending on itself is a CROSS-FIELD rule: see the next test)
  add(preview, 'omissions', { omissions: [{ workId: W, inclusion: 'INCLUDED' }] }, { omissions: [{ workId: W, inclusion: 'EXCLUDED', omissionReason: 'нет задания' }] }, { omissions: [{ workId: W, inclusion: 'EXCLUDED' }] },
    { omissions: [{ workId: W, inclusion: 'EXCLUDED', omissionReason: '   ' }] }, { omissions: [{ workId: W, inclusion: 'EXCLUDED', omissionReason: null }] }, { omissions: [{ workId: W, inclusion: 'MAYBE' }] },
    { omissions: [{ workId: W, inclusion: 'INCLUDED', omissionReason: '   ' }] });
  add('schedule.changes.apply', 'apply', { previewFingerprint: 'a'.repeat(64) }, { previewFingerprint: 'A'.repeat(64) }, { previewFingerprint: 'a'.repeat(63) }, {}, { previewFingerprint: 'a'.repeat(64), entries: [entry()] });
  add('schedule.revision.submit', 'submit', { changeReason: 'готово' }, { changeReason: '  ' }, { changeReason: '' }, { changeReason: 'x'.repeat(2000) }, { changeReason: 'x'.repeat(2001) }, { changeReason: ' ' + 'x'.repeat(2000) }, {}, { changeReason: 'ok', extra: 1 });
  for (const id of ['schedule.revision.return', 'quantity.request.return', 'work-type.publication.reject']) add(id, 'reason', { reason: 'нужна доработка' }, { reason: '\n\t' }, { reason: '' }, { reason: 5 }, {}, { reason: 'x'.repeat(2001) });
  add('schedule.revision.approve', 'schedule approve', fenceOf(), fenceOf({ comment: 'ok' }), fenceOf({ comment: '  ' }), fenceOf({ surprise: 1 }), { inputFingerprint: 'a'.repeat(64) }, { expectedSourceVersions: { calendar: V(3) } }, fenceOf({ expectedSourceVersions: {} }), fenceOf({ expectedSourceVersions: { calendar: 'x' } }), fenceOf({ expectedSourceVersions: { '<x>': V(3) } }), fenceOf({ inputFingerprint: 'z'.repeat(64) }), {});
  for (const id of ['quantity.request.approve', 'imports.boq.commit', 'imports.estimate-labor.commit']) add(id, 'fence', fenceOf(), fenceOf({ rows: [{ a: 1 }], note: 'x' }), fenceOf({ rate: 1.5 }), fenceOf({ rate: '1.5' }), fenceOf({ big: 1e21 }), fenceOf({ nested: { deep: [1, 2, { ok: null }] } }), { inputFingerprint: 'a'.repeat(64) }, fenceOf({ expectedSourceVersions: {} }), {});
  add('finish-change.record-correction', 'correction', { reason: 'исправление' }, { reason: '   ' }, {}, { reason: 'ok', correctedOutcome: { code: 'X' } }, { reason: 'ok', amount: 0.5 }, { correctedOutcome: {} });
  add('quantity.request.create', 'open', {}, { newQuantity: '1.5' }, { newQuantity: 1.5 }, { count: 3 }, { n: 1e21 }, { a: [1, 'x', null, true, { b: [] }] }, { a: [0.1] }, { a: { b: { c: 2.5 } } });
  add('work-type.publication.approve', 'alias', {}, { aliasOfWorkTypeId: V(6) }, { aliasOfWorkTypeId: 'x' }, { other: 1 });

  const roleFor = (id: string) => ROLE[id] ?? PM;
  let compared = 0, agreeAccept = 0, agreeRefuse = 0;
  for (const [id, label, payload] of cases) {
    const e = endpointById(id)!;
    const params = ownedParams(trusted, e, owner), req = validRequest(e, params);
    req.body.payload = payload;
    const docAccepts = accepts(bodySchemaOf(e), req.body, served);
    // domain parser
    let parserAccepts = true;
    try { parseCommand(e, Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v])), req.body); } catch (err) { assert.ok(err instanceof Gpr2Error, label); parserAccepts = false; }
    // live HTTP
    const r = await g.call(await g.roleToken(roleFor(id)), req.method, req.path, { body: req.body, headers: req.headers });
    assert.ok(r.status === 200 || r.status === 422, `${id} / ${label}: ${r.status}`);
    assert.equal(parserAccepts, docAccepts, `${id} / ${label}: parser ${parserAccepts} vs document ${docAccepts} for ${JSON.stringify(payload).slice(0, 100)}`);
    assert.equal(r.status === 200, docAccepts, `${id} / ${label}: HTTP ${r.status} vs document ${docAccepts}`);
    compared++; docAccepts ? agreeAccept++ : agreeRefuse++;
  }
  assert.ok(compared >= 130 && agreeAccept >= 40 && agreeRefuse >= 85, `${compared} compared (${agreeAccept} valid, ${agreeRefuse} invalid)`);
});

test('R01-B05: every status the live routes produce is documented, every documented status is produced, and each body matches its documented schema', async () => {
  const stale = (e: Gpr2Endpoint) => async () => { throw new Gpr2Error(e.scopeFence && !e.aggregateVersion ? 'SCOPE_VERSION_CHANGED' : 'STALE_VERSION', { token: e.scopeFence && !e.aggregateVersion ? 'expectedScopeVersion' : 'expectedVersion' }); };
  const { DISABLED_HOOKS } = await import('../apps/backend/src/gpr2-command-guard');
  const observed = new Map<string, Set<string>>(), note = (e: Gpr2Endpoint, status: number) => { (observed.get(e.id) ?? observed.set(e.id, new Set()).get(e.id)!).add(String(status)); };
  const check = (e: Gpr2Endpoint, r: { status: number; body: any }, expectedStatus: number) => {
    assert.equal(r.status, expectedStatus, `${e.id}: ${JSON.stringify(r.body)}`);
    note(e, r.status);
    const doc = servedOp(e).responses[String(r.status)];
    assert.ok(doc, `${e.id}: status ${r.status} is documented`);
    const schema = doc.content?.['application/json']?.schema;
    if (schema) assert.deepEqual(validate(schema, r.body, served), [], `${e.id} ${r.status} body`);
  };
  for (const e of REACHABLE()) {
    const role = ROLE[e.id] ?? PM;
    const fresh = () => { const params = ownedParams(trusted, e, owner), req = validRequest(e, params); return { params, req }; };
    const go = (x: { req: ReturnType<typeof validRequest> }, token: string | null) => g.call(token, x.req.method, x.req.path, { body: x.req.body, headers: x.req.headers });
    // 200 — applied (recording hooks)
    { const rec = recordingHooks(trusted); const u = await installHooks(g.h.app, rec.hooks); try { check(e, await go(fresh(), await g.roleToken(role)), 200); } finally { u(); } }
    // 409 — the stage reports a stale token
    { const rec = recordingHooks(trusted, null, { execute: stale(e) }); const u = await installHooks(g.h.app, rec.hooks); try { check(e, await go(fresh(), await g.roleToken(role)), 409); } finally { u(); } }
    // 501 — the production gate, with only the resolver trusted
    { const u = await installHooks(g.h.app, { ...DISABLED_HOOKS, resources: trusted }); try { check(e, await go(fresh(), await g.roleToken(role)), 501); } finally { u(); } }
    // 401, 403, 404, 422
    const u = await installHooks(g.h.app, recordingHooks(trusted).hooks);
    try {
      check(e, await go(fresh(), null), 401);
      check(e, await go(fresh(), await g.roleToken('CONTRACTOR_VIEWER')), 403);
      if (e.scope === 'OBJECT') { const missing = { ...fresh().params, objectId: uuid() }; check(e, await go({ req: validRequest(e, missing) }, await g.roleToken(role)), 404); }
      { const x = fresh(); delete x.req.body.payload; check(e, await go(x, await g.roleToken(role)), 422); }
    } finally { u(); }
  }
  // documented ⊆ observed (the tenant-level routes have no object to be missing: their 404 comes from the unknown aggregate)
  const tenantLevel = REACHABLE().filter(e => e.scope === 'TENANT');
  for (const e of tenantLevel) {
    const u = await installHooks(g.h.app, recordingHooks(trusted).hooks);
    try { const req = validRequest(e, { id: uuid() }); check(e, await g.call(await g.roleToken(ROLE[e.id]), req.method, req.path, { body: req.body, headers: req.headers }), 404); } finally { u(); }
  }
  for (const e of REACHABLE()) assert.deepEqual([...observed.get(e.id)!].sort(), Object.keys(servedOp(e).responses).sort(), `${e.id}: documented statuses = observed statuses`);
});

test('R01-B05: signed decimals — the document\'s pattern and the parser agree on negative zero over HTTP (SIGNED profiles reject -0, -0.0000; unsigned profiles reject any sign)', async () => {
  const pattern = (name: string) => new RegExp(served.components.schemas[name].pattern);
  for (const [text, signedOk, unsignedOk] of [['0', true, true], ['0.0000', true, true], ['-0', false, false], ['-0.0', false, false], ['-0.0000', false, false], ['-0.0001', true, false], ['-1', true, false], ['1', true, true], ['-00', false, false], ['--1', false, false]] as const) {
    assert.equal(pattern('DecimalSignedQuantity').test(text), signedOk, 'signed ' + text);
    assert.equal(pattern('DecimalQuantity').test(text), unsignedOk, 'unsigned ' + text);
  }
  // the one signed/unsigned decimal the open API accepts today is the edge lag (NORMATIVE, unsigned): over HTTP "-0" and "-1" are refused like the pattern says
  const e = endpointById('schedule.changes.preview')!;
  for (const lag of ['0', '1.5', '-0', '-1', '-0.5']) {
    const params = ownedParams(trusted, e, owner), req = validRequest(e, params);
    req.body.payload = { edges: [{ predecessorWorkId: uuid(), successorWorkId: uuid(), type: 'FS', lagKind: 'WORKING_DAYS', lagValue: lag }] };
    const r = await g.call(await g.roleToken(PM), req.method, req.path, { body: req.body, headers: req.headers });
    assert.equal(r.status === 200, pattern('DecimalNormative').test(lag), `lag ${lag}: ${r.status}`);
  }
});

test('R01-B05: the rules JSON Schema cannot state (one field compared with another) are declared in x-cross-field-rules and enforced by the live route with exactly that rule and path', async () => {
  const schemas = served.components.schemas;
  assert.deepEqual(schemas.GprEntryInput['x-cross-field-rules'], [{ rule: 'OUT_OF_RANGE', path: 'endDate', requires: 'startDate <= endDate' }]);
  assert.deepEqual(schemas.GprEdgeInput['x-cross-field-rules'], [{ rule: 'OUT_OF_RANGE', path: 'successorWorkId', requires: 'predecessorWorkId != successorWorkId' }]);
  const e = endpointById('schedule.changes.preview')!;
  const run = async (payload: unknown) => { const req = validRequest(e, ownedParams(trusted, e, owner)); req.body.payload = payload; return g.call(await g.roleToken(PM), req.method, req.path, { body: req.body, headers: req.headers }); };
  const W = uuid();
  const reversed = await run({ entries: [{ workId: W, startDate: '2026-03-20', endDate: '2026-03-01' }] });
  assert.deepEqual([reversed.status, reversed.body.details.violations], [422, [{ path: 'payload.entries.0.endDate', rule: 'OUT_OF_RANGE' }]]);
  const loop = await run({ edges: [{ predecessorWorkId: W, successorWorkId: W, type: 'FS', lagKind: 'WORKING_DAYS', lagValue: '0' }] });
  assert.deepEqual([loop.status, loop.body.details.violations], [422, [{ path: 'payload.edges.0.successorWorkId', rule: 'OUT_OF_RANGE' }]]);
  // the document alone would accept both — which is exactly why the rule is announced beside the schema
  const doc = served.paths['/v2' + e.path].post.requestBody.content['application/json'].schema;
  assert.equal(accepts(doc, { expectedVersion: '1', payload: { entries: [{ workId: W, startDate: '2026-03-20', endDate: '2026-03-01' }] } }, served), true);
  assert.equal((await run({ entries: [{ workId: W, startDate: '2026-03-20', endDate: '2026-03-20' }] })).status, 200, 'start = end is fine');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Final B05 corrective: R1 (SourceVersions / __proto__) and R2 (optional Idempotency-Key)
// ---------------------------------------------------------------------------------------------------------------------------------

const rules = (b: any) => (b?.details?.violations ?? []).map((v: any) => `${v.path}:${v.rule}`).sort();
const rawBody = async (role: string, e: Gpr2Endpoint, params: Record<string, string>, text: string, headers?: Record<string, string>) => {
  const req = validRequest(e, params);
  const r = await fetch(g.h.base + req.path, { method: req.method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await g.roleToken(role), ...(headers ?? req.headers) }, body: text });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
};

test('R01-B05-R1: SourceVersions refuses a real JSON own key "__proto__" in the document AND on the server (JSON text, not a JS object literal)', async () => {
  const names = served.components.schemas.SourceVersions.propertyNames;
  assert.deepEqual(names, { allOf: [{ pattern: '^[A-Za-z0-9_.-]{1,64}$' }, { not: { const: '__proto__' } }], }, 'the published schema names the prohibition');
  const fp = 'a'.repeat(64), src = uuid();
  // JSON.parse creates an OWN property called __proto__; an object literal { __proto__: x } would only set the prototype and prove nothing
  const real = JSON.parse(`{"__proto__":"${src}"}`);
  assert.equal(Object.prototype.hasOwnProperty.call(real, '__proto__'), true, 'the fixture really carries an own __proto__ key');
  const literal: any = { __proto__: src as any };
  assert.equal(Object.keys(literal).length, 0, 'while the literal form has no such key — it is not a valid probe');
  const schema = { $ref: '#/components/schemas/SourceVersions' };
  assert.deepEqual(validate(schema, real, served).map(m => m.replace(/<name .*>/, '<name>')), ['$.<name>: matches a forbidden schema'], 'the document refuses it');
  assert.equal(accepts(schema, { calendar: src, 'proto': src, constructor: src, '__proto': src }, served), true, 'near-misses stay valid in the document…');
  for (const id of ['quantity.request.approve', 'imports.boq.commit', 'imports.estimate-labor.commit', 'schedule.revision.approve']) {
    const e = endpointById(id)!, role = ROLE[id] ?? PM;
    const prefix = JSON.stringify({ ...(e.aggregateVersion ? { expectedVersion: '1' } : {}), ...(e.scopeFence ? { expectedScopeVersion: '1' } : {}) }).slice(1, -1);
    const body = (sources: string) => `{${prefix}${prefix ? ',' : ''}"payload":{"inputFingerprint":"${fp}","expectedSourceVersions":${sources}}}`;
    // the whole request body agrees with the document, and the server answers with the controlled rule
    const bad = await rawBody(role, e, ownedParams(trusted, e, owner), body(`{"__proto__":"${src}"}`));
    assert.deepEqual([bad.status, bad.body.code, rules(bad.body)], [422, 'VALIDATION_FAILED', ['payload.expectedSourceVersions.*:FIELD_NOT_ALLOWED']], id);
    assert.equal(accepts(bodySchemaOf(e), JSON.parse(body(`{"__proto__":"${src}"}`)), served), false, id + ': document rejects the same body');
    // …and on the server too
    const good = await rawBody(role, e, ownedParams(trusted, e, owner), body(`{"proto":"${src}","constructor":"${src}"}`));
    assert.equal(good.status, 200, id + ' ' + JSON.stringify(good.body));
    assert.equal(accepts(bodySchemaOf(e), JSON.parse(body(`{"proto":"${src}","constructor":"${src}"}`)), served), true, id + ': document accepts it');
    // the protection is not weakened: a __proto__ next to a valid source is refused, and nothing is polluted
    const mixed = await rawBody(role, e, ownedParams(trusted, e, owner), body(`{"calendar":"${src}","__proto__":"${src}"}`));
    assert.deepEqual([mixed.status, rules(mixed.body)], [422, ['payload.expectedSourceVersions.*:FIELD_NOT_ALLOWED']], id);
  }
  assert.equal(({} as any).calendar, undefined, 'Object.prototype was not polluted');
});

test('R01-B05-R2: an optional Idempotency-Key — absent is fine, a uuid is fine, an EMPTY or malformed one is 422 IDEMPOTENCY_KEY_MALFORMED; the document says the same', async () => {
  const optional = mountedEndpoints().filter(e => !e.idempotent && e.kind === 'COMMAND');
  assert.deepEqual(optional.map(e => e.id).sort(), ['finish-system.preview', 'schedule.backplan.preview', 'schedule.changes.preview']);
  for (const e of optional) {
    const param = servedOp(e).parameters.find((p: any) => p.name === 'Idempotency-Key');
    assert.equal(param.required, false, e.id);
    assert.deepEqual(param.schema, { type: 'string', format: 'uuid' });
    assert.match(param.description, /empty value is IDEMPOTENCY_KEY_MALFORMED/, 'the document states the rule');
    const cases: [string, string | undefined, number, string | null][] = [
      ['absent', undefined, 200, null], ['valid uuid', KEY(7), 200, null], ['valid upper-case uuid', KEY(7).toUpperCase(), 200, null],
      ['EMPTY', '', 422, 'IDEMPOTENCY_KEY_MALFORMED'], ['not a uuid', 'abc', 422, 'IDEMPOTENCY_KEY_MALFORMED'], ['uuid plus a character', KEY(7) + 'x', 422, 'IDEMPOTENCY_KEY_MALFORMED'],
      ['two keys', KEY(7) + ', ' + KEY(8), 422, 'IDEMPOTENCY_KEY_MALFORMED']
    ];
    for (const [label, value, status, rule] of cases) {
      const req = validRequest(e, ownedParams(trusted, e, owner));
      delete req.headers['Idempotency-Key'];
      if (value !== undefined) req.headers['Idempotency-Key'] = value;
      const docAccepts = value === undefined ? true : validate(param.schema, value, served).length === 0;
      const r = await g.call(await g.roleToken(ROLE[e.id] ?? PM), req.method, req.path, { body: req.body, headers: req.headers });
      assert.equal(r.status, status, `${e.id} / ${label}: ${JSON.stringify(r.body)}`);
      assert.equal(docAccepts, status === 200, `${e.id} / ${label}: document vs server`);
      if (rule) assert.deepEqual(r.body.details.violations, [{ path: 'Idempotency-Key', rule }], `${e.id} / ${label}`);
    }
  }
  // the required key keeps its rule: absent or empty is "required", a non-uuid is "malformed"
  const required = endpointById('schedule.revision.submit')!;
  for (const [value, rule] of [[undefined, 'IDEMPOTENCY_KEY_REQUIRED'], ['', 'IDEMPOTENCY_KEY_REQUIRED'], ['abc', 'IDEMPOTENCY_KEY_MALFORMED']] as const) {
    const req = validRequest(required, ownedParams(trusted, required, owner));
    delete req.headers['Idempotency-Key'];
    if (value !== undefined) req.headers['Idempotency-Key'] = value;
    const r = await g.call(await g.roleToken(PM), req.method, req.path, { body: req.body, headers: req.headers });
    assert.deepEqual([r.status, r.body.details.violations], [422, [{ path: 'Idempotency-Key', rule }]], JSON.stringify(value));
  }
});
