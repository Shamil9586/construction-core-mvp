/**
 * GPR-2 R01 — the OpenAPI 3.1 description of the command surface (Technical Design §11.2: "OpenAPI schemas, allowed transitions and error codes must
 * become a verifiable contract of R01").
 *
 * It is DERIVED, not written by hand: every path, method, parameter, header, token field and response comes from the endpoint register, the error table
 * and the same grammars the runtime parsers use, so the document cannot say something the code does not enforce — a test compares the patterns below
 * with the parsers over a corpus. Payloads the design leaves to the implementing stage are described as an open object that names the owning stage
 * (`x-owner-stage`); the ones the design fixes carry their full JSON Schema.
 *
 * Paths are those of the application (`/v2/...`); the public URL adds the `/api` prefix the reverse proxy strips (`servers`).
 */
import { GPR2_ENDPOINTS, Gpr2Endpoint, pathParamsOf } from './endpoints';
import { LIFECYCLES } from './lifecycle';
import { DecimalProfile, NORMATIVE, QUANTITY, SIGNED_QUANTITY } from './decimal';
import { GPR2_ERROR_CODES, GPR2_ERROR_STATUS, GPR2_VALIDATION_RULES } from './errors';
import { EDGE_TYPES, LAG_KINDS, REASON_LIMIT, SOURCE_NAME } from './schemas';
import { MAX_OPEN_DEPTH } from './open-value';

/**
 * The grammar parseDecimal() accepts, exactly. A signed profile starts with a lookahead that refuses `-0`, `-0.0` … : a negative zero is well formed
 * text but not a value the contract admits (DECIMAL_NEGATIVE_ZERO), so the document must not advertise it (R01-B05).
 */
export const decimalPattern = (p: DecimalProfile) => `^${p.signed ? '(?!-0(\\.0+)?$)-?' : ''}(0|[1-9][0-9]{0,${p.integerDigits - 1}})(\\.[0-9]{1,${p.scale}})?$`;
export const VERSION_TOKEN_PATTERN = '^(0|[1-9][0-9]{0,17})$';
export const FINGERPRINT_PATTERN = '^[0-9a-f]{64}$';

// The application's own prefix; the reverse proxy adds /api in front of it (API_V2_PREFIX in endpoints.ts is the public form).
const APP_PREFIX = '/v2';

type Json = Record<string, unknown>;
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const obj = (properties: Json, required: string[] = []): Json => ({ type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) });
const uuid: Json = { type: 'string', format: 'uuid' };
/**
 * Real text once trimmed: at least one non-space character and at most REASON_LIMIT characters AFTER trimming, which is what reasonText enforces.
 * (`maxLength` would count the untrimmed string, so the bound lives in the pattern. Like the parser it counts UTF-16 code units; a consumer that
 * matches by code point is, for astral characters, at most more lenient than the server.)
 */
export const REASON_PATTERN = `^\\s*\\S(?:[\\s\\S]{0,${REASON_LIMIT - 2}}\\S)?\\s*$`;
const reason: Json = { type: 'string', pattern: REASON_PATTERN, description: 'Real text; trimmed; blank is REASON_REQUIRED.' };

export const SCHEMAS: Record<string, Json> = {
  VersionToken: { type: 'string', pattern: VERSION_TOKEN_PATTERN, description: 'A canonical decimal-integer string (never a JSON number): an optimistic version or a scope version.' },
  InputFingerprint: { type: 'string', pattern: FINGERPRINT_PATTERN },
  DecimalQuantity: { type: 'string', pattern: decimalPattern(QUANTITY), description: 'numeric(24,4) as a string; input is never rounded.' },
  DecimalSignedQuantity: { type: 'string', pattern: decimalPattern(SIGNED_QUANTITY) },
  DecimalNormative: { type: 'string', pattern: decimalPattern(NORMATIVE), description: 'numeric(30,12) as a string.' },
  // A calendar day: RFC 3339 full-date, year 0001–9999 (the parser refuses year 0000 and every impossible date — 2026-02-31, 2026-13-01).
  CivilDate: { type: 'string', format: 'date', pattern: '^(?!0000-)[0-9]{4}-[0-9]{2}-[0-9]{2}$' },
  // R01-B03: what an OPEN payload may contain — exactly what canonicalJson can serialise. A fraction is a decimal and must be a string; the nesting bound
  // (MAX_OPEN_DEPTH levels) is enforced by the parser and cannot be expressed in JSON Schema.
  OpenValue: {
    description: `Plain JSON: null, boolean, string, a safe integer, or an array / object of those, at most ${MAX_OPEN_DEPTH} levels deep. A number with a fraction is refused (DECIMAL_NOT_A_STRING): decimals are strings.`,
    oneOf: [{ type: 'null' }, { type: 'boolean' }, { type: 'string' }, { type: 'integer', minimum: -9007199254740991, maximum: 9007199254740991 },
      { type: 'array', items: { $ref: '#/components/schemas/OpenValue' } }, { type: 'object', propertyNames: { not: { const: '__proto__' } }, additionalProperties: { $ref: '#/components/schemas/OpenValue' } }]
  },
  OpenObject: { type: 'object', propertyNames: { not: { const: '__proto__' } }, additionalProperties: ref('OpenValue') },
  // R01-B03: the common fence of an approve / commit (TD §11.1) — at least ONE named immutable source version.
  SourceVersions: { type: 'object', minProperties: 1, propertyNames: { allOf: [{ pattern: SOURCE_NAME.source }, { not: { const: '__proto__' } }] }, additionalProperties: uuid, description: 'Named immutable source versions the input was built from; the names belong to the owning stage.' },
  ErrorCode: { type: 'string', enum: [...GPR2_ERROR_CODES] },
  ValidationRule: { type: 'string', enum: [...GPR2_VALIDATION_RULES] },
  ErrorBody: obj({
    statusCode: { type: 'integer' }, code: ref('ErrorCode'), message: { type: 'string' }, requestId: { type: 'string' },
    details: obj({
      violations: { type: 'array', maxItems: 50, items: obj({ path: { type: 'string', pattern: '^[A-Za-z0-9_.*-]{0,200}$' }, rule: ref('ValidationRule') }, ['path', 'rule']) },
      machine: { type: 'string' }, from: { type: 'string' }, command: { type: 'string' }, token: { type: 'string', enum: ['expectedVersion', 'expectedScopeVersion'] }
    })
  }, ['statusCode', 'message']),
  CommandResult: obj({
    commandId: uuid, resultIds: { type: 'array', items: uuid },
    appliedVersions: obj({ aggregate: { oneOf: [ref('VersionToken'), { type: 'null' }] }, scope: { oneOf: [ref('VersionToken'), { type: 'null' }] } }, ['aggregate', 'scope']),
    warnings: { type: 'array', items: obj({ code: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{1,63}$' }, path: { type: 'string', maxLength: 200 } }, ['code']) }
  }, ['commandId', 'resultIds', 'appliedVersions', 'warnings']),
  ReasonPayload: obj({ reason }, ['reason']),
  ScheduleSubmitPayload: obj({ changeReason: reason }, ['changeReason']),
  ScheduleApprovePayload: obj({ inputFingerprint: ref('InputFingerprint'), expectedSourceVersions: ref('SourceVersions'), comment: reason }, ['inputFingerprint', 'expectedSourceVersions']),
  // R01-B03: the fence is typed; every other property is a deferred extension of the owning stage (x-owner-stage), accepted only as safe JSON.
  ApprovalPayload: {
    type: 'object', required: ['inputFingerprint', 'expectedSourceVersions'], additionalProperties: ref('OpenValue'), propertyNames: { not: { const: '__proto__' } },
    properties: { inputFingerprint: ref('InputFingerprint'), expectedSourceVersions: ref('SourceVersions'), comment: reason }
  },
  CommitPayload: {
    type: 'object', required: ['inputFingerprint', 'expectedSourceVersions'], additionalProperties: ref('OpenValue'), propertyNames: { not: { const: '__proto__' } },
    properties: { inputFingerprint: ref('InputFingerprint'), expectedSourceVersions: ref('SourceVersions') }
  },
  CorrectionPayload: {
    type: 'object', required: ['reason'], additionalProperties: ref('OpenValue'), propertyNames: { not: { const: '__proto__' } },
    properties: { reason }
  },
  WorkTypeApprovePayload: obj({ aliasOfWorkTypeId: uuid }),
  // D01: one entry per Work — there is deliberately no execution-unit, WEU or portion property, and additionalProperties is false.
  // JSON Schema cannot compare two properties, so the cross-field rules of the parser are stated in `x-cross-field-rules` (rule = the violation code returned).
  GprEntryInput: {
    ...obj({ workId: uuid, startDate: ref('CivilDate'), endDate: ref('CivilDate'), sectionNodeId: { oneOf: [uuid, { type: 'null' }] }, sortOrder: { type: 'integer', minimum: 0 } }, ['workId', 'startDate', 'endDate']),
    'x-cross-field-rules': [{ rule: 'OUT_OF_RANGE', path: 'endDate', requires: 'startDate <= endDate' }]
  },
  // D08: FS / SS / FF only. SF is refused with its own error code (UNSUPPORTED_DEPENDENCY_TYPE).
  GprEdgeInput: {
    ...obj({
      predecessorWorkId: uuid, successorWorkId: uuid, type: { type: 'string', enum: [...EDGE_TYPES] }, lagKind: { type: 'string', enum: [...LAG_KINDS] },
      lagValue: ref('DecimalNormative'), reason
    }, ['predecessorWorkId', 'successorWorkId', 'type', 'lagKind', 'lagValue']),
    'x-cross-field-rules': [{ rule: 'OUT_OF_RANGE', path: 'successorWorkId', requires: 'predecessorWorkId != successorWorkId' }]
  },
  // D16: every Work is included or excluded; an exclusion always has its reason.
  GprOmissionInput: {
    ...obj({ workId: uuid, inclusion: { type: 'string', enum: ['INCLUDED', 'EXCLUDED'] }, omissionReason: { type: ['string', 'null'], pattern: `^\\s*(?:\\S(?:[\\s\\S]{0,${REASON_LIMIT - 2}}\\S)?)?\\s*$` } }, ['workId', 'inclusion']),
    if: { properties: { inclusion: { const: 'EXCLUDED' } }, required: ['inclusion'] }, then: { required: ['omissionReason'], properties: { omissionReason: { type: 'string', pattern: REASON_PATTERN } } }
  },
  GprChangeSet: obj({
    entries: { type: 'array', items: ref('GprEntryInput') }, edges: { type: 'array', items: ref('GprEdgeInput') },
    omissions: { type: 'array', items: ref('GprOmissionInput') }, calendarVersionId: uuid
  }),
  GprChangeApply: obj({
    entries: { type: 'array', items: ref('GprEntryInput') }, edges: { type: 'array', items: ref('GprEdgeInput') },
    omissions: { type: 'array', items: ref('GprOmissionInput') }, calendarVersionId: uuid, previewFingerprint: ref('InputFingerprint')
  }, ['previewFingerprint'])
};

const PAYLOAD_SCHEMA: Record<string, string> = {
  'quantity.request.return': 'ReasonPayload', 'schedule.revision.return': 'ReasonPayload', 'work-type.publication.reject': 'ReasonPayload',
  'work-type.publication.approve': 'WorkTypeApprovePayload', 'schedule.revision.submit': 'ScheduleSubmitPayload', 'schedule.revision.approve': 'ScheduleApprovePayload',
  'schedule.changes.preview': 'GprChangeSet', 'schedule.changes.apply': 'GprChangeApply',
  'quantity.request.approve': 'ApprovalPayload', 'imports.boq.commit': 'CommitPayload', 'imports.estimate-labor.commit': 'CommitPayload',
  'finish-change.record-correction': 'CorrectionPayload'
};

/** Payload schemas whose typed part is a fence and whose remaining properties are the owning stage's (deferred extensions). */
const LOOSE_PAYLOADS = new Set(['ApprovalPayload', 'CommitPayload', 'CorrectionPayload']);

const errorResponse = (description: string) => ({ description, content: { 'application/json': { schema: ref('ErrorBody') } } });

/** The lifecycle rows an endpoint performs, as the document states them: which state each applies in, where it leads and what it does to history. */
function lifecycleRows(e: Gpr2Endpoint): Json[] {
  return (e.transitions ?? []).map(x => {
    const row = LIFECYCLES.find(l => l.name === x.lifecycle)?.transitions.find(r => r.command === x.command && r.endpoint === e.id);
    return { lifecycle: x.lifecycle, command: x.command, from: row?.from ?? null, to: row?.to ?? null, effect: row?.effect ?? null };
  });
}

function operation(e: Gpr2Endpoint): Json {
  const parameters: Json[] = pathParamsOf(e).map(name => ({ name, in: 'path', required: true, schema: uuid }));
  if (e.idempotent)
    parameters.push({ name: 'Idempotency-Key', in: 'header', required: true, schema: uuid, description: 'Scoped by tenant, actor, command kind and aggregate; a repeat of the same command returns the same result.' });
  else if (e.kind === 'COMMAND')
    parameters.push({ name: 'Idempotency-Key', in: 'header', required: false, schema: uuid, description: 'A pure preview needs none (absent is fine); one that is sent must still be a well formed uuid — an empty value is IDEMPOTENCY_KEY_MALFORMED (422).' });
  const authorization = e.authorization.type === 'EXISTING_RULES' ? { type: 'EXISTING_RULES' } : e.authorization;
  const op: Json = {
    operationId: e.id, tags: [e.stage], security: [{ bearerAuth: [] }], parameters,
    'x-stage': e.stage, 'x-mounted': e.mounted, 'x-scope': e.scope, 'x-authorization': authorization, 'x-pure': e.pure,
    ...(e.transitions ? { 'x-lifecycle-transitions': lifecycleRows(e) } : {}), ...(e.routeFixedByTd ? {} : { 'x-route-proposed': true }),
    responses: {} as Json
  };
  const responses = op.responses as Json;
  if (e.kind === 'COMMAND') {
    const properties: Json = {}, required: string[] = ['payload'];
    if (e.aggregateVersion) { properties.expectedVersion = ref('VersionToken'); required.push('expectedVersion'); }
    if (e.scopeFence) { properties.expectedScopeVersion = ref('VersionToken'); required.push('expectedScopeVersion'); }
    properties.payload = PAYLOAD_SCHEMA[e.id]
      ? (LOOSE_PAYLOADS.has(PAYLOAD_SCHEMA[e.id]) ? { allOf: [ref(PAYLOAD_SCHEMA[e.id])], 'x-owner-stage': e.stage } : ref(PAYLOAD_SCHEMA[e.id]))
      : { allOf: [ref('OpenObject')], description: 'Open object: its fields belong to the stage that implements the command; R01 only requires plain JSON (OpenValue).', 'x-owner-stage': e.stage };
    op.requestBody = { required: true, content: { 'application/json': { schema: obj(properties, required) } } };
    responses['200'] = { description: 'Applied (or the stored result of a repeat).', content: { 'application/json': { schema: ref('CommandResult') } } };
  } else responses['200'] = { description: 'The projection; its shape is owned by the stage that implements it.', content: { 'application/json': { schema: { type: 'object', 'x-owner-stage': e.stage } } } };
  responses['401'] = { description: 'Not authenticated (the authentication layer\'s own body).' };
  responses['403'] = errorResponse('The caller\'s current role does not hold the permission (decided before scope).');
  // A route with neither an object nor an aggregate in its path (R05 finish-template.draft) addresses nothing that could be missing: it never answers 404.
  if (pathParamsOf(e).length)
    responses['404'] = errorResponse('The resource is missing, malformed, another tenant\'s or out of the caller\'s scope — one and the same answer.');
  if (e.kind === 'COMMAND') {
    if (e.aggregateVersion || e.scopeFence || e.idempotent) responses['409'] = errorResponse('STALE_VERSION, SCOPE_VERSION_CHANGED or IDEMPOTENCY_PAYLOAD_MISMATCH.');
    responses['422'] = errorResponse('VALIDATION_FAILED and the rule codes of the lifecycle / the stage.');
    if (e.mounted) responses['501'] = errorResponse('COMMAND_NOT_ENABLED — R01 ships the contract only; the owning stage replaces the gate.');
  }
  return op;
}

export interface BuildOptions {
  /** Only the routes the application actually mounts (what `/api-docs-json` serves); the default is the whole §11.2 catalogue, flagged by `x-mounted`. */
  mountedOnly?: boolean;
}
export function buildGpr2OpenApi(options: BuildOptions = {}): Json {
  const paths: Record<string, Json> = {};
  for (const e of GPR2_ENDPOINTS) if (!options.mountedOnly || e.mounted) (paths[APP_PREFIX + e.path] ??= {})[e.method.toLowerCase()] = operation(e);
  return {
    openapi: '3.1.0',
    info: { title: 'Construction Core — GPR-2 command contract', version: 'r01', description: 'Derived from the endpoint register of packages/domain/gpr2. Contract only: no command has behaviour yet.' },
    servers: [{ url: '/api' }],
    paths,
    components: { schemas: SCHEMAS, securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
    'x-error-status': { ...GPR2_ERROR_STATUS }
  };
}

/**
 * The ONE authoritative contract (R01-B05). The application's own document (Nest's SwaggerModule) describes only decorators — no parameters, no body,
 * the POST default of 201 — so for every `/v2` route the served document takes the operation from the register-derived contract instead:
 * the served document and buildGpr2OpenApi({ mountedOnly: true }) cannot differ, and a test compares them operation by operation.
 *
 * Mutates and returns `served`. Throws when a derived schema name collides with a different schema already in the document (nothing is overwritten
 * silently). With nothing mounted (the flag is off) the caller does not call this, so a deployment without the flag serves exactly what it served.
 */
export function mountGpr2Contract(served: Json): Json {
  const derived = buildGpr2OpenApi({ mountedOnly: true }) as { paths: Record<string, Json>; components: { schemas: Json; securitySchemes: Json } };
  const paths = (served.paths ??= {}) as Record<string, Json>;
  for (const p of Object.keys(paths)) if (p === APP_PREFIX || p.startsWith(APP_PREFIX + '/')) delete paths[p];
  for (const [p, item] of Object.entries(derived.paths)) paths[p] = item;
  const components = (served.components ??= {}) as { schemas?: Json; securitySchemes?: Json };
  const schemas = (components.schemas ??= {}) as Json;
  for (const [name, schema] of Object.entries(derived.components.schemas)) {
    if (name in schemas && JSON.stringify(schemas[name]) !== JSON.stringify(schema)) throw new Error('GPR-2 OpenAPI: schema name ' + name + ' is already used by the application document');
    schemas[name] = schema;
  }
  const schemes = (components.securitySchemes ??= {}) as Json;
  for (const [name, scheme] of Object.entries(derived.components.securitySchemes)) schemes[name] ??= scheme;
  served['x-error-status'] = { ...GPR2_ERROR_STATUS };
  return served;
}
