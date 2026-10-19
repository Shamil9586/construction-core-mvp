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
import { DecimalProfile, NORMATIVE, QUANTITY, SIGNED_QUANTITY } from './decimal';
import { GPR2_ERROR_CODES, GPR2_ERROR_STATUS, GPR2_VALIDATION_RULES } from './errors';
import { EDGE_TYPES, LAG_KINDS, REASON_LIMIT } from './schemas';

export const decimalPattern = (p: DecimalProfile) => `^${p.signed ? '-?' : ''}(0|[1-9][0-9]{0,${p.integerDigits - 1}})(\\.[0-9]{1,${p.scale}})?$`;
export const VERSION_TOKEN_PATTERN = '^(0|[1-9][0-9]{0,17})$';
export const FINGERPRINT_PATTERN = '^[0-9a-f]{64}$';

// The application's own prefix; the reverse proxy adds /api in front of it (API_V2_PREFIX in endpoints.ts is the public form).
const APP_PREFIX = '/v2';

type Json = Record<string, unknown>;
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const obj = (properties: Json, required: string[] = []): Json => ({ type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) });
const uuid: Json = { type: 'string', format: 'uuid' };
const reason: Json = { type: 'string', minLength: 1, maxLength: REASON_LIMIT, description: 'Real text; trimmed; blank is REASON_REQUIRED.' };

export const SCHEMAS: Record<string, Json> = {
  VersionToken: { type: 'string', pattern: VERSION_TOKEN_PATTERN, description: 'A canonical decimal-integer string (never a JSON number): an optimistic version or a scope version.' },
  InputFingerprint: { type: 'string', pattern: FINGERPRINT_PATTERN },
  DecimalQuantity: { type: 'string', pattern: decimalPattern(QUANTITY), description: 'numeric(24,4) as a string; input is never rounded.' },
  DecimalSignedQuantity: { type: 'string', pattern: decimalPattern(SIGNED_QUANTITY) },
  DecimalNormative: { type: 'string', pattern: decimalPattern(NORMATIVE), description: 'numeric(30,12) as a string.' },
  CivilDate: { type: 'string', format: 'date' },
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
  ScheduleApprovePayload: obj({ inputFingerprint: ref('InputFingerprint'), expectedSourceVersions: { type: 'object', additionalProperties: uuid }, comment: reason }, ['inputFingerprint', 'expectedSourceVersions']),
  WorkTypeApprovePayload: obj({ aliasOfWorkTypeId: uuid }),
  // D01: one entry per Work — there is deliberately no execution-unit, WEU or portion property, and additionalProperties is false.
  GprEntryInput: obj({ workId: uuid, startDate: ref('CivilDate'), endDate: ref('CivilDate'), sectionNodeId: { oneOf: [uuid, { type: 'null' }] }, sortOrder: { type: 'integer', minimum: 0 } }, ['workId', 'startDate', 'endDate']),
  // D08: FS / SS / FF only. SF is refused with its own error code (UNSUPPORTED_DEPENDENCY_TYPE).
  GprEdgeInput: obj({
    predecessorWorkId: uuid, successorWorkId: uuid, type: { type: 'string', enum: [...EDGE_TYPES] }, lagKind: { type: 'string', enum: [...LAG_KINDS] },
    lagValue: ref('DecimalNormative'), reason
  }, ['predecessorWorkId', 'successorWorkId', 'type', 'lagKind', 'lagValue']),
  // D16: every Work is included or excluded; an exclusion always has its reason.
  GprOmissionInput: {
    ...obj({ workId: uuid, inclusion: { type: 'string', enum: ['INCLUDED', 'EXCLUDED'] }, omissionReason: { type: ['string', 'null'], maxLength: REASON_LIMIT } }, ['workId', 'inclusion']),
    if: { properties: { inclusion: { const: 'EXCLUDED' } }, required: ['inclusion'] }, then: { required: ['omissionReason'], properties: { omissionReason: { type: 'string', minLength: 1 } } }
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
  'schedule.changes.preview': 'GprChangeSet', 'schedule.changes.apply': 'GprChangeApply'
};

const errorResponse = (description: string) => ({ description, content: { 'application/json': { schema: ref('ErrorBody') } } });

function operation(e: Gpr2Endpoint): Json {
  const parameters: Json[] = pathParamsOf(e).map(name => ({ name, in: 'path', required: true, schema: uuid }));
  if (e.idempotent)
    parameters.push({ name: 'Idempotency-Key', in: 'header', required: true, schema: uuid, description: 'Scoped by tenant, actor, command kind and aggregate; a repeat of the same command returns the same result.' });
  else if (e.kind === 'COMMAND')
    parameters.push({ name: 'Idempotency-Key', in: 'header', required: false, schema: uuid, description: 'A pure preview needs none; one that is sent must still be well formed.' });
  const authorization = e.authorization.type === 'EXISTING_RULES' ? { type: 'EXISTING_RULES' } : e.authorization;
  const op: Json = {
    operationId: e.id, tags: [e.stage], security: [{ bearerAuth: [] }], parameters,
    'x-stage': e.stage, 'x-mounted': e.mounted, 'x-scope': e.scope, 'x-authorization': authorization, 'x-pure': e.pure,
    ...(e.transition ? { 'x-lifecycle-transition': e.transition } : {}), ...(e.routeFixedByTd ? {} : { 'x-route-proposed': true }),
    responses: {} as Json
  };
  const responses = op.responses as Json;
  if (e.kind === 'COMMAND') {
    const properties: Json = {}, required: string[] = ['payload'];
    if (e.aggregateVersion) { properties.expectedVersion = ref('VersionToken'); required.push('expectedVersion'); }
    if (e.scopeFence) { properties.expectedScopeVersion = ref('VersionToken'); required.push('expectedScopeVersion'); }
    properties.payload = PAYLOAD_SCHEMA[e.id] ? ref(PAYLOAD_SCHEMA[e.id]) : { type: 'object', description: 'Open object: its fields belong to the stage that implements the command.', 'x-owner-stage': e.stage };
    op.requestBody = { required: true, content: { 'application/json': { schema: obj(properties, required) } } };
    responses['200'] = { description: 'Applied (or the stored result of a repeat).', content: { 'application/json': { schema: ref('CommandResult') } } };
  } else responses['200'] = { description: 'The projection; its shape is owned by the stage that implements it.', content: { 'application/json': { schema: { type: 'object', 'x-owner-stage': e.stage } } } };
  responses['401'] = { description: 'Not authenticated (the authentication layer\'s own body).' };
  responses['403'] = errorResponse('The caller\'s current role does not hold the permission (decided before scope).');
  responses['404'] = errorResponse('The resource is missing, malformed, another tenant\'s or out of the caller\'s scope — one and the same answer.');
  if (e.kind === 'COMMAND') {
    if (e.aggregateVersion || e.scopeFence || e.idempotent) responses['409'] = errorResponse('STALE_VERSION, SCOPE_VERSION_CHANGED or IDEMPOTENCY_PAYLOAD_MISMATCH.');
    responses['422'] = errorResponse('VALIDATION_FAILED and the rule codes of the lifecycle / the stage.');
    if (e.mounted) responses['501'] = errorResponse('COMMAND_NOT_ENABLED — R01 ships the contract only; the owning stage replaces the gate.');
  }
  return op;
}

export function buildGpr2OpenApi(): Json {
  const paths: Record<string, Json> = {};
  for (const e of GPR2_ENDPOINTS) (paths[APP_PREFIX + e.path] ??= {})[e.method.toLowerCase()] = operation(e);
  return {
    openapi: '3.1.0',
    info: { title: 'Construction Core — GPR-2 command contract', version: 'r01', description: 'Derived from the endpoint register of packages/domain/gpr2. Contract only: no command has behaviour yet.' },
    servers: [{ url: '/api' }],
    paths,
    components: { schemas: SCHEMAS, securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
    'x-error-status': { ...GPR2_ERROR_STATUS }
  };
}
