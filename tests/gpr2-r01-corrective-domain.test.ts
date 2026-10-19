import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCivilDate, isCivilDate, daysInMonth, isLeapYear, gprEntryInput, gprChangeSet, parseCommand, endpointById, GPR2_ENDPOINTS, mountedEndpoints, pathParamsOf, canonicalJson, commandFingerprint,
  openValueViolations, openObjectViolations, MAX_OPEN_DEPTH, FINISH_CHANGE_RECORD, findTransition, resourceRefsOf, ownershipPermits, DENY_ALL_RESOURCES, GPR2_RESOURCE_KINDS,
  TENANT_LEVEL_RESOURCE_KINDS, LIFECYCLES, parseIdempotencyKey, Gpr2Error
} from '../packages/domain/gpr2';

/**
 * GPR-2 R01 corrective tests, domain level (findings R01-B01, R01-B03, R01-B04). Pure functions only — the same findings are proved over real
 * HTTP in gpr2-r01-corrective-http.test.ts.
 */
const KEY = '11111111-1111-4111-8111-111111111111';
const U = (n: number) => `0000000${n}-0000-4000-8000-000000000000`.slice(-36);
const FP = 'b'.repeat(64);
const ep = (id: string) => endpointById(id)!;
const must = (fn: () => unknown): Gpr2Error => { try { fn(); } catch (e: any) { assert.ok(e instanceof Gpr2Error, 'a contract error, not ' + String(e?.stack ?? e)); return e; } assert.fail('expected a contract error'); };
const violations = (fn: () => unknown) => { const e = must(fn); assert.equal(e.code, 'VALIDATION_FAILED'); assert.equal(e.status, 422); return e.details!.violations!.map(v => `${v.path}:${v.rule}`).sort(); };
const run = (id: string, payload: unknown, extra: Record<string, unknown> = {}) => {
  const e = ep(id);
  return parseCommand(e, e.idempotent ? { 'idempotency-key': KEY } : {}, { ...(e.aggregateVersion ? { expectedVersion: '1' } : {}), ...(e.scopeFence ? { expectedScopeVersion: '1' } : {}), payload, ...extra });
};

// ---------------------------------------------------------------------------------------------------------------------------------
// R01-B01 — a calendar date is checked by arithmetic; no input can throw
// ---------------------------------------------------------------------------------------------------------------------------------

test('R01-B01: the reviewer\'s five impossible dates are DATE_MALFORMED through safeParse — none throws', () => {
  for (const date of ['2026-13-01', '2026-00-10', '2026-01-32', '9999-99-99', '2026-02-31']) {
    for (const field of ['startDate', 'endDate'] as const) {
      const entry = { workId: U(1), startDate: '2026-03-01', endDate: '2026-03-20', [field]: date };
      let result: ReturnType<typeof gprEntryInput.safeParse> | undefined;
      assert.doesNotThrow(() => { result = gprEntryInput.safeParse(entry); }, `${field}=${date} must not throw`);
      assert.equal(result!.success, false, `${field}=${date}`);
      assert.deepEqual(result!.error!.issues.map(i => `${i.path.join('.')}:${i.message}`), [`${field}:DATE_MALFORMED`], `${field}=${date}`);
    }
    // and through the whole envelope: the controlled VALIDATION_FAILED (422) of the error catalogue, never an exception
    const e = must(() => run('schedule.changes.preview', { entries: [{ workId: U(1), startDate: date, endDate: '2026-12-31' }] }));
    assert.deepEqual([e.code, e.status], ['VALIDATION_FAILED', 422]);
    assert.deepEqual(e.details!.violations, [{ path: 'payload.entries.0.startDate', rule: 'DATE_MALFORMED' }]);
    assert.equal(JSON.stringify(e.toBody()).includes(date), false, 'the offending value is not echoed');
  }
});

test('R01-B01: calendar arithmetic — month lengths, leap years (400/100/4 rule), no rollover; verified against an independent Date oracle over whole year ranges', () => {
  assert.deepEqual([2024, 2000, 1600, 2400].map(isLeapYear), [true, true, true, true]);
  assert.deepEqual([2026, 1900, 2100, 1800, 2023].map(isLeapYear), [false, false, false, false, false]);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(m => daysInMonth(2026, m)), [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);
  assert.equal(daysInMonth(2024, 2), 29);
  // positive coverage is preserved
  for (const ok of ['2026-03-01', '2024-02-29', '2000-02-29', '9999-12-31', '0001-01-01', '2026-12-31', '2026-04-30']) assert.deepEqual(parseCivilDate(ok), { ok: true, value: ok }, ok);
  // negative: impossible dates are refused, never normalised into a neighbouring one
  for (const bad of ['2026-02-29', '1900-02-29', '2100-02-29', '2026-04-31', '2026-06-31', '2026-09-31', '2026-11-31', '2026-02-30', '0000-01-01', '0000-12-31', '2026-00-01', '2026-01-00'])
    assert.deepEqual(parseCivilDate(bad), { ok: false, rule: 'DATE_MALFORMED' }, bad);
  // the oracle: a UTC Date round trip (independent of civil-date.ts); the year is set explicitly so 0–99 is not mapped to 1900–1999
  const oracle = (y: number, m: number, d: number) => {
    const t = new Date(Date.UTC(2000, 0, 1)); t.setUTCFullYear(y, m - 1, d); t.setUTCHours(0, 0, 0, 0);
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  };
  const pad = (n: number, w: number) => String(n).padStart(w, '0');
  let checked = 0;
  for (const [from, to] of [[1, 410], [1890, 2110], [9990, 9999]])
    for (let y = from; y <= to; y++)
      for (let m = 0; m <= 13; m++)
        for (let d = 0; d <= 32; d++) {
          const text = `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
          assert.equal(parseCivilDate(text).ok, m >= 1 && m <= 12 && d >= 1 && oracle(y, m, d), text);
          checked++;
        }
  assert.ok(checked > 100000, 'a meaningful number of dates were compared: ' + checked);
});

test('R01-B01: malformed shapes and non-strings are DATE_MALFORMED (or FIELD_REQUIRED when absent) — no exception from any input type', () => {
  const shapes: unknown[] = ['', ' 2026-03-01', '2026-03-01 ', '2026-03-01\n', '2026-3-01', '2026-03-1', '26-03-01', '12026-03-01', '+2026-03-01', '-2026-03-01', '2026/03/01', '2026.03.01',
    '2026-03-01T00:00:00Z', '2026-03-01T00:00:00', '２０２６-03-01', '2026-0３-01', '٢٠٢٦-03-01', '2026-03-01\u0000', 'abc', 'Infinity', '20260301',
    20260301, 1, 0, NaN, Infinity, null, true, false, {}, [], ['2026-03-01'], { toString: () => '2026-03-01' }, Symbol('d'), () => '2026-03-01', 10n, new Date('2026-03-01')];
  for (const input of shapes) {
    let r: unknown;
    assert.doesNotThrow(() => { r = parseCivilDate(input); }, String(typeof input));
    assert.deepEqual(r, { ok: false, rule: 'DATE_MALFORMED' });
    assert.equal(isCivilDate(input), false);
    assert.doesNotThrow(() => gprEntryInput.safeParse({ workId: U(1), startDate: input, endDate: '2026-03-01' }));
  }
  assert.deepEqual(gprEntryInput.safeParse({ workId: U(1), endDate: '2026-03-01' }).error!.issues.map(i => `${i.path}:${i.message}`), ['startDate:FIELD_REQUIRED'], 'absent is required, not malformed');
  assert.equal(gprChangeSet.safeParse({ entries: [{ workId: U(1), startDate: '2026-02-28', endDate: '2026-03-01' }] }).success, true, 'a valid range is still accepted');
  assert.equal(gprEntryInput.safeParse({ workId: U(1), startDate: '2026-03-02', endDate: '2026-03-01' }).error!.issues[0].message, 'OUT_OF_RANGE', 'an ordered-range violation is its own rule, not a date error');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// R01-B03 — the mandatory common fence, the correction reason, and a payload that can never reach commandFingerprint unsafe
// ---------------------------------------------------------------------------------------------------------------------------------

const FENCED = ['quantity.request.approve', 'imports.boq.commit', 'imports.estimate-labor.commit', 'schedule.revision.approve'];

test('R01-B03: approve / commit without the common fence is VALIDATION_FAILED — {payload:{}} is never valid (TD §11.1)', () => {
  for (const id of FENCED) {
    assert.deepEqual(violations(() => run(id, {})), ['payload.expectedSourceVersions:FIELD_REQUIRED', 'payload.inputFingerprint:FIELD_REQUIRED'], id);
    assert.deepEqual(violations(() => run(id, { inputFingerprint: FP })), ['payload.expectedSourceVersions:FIELD_REQUIRED'], id);
    assert.deepEqual(violations(() => run(id, { expectedSourceVersions: { calendar: U(1) } })), ['payload.inputFingerprint:FIELD_REQUIRED'], id);
    // an empty map fences nothing: it is refused like a missing one
    assert.deepEqual(violations(() => run(id, { inputFingerprint: FP, expectedSourceVersions: {} })), ['payload.expectedSourceVersions:FIELD_REQUIRED'], id);
    assert.deepEqual(violations(() => run(id, { inputFingerprint: 'abc', expectedSourceVersions: { calendar: U(1) } })), ['payload.inputFingerprint:FIELD_TYPE'], id);
    assert.deepEqual(violations(() => run(id, { inputFingerprint: FP.toUpperCase(), expectedSourceVersions: { calendar: U(1) } })), ['payload.inputFingerprint:FIELD_TYPE'], id + ': lower-case hex only');
    assert.deepEqual(violations(() => run(id, { inputFingerprint: FP, expectedSourceVersions: { calendar: 'not-a-uuid' } })), ['payload.expectedSourceVersions.calendar:ID_MALFORMED'], id);
    assert.deepEqual(violations(() => run(id, { inputFingerprint: FP, expectedSourceVersions: { calendar: 5 } })), ['payload.expectedSourceVersions.calendar:FIELD_TYPE'], id);
    for (const notAMap of [[U(1)], 'x', 7, null, true]) assert.deepEqual(violations(() => run(id, { inputFingerprint: FP, expectedSourceVersions: notAMap })), ['payload.expectedSourceVersions:FIELD_TYPE'], id + ' ' + JSON.stringify(notAMap));
    // the envelope's own tokens are still required alongside it (version tokens "in addition")
    assert.ok(violations(() => parseCommand(ep(id), { 'idempotency-key': KEY }, { payload: { inputFingerprint: FP, expectedSourceVersions: { calendar: U(1) } } })).some(v => v.startsWith('expectedVersion:')), id);
  }
});

test('R01-B03: a well-formed fence passes; its ids are canonicalised; source names are safe; a hostile name is "*" and never echoed', () => {
  for (const id of FENCED) {
    const ok = run(id, { inputFingerprint: FP, expectedSourceVersions: { calendar: U(7).toUpperCase(), 'boq.v2': U(8) } });
    assert.deepEqual(ok.payload.expectedSourceVersions, { calendar: U(7), 'boq.v2': U(8) }, id);
    assert.equal(ok.payload.inputFingerprint, FP);
    const hostile = must(() => run(id, { inputFingerprint: FP, expectedSourceVersions: { '<script>alert(1)</script>': U(1) } }));
    assert.deepEqual(hostile.details!.violations, [{ path: 'payload.expectedSourceVersions.*', rule: 'FIELD_NOT_ALLOWED' }], id);
    assert.equal(JSON.stringify(hostile.toBody()).includes('script'), false, id);
    const proto = JSON.parse(`{"inputFingerprint":"${FP}","expectedSourceVersions":{"__proto__":"${U(1)}"}}`);
    assert.deepEqual(must(() => run(id, proto)).details!.violations, [{ path: 'payload.expectedSourceVersions.*', rule: 'FIELD_NOT_ALLOWED' }], id + ' __proto__');
  }
  // the fence also makes the fingerprint depend on the sources: another source version is another command (§12.4)
  const f = (v: string) => commandFingerprint({ commandKind: 'imports.boq.commit', payload: { inputFingerprint: FP }, expectedVersion: '1' as any, expectedScopeVersion: '1' as any, sourceVersions: { calendar: v as any } });
  assert.notEqual(f(U(1)), f(U(2)));
});

test('R01-B03: stage-owned fields beside the fence are DEFERRED EXTENSIONS — accepted as safe JSON on approve/commit, refused on the strict schedule approval', () => {
  const fence = { inputFingerprint: FP, expectedSourceVersions: { calendar: U(1) } };
  for (const id of ['quantity.request.approve', 'imports.boq.commit', 'imports.estimate-labor.commit']) {
    const ok = run(id, { ...fence, rows: [{ line: 1, label: 'x' }], parserOptions: { sheet: 'A' } });
    assert.deepEqual(ok.payload.rows, [{ line: 1, label: 'x' }], id);
    assert.deepEqual(violations(() => run(id, { ...fence, rate: 1.5 })), ['payload.rate:DECIMAL_NOT_A_STRING'], id + ': extensions are still safe JSON');
  }
  assert.equal(run('quantity.request.approve', { ...fence, comment: ' ok ' }).payload.comment, 'ok');
  assert.deepEqual(violations(() => run('quantity.request.approve', { ...fence, comment: '  ' })), ['payload.comment:REASON_REQUIRED']);
  assert.deepEqual(violations(() => run('schedule.revision.approve', { ...fence, surprise: 1 })), ['payload.surprise:FIELD_NOT_ALLOWED'], 'schedule approval stays a closed object');
});

test('R01-B03: finish-change.record-correction requires a reason, consistently with its lifecycle row (reasonRequired)', () => {
  const row = findTransition(FINISH_CHANGE_RECORD, 'EFFECTIVE', 'record-correction')!;
  assert.equal(row.reasonRequired, true);
  assert.equal(row.endpoint, 'finish-change.record-correction');
  for (const bad of [null, '', '   ', '\n', 5, {}, [], false, 'x'.repeat(2001)]) assert.deepEqual(violations(() => run('finish-change.record-correction', { reason: bad })), ['payload.reason:REASON_REQUIRED'], JSON.stringify(bad)?.slice(0, 12));
  assert.deepEqual(violations(() => run('finish-change.record-correction', {})), ['payload.reason:REASON_REQUIRED']);
  const ok = run('finish-change.record-correction', { reason: '  исправление внешнего решения  ', correctedOutcome: { code: 'X' } });
  assert.equal(ok.payload.reason, 'исправление внешнего решения', 'trimmed, like every reason');
  assert.deepEqual(ok.payload.correctedOutcome, { code: 'X' }, 'the corrected content is R09\'s: carried as a deferred extension');
  // the rule holds for every mounted endpoint that performs a reason-requiring lifecycle row: its payload demands a reason too
  const reasonEndpoints = new Set<string>();
  for (const l of LIFECYCLES) for (const r of l.transitions) if (r.reasonRequired && r.endpoint && endpointById(r.endpoint)?.mounted) reasonEndpoints.add(r.endpoint);
  assert.deepEqual([...reasonEndpoints].sort(), ['finish-change.record-correction', 'quantity.request.return', 'schedule.revision.return', 'work-type.publication.reject']);
  for (const id of reasonEndpoints) assert.ok(violations(() => run(id, {})).includes('payload.reason:REASON_REQUIRED'), id + ' demands a reason');
});

test('R01-B03: an open payload is plain JSON — the reviewer\'s newQuantity:1.5 is a 422 DECIMAL_NOT_A_STRING, not a TypeError out of canonicalJson', () => {
  // reproduce the defect first: this payload used to pass the envelope and then throw in the fingerprint
  assert.throws(() => canonicalJson({ newQuantity: 1.5 }), TypeError);
  assert.deepEqual(violations(() => run('quantity.request.create', { newQuantity: 1.5 })), ['payload.newQuantity:DECIMAL_NOT_A_STRING']);
  assert.equal(run('quantity.request.create', { newQuantity: '1.5' }).payload.newQuantity, '1.5', 'a decimal string is what the contract asks for');
  assert.equal(run('quantity.request.create', { count: 3, nested: { list: [1, 2, { ok: true, none: null, text: 'ü' }] } }).payload.count, 3, 'safe integers, booleans, null, strings, arrays, objects are fine');
  const bad: [unknown, string][] = [[1e21, 'OUT_OF_RANGE'], [Number.MAX_SAFE_INTEGER + 1, 'OUT_OF_RANGE'], [-(Number.MAX_SAFE_INTEGER + 1), 'OUT_OF_RANGE'], [Infinity, 'OUT_OF_RANGE'], [-Infinity, 'OUT_OF_RANGE'], [NaN, 'OUT_OF_RANGE'],
    [0.1, 'DECIMAL_NOT_A_STRING'], [-2.5, 'DECIMAL_NOT_A_STRING'], [undefined, 'FIELD_TYPE'], [10n, 'FIELD_TYPE'], [Symbol('s'), 'FIELD_TYPE'], [() => 1, 'FIELD_TYPE'],
    [new Date(0), 'FIELD_TYPE'], [new Map(), 'FIELD_TYPE'], [new (class Foo { a = 1 })(), 'FIELD_TYPE'], [Object.create(null), 'FIELD_TYPE']];
  for (const [value, rule] of bad) assert.deepEqual(violations(() => run('quantity.request.create', { field: value })), [`payload.field:${rule}`], typeof value + ' ' + Object.prototype.toString.call(value));
  assert.deepEqual(violations(() => run('quantity.request.create', { a: [1, { b: [0.5] }] })), ['payload.a.1.b.0:DECIMAL_NOT_A_STRING'], 'nested paths are reported');
  for (const top of [[], 'x', 5, true, null]) assert.deepEqual(violations(() => run('quantity.request.create', top)), ['payload:FIELD_TYPE'], JSON.stringify(top));
  assert.deepEqual(violations(() => run('quantity.request.create', JSON.parse('{"__proto__":{"x":1}}'))), ['payload.*:FIELD_NOT_ALLOWED']);
  assert.deepEqual(violations(() => parseCommand(ep('quantity.request.create'), { 'idempotency-key': KEY }, { expectedScopeVersion: '1' })), ['payload:FIELD_REQUIRED']);
  // values are never echoed
  const echoed = JSON.stringify(must(() => run('quantity.request.create', { 'SECRET key <x>': 1.234567, plain: 9.876543 })).toBody());
  assert.equal(echoed.includes('SECRET'), false, 'a hostile key is reported as "*"');
  assert.equal(echoed.includes('1.234567') || echoed.includes('9.876543'), false, 'no value is echoed');
  assert.ok(echoed.includes('payload.plain') && echoed.includes('payload.*'), 'a plain field name is reported, a hostile one is not');
});

test('R01-B03: the nesting bound — MAX_OPEN_DEPTH levels pass, one more is OUT_OF_RANGE, and a hostile 100 000-level body cannot exhaust the stack', () => {
  const nest = (levels: number) => { let v: unknown = 'leaf'; for (let i = 0; i < levels; i++) v = { a: v }; return v; };
  assert.deepEqual(openObjectViolations(nest(MAX_OPEN_DEPTH)), [], 'MAX_OPEN_DEPTH levels of containers are fine');
  assert.deepEqual(openObjectViolations(nest(MAX_OPEN_DEPTH + 1)).map(v => v.rule), ['OUT_OF_RANGE']);
  let arrays: unknown = [];
  for (let i = 0; i < 100000; i++) arrays = [arrays];
  let found: ReturnType<typeof openValueViolations> = [];
  assert.doesNotThrow(() => { found = openValueViolations(arrays); });
  assert.deepEqual(found.map(v => v.rule), ['OUT_OF_RANGE']);
  assert.deepEqual(violations(() => run('quantity.request.create', nest(MAX_OPEN_DEPTH + 5))), [`payload.${Array(MAX_OPEN_DEPTH).fill('a').join('.')}:OUT_OF_RANGE`]);
  // a cyclic structure cannot arrive over JSON, but a domain caller could hold one: it is bounded too
  const cyc: any = { a: 1 }; cyc.self = cyc;
  assert.deepEqual(openObjectViolations(cyc).map(v => v.rule), ['OUT_OF_RANGE']);
  // a body with thousands of defects reports a bounded list
  assert.ok(openValueViolations(Array.from({ length: 5000 }, () => 0.5)).length <= 50);
});

test('R01-B03: whatever the open-value validator accepts, canonicalJson / commandFingerprint serialise without throwing — and what it refuses, they could not (seeded fuzz)', () => {
  let seed = 20261019;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
  const leaves: unknown[] = [null, true, false, 0, -0, 1, -7, 42, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 0.5, -1.25, 1e21, 1e-7, NaN, Infinity, -Infinity, '', 'text', 'ü', '0.5', undefined, 5n, Symbol('x'), () => 0, new Date(0), new Map(), new Set(), /re/, new Uint8Array(2), Object.create(null), new (class K {})()];
  const gen = (depth: number): unknown => {
    const r = rnd();
    if (depth > 5 || r < 0.5) return pick(leaves);
    if (r < 0.75) return Array.from({ length: Math.floor(rnd() * 4) }, () => gen(depth + 1));
    const o: Record<string, unknown> = {};
    for (let i = 0, n = Math.floor(rnd() * 4); i < n; i++) o[pick(['a', 'b', 'c d', '<x>', 'ü', '0', 'constructor', 'toString', 'k'.repeat(80)])] = gen(depth + 1);
    return o;
  };
  let accepted = 0, refused = 0;
  for (let i = 0; i < 4000; i++) {
    const value = { payload: gen(0) } as Record<string, unknown>;
    const found = openObjectViolations(value);
    let serialised = true;
    try { canonicalJson(value); } catch { serialised = false; }
    if (found.length === 0) { assert.equal(serialised, true, 'accepted ⇒ canonicalisable'); assert.doesNotThrow(() => commandFingerprint({ commandKind: 'x', payload: value, expectedVersion: null, expectedScopeVersion: null, sourceVersions: {} })); accepted++; }
    else { assert.equal(serialised, false, 'refused ⇒ canonicalJson would have thrown (the validator is not stricter than needed): ' + JSON.stringify(found)); refused++; }
    // and the whole parser never lets anything but a Gpr2Error out
    try { run('quantity.request.create', value.payload); } catch (e) { assert.ok(e instanceof Gpr2Error); }
  }
  assert.ok(accepted > 300 && refused > 300, `both outcomes were exercised: ${accepted} accepted, ${refused} refused`);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// R01-B04 — the register declares the aggregate behind every {id}; the ownership rule is strict and fail-closed
// ---------------------------------------------------------------------------------------------------------------------------------

test('R01-B04: every {id} in the register names the kind of aggregate behind it — and only an {id} does; tenant-level kinds are exactly the tenant-level routes', () => {
  assert.ok(GPR2_ENDPOINTS.some(e => e.path.includes('{id}')));
  for (const e of GPR2_ENDPOINTS) {
    assert.equal(!!e.resource, e.path.includes('{id}'), e.id);
    if (e.resource) {
      assert.equal(e.resource.param, 'id');
      assert.ok((GPR2_RESOURCE_KINDS as readonly string[]).includes(e.resource.kind), e.id);
      assert.deepEqual(pathParamsOf(e).filter(n => n !== 'objectId'), ['id'], e.id + ': one nested resource per route');
      assert.equal(TENANT_LEVEL_RESOURCE_KINDS.includes(e.resource.kind), e.scope === 'TENANT', `${e.id}: a tenant-level kind is addressed by a tenant-level route and vice versa`);
    }
  }
  assert.deepEqual(GPR2_ENDPOINTS.filter(e => e.scope === 'TENANT').map(e => e.id).sort(), ['finish-template.publish', 'work-type.publication.approve', 'work-type.publication.reject']);
  assert.deepEqual(mountedEndpoints().filter(e => e.resource).length, 24, 'the mounted commands that address an existing aggregate');
  assert.equal(new Set(GPR2_ENDPOINTS.filter(e => e.resource).map(e => e.resource!.kind)).size, GPR2_RESOURCE_KINDS.length, 'no unused kind');
  assert.deepEqual(resourceRefsOf(ep('quantity.request.approve'), { objectId: U(1), id: U(2).toUpperCase() }), [{ kind: 'QUANTITY_CHANGE_REQUEST', id: U(2) }]);
  assert.deepEqual(resourceRefsOf(ep('work-type.publication.approve'), { id: U(3) }), [{ kind: 'WORK_TYPE_PUBLICATION_REQUEST', id: U(3) }]);
  assert.deepEqual(resourceRefsOf(ep('quantity.request.create'), { objectId: U(1) }), [], 'a creation addresses no existing aggregate');
});

test('R01-B04: ownershipPermits is strict — same tenant AND same object (or no object for a tenant-level route); anything doubtful is a refusal', async () => {
  const tenant = 't-1', route = { scope: 'OBJECT' as const, objectId: U(1) };
  assert.equal(ownershipPermits({ found: true, tenantId: tenant, objectId: U(1) }, { tenantId: tenant }, route), true);
  assert.equal(ownershipPermits({ found: true, tenantId: tenant, objectId: U(1).toUpperCase() }, { tenantId: tenant }, route), true, 'ids compare case-insensitively');
  const no = (answer: unknown, label: string) => assert.equal(ownershipPermits(answer, { tenantId: tenant }, route), false, label);
  no({ found: false }, 'missing');
  no({ found: true, tenantId: 't-2', objectId: U(1) }, 'another tenant');
  no({ found: true, tenantId: tenant, objectId: U(2) }, 'another object of the same tenant');
  no({ found: true, tenantId: tenant, objectId: null }, 'a tenant-level aggregate behind an object route');
  no({ found: true, tenantId: tenant }, 'no object in the answer');
  no({ found: true, objectId: U(1) }, 'no tenant in the answer');
  no({ found: true, tenantId: '', objectId: U(1) }, 'empty tenant');
  no({ found: 'yes', tenantId: tenant, objectId: U(1) }, 'found is not literally true');
  no({ found: 1, tenantId: tenant, objectId: U(1) }, 'found is not literally true (1)');
  no({ found: true, tenantId: 1, objectId: U(1) }, 'tenant of the wrong type');
  for (const junk of [null, undefined, true, 'ok', 5, [], {}]) no(junk, 'junk ' + JSON.stringify(junk));
  // tenant-level route: the aggregate must belong to the tenant and to NO object
  const tenantRoute = { scope: 'TENANT' as const, objectId: null };
  assert.equal(ownershipPermits({ found: true, tenantId: tenant, objectId: null }, { tenantId: tenant }, tenantRoute), true);
  assert.equal(ownershipPermits({ found: true, tenantId: 't-2', objectId: null }, { tenantId: tenant }, tenantRoute), false, 'another tenant\'s publication request');
  assert.equal(ownershipPermits({ found: true, tenantId: tenant, objectId: U(1) }, { tenantId: tenant }, tenantRoute), false, 'an object-owned aggregate behind a tenant route');
  assert.equal(ownershipPermits({ found: true, tenantId: tenant }, { tenantId: tenant }, tenantRoute), false, 'undefined objectId is not null');
  // the default knows nothing
  assert.deepEqual(await DENY_ALL_RESOURCES.resolve({ kind: 'QUANTITY_CHANGE_REQUEST', id: U(1) }), { found: false });
  assert.ok(Object.isFrozen(DENY_ALL_RESOURCES));
});

test('R01-B04: every id-bearing endpoint is refused by the default resolver — the safe default for aggregates whose persistence does not exist yet', async () => {
  let n = 0;
  for (const e of mountedEndpoints().filter(x => x.resource)) {
    const refs = resourceRefsOf(e, { objectId: U(1), id: U(2) });
    assert.equal(refs.length, 1, e.id);
    assert.equal(ownershipPermits(await DENY_ALL_RESOURCES.resolve(refs[0]), { tenantId: 't' }, { scope: e.scope, objectId: e.scope === 'OBJECT' ? U(1) : null }), false, e.id);
    n++;
  }
  assert.equal(n, 24);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// R01-B05-R2 — optional vs required Idempotency-Key, domain level
// ---------------------------------------------------------------------------------------------------------------------------------

test('R01-B05-R2: parseIdempotencyKey — absent is allowed where optional, an EMPTY header is malformed there, and the required key keeps REQUIRED for absent / empty', () => {
  assert.deepEqual(parseIdempotencyKey(undefined, false), { ok: true, value: null });
  assert.deepEqual(parseIdempotencyKey(null, false), { ok: true, value: null });
  assert.deepEqual(parseIdempotencyKey(KEY.toUpperCase(), false), { ok: true, value: KEY });
  for (const bad of ['', 'abc', KEY + 'x', ' ' + KEY, KEY + ', ' + KEY, 5, {}, []]) assert.deepEqual(parseIdempotencyKey(bad, false), { ok: false, rule: 'IDEMPOTENCY_KEY_MALFORMED' }, JSON.stringify(bad));
  assert.deepEqual(parseIdempotencyKey(undefined, true), { ok: false, rule: 'IDEMPOTENCY_KEY_REQUIRED' });
  assert.deepEqual(parseIdempotencyKey('', true), { ok: false, rule: 'IDEMPOTENCY_KEY_REQUIRED' });
  assert.deepEqual(parseIdempotencyKey('abc', true), { ok: false, rule: 'IDEMPOTENCY_KEY_MALFORMED' });
  // through the envelope of a pure preview
  const preview = ep('schedule.changes.preview');
  assert.deepEqual(parseCommand(preview, {}, { expectedVersion: '1', payload: {} }).idempotencyKey, null);
  assert.deepEqual(violations(() => parseCommand(preview, { 'idempotency-key': '' }, { expectedVersion: '1', payload: {} })), ['Idempotency-Key:IDEMPOTENCY_KEY_MALFORMED']);
});

test('R01-B05-R1: the server rule behind the published SourceVersions schema — a real JSON own key __proto__ is FIELD_NOT_ALLOWED at «*», and look-alike names stay valid', () => {
  const fence = (sources: string) => JSON.parse(`{"inputFingerprint":"${FP}","expectedSourceVersions":${sources}}`);
  assert.equal(Object.prototype.hasOwnProperty.call(fence(`{"__proto__":"${U(1)}"}`).expectedSourceVersions, '__proto__'), true);
  for (const id of FENCED) {
    assert.deepEqual(violations(() => run(id, fence(`{"__proto__":"${U(1)}"}`))), ['payload.expectedSourceVersions.*:FIELD_NOT_ALLOWED'], id);
    assert.deepEqual(violations(() => run(id, fence(`{"calendar":"${U(1)}","__proto__":"${U(2)}"}`))), ['payload.expectedSourceVersions.*:FIELD_NOT_ALLOWED'], id);
    assert.deepEqual(run(id, fence(`{"proto":"${U(1)}","__proto":"${U(2)}","constructor":"${U(3)}"}`)).payload.expectedSourceVersions, { proto: U(1), __proto: U(2), constructor: U(3) }, id);
  }
  assert.equal(({} as any).proto, undefined);
});
