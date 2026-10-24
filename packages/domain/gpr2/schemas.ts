/**
 * GPR-2 R01 — API schemas (Technical Design §5.4, §8.1, §11.1–11.2; decisions D01/D08/D16, C01/C11, A10).
 *
 * The command envelope is the same for every command (§11.1):
 *   header  Idempotency-Key          a uuid, like every idempotency key already in the repository (infra/013, infra/014)
 *   body    { expectedVersion?, expectedScopeVersion?, payload }
 * Which of the optional tokens a command carries is declared in the endpoint register; a token the command does not use is REFUSED, not
 * ignored, so a client that sends one is told it is talking to the wrong contract.
 *
 * Only payloads the design fixes outright are typed here — the reason of a return / reject, a schedule submission, an approval's fence and
 * the change-set of a draft (entries, edges, omissions, calendar). Everything else is an object whose fields belong to the stage that
 * implements the command (R05, R07, R09, R15–R17); freezing a shape the design leaves open would be inventing it.
 *
 * Every violation is reduced to a (path, rule) pair from a closed set — never the offending value — so a validation error cannot echo data
 * the caller should not read back.
 */
import { z } from 'zod';
import { DecimalProfile, NORMATIVE, parseDecimal } from './decimal';
import { Gpr2Error, Gpr2ValidationRule, Gpr2Violation, validationFailed } from './errors';
import { parseAggregateVersion, parseScopeVersion, parseSourceVersionId, isInputFingerprint } from './versions';
import { parseCivilDate } from './civil-date';
import { openObjectViolations } from './open-value';
import type { Gpr2Endpoint } from './endpoints';

// ---------------------------------------------------------------------------------------------------------------------------------
// Leaf schemas. A custom issue carries the rule code as its message, which zodViolations() maps back.
// ---------------------------------------------------------------------------------------------------------------------------------

const fail = (ctx: z.RefinementCtx, rule: Gpr2ValidationRule | 'UNSUPPORTED_DEPENDENCY_TYPE') => { ctx.addIssue({ code: 'custom', message: rule }); return z.NEVER; };

export const decimalString = (profile: DecimalProfile) => z.unknown().transform((input, ctx) => {
    if (input === undefined)
        return fail(ctx, 'FIELD_REQUIRED');
    const r = parseDecimal(profile, input);
    return r.ok === true ? r.value : fail(ctx, r.rule);
});
/** The field must be present: `null` is the explicit "unknown", a missing key is a malformed projection. */
export const nullableDecimalString = (profile: DecimalProfile) => z.unknown().transform((input, ctx) => {
    if (input === undefined)
        return fail(ctx, 'FIELD_REQUIRED');
    if (input === null)
        return null;
    const r = parseDecimal(profile, input);
    return r.ok === true ? r.value : fail(ctx, r.rule);
});

const tokenSchema = (parse: (v: unknown) => { ok: true; value: any } | { ok: false; rule: Gpr2ValidationRule }) => z.unknown().transform((input, ctx) => {
    if (input === undefined)
        return fail(ctx, 'VERSION_TOKEN_REQUIRED');
    const r = parse(input);
    return r.ok === true ? r.value : fail(ctx, r.rule);
});
export const aggregateVersionSchema = tokenSchema(parseAggregateVersion);
export const scopeVersionSchema = tokenSchema(parseScopeVersion);
export const sourceVersionIdSchema = tokenSchema(parseSourceVersionId);

export const uuidSchema = z.unknown().transform((input, ctx) => {
    if (input === undefined)
        return fail(ctx, 'FIELD_REQUIRED');
    if (typeof input !== 'string')
        return fail(ctx, 'FIELD_TYPE');
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input) ? input.toLowerCase() : fail(ctx, 'ID_MALFORMED');
});
/** A calendar day (§5.1). Validated by integer arithmetic (civil-date.ts) — never through the host Date, whose RangeError used to surface as HTTP 500 (R01-B01). */
export const civilDate = z.unknown().transform((input, ctx) => {
    if (input === undefined)
        return fail(ctx, 'FIELD_REQUIRED');
    const r = parseCivilDate(input);
    return r.ok === true ? r.value : fail(ctx, r.rule);
});
export const REASON_LIMIT = 2000;
/** A reason / comment: real text, trimmed. Blank or missing is REASON_REQUIRED. */
export const reasonText = z.unknown().transform((input, ctx) => {
    const text = typeof input === 'string' ? input.trim() : '';
    return text && text.length <= REASON_LIMIT ? text : fail(ctx, 'REASON_REQUIRED');
});
const fingerprint = z.unknown().transform((input, ctx) => input === undefined ? fail(ctx, 'FIELD_REQUIRED') : isInputFingerprint(input) ? input : fail(ctx, 'FIELD_TYPE'));

// ---------------------------------------------------------------------------------------------------------------------------------
// Idempotency-Key header and the command envelope
// ---------------------------------------------------------------------------------------------------------------------------------

export function parseIdempotencyKey(header: unknown, required: boolean): { ok: true; value: string | null } | { ok: false; rule: Gpr2ValidationRule } {
    // Absent is absent. A header that IS sent but empty is not "absent": where the key is optional (a pure preview) it is malformed (R01-B05-R2),
    // where it is required it stays "required" (nothing usable was given).
    if (header === undefined || header === null)
        return required ? { ok: false, rule: 'IDEMPOTENCY_KEY_REQUIRED' } : { ok: true, value: null };
    if (header === '')
        return { ok: false, rule: required ? 'IDEMPOTENCY_KEY_REQUIRED' : 'IDEMPOTENCY_KEY_MALFORMED' };
    if (typeof header !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(header))
        return { ok: false, rule: 'IDEMPOTENCY_KEY_MALFORMED' };
    return { ok: true, value: header.toLowerCase() };
}

/**
 * Which payload schema, if any, the design fixes for a command; otherwise an object whose fields the implementing stage owns.
 * "Open" is not "anything" (R01-B03): the object must be plain JSON that the fingerprint can canonicalise (open-value.ts), so a client mistake
 * is a 422 here and never a 500 out of commandFingerprint.
 */
const issues = (ctx: z.RefinementCtx, found: Gpr2Violation[]) => { for (const v of found) ctx.addIssue({ code: 'custom', message: v.rule, path: v.path ? v.path.split('.') : [] }); return z.NEVER; };
export const openObject = z.unknown().transform((input, ctx) => {
    const found = openObjectViolations(input);
    // The ORIGINAL object is returned, not a copy: canonicalJson only accepts plain Object prototypes.
    return found.length ? issues(ctx, found) : input as Record<string, unknown>;
});
const OPEN_PAYLOAD = openObject;
export const reasonPayload = z.strictObject({ reason: reasonText });
export const schedulePayloads = {
    submit: z.strictObject({ changeReason: reasonText })
};

/**
 * The common fence of an approve / commit (§11.1: "У approve/commit — immutable input fingerprint и expected source versions"; R01-B03).
 *   inputFingerprint        the exact input the approver / committer looked at (sha256, 64 hex)
 *   expectedSourceVersions  the immutable source versions that input was built from: at least ONE named version id. An empty map would fence
 *                           nothing, so it is refused like a missing one. Which sources a command names belongs to the stage that implements it.
 * Both are mandatory: a body without them is refused (422) before replay and before execute.
 */
export const SOURCE_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
export const sourceVersionsSchema = z.unknown().transform((input, ctx) => {
    if (input === undefined)
        return fail(ctx, 'FIELD_REQUIRED');
    if (typeof input !== 'object' || input === null || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype)
        return fail(ctx, 'FIELD_TYPE');
    const out: Record<string, string> = {}, entries = Object.entries(input as object);
    if (entries.length === 0)
        return fail(ctx, 'FIELD_REQUIRED');
    for (const [name, value] of entries) {
        const at = SOURCE_NAME.test(name) && name !== '__proto__' ? name : '*';
        if (at === '*') { ctx.addIssue({ code: 'custom', message: 'FIELD_NOT_ALLOWED', path: [at] }); continue; }
        const r = parseSourceVersionId(value);
        if (r.ok === true) out[name] = r.value; else ctx.addIssue({ code: 'custom', message: r.rule, path: [at] });
    }
    return out;
});
export const approvalFence = { inputFingerprint: fingerprint, expectedSourceVersions: sourceVersionsSchema };
/**
 * A payload that is a typed FENCE plus stage-owned fields: the fence keys are typed here, every other key is a deferred extension of the owning
 * stage — accepted, but only as safe JSON (open-value.ts), never interpreted by R01.
 */
const fenced = (shape: Record<string, z.ZodType>) => openObject.pipe(z.looseObject(shape));
export const approvalPayload = fenced({ ...approvalFence, comment: reasonText.optional() });
export const commitPayload = fenced(approvalFence);
/** A correction of an external outcome always says why (lifecycle: reasonRequired on `record-correction`); the corrected content is R09's. */
export const correctionPayload = fenced({ reason: reasonText });

// --- the draft change-set (§5.4, §11.2 "Entries/placement/edges/calendar/omissions") ----------------------------------------------
// D01/C01: one entry per Work. There is no execution-unit field, and .strict() makes sending one an error, not a silent ignore.
export const gprEntryInput = z.strictObject({
    workId: uuidSchema, startDate: civilDate, endDate: civilDate,
    sectionNodeId: uuidSchema.nullable().optional(), sortOrder: z.number().int().min(0).optional()
}).superRefine((e, ctx) => { if (e.startDate > e.endDate) ctx.addIssue({ code: 'custom', message: 'OUT_OF_RANGE', path: ['endDate'] }); });
export const EDGE_TYPES = ['FS', 'SS', 'FF'] as const;
export const LAG_KINDS = ['WORKING_DAYS', 'ELAPSED_HOURS'] as const;
// D08: FS / SS / FF. SF is refused EXPLICITLY (§5.4) with its own rule code rather than as a generic enum miss.
const edgeType = z.unknown().transform((input, ctx) => input === 'SF' ? fail(ctx, 'UNSUPPORTED_DEPENDENCY_TYPE') : (EDGE_TYPES as readonly unknown[]).includes(input) ? input as typeof EDGE_TYPES[number] : fail(ctx, 'ENUM_VALUE'));
export const gprEdgeInput = z.strictObject({
    predecessorWorkId: uuidSchema, successorWorkId: uuidSchema, type: edgeType,
    lagKind: z.enum(LAG_KINDS), lagValue: decimalString(NORMATIVE), reason: reasonText.optional()
}).superRefine((e, ctx) => { if (e.predecessorWorkId === e.successorWorkId) ctx.addIssue({ code: 'custom', message: 'OUT_OF_RANGE', path: ['successorWorkId'] }); });
// D16/C11: every real Work is included or excluded, and an exclusion always has its reason.
export const gprOmissionInput = z.strictObject({
    workId: uuidSchema, inclusion: z.enum(['INCLUDED', 'EXCLUDED']), omissionReason: z.string().trim().max(REASON_LIMIT).nullable().optional()
}).superRefine((o, ctx) => { if (o.inclusion === 'EXCLUDED' && !o.omissionReason) ctx.addIssue({ code: 'custom', message: 'REASON_REQUIRED', path: ['omissionReason'] }); });
export const gprChangeSet = z.strictObject({
    entries: z.array(gprEntryInput).optional(), edges: z.array(gprEdgeInput).optional(),
    omissions: z.array(gprOmissionInput).optional(), calendarVersionId: uuidSchema.optional()
});
// A10: an apply names the exact preview it confirms; a stale or foreign fingerprint is refused by R14, a missing one by the contract.
export const gprChangeApply = gprChangeSet.extend({ previewFingerprint: fingerprint });

const PAYLOAD_SCHEMAS: Record<string, z.ZodType> = {
    'quantity.request.return': reasonPayload, 'schedule.revision.return': reasonPayload, 'work-type.publication.reject': reasonPayload,
    'work-type.publication.approve': z.strictObject({ aliasOfWorkTypeId: uuidSchema.optional() }),
    'schedule.revision.submit': schedulePayloads.submit, 'schedule.revision.approve': z.strictObject({ ...approvalFence, comment: reasonText.optional() }),
    'quantity.request.approve': approvalPayload, 'imports.boq.commit': commitPayload, 'imports.estimate-labor.commit': commitPayload,
    'finish-change.record-correction': correctionPayload,
    'schedule.changes.preview': gprChangeSet, 'schedule.changes.apply': gprChangeApply
};
export const payloadSchemaFor = (endpointId: string): z.ZodType => PAYLOAD_SCHEMAS[endpointId] ?? OPEN_PAYLOAD;

/** The body of a command for this endpoint: exactly the tokens the register says it carries, and a payload. */
export function envelopeSchemaFor(e: Gpr2Endpoint) {
    // `payload` is always present: an empty command is `{ "payload": {} }`, never a missing key.
    const payload = z.unknown().transform((input, ctx) => input === undefined ? fail(ctx, 'FIELD_REQUIRED') : input).pipe(payloadSchemaFor(e.id));
    const shape: Record<string, z.ZodType> = { payload };
    if (e.aggregateVersion)
        shape.expectedVersion = aggregateVersionSchema;
    if (e.scopeFence)
        shape.expectedScopeVersion = scopeVersionSchema;
    return z.strictObject(shape);
}

export interface ParsedCommand {
    idempotencyKey: string | null;
    expectedVersion: string | null;
    expectedScopeVersion: string | null;
    payload: any;
}
/** Validate header + body against the register; throws VALIDATION_FAILED (every violation at once) or UNSUPPORTED_DEPENDENCY_TYPE. */
export function parseCommand(e: Gpr2Endpoint, headers: Record<string, unknown>, body: unknown): ParsedCommand {
    const violations: Gpr2Violation[] = [];
    const key = parseIdempotencyKey(headers['idempotency-key'], e.idempotent);
    if (key.ok === false)
        violations.push({ path: 'Idempotency-Key', rule: key.rule });
    // reportInput only lets zodViolations() tell "missing" from "wrong type"; the value itself is never copied into an error.
    const parsed = envelopeSchemaFor(e).safeParse(body === undefined || body === null ? {} : body, { reportInput: true });
    if (!parsed.success)
        violations.push(...zodViolations(parsed.error));
    if (violations.length)
        throw validationFailed(violations);
    const data = (parsed as any).data;
    return { idempotencyKey: (key as any).value, expectedVersion: data.expectedVersion ?? null, expectedScopeVersion: data.expectedScopeVersion ?? null, payload: data.payload };
}

// ---------------------------------------------------------------------------------------------------------------------------------

const RULES = new Set<string>(['DECIMAL_NOT_A_STRING', 'DECIMAL_MALFORMED', 'DECIMAL_SCALE_EXCEEDED', 'DECIMAL_OUT_OF_RANGE', 'DECIMAL_NEGATIVE_NOT_ALLOWED', 'DECIMAL_NEGATIVE_ZERO',
    'VERSION_TOKEN_NOT_A_STRING', 'VERSION_TOKEN_MALFORMED', 'VERSION_TOKEN_REQUIRED', 'IDEMPOTENCY_KEY_REQUIRED', 'IDEMPOTENCY_KEY_MALFORMED', 'ID_MALFORMED', 'DATE_MALFORMED',
    'FIELD_REQUIRED', 'FIELD_NOT_ALLOWED', 'FIELD_TYPE', 'OUT_OF_RANGE', 'ENUM_VALUE', 'REASON_REQUIRED',
    'QUANTITY_MISSING', 'UNIT_MISSING', 'UNIT_UNKNOWN', 'UNIT_MISMATCH', 'REFERENCE_NOT_IN_SCOPE', 'AREA_OVERLAP', 'PRODUCER_EXISTS', 'DUPLICATE_VALUE', 'NOTHING_TO_GENERATE']);
const pathOf = (p: ReadonlyArray<PropertyKey>) => p.map(String).join('.');

/** zod issues → closed (path, rule) pairs. An unsupported dependency type is not a violation but its own error code. */
export function zodViolations(error: z.ZodError): Gpr2Violation[] {
    const out: Gpr2Violation[] = [];
    for (const issue of error.issues) {
        if (issue.code === 'custom' && issue.message === 'UNSUPPORTED_DEPENDENCY_TYPE')
            throw new Gpr2Error('UNSUPPORTED_DEPENDENCY_TYPE');
        if (issue.code === 'custom' && RULES.has(issue.message))
            out.push({ path: pathOf(issue.path), rule: issue.message as Gpr2ValidationRule });
        else if (issue.code === 'unrecognized_keys')
            for (const k of issue.keys)
                out.push({ path: pathOf([...issue.path, /^[A-Za-z0-9_-]{1,64}$/.test(k) ? k : '*']), rule: 'FIELD_NOT_ALLOWED' });
        else if (issue.code === 'invalid_type')
            out.push({ path: pathOf(issue.path), rule: (issue as any).input === undefined ? 'FIELD_REQUIRED' : 'FIELD_TYPE' });
        else if (issue.code === 'invalid_value')
            out.push({ path: pathOf(issue.path), rule: 'ENUM_VALUE' });
        else if (issue.code === 'too_small' || issue.code === 'too_big')
            out.push({ path: pathOf(issue.path), rule: 'OUT_OF_RANGE' });
        else
            out.push({ path: pathOf(issue.path), rule: 'FIELD_TYPE' });
    }
    return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The success envelope (§11.1: "applied versions, command / result ID and structured warnings")
// ---------------------------------------------------------------------------------------------------------------------------------

export const commandResultSchema = z.strictObject({
    commandId: z.string().uuid(),
    resultIds: z.array(z.string().uuid()),
    appliedVersions: z.strictObject({ aggregate: z.string().regex(/^(0|[1-9][0-9]{0,17})$/).nullable(), scope: z.string().regex(/^(0|[1-9][0-9]{0,17})$/).nullable() }),
    warnings: z.array(z.strictObject({ code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/), path: z.string().max(200).optional() }))
});
export type CommandResult = z.infer<typeof commandResultSchema>;
