import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAggregateVersion, parseScopeVersion, parseRevisionSequence, parseSourceVersionId, assertAggregateVersion, assertScopeVersion, nextVersion, formatVersion,
  canonicalJson, commandFingerprint, isInputFingerprint, GPR2_ERROR_STATUS, GPR2_ERROR_CODES, GPR2_ERROR_PRODUCER, GPR2_VALIDATION_RULES, Gpr2Error, sanitizeDetails,
  scopeSafeNotFound, permissionDenied, validationFailed, type AggregateVersion, type ScopeVersion, type SourceVersionId
} from '../packages/domain/gpr2';

/**
 * GPR-2 R01 — version tokens, command fingerprint and the error contract (TD §5.4, §8.1, §11.1, §12.2, §12.4; D16/D17, C11/C16).
 * Pure domain. Pins: tokens are canonical decimal-integer strings (a JSON number is refused), the four "versions" of the design are distinct,
 * staleness is a 409 with its own code, the fingerprint is order-independent but payload/version-sensitive, and an error says nothing about WHY
 * a resource is unreachable.
 */
const ok = (r: any) => (r.ok === true ? r.value : 'ERR:' + r.rule);

test('version tokens: canonical decimal-integer strings only — no numbers, no sign, no leading zeros, bigint-safe width', () => {
  for (const parse of [parseAggregateVersion, parseScopeVersion]) {
    assert.equal(ok(parse('0')), '0');
    assert.equal(ok(parse('1')), '1');
    assert.equal(ok(parse('123456789012345678')), '123456789012345678', '18 digits always fit a bigint');
    for (const n of [1, 0, 3.0, 12n, null, undefined, true, {}, []]) assert.equal(ok(parse(n)), 'ERR:VERSION_TOKEN_NOT_A_STRING', String(typeof n));
    for (const s of ['', '01', '-1', '+1', '1.0', '1e3', ' 1', '1 ', '1234567890123456789', '0x1', 'v1', '٣']) assert.equal(ok(parse(s)), 'ERR:VERSION_TOKEN_MALFORMED', JSON.stringify(s));
  }
});

test('the design has four different "versions"; each is its own type and has its own validator', () => {
  assert.equal(ok(parseRevisionSequence(1)), 1);
  assert.equal(ok(parseRevisionSequence(7)), 7);
  for (const bad of [0, -1, 1.5, '1', null, Number.MAX_SAFE_INTEGER + 1, NaN]) assert.equal(ok(parseRevisionSequence(bad)), 'ERR:OUT_OF_RANGE', String(bad));
  // TD §5.4: "revision number is not an optimistic version" — a sequence is a number, a version is a string, neither parses as the other
  assert.equal(ok(parseAggregateVersion(3)), 'ERR:VERSION_TOKEN_NOT_A_STRING');
  assert.equal(ok(parseRevisionSequence('3')), 'ERR:OUT_OF_RANGE');
  assert.equal(ok(parseSourceVersionId('2D9F6B0A-1C3E-4F5A-8B7D-0123456789AB')), '2d9f6b0a-1c3e-4f5a-8b7d-0123456789ab', 'a source version id is a lower-cased uuid');
  assert.equal(ok(parseSourceVersionId('not-a-uuid')), 'ERR:ID_MALFORMED');
  assert.equal(ok(parseSourceVersionId(5)), 'ERR:FIELD_TYPE');
});

test('C16/D16: stale aggregate version → 409 STALE_VERSION; changed scope → 409 SCOPE_VERSION_CHANGED; the two are never confused and values are not leaked', () => {
  const v = (s: string) => s as AggregateVersion, sc = (s: string) => s as ScopeVersion;
  assert.doesNotThrow(() => assertAggregateVersion(v('3'), 3));
  assert.doesNotThrow(() => assertAggregateVersion(v('3'), '3'), 'int4 (number) and int8 (string) database values both compare as BigInt');
  assert.doesNotThrow(() => assertScopeVersion(sc('12'), 12n));
  try { assertAggregateVersion(v('3'), 4); assert.fail('stale'); }
  catch (e: any) {
    assert.equal(e.code, 'STALE_VERSION'); assert.equal(e.status, 409);
    assert.deepEqual(e.details, { token: 'expectedVersion' });
    assert.deepEqual(Object.keys(e.toBody().details), ['token'], 'only WHICH token was stale — neither the expected nor the actual value is echoed');
  }
  try { assertScopeVersion(sc('12'), 13); assert.fail('scope'); }
  catch (e: any) { assert.equal(e.code, 'SCOPE_VERSION_CHANGED'); assert.equal(e.status, 409); assert.deepEqual(e.details, { token: 'expectedScopeVersion' }); }
  assert.equal(nextVersion(v('9')), '10');
  assert.equal(nextVersion(v('123456789012345678')), '123456789012345679', 'incrementing never goes through floating point');
  assert.equal(formatVersion(7), '7');
});

test('canonicalJson: key order and whitespace cannot matter; what has no stable text is refused', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, 2, 1], c: 'x' } }), '{"a":{"c":"x","d":[3,2,1]},"b":1}');
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
  assert.equal(canonicalJson([{ b: 1, a: 2 }]), '[{"a":2,"b":1}]', 'array order is meaningful and kept');
  for (const bad of [undefined, () => 1, Symbol('x'), 10n, NaN, Infinity, 1.5, new Date(), new Map(), { a: undefined }]) assert.throws(() => canonicalJson(bad as any), TypeError, String(bad));
  assert.equal(canonicalJson({ amount: '1000.0000' }), '{"amount":"1000.0000"}', 'a decimal is a string — a number with a fraction is refused');
});

test('A10/§12.4: the command fingerprint is stable under reordering and changes with the payload, either token, the source versions or the command', () => {
  const U1 = '11111111-1111-4111-8111-111111111111' as SourceVersionId, U2 = '22222222-2222-4222-8222-222222222222' as SourceVersionId;
  const base = { commandKind: 'schedule.revision.approve', payload: { comment: 'ok', x: { b: 1, a: 2 } }, expectedVersion: '3' as AggregateVersion, expectedScopeVersion: '12' as ScopeVersion, sourceVersions: { calendar: U1 } };
  const f = commandFingerprint(base);
  assert.ok(isInputFingerprint(f), 'sha256 hex');
  assert.equal(f.length, 64);
  assert.equal(commandFingerprint({ ...base, payload: { x: { a: 2, b: 1 }, comment: 'ok' } }), f, 'key order is irrelevant');
  assert.notEqual(commandFingerprint({ ...base, payload: { ...base.payload, comment: 'ok!' } }), f, 'payload');
  assert.notEqual(commandFingerprint({ ...base, expectedVersion: '4' as AggregateVersion }), f, 'expectedVersion');
  assert.notEqual(commandFingerprint({ ...base, expectedScopeVersion: '13' as ScopeVersion }), f, 'expectedScopeVersion');
  assert.notEqual(commandFingerprint({ ...base, expectedVersion: null }), f, 'null token ≠ a token');
  assert.notEqual(commandFingerprint({ ...base, sourceVersions: { calendar: U2 } }), f, 'source version');
  assert.notEqual(commandFingerprint({ ...base, commandKind: 'schedule.revision.return' }), f, 'command kind');
  // decimals are compared as the canonical strings the schemas produce: "1000" and "1000.0000" are different TEXT, so callers fingerprint parsed payloads
  assert.notEqual(commandFingerprint({ ...base, payload: { q: '1000' } }), commandFingerprint({ ...base, payload: { q: '1000.0000' } }));
  assert.equal(isInputFingerprint('A'.repeat(64)), false, 'lower-case hex only');
  assert.equal(isInputFingerprint('a'.repeat(63)), false);
});

test('error contract: the status table is the §11.1 list (403/404/409/422/413/415) plus the single 501, and every code has a producer stage', () => {
  assert.deepEqual(GPR2_ERROR_STATUS, {
    PERMISSION_DENIED: 403, RESOURCE_NOT_FOUND: 404, STALE_VERSION: 409, SCOPE_VERSION_CHANGED: 409, IDEMPOTENCY_PAYLOAD_MISMATCH: 409,
    VALIDATION_FAILED: 422, INVALID_TRANSITION: 422, REASON_REQUIRED: 422, SEPARATION_OF_DUTIES: 422, BELOW_PROTECTED_QUANTITY: 422, UNSUPPORTED_DEPENDENCY_TYPE: 422,
    PAYLOAD_TOO_LARGE: 413, UNSUPPORTED_MEDIA_TYPE: 415, COMMAND_NOT_ENABLED: 501
  });
  assert.deepEqual(Object.keys(GPR2_ERROR_PRODUCER).sort(), [...GPR2_ERROR_CODES].sort(), 'no code without a producer, no producer without a code');
  assert.deepEqual(new Set(Object.values(GPR2_ERROR_STATUS)), new Set([403, 404, 409, 422, 413, 415, 501]));
  // 409 is for concurrency and idempotency ONLY; a rule violation is 422
  assert.deepEqual(GPR2_ERROR_CODES.filter(c => GPR2_ERROR_STATUS[c] === 409).sort(), ['IDEMPOTENCY_PAYLOAD_MISMATCH', 'SCOPE_VERSION_CHANGED', 'STALE_VERSION']);
  for (const code of GPR2_ERROR_CODES) { const e = new Gpr2Error(code); assert.equal(e.status, GPR2_ERROR_STATUS[code]); assert.ok(e.message.length > 0); assert.equal(e.toBody().code, code); }
});

test('scope-safe errors: "missing", "other tenant", "other object", "malformed id" are the SAME answer; 403 never reveals an object either', () => {
  const a = scopeSafeNotFound().toBody(), b = scopeSafeNotFound().toBody();
  assert.deepEqual(a, b);
  assert.deepEqual(a, { statusCode: 404, code: 'RESOURCE_NOT_FOUND', message: 'Запись не найдена' });
  assert.deepEqual(permissionDenied().toBody(), { statusCode: 403, code: 'PERMISSION_DENIED', message: 'Недостаточно прав для этого действия' });
  assert.equal(Object.prototype.hasOwnProperty.call(a, 'details'), false);
  // a message is chosen by code: nothing a caller (or a service) passes in can become part of it
  const hostile = new Gpr2Error('RESOURCE_NOT_FOUND', { message: 'object 7f..9 of tenant ACME', objectId: '7f9', evidence: { secret: 1 }, violations: 'x', from: 'a b', machine: '<script>' });
  assert.deepEqual(hostile.toBody(), a, 'unknown or malformed detail keys are dropped');
});

test('error details: an allowlist of closed rule codes and short identifiers — never values, never free text', () => {
  const noisy = sanitizeDetails({
    violations: [{ path: 'payload.qty', rule: 'DECIMAL_MALFORMED', value: '1e3' }, { path: 'p', rule: 'NOT_A_RULE' }, { path: 5, rule: 'FIELD_REQUIRED' }, null],
    machine: 'GPR_REVISION', from: 'DRAFT', command: 'approve', token: 'expectedVersion', secret: 'x'
  });
  assert.deepEqual(noisy, { violations: [{ path: 'payload.qty', rule: 'DECIMAL_MALFORMED' }], machine: 'GPR_REVISION', from: 'DRAFT', command: 'approve', token: 'expectedVersion' });
  assert.equal(sanitizeDetails({ token: 'somethingElse' }), undefined);
  assert.equal(sanitizeDetails('string'), undefined);
  assert.equal(sanitizeDetails(null), undefined);
  assert.equal(sanitizeDetails({ machine: 'has spaces and \n newline' }), undefined);
  assert.deepEqual(sanitizeDetails({ violations: [{ path: 'a.b-c_d.*', rule: 'FIELD_TYPE' }, { path: 'x<script>', rule: 'FIELD_TYPE' }, { path: 'q'.repeat(300), rule: 'FIELD_TYPE' }] }),
    { violations: [{ path: 'a.b-c_d.*', rule: 'FIELD_TYPE' }, { path: '*', rule: 'FIELD_TYPE' }, { path: '*', rule: 'FIELD_TYPE' }] }, 'a path names a field with identifier characters only');
  const many = sanitizeDetails({ violations: Array.from({ length: 500 }, (_, i) => ({ path: 'p' + i, rule: 'FIELD_TYPE' })) })!;
  assert.equal(many.violations!.length, 50, 'bounded');
  assert.ok(GPR2_VALIDATION_RULES.length >= 19);
  assert.equal(validationFailed([{ path: 'a', rule: 'FIELD_REQUIRED' }]).status, 422);
});
