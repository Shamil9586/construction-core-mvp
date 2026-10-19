/**
 * GPR-2 R01 — the read contracts: four different quantities, the schedule state, labor coverage (Technical Design §6.1, §7.6, §8.3–8.4, §10.3;
 * decisions D04/D09/D13–D15/D19, K01/K02, C04/C05/C08/C09).
 *
 * THE QUANTITIES ARE NEVER ONE FIELD. The design separates what each number means, and a type per meaning keeps one from standing in for
 * another (a current quantity is not "the baseline", a labor-coverage figure is not a fact):
 *
 *   originalQuantity   the proven original BoQ figure; null with provenance UNKNOWN_LEGACY when the legacy data cannot prove one — "the
 *                      current planned value" is NEVER presented as the original
 *   currentQuantity    the latest approved quantity version — the production task and the denominator of physical progress
 *   baselineQuantity   the quantity snapshot of the approved GPR entry; null when the Work has no approved baseline
 *   rpFactQuantity     what the project manager reported (the authoritative RP_FACT); null when no unambiguous source is proven
 *   labor coverage     a separate projection (LaborCoverageProjection) — its percent is null unless coverage is COMPLETE
 *
 * NULL IS NOT ZERO, anywhere in these contracts. A null says "not known / does not apply"; "0.0000" is a real zero. current = 0 with a fact of
 * 0 is NOT_APPLICABLE, not "100 % done"; a fact above current is INTEGRITY_CONFLICT and is shown, not clamped to 100 %.
 *
 * Only exact arithmetic lives here (a subtraction floored at zero). No percent is computed in R01: a division needs a rounding point, and
 * those belong to the stages that own the calculation (R06, R13, R17). The validators below pin what a projection may NOT claim.
 */
import { DecimalString, DecimalProfile, QUANTITY, NORMATIVE, parseDecimal, isZeroDecimal, compareDecimals, subtractFloorZero, isPositiveDecimal } from './decimal';
import { isCivilDate, isIsoTimestamp, isTimeZoneName } from './civil-date';

// ---------------------------------------------------------------------------------------------------------------------------------
// What every projection carries (§5.1, §10.3, §12.2) — R01-B07
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * §5.1: "Каждая projection несёт calculation_version, source_version, computed_at, coverage_state; её можно перестроить из immutable records."
 * §12.2: "Projection содержит все source version IDs, чтобы UI не склеивал ответы разных версий."
 *
 *   calculationVersion  which formula / code revision produced the numbers
 *   sourceVersion       one token naming the exact set of source versions the projection was built from
 *   sourceVersionIds    those source versions by name (a quantity version, a calendar version, a revision …): uuids of immutable rows
 *   computedAt          the instant of the calculation, ISO-8601 with an explicit offset (§11.1: "timestamps ISO UTC + timezone metadata")
 *
 * `coverage_state` is the labor projection's own `coverageState`; for the quantity and schedule projections the design's equivalent is their
 * state field (`physicalState`, `scheduleState`) — no third enum is invented for them (listed as a deferred interpretation in the contract document).
 */
export interface ProjectionMeta {
    calculationVersion: string;
    sourceVersion: string;
    sourceVersionIds: Record<string, string>;
    computedAt: string;
}
const TOKEN = /^[A-Za-z0-9._:-]{1,64}$/;
const SOURCE_KEY = /^[A-Za-z0-9_.-]{1,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/** A decimal in a projection is the CANONICAL string of its profile (exactly what serializeDecimal writes): `100` is not `100.000000000000`. */
const canonicalDecimal = (profile: DecimalProfile, value: unknown): value is DecimalString => {
    const r = parseDecimal(profile, value);
    return r.ok === true && r.value === value;
};
const checkDecimal = (v: string[], label: string, profile: DecimalProfile, value: unknown) => {
    if (value !== null && !canonicalDecimal(profile, value))
        v.push(`${label} must be null or a canonical ${profile.name} decimal string`);
};

/** `allowNoSources`: a state that has nothing to be derived from (no approved GPR, an empty scope) may carry an empty source map; every other projection names at least one. */
export function validateProjectionMeta(p: Partial<ProjectionMeta> | null | undefined, options: { allowNoSources?: boolean } = {}): string[] {
    const v: string[] = [];
    if (!p || typeof p !== 'object')
        return ['projection metadata (calculationVersion, sourceVersion, sourceVersionIds, computedAt) is missing'];
    if (typeof p.calculationVersion !== 'string' || !TOKEN.test(p.calculationVersion))
        v.push('calculationVersion is required (a short token)');
    if (typeof p.sourceVersion !== 'string' || !TOKEN.test(p.sourceVersion))
        v.push('sourceVersion is required (a short token)');
    if (!isPlain(p.sourceVersionIds))
        v.push('sourceVersionIds is required (an object of named source version ids)');
    else {
        const entries = Object.entries(p.sourceVersionIds);
        if (entries.length === 0 && !options.allowNoSources)
            v.push('sourceVersionIds must name at least one source version');
        for (const [name, id] of entries)
            if (!SOURCE_KEY.test(name) || name === '__proto__' || typeof id !== 'string' || !UUID_RE.test(id))
                v.push('sourceVersionIds: every entry is a safe name and the uuid of an immutable version');
    }
    if (!isIsoTimestamp(p.computedAt))
        v.push('computedAt must be an ISO-8601 instant with an explicit offset');
    return v;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Quantities (§6.1)
// ---------------------------------------------------------------------------------------------------------------------------------

export const ORIGINAL_PROVENANCE = ['PROVEN', 'UNKNOWN_LEGACY'] as const;
export type OriginalProvenance = typeof ORIGINAL_PROVENANCE[number];

export const PHYSICAL_STATES = ['OK', 'NOT_APPLICABLE', 'INTEGRITY_CONFLICT', 'UNKNOWN'] as const;
export type PhysicalState = typeof PHYSICAL_STATES[number];

export interface QuantityProjection extends ProjectionMeta {
    originalQuantity: DecimalString | null;
    originalProvenance: OriginalProvenance;
    currentQuantity: DecimalString;
    currentQuantityVersionId: string;
    baselineQuantity: DecimalString | null;
    rpFactQuantity: DecimalString | null;
    /** Approved adjustment ledger — an explanation of the change of the task, never a fact (D19). */
    excludedQuantity: DecimalString | null;
    addedQuantity: DecimalString | null;
    remainingQuantity: DecimalString | null;
    physicalState: PhysicalState;
    /** Present only when physicalState is OK; computed by R06 (R01 fixes only that it must otherwise be null). */
    workPhysicalPercent: DecimalString | null;
}

/** What the relation between the current task and the proven fact is — without clamping and without inventing a number. */
export function classifyPhysical(current: DecimalString, rpFact: DecimalString | null): PhysicalState {
    if (rpFact === null)
        return 'UNKNOWN';
    if (isZeroDecimal(current))
        return isZeroDecimal(rpFact) ? 'NOT_APPLICABLE' : 'INTEGRITY_CONFLICT';
    return compareDecimals(rpFact, current) > 0 ? 'INTEGRITY_CONFLICT' : 'OK';
}
/** max(current − fact, 0) when the data is valid; null for a conflict or an unproven fact — a clamp would hide the violation. */
export function remainingQuantityOf(current: DecimalString, rpFact: DecimalString | null): DecimalString | null {
    const state = classifyPhysical(current, rpFact);
    return state === 'OK' || state === 'NOT_APPLICABLE' ? subtractFloorZero(QUANTITY, current, rpFact as DecimalString) : null;
}

export function validateQuantityProjection(p: QuantityProjection): string[] {
    if (!p || typeof p !== 'object')
        return ['the quantity projection is missing'];
    const v: string[] = validateProjectionMeta(p);
    if (typeof p.currentQuantityVersionId !== 'string' || !UUID_RE.test(p.currentQuantityVersionId))
        v.push('currentQuantityVersionId must be the uuid of the current approved quantity version');
    for (const [label, value] of [['originalQuantity', p.originalQuantity], ['currentQuantity', p.currentQuantity], ['baselineQuantity', p.baselineQuantity], ['rpFactQuantity', p.rpFactQuantity],
        ['excludedQuantity', p.excludedQuantity], ['addedQuantity', p.addedQuantity], ['remainingQuantity', p.remainingQuantity]] as const)
        checkDecimal(v, label, QUANTITY, value);
    if (!canonicalDecimal(QUANTITY, p.currentQuantity))
        v.push('currentQuantity is required (a quantity can be 0.0000 but is never unknown)');
    if (p.workPhysicalPercent !== null && (!canonicalDecimal(NORMATIVE, p.workPhysicalPercent) || compareDecimals(p.workPhysicalPercent, '100.000000000000' as DecimalString) > 0))
        v.push('workPhysicalPercent must be null or a percent between 0 and 100');
    if (!canonicalDecimal(QUANTITY, p.currentQuantity) || (p.rpFactQuantity !== null && !canonicalDecimal(QUANTITY, p.rpFactQuantity)))
        return v; // the derived-state checks below need valid numbers
    if (p.originalProvenance === 'UNKNOWN_LEGACY' && p.originalQuantity !== null)
        v.push('UNKNOWN_LEGACY original must be null, never the current value or 0');
    if (p.originalProvenance === 'PROVEN' && p.originalQuantity === null)
        v.push('a PROVEN original must carry its value');
    if (p.physicalState !== classifyPhysical(p.currentQuantity, p.rpFactQuantity))
        v.push('physicalState does not follow from current and rpFact');
    if (p.physicalState !== 'OK' && p.workPhysicalPercent !== null)
        v.push('workPhysicalPercent must be null unless physicalState is OK');
    if (p.remainingQuantity !== remainingQuantityOf(p.currentQuantity, p.rpFactQuantity))
        v.push('remainingQuantity must be max(current − fact, 0), or null when the data is not valid');
    return v;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Schedule state (§8.4, §10.3)
// ---------------------------------------------------------------------------------------------------------------------------------

/** In the priority order of §8.4: the first condition that holds decides the state. */
export const SCHEDULE_STATES = ['NO_APPROVED_GPR', 'NOT_INCLUDED', 'REBASELINE_REQUIRED', 'DATA_INCOMPLETE', 'INTEGRITY_CONFLICT', 'NOT_STARTED_BY_PLAN',
    'ON_PLAN', 'BEHIND', 'COMPLETED_ON_TIME', 'COMPLETED_LATE', 'COMPLETED_COMPLETION_DATE_UNKNOWN'] as const;
export type ScheduleState = typeof SCHEDULE_STATES[number];
/** The categorical verdicts. A state outside this set never carries one. */
export const SCHEDULE_VERDICTS = ['ON_PLAN', 'BEHIND', 'COMPLETED_ON_TIME', 'COMPLETED_LATE'] as const;
export type ScheduleVerdict = typeof SCHEDULE_VERDICTS[number];

export interface ScheduleProjection extends ProjectionMeta {
    baselineRevisionId: string | null;
    calendarVersionId: string | null;
    objectTimezone: string | null;
    /** Last fully completed local day the evaluation covers (§8.2); a day in progress is never "overdue". */
    evaluatedThroughLocalDate: string | null;
    scheduleState: ScheduleState;
    /** Why the state is DATA_INCOMPLETE / INTEGRITY_CONFLICT / NOT_INCLUDED, when known. */
    stateReason: string | null;
    operativeStart: string | null;
    operativeEnd: string | null;
    baselineQuantity: DecimalString | null;
    quantityBehind: DecimalString | null;
    /** Working-day lag is a decimal (it is fractional in general), in the NORMATIVE profile. */
    workingDayLag: DecimalString | null;
    verdict: ScheduleVerdict | null;
}

/**
 * Structural invariants of a ScheduleProjection — what a state may NOT claim, and what it MUST be able to point at (R01-B07). R13 owns the calculation;
 * these rules need no engine, only the design's own definitions:
 *
 *   identity / formats   a revision / calendar / version id is a uuid; the timezone an IANA name; dates real civil days; quantities canonical decimals
 *                        (baseline > 0 where it is used, §8.3 "Qb>0"; behind ≥ 0, lag ≥ 0 — both are max(…, 0))
 *   NO_APPROVED_GPR      no baseline, no dates, no verdict, no lag (D14)
 *   NOT_INCLUDED         an approved revision exists but not for this Work: no operative dates, no verdict, no lag (D15)
 *   REBASELINE_REQUIRED  the PREVIOUS baseline (its revision, dates and quantity) stays visible; no categorical verdict and no current lag (K02)
 *   DATA_INCOMPLETE / INTEGRITY_CONFLICT   never "on time": no verdict, no lag, and a concrete reason (§8.4)
 *   a comparable state   NOT_STARTED_BY_PLAN, ON_PLAN, BEHIND, COMPLETED_ON_TIME, COMPLETED_LATE need an APPROVED BASELINE to compare with: its revision,
 *                        the calendar version it froze, the object timezone, the evaluation date, the operative dates and a positive baseline quantity.
 *                        "ON_PLAN" with no baseline is the contradiction D14 forbids: without an approved baseline nothing can be on plan.
 *   verdict ↔ lag        ON_PLAN: nothing behind (0 and 0) · BEHIND: a positive gap AND a positive lag · COMPLETED_ON_TIME: lag 0 ·
 *                        COMPLETED_LATE: lag > 0 · NOT_STARTED_BY_PLAN: nothing behind yet (null or 0), no verdict ·
 *                        COMPLETED_COMPLETION_DATE_UNKNOWN: no verdict and no lag — the moment is unproven (§8.3), nothing is invented
 */
export const COMPARABLE_SCHEDULE_STATES: readonly ScheduleState[] = ['NOT_STARTED_BY_PLAN', 'ON_PLAN', 'BEHIND', 'COMPLETED_ON_TIME', 'COMPLETED_LATE'];

export function validateScheduleProjection(p: ScheduleProjection): string[] {
    const s = p?.scheduleState;
    if (!(SCHEDULE_STATES as readonly string[]).includes(s))
        return ['unknown scheduleState'];
    const v: string[] = validateProjectionMeta(p, { allowNoSources: s === 'NO_APPROVED_GPR' });
    const mustBeNull = (label: string, value: unknown) => { if (value !== null) v.push(`${s}: ${label} must be null`); };
    const mustHave = (label: string, value: unknown) => { if (value === null || value === undefined) v.push(`${s}: ${label} is required`); };

    // formats of every identity / date / number that is present
    for (const [label, id] of [['baselineRevisionId', p.baselineRevisionId], ['calendarVersionId', p.calendarVersionId]] as const)
        if (id !== null && (typeof id !== 'string' || !UUID_RE.test(id)))
            v.push(`${label} must be null or a uuid`);
    if (p.objectTimezone !== null && !isTimeZoneName(p.objectTimezone))
        v.push('objectTimezone must be null or an IANA time zone name');
    for (const [label, d] of [['evaluatedThroughLocalDate', p.evaluatedThroughLocalDate], ['operativeStart', p.operativeStart], ['operativeEnd', p.operativeEnd]] as const)
        if (d !== null && !isCivilDate(d))
            v.push(`${label} must be null or a real calendar date (YYYY-MM-DD)`);
    if (isCivilDate(p.operativeStart) && isCivilDate(p.operativeEnd) && p.operativeStart > p.operativeEnd)
        v.push('operativeStart must not be after operativeEnd');
    checkDecimal(v, 'baselineQuantity', QUANTITY, p.baselineQuantity);
    checkDecimal(v, 'quantityBehind', QUANTITY, p.quantityBehind);
    checkDecimal(v, 'workingDayLag', NORMATIVE, p.workingDayLag);
    const num = (profile: DecimalProfile, x: unknown) => (canonicalDecimal(profile, x) ? x : null);
    const baseline = num(QUANTITY, p.baselineQuantity), behind = num(QUANTITY, p.quantityBehind), lag = num(NORMATIVE, p.workingDayLag);
    const positive = (x: DecimalString | null) => x !== null && isPositiveDecimal(x);
    const zero = (x: DecimalString | null) => x !== null && isZeroDecimal(x);

    if (p.verdict !== null && !(SCHEDULE_VERDICTS as readonly string[]).includes(p.verdict as string))
        v.push('verdict is not a categorical verdict');
    if (p.verdict !== null && p.verdict !== s)
        v.push('verdict must equal the scheduleState it names');
    if (s === 'NO_APPROVED_GPR') {
        mustBeNull('baselineRevisionId', p.baselineRevisionId); mustBeNull('operativeStart', p.operativeStart); mustBeNull('operativeEnd', p.operativeEnd);
        mustBeNull('baselineQuantity', p.baselineQuantity); mustBeNull('quantityBehind', p.quantityBehind); mustBeNull('workingDayLag', p.workingDayLag);
        mustBeNull('verdict', p.verdict);
    }
    if (s === 'NOT_INCLUDED') {
        if (p.baselineRevisionId === null)
            v.push('NOT_INCLUDED: an approved revision must exist (otherwise the state is NO_APPROVED_GPR)');
        mustBeNull('operativeStart', p.operativeStart); mustBeNull('operativeEnd', p.operativeEnd); mustBeNull('baselineQuantity', p.baselineQuantity);
        mustBeNull('quantityBehind', p.quantityBehind); mustBeNull('workingDayLag', p.workingDayLag); mustBeNull('verdict', p.verdict);
    }
    if (s === 'REBASELINE_REQUIRED') {
        if (p.baselineRevisionId === null || p.operativeStart === null || p.operativeEnd === null || p.baselineQuantity === null)
            v.push('REBASELINE_REQUIRED: the previous baseline revision, dates and quantity stay visible');
        mustBeNull('quantityBehind', p.quantityBehind); mustBeNull('workingDayLag', p.workingDayLag); mustBeNull('verdict', p.verdict);
    }
    if (s === 'DATA_INCOMPLETE' || s === 'INTEGRITY_CONFLICT') {
        if (!p.stateReason)
            v.push(`${s}: a concrete reason is required`);
        mustBeNull('quantityBehind', p.quantityBehind); mustBeNull('workingDayLag', p.workingDayLag); mustBeNull('verdict', p.verdict);
    }
    if (s === 'COMPLETED_COMPLETION_DATE_UNKNOWN') {
        mustBeNull('verdict', p.verdict); mustBeNull('workingDayLag', p.workingDayLag);
        for (const [label, value] of [['baselineRevisionId', p.baselineRevisionId], ['operativeStart', p.operativeStart], ['operativeEnd', p.operativeEnd], ['baselineQuantity', p.baselineQuantity]] as const)
            mustHave(label, value);
    }
    if (COMPARABLE_SCHEDULE_STATES.includes(s)) {
        // D14 / §8.4: a comparison needs something to compare with
        for (const [label, value] of [['baselineRevisionId', p.baselineRevisionId], ['calendarVersionId', p.calendarVersionId], ['objectTimezone', p.objectTimezone],
            ['evaluatedThroughLocalDate', p.evaluatedThroughLocalDate], ['operativeStart', p.operativeStart], ['operativeEnd', p.operativeEnd], ['baselineQuantity', p.baselineQuantity]] as const)
            mustHave(label, value);
        if (baseline !== null && !positive(baseline))
            v.push(`${s}: baselineQuantity must be positive (Qb > 0)`);
        if (s !== 'NOT_STARTED_BY_PLAN' && (p.verdict === null || p.verdict === undefined))
            v.push(`${s}: the verdict is the state and must be present`);
    }
    if (s === 'NOT_STARTED_BY_PLAN') {
        if ((p.quantityBehind !== null && !zero(behind)) || (p.workingDayLag !== null && !zero(lag)))
            v.push('NOT_STARTED_BY_PLAN: nothing can be behind before the planned start');
    }
    if (s === 'ON_PLAN' && !(zero(behind) && zero(lag)))
        v.push('ON_PLAN: quantityBehind and workingDayLag must both be 0 (known zeros, not unknowns)');
    if (s === 'BEHIND' && !(positive(behind) && positive(lag)))
        v.push('BEHIND: quantityBehind and workingDayLag must both be positive');
    if (s === 'COMPLETED_ON_TIME' && !(zero(lag) && (p.quantityBehind === null || zero(behind))))
        v.push('COMPLETED_ON_TIME: the final lag is 0 and nothing is left behind');
    if (s === 'COMPLETED_LATE' && !(positive(lag) && (p.quantityBehind === null || zero(behind))))
        v.push('COMPLETED_LATE: the final lag is positive and nothing is left behind');
    return v;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Labor coverage (§7.5–7.6, K01)
// ---------------------------------------------------------------------------------------------------------------------------------

export const COVERAGE_STATES = ['COMPLETE', 'MISSING_ESTIMATE', 'UNMAPPED', 'STALE_RECIPE', 'AMBIGUOUS', 'AMBIGUOUS_EARNED_ALLOCATION', 'CONFLICT',
    'EMPTY_SCOPE', 'ZERO_WORKER_DENOMINATOR'] as const;
export type CoverageState = typeof COVERAGE_STATES[number];

export interface LaborCoverageProjection extends ProjectionMeta {
    coverageState: CoverageState;
    /** Worker labor only (machinists are stored but are not part of the general percent in the first version). */
    plannedWorkerHours: DecimalString | null;
    earnedWorkerHours: DecimalString | null;
    objectPhysicalPercent: DecimalString | null;
}

/**
 * K01 / §7.5–7.6. The general physical readiness is `100 × earned / planned`, only for COMPLETE coverage and a positive denominator; everything else is
 * null — never 0, never 100. R01 does not compute it, it pins what a projection may NOT claim (R01-B07):
 *
 *   a numeric percent needs ALL of its basis: COMPLETE coverage, planned > 0 AND earned KNOWN (null ≠ 0: an unknown numerator is not a zero numerator,
 *   so `COMPLETE + earned null + percent 100` is refused), and 0 ≤ percent ≤ 100; earned = 0 ⇒ percent 0 and earned = planned ⇒ percent 100 (both exact)
 *   COMPLETE           planned > 0 and, when earned is known, 0 ≤ earned ≤ planned (0 ≤ f ≤ q) and the percent present — §7.6: "COMPLETE, denominator>0 → число".
 *                      Coverage is about the NORMS being complete; an unknown numerator (earned null) is allowed and then the percent is null, not 0
 *   ZERO_WORKER_DENOMINATOR   planned is a KNOWN zero (a missing estimate is not a zero denominator), earned zero or unknown, percent null. A zero denominator
 *                      is never COMPLETE and never 0 % or 100 %
 *   every other state  percent null
 */
export function validateLaborCoverage(p: LaborCoverageProjection): string[] {
    if (!(COVERAGE_STATES as readonly string[]).includes(p?.coverageState))
        return ['unknown coverageState'];
    const v: string[] = validateProjectionMeta(p, { allowNoSources: p.coverageState === 'EMPTY_SCOPE' });
    checkDecimal(v, 'plannedWorkerHours', NORMATIVE, p.plannedWorkerHours);
    checkDecimal(v, 'earnedWorkerHours', NORMATIVE, p.earnedWorkerHours);
    checkDecimal(v, 'objectPhysicalPercent', NORMATIVE, p.objectPhysicalPercent);
    const num = (x: unknown) => (canonicalDecimal(NORMATIVE, x) ? x : null);
    const planned = num(p.plannedWorkerHours), earned = num(p.earnedWorkerHours), percent = num(p.objectPhysicalPercent);
    const state = p.coverageState;
    const COMPLETE = state === 'COMPLETE';

    if (percent !== null) {
        if (!COMPLETE)
            v.push('objectPhysicalPercent must be null unless coverage is COMPLETE with a positive planned worker-hours denominator');
        else if (planned === null || !isPositiveDecimal(planned))
            v.push('objectPhysicalPercent needs a positive planned worker-hours denominator');
        if (earned === null)
            v.push('objectPhysicalPercent needs KNOWN earned worker hours (an unknown numerator is not 0 and not 100 %)');
        if (compareDecimals(percent, '100.000000000000' as DecimalString) > 0)
            v.push('objectPhysicalPercent cannot exceed 100');
        if (earned !== null && planned !== null && isPositiveDecimal(planned)) {
            if (isZeroDecimal(earned) && !isZeroDecimal(percent))
                v.push('zero earned worker hours cannot give a non-zero percent');
            if (compareDecimals(earned, planned) === 0 && compareDecimals(percent, '100.000000000000' as DecimalString) !== 0)
                v.push('earned = planned is exactly 100 %');
        }
    }
    if (COMPLETE) {
        if (planned === null)
            v.push('COMPLETE coverage must state its planned worker hours');
        else if (!isPositiveDecimal(planned))
            v.push('COMPLETE needs a positive denominator: a zero planned worker-hours total is ZERO_WORKER_DENOMINATOR, not COMPLETE');
        if (planned !== null && earned !== null && compareDecimals(earned, planned) > 0)
            v.push('earned worker hours cannot exceed planned (0 ≤ f ≤ q)');
        if (planned !== null && isPositiveDecimal(planned) && earned !== null && p.objectPhysicalPercent === null)
            v.push('COMPLETE with a positive denominator and known earned hours must carry the percent (§7.6)');
    }
    if (state === 'ZERO_WORKER_DENOMINATOR') {
        if (planned === null || !isZeroDecimal(planned))
            v.push('ZERO_WORKER_DENOMINATOR: planned worker hours must be a KNOWN zero (an unknown total is a missing estimate, not a zero denominator)');
        if (earned !== null && !isZeroDecimal(earned))
            v.push('ZERO_WORKER_DENOMINATOR: nothing can be earned against a zero plan');
    }
    return v;
}
