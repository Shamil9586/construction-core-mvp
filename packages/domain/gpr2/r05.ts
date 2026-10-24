/**
 * GPR-2 R05 — WorkType scopes, object finish systems, AreaScopes, versioned templates and Work generation: the PURE part
 * (Technical Design §4.1, §5.2, §11.2–11.3; decisions D01, D03, D05, D06, D09, D20; scenarios A01, A03, A07, A12).
 *
 * No database and no HTTP here. What lives here is what must be the SAME wherever it is computed:
 *   * the stage-owned payload contracts of the R05 commands (R01 left them open objects "owned by R05"; they are strict here);
 *   * the unit catalogue every NEW unit is checked against;
 *   * computeGenerationPreview(): from one object finish-system version, a set of AreaScopes and the existing producer bindings, the Works a confirm
 *     would create, the ones that already exist, every blocker and warning — and the preview fingerprint. The backend computes it twice: once for the
 *     read-only preview, once again inside the confirm transaction under the EXCLUSIVE coordination lock. Equal fingerprints are the proof that the
 *     PM confirms exactly what was shown.
 *
 * Things this module refuses to invent (D09 / R04, TD §6.1): a quantity, a unit, a contractor, a responsible person, a cost or a date. A missing
 * quantity or unit is a structured BLOCKER where it prevents a real Work; missing contractor / responsible / cost / dates are WARNINGS — an Early Work
 * is created with them unknown (NULL), exactly as R04 allows. Proposed technological holds are PROPOSALS, never a normative obligation.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Gpr2Error, Gpr2ErrorCode, Gpr2ValidationRule, Gpr2Violation, validationFailed } from './errors';
import { DecimalString, NORMATIVE, QUANTITY, addDecimals, compareDecimals, isPositiveDecimal, parseDecimal, subtractFloorZero } from './decimal';
import { canonicalJson } from './versions';
import { reasonText, uuidSchema, zodViolations } from './schemas';

// ---------------------------------------------------------------------------------------------------------------------------------
// Units. A NEW unit (object WorkType, AreaScope measure) must be one of these. Legacy units of existing corporate WorkTypes are not re-validated:
// they are authoritative for the stages that use them (a stage's measure unit must equal its WorkType's unit exactly — no conversion, ever).
// ---------------------------------------------------------------------------------------------------------------------------------
export const R05_UNITS = ['м', 'м²', 'м³', 'т', 'кг', 'шт', 'компл'] as const;
export type R05Unit = typeof R05_UNITS[number];
// Spelling variants that name the SAME unit (Latin/ASCII input of a Cyrillic symbol). Never a conversion between different units.
const UNIT_SPELLINGS: Readonly<Record<string, R05Unit>> = Object.freeze({ 'м2': 'м²', 'м3': 'м³', 'm': 'м', 'm2': 'м²', 'm²': 'м²', 'm3': 'м³', 'm³': 'м³', 't': 'т', 'kg': 'кг', 'pcs': 'шт' });
export function normalizeUnit(input: unknown): { ok: true; value: R05Unit } | { ok: false; rule: 'UNIT_MISSING' | 'UNIT_UNKNOWN' } {
    if (input === undefined || input === null || (typeof input === 'string' && input.trim() === ''))
        return { ok: false, rule: 'UNIT_MISSING' };
    if (typeof input !== 'string')
        return { ok: false, rule: 'UNIT_UNKNOWN' };
    const t = input.trim();
    if ((R05_UNITS as readonly string[]).includes(t))
        return { ok: true, value: t as R05Unit };
    const alias = UNIT_SPELLINGS[t.toLowerCase()];
    return alias ? { ok: true, value: alias } : { ok: false, rule: 'UNIT_UNKNOWN' };
}

export const AREA_SCOPE_KINDS = ['BUILDING', 'SECTION', 'FLOOR', 'ZONE', 'ROOM', 'SURFACE', 'OTHER'] as const;
export const MEASURE_SCOPES = ['MAIN', 'LOCAL'] as const;
export type MeasureScope = typeof MEASURE_SCOPES[number];
export const OVERRIDE_KINDS = ['INHERITED', 'OVERRIDDEN', 'ADDED_LOCAL'] as const;
export type OverrideKind = typeof OVERRIDE_KINDS[number];
export const GENERATION_GROUPINGS = ['PER_OCCURRENCE', 'PER_AREA'] as const;
export const LEGACY_MAPPING_STATES = ['UNRESOLVED', 'RESOLVED', 'AMBIGUOUS'] as const;
export const LEGACY_WORK_CLASSES = ['SINGLE_FINISH', 'MIXED_FINISH', 'NON_FINISH', 'UNKNOWN'] as const;
/** works.planned_quantity is numeric(20,4): a generated Work above this cannot be stored, and is refused rather than clamped. */
export const WORK_QUANTITY_MAX = '9999999999999999.9999' as DecimalString;

// ---------------------------------------------------------------------------------------------------------------------------------
// Stage-owned payload contracts
// ---------------------------------------------------------------------------------------------------------------------------------
const fail = (ctx: z.RefinementCtx, rule: Gpr2ValidationRule) => { ctx.addIssue({ code: 'custom', message: rule }); return z.NEVER; };
const text = (max: number) => z.unknown().transform((input, ctx) => {
    if (input === undefined) return fail(ctx, 'FIELD_REQUIRED');
    if (typeof input !== 'string') return fail(ctx, 'FIELD_TYPE');
    const t = input.trim();
    return t && t.length <= max ? t : fail(ctx, 'OUT_OF_RANGE');
});
/** A stable code: letters, digits and . _ - ; it is an identity, so it is compared exactly and never re-cased. */
export const CODE_PATTERN = /^[A-Za-z0-9А-Яа-яЁё][A-Za-z0-9А-Яа-яЁё_.-]{0,63}$/;
const code = z.unknown().transform((input, ctx) => {
    if (input === undefined) return fail(ctx, 'FIELD_REQUIRED');
    return typeof input === 'string' && CODE_PATTERN.test(input) ? input : fail(ctx, typeof input === 'string' ? 'OUT_OF_RANGE' : 'FIELD_TYPE');
});
const unit = z.unknown().transform((input, ctx) => { const r = normalizeUnit(input); return r.ok === true ? r.value : fail(ctx, r.rule); });
/** The unit a stage measures in, as written; it is compared with its WorkType's unit exactly (validated by the stage, and by PostgreSQL). */
const measureUnit = z.unknown().transform((input, ctx) => typeof input === 'string' && input.trim() ? input.trim() : fail(ctx, input === undefined ? 'UNIT_MISSING' : 'FIELD_TYPE'));
const decimal = (profile: typeof QUANTITY) => z.unknown().transform((input, ctx) => {
    if (input === undefined) return fail(ctx, 'FIELD_REQUIRED');
    const r = parseDecimal(profile, input);
    return r.ok === true ? r.value : fail(ctx, r.rule);
});
const positiveQuantity = decimal(QUANTITY).superRefine((v, ctx) => { if (!isPositiveDecimal(v)) ctx.addIssue({ code: 'custom', message: 'OUT_OF_RANGE' }); });
const position = z.number().int().min(1).max(10000);
const bool = z.boolean();

export const workTypeCreatePayload = z.strictObject({
    name: text(500), categoryId: uuidSchema, unit,
    requiresInspection: bool, requiresExecutiveDocs: bool, requiresMaterials: bool
});
export const publicationRequestPayload = z.strictObject({ justification: reasonText.optional() });

export const areaScopeCreatePayload = z.strictObject({
    parentId: uuidSchema.nullable().optional(), kind: z.enum(AREA_SCOPE_KINDS), code, name: text(500),
    measureQuantity: positiveQuantity.nullable().optional(), measureUnit: unit.nullable().optional()
}).superRefine((d, ctx) => {
    if ((d.measureQuantity == null) !== (d.measureUnit == null))
        ctx.addIssue({ code: 'custom', message: d.measureQuantity == null ? 'QUANTITY_MISSING' : 'UNIT_MISSING', path: [d.measureQuantity == null ? 'measureQuantity' : 'measureUnit'] });
});

const stageShape = {
    occurrenceKey: code, position, workTypeId: uuidSchema, required: bool, measureScope: z.enum(MEASURE_SCOPES), measureUnit,
    proposedHoldHours: decimal(NORMATIVE).nullable().optional()
};
const uniqueStages = (stages: { occurrenceKey?: string; position: number }[], ctx: z.RefinementCtx) => {
    const keys = new Set<string | undefined>(), positions = new Set<number>();
    stages.forEach((s, i) => {
        if (keys.has(s.occurrenceKey)) ctx.addIssue({ code: 'custom', message: 'DUPLICATE_VALUE', path: ['stages', i, 'occurrenceKey'] });
        if (positions.has(s.position)) ctx.addIssue({ code: 'custom', message: 'DUPLICATE_VALUE', path: ['stages', i, 'position'] });
        keys.add(s.occurrenceKey); positions.add(s.position);
    });
};
export const templateStageInput = z.strictObject(stageShape);
export const finishTemplateDraftPayload = z.strictObject({
    templateId: uuidSchema.optional(), code: code.optional(), name: text(500).optional(), stages: z.array(templateStageInput).min(1).max(100)
}).superRefine((d, ctx) => {
    if (d.templateId ? (d.code !== undefined || d.name !== undefined) : (d.code === undefined || d.name === undefined))
        ctx.addIssue({ code: 'custom', message: d.templateId ? 'FIELD_NOT_ALLOWED' : 'FIELD_REQUIRED', path: [d.templateId ? 'code' : 'name'] });
    uniqueStages(d.stages, ctx);
});
export const finishTemplatePublishPayload = z.strictObject({ templateVersionId: uuidSchema });

export const objectStageInput = z.strictObject({ ...stageShape, sourceTemplateStageId: uuidSchema.nullable().optional(), overrideReason: reasonText.optional() });
export const finishSystemUpsertPayload = z.strictObject({
    finishTypeId: uuidSchema.optional(),
    finishType: z.strictObject({ code, name: text(500) }).optional(),
    sourceTemplateVersionId: uuidSchema.nullable().optional(),
    /** Omitted with a template: every template stage is inherited unchanged. */
    stages: z.array(objectStageInput).min(1).max(100).optional(),
    excludedTemplateStages: z.array(z.strictObject({ templateStageId: uuidSchema, reason: reasonText })).max(100).optional()
}).superRefine((d, ctx) => {
    if ((d.finishTypeId === undefined) === (d.finishType === undefined))
        ctx.addIssue({ code: 'custom', message: d.finishTypeId ? 'FIELD_NOT_ALLOWED' : 'FIELD_REQUIRED', path: ['finishType'] });
    if (!d.sourceTemplateVersionId && !d.stages)
        ctx.addIssue({ code: 'custom', message: 'FIELD_REQUIRED', path: ['stages'] });
    if (!d.sourceTemplateVersionId && d.excludedTemplateStages?.length)
        ctx.addIssue({ code: 'custom', message: 'FIELD_NOT_ALLOWED', path: ['excludedTemplateStages'] });
    if (d.stages) uniqueStages(d.stages, ctx);
});

const localQuantity = z.strictObject({ occurrenceKey: code, areaScopeId: uuidSchema, quantity: positiveQuantity });
const previewShape = {
    systemVersionId: uuidSchema,
    areaScopeIds: z.array(uuidSchema).min(1).max(500),
    includeOptional: z.array(code).max(100).optional(),
    localQuantities: z.array(localQuantity).max(5000).optional(),
    grouping: z.enum(GENERATION_GROUPINGS).optional()
};
export const generationPreviewPayload = z.strictObject(previewShape);
export const generationConfirmPayload = z.strictObject({
    ...previewShape,
    previewFingerprint: z.unknown().transform((input, ctx) => typeof input === 'string' && /^[0-9a-f]{64}$/.test(input) ? input : fail(ctx, input === undefined ? 'FIELD_REQUIRED' : 'FIELD_TYPE')),
    // The fence of a confirm (TD §11.1): the one immutable source version the preview was built from, by name.
    expectedSourceVersions: z.strictObject({ systemVersion: uuidSchema })
});
export type GenerationPreviewRequest = z.infer<typeof generationPreviewPayload>;

export const legacyFinishMappingInput = z.strictObject({
    legacyFinishTypeId: uuidSchema, resolutionState: z.enum(LEGACY_MAPPING_STATES), targetFinishTypeId: uuidSchema.nullable().optional(), basis: reasonText,
    supersedesMappingId: uuidSchema.nullable().optional()
}).superRefine((d, ctx) => {
    if ((d.resolutionState === 'RESOLVED') !== (d.targetFinishTypeId != null))
        ctx.addIssue({ code: 'custom', message: d.resolutionState === 'RESOLVED' ? 'FIELD_REQUIRED' : 'FIELD_NOT_ALLOWED', path: ['targetFinishTypeId'] });
});
export const legacyWorkClassificationInput = z.strictObject({
    workId: uuidSchema, classification: z.enum(LEGACY_WORK_CLASSES), basis: reasonText, supersedesClassificationId: uuidSchema.nullable().optional()
});

/** Validate a stage-owned payload. Every violation at once, as (path, rule) pairs — never the offending value. */
export function parseR05Payload<S extends z.ZodType>(schema: S, payload: unknown): z.infer<S> {
    const r = schema.safeParse(payload, { reportInput: true });
    if (!r.success)
        throw validationFailed(zodViolations(r.error));
    return r.data;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Generation preview
// ---------------------------------------------------------------------------------------------------------------------------------
export interface PreviewArea { id: string; parentId: string | null; code: string; name: string; kind: string; measureQuantity: string | null; measureUnit: string | null }
export interface PreviewOccurrence {
    id: string; occurrenceKey: string; position: number; workTypeId: string; workTypeName: string; workTypeUnit: string;
    required: boolean; measureScope: MeasureScope; measureUnit: string; proposedHoldHours: string | null; overrideKind: OverrideKind
}
export interface PreviewBinding {
    id: string; workId: string; occurrenceKey: string; areaScopeId: string; systemVersionId: string; workName: string; workUnit: string; workQuantity: string;
    /** The operation the producer actually performs: its Work's WorkType, and the WorkType / unit / measure scope of the occurrence it was bound under. */
    workTypeId: string; producedWorkTypeId: string; producedMeasureUnit: string; producedMeasureScope: MeasureScope;
}
/**
 * R05-IND-NEW-05. An occurrence key names an obligation, not an operation: a producer bound under one version satisfies the same key of another version
 * only when it performs the SAME operation — the same WorkType (its Work's and its occurrence's), the same unit and the same measure scope. Anything
 * else is a different operation: the obligation is not met, the old Work is neither reused nor rewritten, and no duplicate producer is created
 * (resolving it is a finish change, R09).
 */
export function producerCompatible(b: PreviewBinding, o: Pick<PreviewOccurrence, 'workTypeId' | 'measureUnit' | 'measureScope'>): boolean {
    return b.workTypeId === o.workTypeId && b.producedWorkTypeId === o.workTypeId && b.workUnit === o.measureUnit && b.producedMeasureUnit === o.measureUnit
        && b.producedMeasureScope === o.measureScope;
}
export interface PreviewInput {
    finishType: { id: string; code: string; name: string; version: number };
    systemVersion: { id: string; versionNumber: number; isCurrent: boolean };
    scopeVersion: string;
    occurrences: readonly PreviewOccurrence[];
    /** Every ACTIVE AreaScope of the object (the hierarchy is needed to find leaves, ancestors and descendants). */
    areas: readonly PreviewArea[];
    /** Active PRODUCER bindings of THIS finish type in the object. */
    bindings: readonly PreviewBinding[];
    /** Area ids that carry an active producer binding of ANOTHER finish type (a warning: alternative finishes are not merged, nor silently allowed). */
    otherFinishAreaIds: readonly string[];
    /** Unbound historical Works of the object whose WorkType equals a stage's WorkType: overlap cannot be proven or excluded — shown, never merged. */
    legacyWorks: readonly { workId: string; workTypeId: string }[];
    request: GenerationPreviewRequest;
}
export type BlockerRule = Extract<Gpr2ValidationRule, 'QUANTITY_MISSING' | 'UNIT_MISSING' | 'UNIT_MISMATCH' | 'AREA_OVERLAP' | 'AREA_COVERAGE_INCOMPLETE' | 'PRODUCER_EXISTS' | 'PRODUCER_INCOMPATIBLE' | 'NOTHING_TO_GENERATE' | 'REFERENCE_NOT_IN_SCOPE' | 'OUT_OF_RANGE'>;
export interface PreviewBlocker { error: Gpr2ErrorCode; rule: BlockerRule | null; path: string; occurrenceKey: string | null; areaScopeId: string | null }
export interface PreviewWarning { code: string; path: string }
export type ItemStatus = 'PROPOSED' | 'EXISTING' | 'BLOCKED';
export interface PreviewItem { occurrenceKey: string; occurrenceId: string; areaScopeId: string; status: ItemStatus; quantity: string | null; unit: string; existingWorkId: string | null }
export interface ProposedWork {
    key: string; name: string; workTypeId: string; unit: string; quantity: string; occurrenceId: string; occurrenceKey: string; position: number;
    required: boolean; measureScope: MeasureScope; areaScopeIds: string[]; areaQuantities: { areaScopeId: string; quantity: string }[]; sourceSystemVersionId: string;
    contractorId: null; responsibleUserId: null; estimatedCost: null; plannedStartDate: null; plannedFinishDate: null;
    proposedHold: { hours: string; status: 'PROPOSAL' } | null;
}
export interface ExistingWork { workId: string; occurrenceKey: string; areaScopeId: string; bindingId: string; systemVersionId: string; name: string; unit: string; quantity: string }
export interface GenerationPreview {
    previewFingerprint: string;
    scopeVersion: string;
    finishTypeId: string;
    finishTypeVersion: string;
    systemVersionId: string;
    sourceVersions: { systemVersion: string };
    grouping: typeof GENERATION_GROUPINGS[number];
    proposedWorks: ProposedWork[];
    existingWorks: ExistingWork[];
    items: PreviewItem[];
    /** QUANTITY / UNIT: a value nobody stated. AREA_COVERAGE: the part of a measured AreaScope its child AreaScopes do not represent (quantity, unit). */
    missingInputs: { kind: 'QUANTITY' | 'UNIT' | 'AREA_COVERAGE'; occurrenceKey: string; areaScopeId: string | null; quantity?: string; unit?: string }[];
    blockers: PreviewBlocker[];
    warnings: PreviewWarning[];
    canConfirm: boolean;
}

export const PREVIEW_SCHEMA = 'gpr2.r05d.preview.v1';
const byCode = (a: { code: string; id: string }, b: { code: string; id: string }) => a.code < b.code ? -1 : a.code > b.code ? 1 : a.id < b.id ? -1 : 1;

/** The leaves an AreaScope stands for: itself when it has no active child, otherwise its active descendants that have none (D20: disjoint leaves only). */
export function leavesOf(rootId: string, children: ReadonlyMap<string, string[]>): string[] {
    const out: string[] = [], stack = [rootId];
    while (stack.length) {
        const id = stack.pop()!;
        const kids = children.get(id) ?? [];
        if (!kids.length) out.push(id); else stack.push(...kids);
    }
    return out.sort();
}
/**
 * R05-GPT-B04. A measured AreaScope that has children is represented ONLY by its leaves, so the leaves must account for all of its measure in the
 * stage's unit. For every node with children inside the selected subtree whose own measure is in `unit`, the effective measure of its children (a
 * child's own measure in `unit`, or — for an unmeasured child with children — the effective measure of those) is compared with the node's measure:
 *   less    → INCOMPLETE with the uncovered quantity (never filled in: no remainder AreaScope is invented, the PM models it or selects otherwise);
 *   greater → EXCEEDED (the children count more space than the parent declares).
 * A child whose measure in `unit` is unknown makes the node's coverage unknown: not reported here, because that leaf is already a QUANTITY_MISSING /
 * UNIT_MISMATCH blocker. A node without a measure in `unit` declares nothing to cover.
 */
export function areaCoverageGaps(rootId: string, unit: string, areas: ReadonlyMap<string, PreviewArea>, children: ReadonlyMap<string, string[]>):
        { areaScopeId: string; kind: 'INCOMPLETE' | 'EXCEEDED'; quantity: DecimalString }[] {
    const measured = (id: string): DecimalString | null => {
        const a = areas.get(id);
        return a && a.measureQuantity !== null && a.measureUnit === unit ? a.measureQuantity as DecimalString : null;
    };
    const effective = (id: string): DecimalString | null => {
        const own = measured(id);
        if (own !== null) return own;
        const kids = children.get(id) ?? [];
        if (!kids.length) return null;
        const parts = kids.map(effective);
        return parts.every(p => p !== null) ? addDecimals(QUANTITY, parts as DecimalString[]) : null;
    };
    const out: { areaScopeId: string; kind: 'INCOMPLETE' | 'EXCEEDED'; quantity: DecimalString }[] = [];
    const stack = [rootId];
    while (stack.length) {
        const id = stack.pop()!;
        const kids = children.get(id) ?? [];
        if (!kids.length) continue;
        stack.push(...kids);
        const own = measured(id);
        if (own === null) continue;
        const parts = kids.map(effective);
        if (!parts.every(p => p !== null)) continue;
        const covered = addDecimals(QUANTITY, parts as DecimalString[]);
        const cmp = compareDecimals(covered, own);
        if (cmp < 0) out.push({ areaScopeId: id, kind: 'INCOMPLETE', quantity: subtractFloorZero(QUANTITY, own, covered) });
        else if (cmp > 0) out.push({ areaScopeId: id, kind: 'EXCEEDED', quantity: subtractFloorZero(QUANTITY, covered, own) });
    }
    return out.sort((a, b) => a.areaScopeId < b.areaScopeId ? -1 : a.areaScopeId > b.areaScopeId ? 1 : 0);
}
export function ancestorsOf(id: string, parent: ReadonlyMap<string, string | null>): string[] {
    const out: string[] = [];
    for (let p = parent.get(id) ?? null, guard = 0; p && guard < 10000; p = parent.get(p) ?? null, guard++) out.push(p);
    return out;
}

/** Normalised request: the part of the input that identifies the selection, independent of the order the client listed it in. */
export function normalizedRequest(r: GenerationPreviewRequest) {
    return {
        systemVersionId: r.systemVersionId, areaScopeIds: [...new Set(r.areaScopeIds)].sort(), includeOptional: [...new Set(r.includeOptional ?? [])].sort(),
        localQuantities: [...(r.localQuantities ?? [])].map(q => ({ occurrenceKey: q.occurrenceKey, areaScopeId: q.areaScopeId, quantity: q.quantity }))
            .sort((a, b) => (a.occurrenceKey + '|' + a.areaScopeId) < (b.occurrenceKey + '|' + b.areaScopeId) ? -1 : 1),
        grouping: r.grouping ?? 'PER_OCCURRENCE'
    };
}

const BLOCKER_PRIORITY: Gpr2ErrorCode[] = ['STALE_SOURCE_VERSION', 'AREA_SCOPE_CONFLICT', 'ONE_PRODUCER_CONFLICT', 'INVALID_MEASUREMENT', 'MISSING_REQUIRED_DATA'];

export function computeGenerationPreview(input: PreviewInput): GenerationPreview {
    const req = normalizedRequest(input.request);
    const areas = new Map(input.areas.map(a => [a.id, a]));
    const parent = new Map(input.areas.map(a => [a.id, a.parentId]));
    const children = new Map<string, string[]>();
    for (const a of [...input.areas].sort(byCode)) if (a.parentId && areas.has(a.parentId)) (children.get(a.parentId) ?? children.set(a.parentId, []).get(a.parentId)!).push(a.id);
    const blockers: PreviewBlocker[] = [], warnings: PreviewWarning[] = [], missingInputs: GenerationPreview['missingInputs'] = [];
    const block = (error: Gpr2ErrorCode, rule: BlockerRule | null, path: string, occurrenceKey: string | null = null, areaScopeId: string | null = null) =>
        blockers.push({ error, rule, path, occurrenceKey, areaScopeId });

    if (!input.systemVersion.isCurrent)
        block('STALE_SOURCE_VERSION', null, 'systemVersionId');

    // 1. Selected AreaScopes → disjoint leaves. Two selections where one contains the other would count the same space twice.
    const selected = req.areaScopeIds;
    for (const id of selected) {
        const up = ancestorsOf(id, parent);
        if (selected.some(other => other !== id && up.includes(other)))
            block('AREA_SCOPE_CONFLICT', 'AREA_OVERLAP', 'areaScopeIds.' + input.request.areaScopeIds.indexOf(id), null, id);
    }
    const leaves = [...new Set(selected.flatMap(id => leavesOf(id, children)))].sort();

    // 2. Which occurrences take part: every required one; an optional one only when the PM includes it by key.
    const occurrences = [...input.occurrences].sort((a, b) => a.position - b.position);
    const optionalKeys = new Set(req.includeOptional);
    const included = occurrences.filter(o => o.required || optionalKeys.has(o.occurrenceKey));

    // 3. Per occurrence and leaf: EXISTING (a producer already holds this obligation), BLOCKED or PROPOSED with a known quantity.
    const bound = new Map(input.bindings.map(b => [b.occurrenceKey + '|' + b.areaScopeId, b]));
    const boundAreasOf = new Map<string, Set<string>>();
    for (const b of input.bindings) (boundAreasOf.get(b.occurrenceKey) ?? boundAreasOf.set(b.occurrenceKey, new Set()).get(b.occurrenceKey)!).add(b.areaScopeId);
    const local = new Map(req.localQuantities.map(q => [q.occurrenceKey + '|' + q.areaScopeId, q.quantity]));
    const items: PreviewItem[] = [];
    for (const o of included) {
        // R05-GPT-B04: a MAIN stage over a measured parent is generated only when the parent's measure is fully represented by its leaves.
        if (o.measureScope === 'MAIN')
            for (const gap of [...new Map(selected.flatMap(root => areaCoverageGaps(root, o.measureUnit, areas, children)).map(g => [g.areaScopeId, g])).values()]) {
                if (gap.kind === 'INCOMPLETE') {
                    missingInputs.push({ kind: 'AREA_COVERAGE', occurrenceKey: o.occurrenceKey, areaScopeId: gap.areaScopeId, quantity: gap.quantity, unit: o.measureUnit });
                    block('MISSING_REQUIRED_DATA', 'AREA_COVERAGE_INCOMPLETE', 'areaScopeIds', o.occurrenceKey, gap.areaScopeId);
                } else block('AREA_SCOPE_CONFLICT', 'AREA_OVERLAP', 'areaScopeIds', o.occurrenceKey, gap.areaScopeId);
            }
        if (o.measureUnit !== o.workTypeUnit)
            block('INVALID_MEASUREMENT', 'UNIT_MISMATCH', 'occurrences.' + o.occurrenceKey, o.occurrenceKey);
        const descendantsBound = (leaf: string) => [...(boundAreasOf.get(o.occurrenceKey) ?? [])].some(b => b !== leaf && ancestorsOf(b, parent).includes(leaf));
        let applicable = 0;
        for (const leaf of leaves) {
            const existing = bound.get(o.occurrenceKey + '|' + leaf);
            if (existing && !producerCompatible(existing, o)) {
                // the obligation is held by a producer of another operation: not satisfied, not duplicable here (one producer per obligation)
                items.push({ occurrenceKey: o.occurrenceKey, occurrenceId: o.id, areaScopeId: leaf, status: 'BLOCKED', quantity: null, unit: o.measureUnit, existingWorkId: existing.workId });
                block('ONE_PRODUCER_CONFLICT', 'PRODUCER_INCOMPATIBLE', 'areaScopeIds', o.occurrenceKey, leaf);
                applicable++;
                continue;
            }
            if (existing) {
                items.push({ occurrenceKey: o.occurrenceKey, occurrenceId: o.id, areaScopeId: leaf, status: 'EXISTING', quantity: existing.workQuantity, unit: existing.workUnit, existingWorkId: existing.workId });
                applicable++;
                continue;
            }
            let quantity: string | null = null;
            if (o.measureScope === 'LOCAL') {
                quantity = local.get(o.occurrenceKey + '|' + leaf) ?? null;
                if (quantity === null) continue; // a LOCAL stage applies only where its own local quantity is stated
            }
            applicable++;
            const overlapping = ancestorsOf(leaf, parent).some(up => bound.has(o.occurrenceKey + '|' + up)) || descendantsBound(leaf);
            let status: ItemStatus = 'PROPOSED';
            if (overlapping) { status = 'BLOCKED'; block('ONE_PRODUCER_CONFLICT', 'PRODUCER_EXISTS', 'areaScopeIds', o.occurrenceKey, leaf); }
            if (o.measureScope === 'MAIN') {
                const a = areas.get(leaf)!;
                if (a.measureQuantity === null || a.measureUnit === null) {
                    status = 'BLOCKED'; missingInputs.push({ kind: 'QUANTITY', occurrenceKey: o.occurrenceKey, areaScopeId: leaf });
                    block('MISSING_REQUIRED_DATA', 'QUANTITY_MISSING', 'areaScopeIds', o.occurrenceKey, leaf);
                } else if (a.measureUnit !== o.measureUnit) {
                    status = 'BLOCKED'; block('INVALID_MEASUREMENT', 'UNIT_MISMATCH', 'areaScopeIds', o.occurrenceKey, leaf);
                } else quantity = a.measureQuantity;
            }
            items.push({ occurrenceKey: o.occurrenceKey, occurrenceId: o.id, areaScopeId: leaf, status, quantity, unit: o.measureUnit, existingWorkId: null });
        }
        if (o.measureScope === 'LOCAL' && o.required && applicable === 0) {
            missingInputs.push({ kind: 'QUANTITY', occurrenceKey: o.occurrenceKey, areaScopeId: null });
            block('MISSING_REQUIRED_DATA', 'QUANTITY_MISSING', 'localQuantities', o.occurrenceKey);
        }
    }
    // A local quantity that names nothing it could apply to is refused, never ignored.
    const leafSet = new Set(leaves);
    req.localQuantities.forEach((q, i) => {
        const o = included.find(x => x.occurrenceKey === q.occurrenceKey);
        if (!o || o.measureScope !== 'LOCAL' || !leafSet.has(q.areaScopeId))
            block('INVALID_MEASUREMENT', 'REFERENCE_NOT_IN_SCOPE', 'localQuantities.' + i, q.occurrenceKey, q.areaScopeId);
    });

    // 4. Group the PROPOSED items into real Works.
    const grouping = req.grouping;
    const proposedWorks: ProposedWork[] = [];
    for (const o of included) {
        const mine = items.filter(it => it.occurrenceKey === o.occurrenceKey && it.status === 'PROPOSED');
        const groups = grouping === 'PER_AREA' ? mine.map(it => [it]) : (mine.length ? [mine] : []);
        for (const g of groups) {
            const quantity = addDecimals(QUANTITY, g.map(it => it.quantity as DecimalString));
            const areaIds = g.map(it => it.areaScopeId);
            if (compareDecimals(quantity, WORK_QUANTITY_MAX) > 0)
                block('MISSING_REQUIRED_DATA', 'OUT_OF_RANGE', 'areaScopeIds', o.occurrenceKey);
            const suffix = grouping === 'PER_AREA' ? ' · ' + areas.get(areaIds[0])!.code : '';
            const name = (o.workTypeName + ' — ' + input.finishType.name + ' [' + o.occurrenceKey + ']' + suffix).slice(0, 500);
            proposedWorks.push({
                key: createHash('sha256').update(o.id + '|' + areaIds.join(','), 'utf8').digest('hex').slice(0, 32),
                name, workTypeId: o.workTypeId, unit: o.measureUnit, quantity, occurrenceId: o.id, occurrenceKey: o.occurrenceKey, position: o.position,
                required: o.required, measureScope: o.measureScope, areaScopeIds: areaIds, areaQuantities: g.map(it => ({ areaScopeId: it.areaScopeId, quantity: it.quantity! })),
                sourceSystemVersionId: input.systemVersion.id,
                contractorId: null, responsibleUserId: null, estimatedCost: null, plannedStartDate: null, plannedFinishDate: null,
                proposedHold: o.proposedHoldHours === null ? null : { hours: o.proposedHoldHours, status: 'PROPOSAL' }
            });
        }
    }
    const existingWorks: ExistingWork[] = items.filter(it => it.status === 'EXISTING').map(it => {
        const b = bound.get(it.occurrenceKey + '|' + it.areaScopeId)!;
        return { workId: b.workId, occurrenceKey: b.occurrenceKey, areaScopeId: b.areaScopeId, bindingId: b.id, systemVersionId: b.systemVersionId, name: b.workName, unit: b.workUnit, quantity: b.workQuantity };
    });
    if (!proposedWorks.length && !blockers.length)
        block(existingWorks.length ? 'ONE_PRODUCER_CONFLICT' : 'MISSING_REQUIRED_DATA', 'NOTHING_TO_GENERATE', 'areaScopeIds');

    // 5. Warnings: visible, part of the fingerprint, never a reason to invent a value.
    if (proposedWorks.length)
        warnings.push({ code: 'EARLY_WORK_UNASSIGNED', path: 'proposedWorks' }); // contractor / responsible / cost / dates stay NULL (R04 Early Work)
    if (proposedWorks.some(w => w.proposedHold))
        warnings.push({ code: 'PROPOSED_HOLD_NOT_NORMATIVE', path: 'proposedWorks' });
    if (existingWorks.some(w => w.systemVersionId !== input.systemVersion.id))
        warnings.push({ code: 'EXISTING_FROM_OTHER_VERSION', path: 'existingWorks' });
    const other = new Set(input.otherFinishAreaIds);
    for (const leaf of leaves) if (other.has(leaf)) warnings.push({ code: 'AREA_HAS_OTHER_FINISH_TYPE', path: 'areaScopeIds' });
    const stageTypes = new Set(included.map(o => o.workTypeId));
    if (input.legacyWorks.some(w => stageTypes.has(w.workTypeId)))
        warnings.push({ code: 'LEGACY_WORK_SAME_WORK_TYPE', path: 'proposedWorks' });

    const sortedBlockers = blockers.sort((a, b) => BLOCKER_PRIORITY.indexOf(a.error) - BLOCKER_PRIORITY.indexOf(b.error) || (a.path + (a.occurrenceKey ?? '') + (a.areaScopeId ?? '') < b.path + (b.occurrenceKey ?? '') + (b.areaScopeId ?? '') ? -1 : 1));
    const dedupWarnings = [...new Map(warnings.map(w => [w.code + '|' + w.path, w])).values()];
    const body = {
        schema: PREVIEW_SCHEMA, finishTypeId: input.finishType.id, finishTypeVersion: String(input.finishType.version), systemVersionId: input.systemVersion.id,
        scopeVersion: input.scopeVersion, request: req, proposedWorks, existingWorks, blockers: sortedBlockers, warnings: dedupWarnings
    };
    const previewFingerprint = createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex');
    return {
        previewFingerprint, scopeVersion: input.scopeVersion, finishTypeId: input.finishType.id, finishTypeVersion: String(input.finishType.version),
        systemVersionId: input.systemVersion.id, sourceVersions: { systemVersion: input.systemVersion.id }, grouping, proposedWorks, existingWorks, items,
        missingInputs, blockers: sortedBlockers, warnings: dedupWarnings, canConfirm: sortedBlockers.length === 0 && proposedWorks.length > 0
    };
}

/** The error a confirm answers with when the (re-computed) preview has blockers: the most specific class first, every blocker of it as a violation. */
export function blockingError(preview: Pick<GenerationPreview, 'blockers'>): Gpr2Error | null {
    if (!preview.blockers.length)
        return null;
    const first = preview.blockers[0].error;
    const violations: Gpr2Violation[] = preview.blockers.filter(b => b.error === first && b.rule).map(b => ({ path: b.path, rule: b.rule! }));
    return new Gpr2Error(first, violations.length ? { violations } : undefined);
}

/** sha256 over the canonical content of a published version (templates and object systems): what "this exact version" means. */
export function contentHash(value: unknown): string {
    return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}
