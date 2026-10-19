import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGpr2OpenApi, SCHEMAS, decimalPattern, VERSION_TOKEN_PATTERN, FINGERPRINT_PATTERN, GPR2_ENDPOINTS, GPR2_ERROR_CODES, GPR2_ERROR_STATUS, GPR2_VALIDATION_RULES,
  QUANTITY, SIGNED_QUANTITY, NORMATIVE, parseDecimal, parseAggregateVersion, isInputFingerprint, gprEntryInput, gprEdgeInput, EDGE_TYPES, pathParamsOf, LIFECYCLES
} from '../packages/domain/gpr2';

/**
 * GPR-2 R01 — the OpenAPI description of the command surface (TD §11.2: "OpenAPI schemas, allowed transitions and error codes must become a
 * verifiable contract of R01"). The document is derived from the register; these tests check that it says what the code enforces.
 */
const doc: any = buildGpr2OpenApi();
const ops = () => Object.entries(doc.paths).flatMap(([path, item]: [string, any]) => Object.entries(item).map(([method, op]: [string, any]) => ({ path, method, op })));

test('the document is deterministic, serialisable OpenAPI 3.1 with one operation per register row — method, path and operationId all match', () => {
  assert.equal(doc.openapi, '3.1.0');
  assert.equal(JSON.stringify(buildGpr2OpenApi()), JSON.stringify(doc), 'deterministic');
  assert.deepEqual(JSON.parse(JSON.stringify(doc)), doc, 'plain JSON, nothing lost in serialisation');
  assert.equal(ops().length, GPR2_ENDPOINTS.length);
  for (const e of GPR2_ENDPOINTS) {
    const op = doc.paths['/v2' + e.path]?.[e.method.toLowerCase()];
    assert.ok(op, `${e.method} ${e.path}`);
    assert.equal(op.operationId, e.id);
    assert.equal(op['x-stage'], e.stage);
    assert.equal(op['x-mounted'], e.mounted);
    assert.deepEqual(op.parameters.filter((p: any) => p.in === 'path').map((p: any) => p.name), pathParamsOf(e), e.id + ' path parameters');
    assert.deepEqual(op.security, [{ bearerAuth: [] }]);
  }
  assert.deepEqual(doc.servers, [{ url: '/api' }]);
});

test('Idempotency-Key and the version tokens appear exactly where the register says — and a token the command does not use is not in its body', () => {
  for (const e of GPR2_ENDPOINTS) {
    const op = doc.paths['/v2' + e.path][e.method.toLowerCase()];
    const key = op.parameters.find((p: any) => p.name === 'Idempotency-Key');
    if (e.kind === 'QUERY') { assert.equal(key, undefined, e.id); assert.equal(op.requestBody, undefined, e.id); continue; }
    assert.ok(key, e.id + ' documents the header');
    assert.equal(key.required, e.idempotent, e.id + ': required iff idempotent (a pure preview needs none)');
    const body = op.requestBody.content['application/json'].schema;
    assert.equal(body.additionalProperties, false, e.id);
    assert.deepEqual(Object.keys(body.properties).sort(), ['payload', ...(e.aggregateVersion ? ['expectedVersion'] : []), ...(e.scopeFence ? ['expectedScopeVersion'] : [])].sort(), e.id);
    assert.deepEqual([...body.required].sort(), Object.keys(body.properties).sort(), e.id + ': every declared field is required');
  }
});

test('responses: 403 and 404 everywhere, 409 only where there is something to conflict with, 422 for every command, 501 exactly for the mounted gate — with one error body', () => {
  for (const e of GPR2_ENDPOINTS) {
    const codes = Object.keys(doc.paths['/v2' + e.path][e.method.toLowerCase()].responses).sort();
    const expected = e.kind === 'QUERY' ? ['200', '401', '403', '404']
      : ['200', '401', '403', '404', '422', ...(e.aggregateVersion || e.scopeFence || e.idempotent ? ['409'] : []), ...(e.mounted ? ['501'] : [])];
    assert.deepEqual(codes, expected.sort(), e.id);
  }
  assert.deepEqual(doc.components.schemas.ErrorCode.enum, [...GPR2_ERROR_CODES], 'the error body can only name a code of the catalogue');
  assert.deepEqual(doc['x-error-status'], GPR2_ERROR_STATUS);
  assert.deepEqual(doc.components.schemas.ValidationRule.enum, [...GPR2_VALIDATION_RULES]);
  const errorBody = doc.components.schemas.ErrorBody;
  assert.deepEqual(Object.keys(errorBody.properties.details.properties).sort(), ['command', 'from', 'machine', 'token', 'violations'], 'details is the same allowlist the runtime applies');
  assert.equal(errorBody.properties.details.additionalProperties, false);
});

test('D01/D08/D16/K03 in the document: no execution-unit property, no SF edge, an exclusion needs its reason, and no suitability path', () => {
  const entry = SCHEMAS.GprEntryInput as any;
  assert.equal(entry.additionalProperties, false);
  assert.deepEqual(Object.keys(entry.properties).sort(), ['endDate', 'sectionNodeId', 'sortOrder', 'startDate', 'workId']);
  assert.deepEqual(Object.keys(entry.properties).sort(), Object.keys(gprEntryInput.shape).sort(), 'the document and the runtime schema name the same fields');
  assert.deepEqual((SCHEMAS.GprEdgeInput as any).properties.type.enum, [...EDGE_TYPES]);
  assert.equal((SCHEMAS.GprEdgeInput as any).properties.type.enum.includes('SF'), false);
  assert.deepEqual(Object.keys((SCHEMAS.GprEdgeInput as any).properties).sort(), Object.keys(gprEdgeInput.shape).sort());
  const omission = SCHEMAS.GprOmissionInput as any;
  assert.deepEqual(omission.if, { properties: { inclusion: { const: 'EXCLUDED' } }, required: ['inclusion'] });
  assert.deepEqual(omission.then.required, ['omissionReason']);
  assert.equal(Object.keys(doc.paths).some(p => /suitab/i.test(p)), false);
  assert.equal(JSON.stringify(doc).includes('executionUnit'), false, 'the contract never mentions an execution unit');
  assert.deepEqual((SCHEMAS.GprChangeApply as any).required, ['previewFingerprint'], 'A10: an apply names its preview');
});

test('the patterns in the document are the grammars the parsers enforce — compared over a corpus of valid and invalid strings', () => {
  const corpus = ['0', '1', '10', '1000', '1000.5', '1000.5000', '0.0001', '0.00001', '00', '01', '-1', '-0', '-0.0001', '+1', '1e3', '1,5', '.5', '5.', '', ' 1', '1 ', 'abc',
    '99999999999999999999.9999', '100000000000000000000', '999999999999999999.999999999999', '1000000000000000000', '1.0000000000001', '123456789012345678', '1234567890123456789'];
  for (const [profile, schema] of [[QUANTITY, 'DecimalQuantity'], [SIGNED_QUANTITY, 'DecimalSignedQuantity'], [NORMATIVE, 'DecimalNormative']] as const) {
    const pattern = new RegExp((SCHEMAS[schema] as any).pattern);
    assert.equal((SCHEMAS[schema] as any).pattern, decimalPattern(profile));
    for (const s of corpus) {
      const parsed = parseDecimal(profile, s);
      // the pattern says "well formed for this profile"; the parser additionally refuses a signed zero ("-0..."), which a regex cannot express
      const accepted = parsed.ok === true || parsed.rule === 'DECIMAL_NEGATIVE_ZERO';
      assert.equal(pattern.test(s), accepted, `${schema} ${JSON.stringify(s)}`);
    }
  }
  const token = new RegExp(VERSION_TOKEN_PATTERN), fp = new RegExp(FINGERPRINT_PATTERN);
  for (const s of [...corpus, '123456789012345678', '9'.repeat(18), '9'.repeat(19), '12a']) assert.equal(token.test(s), parseAggregateVersion(s).ok, `token ${JSON.stringify(s)}`);
  for (const s of ['a'.repeat(64), 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), '0'.repeat(64), '']) assert.equal(fp.test(s), isInputFingerprint(s), `fingerprint ${JSON.stringify(s)}`);
  assert.equal(SCHEMAS.VersionToken.pattern, VERSION_TOKEN_PATTERN);
  assert.equal(SCHEMAS.InputFingerprint.pattern, FINGERPRINT_PATTERN);
});

test('every command that performs a lifecycle transition says so in the document, and the lifecycle row exists', () => {
  const rows = LIFECYCLES.flatMap(l => l.transitions.map(t => `${l.name}:${t.command}`));
  for (const { op } of ops()) if (op['x-lifecycle-transition']) assert.ok(rows.includes(`${op['x-lifecycle-transition'].lifecycle}:${op['x-lifecycle-transition'].command}`), op.operationId);
  assert.equal(ops().filter(o => o.op['x-lifecycle-transition']).length, GPR2_ENDPOINTS.filter(e => e.transition).length);
  const proposed = ops().filter(o => o.op['x-route-proposed']).map(o => o.op.operationId);
  assert.deepEqual(proposed, ['finish-template.publish'], 'the one route the design does not name is flagged as a proposal');
  assert.deepEqual(ops().filter(o => o.op['x-authorization'].type === 'CAPABILITY').map(o => o.op.operationId), ['imports.estimate-labor.mapping-reviews'], 'N01: one capability-only operation');
});
