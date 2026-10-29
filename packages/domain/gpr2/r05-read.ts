/**
 * GPR-2 R05 / D1 — the read contracts of the five R05 queries (owner-authorised 29.10.2026; docs/gpr-2-r05-read-api-d1.md).
 *
 * Pure domain: the query-string grammar (strict — an unknown or repeated parameter is refused), the opaque keyset cursor, the response shapes and the
 * JSON Schemas the OpenAPI document publishes for them. The SQL lives in apps/backend/src/gpr2-r05-read.ts; nothing here touches a database.
 *
 * A read never invents data and never echoes a foreign identifier: every shape below is an explicit allow-list of columns, not the stored row.
 */
import { Gpr2Endpoint, Gpr2QueryParam } from './endpoints';
import { Gpr2Violation, validationFailed } from './errors';

// ---------------------------------------------------------------------------------------------------------------------------------
// Query string
// ---------------------------------------------------------------------------------------------------------------------------------
export const READ_LIMIT_DEFAULT = 100;
export const READ_LIMIT_MAX = 200;
const CURSOR_MAX_LENGTH = 1024;

export interface ParsedReadQuery { limit: number; cursor: string | null; state: 'PENDING' | 'APPROVED' | 'REJECTED' | null }

/**
 * `raw` is the framework's parsed query object (string | string[] | nested object per key). Exactly the parameters the register row lists are accepted,
 * each at most once; the violations of the whole query are reported together, never the first only.
 */
export function parseReadQuery(endpoint: Gpr2Endpoint, raw: unknown): ParsedReadQuery {
    const allowed = new Map<string, Gpr2QueryParam>((endpoint.queryParams ?? []).map(p => [p.name, p]));
    const input: Record<string, unknown> = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const violations: Gpr2Violation[] = [];
    const out: ParsedReadQuery = { limit: READ_LIMIT_DEFAULT, cursor: null, state: null };
    for (const key of Object.keys(input)) {
        const param = allowed.get(key);
        if (!param) { violations.push({ path: key.slice(0, 64), rule: 'FIELD_NOT_ALLOWED' }); continue; }
        const value = input[key];
        if (typeof value !== 'string') { violations.push({ path: key, rule: 'FIELD_TYPE' }); continue; }
        if (key === 'limit') {
            if (!/^[1-9][0-9]{0,3}$/.test(value) || Number(value) > READ_LIMIT_MAX) violations.push({ path: key, rule: 'OUT_OF_RANGE' });
            else out.limit = Number(value);
        }
        else if (key === 'cursor') {
            if (value.length === 0 || value.length > CURSOR_MAX_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) violations.push({ path: key, rule: 'FIELD_TYPE' });
            else out.cursor = value;
        }
        else if (key === 'state') {
            if (!param.enum?.includes(value)) violations.push({ path: key, rule: 'ENUM_VALUE' });
            else out.state = value as ParsedReadQuery['state'];
        }
    }
    if (violations.length)
        throw validationFailed(violations);
    return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Cursor — opaque keyset position, bound to the route and to everything that changes the result set
// ---------------------------------------------------------------------------------------------------------------------------------
export interface CursorBinding { endpoint: string; objectId: string | null; mode: string; state: string | null }
export type CursorKey = readonly [string, string];

export function encodeCursor(binding: CursorBinding, key: CursorKey): string {
    return Buffer.from(JSON.stringify({ b: [binding.endpoint, binding.objectId, binding.mode, binding.state], k: key }), 'utf8').toString('base64url');
}

/** A cursor that is malformed, was issued for another route / object / view / filter, or carries a key of the wrong shape is a 422 on `cursor`. */
export function decodeCursor(cursor: string, binding: CursorBinding, keyIsValid: (key: CursorKey) => boolean): CursorKey {
    const refuse = () => validationFailed([{ path: 'cursor', rule: 'FIELD_TYPE' }]);
    let parsed: any;
    try { parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); }
    catch { throw refuse(); }
    const b = parsed?.b, k = parsed?.k;
    if (!Array.isArray(b) || b.length !== 4 || b[0] !== binding.endpoint || b[1] !== binding.objectId || b[2] !== binding.mode || b[3] !== binding.state)
        throw refuse();
    if (!Array.isArray(k) || k.length !== 2 || typeof k[0] !== 'string' || typeof k[1] !== 'string' || k[0].length > 600 || !keyIsValid([k[0], k[1]]))
        throw refuse();
    return [k[0], k[1]];
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------------------------------------------------------------
export interface Page<T> { items: T[]; nextCursor: string | null }

export interface WorkTypeRead {
    id: string; scope: 'CORPORATE' | 'OBJECT'; name: string; categoryId: string; unit: string;
    requiresInspection: boolean | null; requiresExecutiveDocs: boolean | null; requiresMaterials: boolean | null; isActive: boolean | null;
    aliasOfWorkTypeId: string | null; version: string; createdAt: string; updatedAt: string;
}
export interface AreaScopeRead {
    id: string; parentId: string | null; kind: string; code: string; name: string; measureQuantity: string | null; measureUnit: string | null;
    lifecycle: 'ACTIVE' | 'RETIRED'; version: string; createdAt: string; updatedAt: string;
}
export interface StageRead {
    id: string; occurrenceKey: string; position: number; workTypeId: string; workTypeName: string | null; required: boolean; measureScope: 'MAIN' | 'LOCAL';
    measureUnit: string; proposedHoldHours: string | null; proposedHoldStatus: 'PROPOSAL';
}
export interface SystemStageRead extends StageRead {
    overrideKind: 'INHERITED' | 'OVERRIDDEN' | 'ADDED_LOCAL'; overrideReason: string | null; sourceTemplateVersionId: string | null; sourceTemplateStageId: string | null;
}
export interface VersionSummaryRead { id: string; versionNumber: number; state: 'DRAFT' | 'PUBLISHED'; contentHash: string | null; publishedAt: string | null; createdAt: string }
export interface SystemVersionSummaryRead extends VersionSummaryRead { sourceTemplateVersionId: string | null }
export interface SystemVersionRead extends SystemVersionSummaryRead {
    stages: SystemStageRead[]; exclusions: { templateStageId: string; sourceTemplateVersionId: string; reason: string }[];
}
export interface FinishTypeRead {
    id: string; code: string; name: string; lifecycle: 'ACTIVE' | 'RETIRED'; version: string; createdAt: string; updatedAt: string;
    versions: SystemVersionSummaryRead[]; currentVersion: SystemVersionRead | null;
}
export interface TemplateVersionRead extends VersionSummaryRead { stages: StageRead[] }
export interface FinishTemplateRead {
    id: string; code: string; name: string; lifecycle: 'ACTIVE' | 'RETIRED'; version: string; createdAt: string; updatedAt: string;
    versions: VersionSummaryRead[]; currentVersion: TemplateVersionRead | null; draftVersion: TemplateVersionRead | null;
}
export interface PublicationRequestRead {
    id: string; workTypeId: string; workTypeVersion: string; proposedName: string; proposedCategoryId: string; proposedUnit: string; justification: string | null;
    requestedById: string; status: 'PENDING' | 'APPROVED' | 'REJECTED'; outcome: 'PROMOTED' | 'ALIASED' | null; aliasOfWorkTypeId: string | null;
    decidedById: string | null; decidedAt: string | null; decisionReason: string | null; version: string; createdAt: string; updatedAt: string;
    workType: { id: string; scope: 'CORPORATE' | 'OBJECT'; name: string; unit: string; version: string; aliasOfWorkTypeId: string | null };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// JSON Schemas published in the OpenAPI document (components.schemas)
// ---------------------------------------------------------------------------------------------------------------------------------
type Json = Record<string, unknown>;
const ref = (n: string): Json => ({ $ref: `#/components/schemas/${n}` });
const obj = (properties: Json, required = Object.keys(properties)): Json => ({ type: 'object', additionalProperties: false, properties, required });
const str: Json = { type: 'string' }, bool: Json = { type: 'boolean' }, int: Json = { type: 'integer' };
const uuid: Json = { type: 'string', format: 'uuid' }, ts: Json = { type: 'string', format: 'date-time' };
const nullable = (s: Json): Json => ({ oneOf: [s, { type: 'null' }] });
const arr = (items: Json): Json => ({ type: 'array', items });
const en = (...v: string[]): Json => ({ type: 'string', enum: v });
const decimal = ref('DecimalQuantity');
const version = ref('VersionToken');
const page = (item: string): Json => obj({ items: arr(ref(item)), nextCursor: nullable(str) });

const stage = { id: uuid, occurrenceKey: str, position: int, workTypeId: uuid, workTypeName: nullable(str), required: bool, measureScope: en('MAIN', 'LOCAL'), measureUnit: str,
    proposedHoldHours: nullable(ref('DecimalNormative')), proposedHoldStatus: en('PROPOSAL') };
const versionSummary = { id: uuid, versionNumber: int, state: en('DRAFT', 'PUBLISHED'), contentHash: nullable(str), publishedAt: nullable(ts), createdAt: ts };
const header = { id: uuid, code: str, name: str, lifecycle: en('ACTIVE', 'RETIRED'), version, createdAt: ts, updatedAt: ts };

export const R05_READ_SCHEMAS: Readonly<Record<string, Json>> = Object.freeze({
    ReadWorkType: obj({ id: uuid, scope: en('CORPORATE', 'OBJECT'), name: str, categoryId: uuid, unit: str, requiresInspection: nullable(bool), requiresExecutiveDocs: nullable(bool), requiresMaterials: nullable(bool),
        isActive: nullable(bool), aliasOfWorkTypeId: nullable(uuid), version, createdAt: ts, updatedAt: ts }),
    ReadAreaScope: obj({ id: uuid, parentId: nullable(uuid), kind: str, code: str, name: str, measureQuantity: nullable(decimal), measureUnit: nullable(str), lifecycle: en('ACTIVE', 'RETIRED'),
        version, createdAt: ts, updatedAt: ts }),
    ReadTemplateStage: obj(stage),
    ReadSystemStage: obj({ ...stage, overrideKind: en('INHERITED', 'OVERRIDDEN', 'ADDED_LOCAL'), overrideReason: nullable(str), sourceTemplateVersionId: nullable(uuid), sourceTemplateStageId: nullable(uuid) }),
    ReadVersionSummary: obj(versionSummary),
    ReadSystemVersionSummary: obj({ ...versionSummary, sourceTemplateVersionId: nullable(uuid) }),
    ReadSystemVersion: obj({ ...versionSummary, sourceTemplateVersionId: nullable(uuid), stages: arr(ref('ReadSystemStage')),
        exclusions: arr(obj({ templateStageId: uuid, sourceTemplateVersionId: uuid, reason: str })) }),
    ReadFinishType: obj({ ...header, versions: arr(ref('ReadSystemVersionSummary')), currentVersion: nullable(ref('ReadSystemVersion')) }),
    ReadTemplateVersion: obj({ ...versionSummary, stages: arr(ref('ReadTemplateStage')) }),
    ReadFinishTemplate: obj({ ...header, versions: arr(ref('ReadVersionSummary')), currentVersion: nullable(ref('ReadTemplateVersion')), draftVersion: nullable(ref('ReadTemplateVersion')) }),
    ReadPublicationRequest: obj({ id: uuid, workTypeId: uuid, workTypeVersion: version, proposedName: str, proposedCategoryId: uuid, proposedUnit: str, justification: nullable(str),
        requestedById: uuid, status: en('PENDING', 'APPROVED', 'REJECTED'), outcome: nullable(en('PROMOTED', 'ALIASED')), aliasOfWorkTypeId: nullable(uuid), decidedById: nullable(uuid),
        decidedAt: nullable(ts), decisionReason: nullable(str), version, createdAt: ts, updatedAt: ts,
        workType: obj({ id: uuid, scope: en('CORPORATE', 'OBJECT'), name: str, unit: str, version, aliasOfWorkTypeId: nullable(uuid) }) }),
    ReadPageWorkTypes: page('ReadWorkType'), ReadPageAreaScopes: page('ReadAreaScope'), ReadPageFinishTypes: page('ReadFinishType'),
    ReadPageFinishTemplates: page('ReadFinishTemplate'), ReadPagePublicationRequests: page('ReadPublicationRequest')
});

/** Which published schema describes the 200 body of each mounted R05 read. */
export const R05_READ_RESPONSE: Readonly<Record<string, string>> = Object.freeze({
    'work-types.list': 'ReadPageWorkTypes', 'area-scopes.list': 'ReadPageAreaScopes', 'finish-systems.list': 'ReadPageFinishTypes',
    'finish-templates.list': 'ReadPageFinishTemplates', 'work-type-publication-requests.list': 'ReadPagePublicationRequests'
});
