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
import { DecimalString, QUANTITY, isZeroDecimal, compareDecimals, subtractFloorZero, isPositiveDecimal } from './decimal';

// ---------------------------------------------------------------------------------------------------------------------------------
// Quantities (§6.1)
// ---------------------------------------------------------------------------------------------------------------------------------

export const ORIGINAL_PROVENANCE = ['PROVEN', 'UNKNOWN_LEGACY'] as const;
export type OriginalProvenance = typeof ORIGINAL_PROVENANCE[number];

export const PHYSICAL_STATES = ['OK', 'NOT_APPLICABLE', 'INTEGRITY_CONFLICT', 'UNKNOWN'] as const;
export type PhysicalState = typeof PHYSICAL_STATES[number];

export interface QuantityProjection {
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
    const v: string[] = [];
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

export interface ScheduleProjection {
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
 * Only the invariants the design states outright; richer evaluation arrives with R13. Each is a thing a state may NOT claim:
 *   NO_APPROVED_GPR   no baseline, no dates, no verdict, no lag (D14)
 *   NOT_INCLUDED      an approved baseline exists but not for this Work: no operative dates, no verdict, no lag (D15)
 *   REBASELINE_REQUIRED  the old baseline dates and quantity stay visible; no categorical verdict and no current lag (K02)
 *   DATA_INCOMPLETE / INTEGRITY_CONFLICT   never "on time": no verdict, no lag, and a concrete reason (§8.4)
 *   COMPLETED_COMPLETION_DATE_UNKNOWN      never an invented "on time": no verdict (§8.3)
 */
export function validateScheduleProjection(p: ScheduleProjection): string[] {
    const v: string[] = [], s = p.scheduleState;
    const mustBeNull = (label: string, value: unknown) => { if (value !== null) v.push(`${s}: ${label} must be null`); };
    if (!(SCHEDULE_STATES as readonly string[]).includes(s))
        return ['unknown scheduleState'];
    if (p.verdict !== null && !(SCHEDULE_VERDICTS as readonly string[]).includes(p.verdict))
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
        if (p.operativeStart === null || p.operativeEnd === null || p.baselineQuantity === null)
            v.push('REBASELINE_REQUIRED: the previous baseline dates and quantity stay visible');
        mustBeNull('quantityBehind', p.quantityBehind); mustBeNull('workingDayLag', p.workingDayLag); mustBeNull('verdict', p.verdict);
    }
    if (s === 'DATA_INCOMPLETE' || s === 'INTEGRITY_CONFLICT') {
        if (!p.stateReason)
            v.push(`${s}: a concrete reason is required`);
        mustBeNull('quantityBehind', p.quantityBehind); mustBeNull('workingDayLag', p.workingDayLag); mustBeNull('verdict', p.verdict);
    }
    if (s === 'COMPLETED_COMPLETION_DATE_UNKNOWN')
        mustBeNull('verdict', p.verdict);
    if ((SCHEDULE_VERDICTS as readonly string[]).includes(s) && p.verdict === null)
        v.push(`${s}: the verdict is the state and must be present`);
    return v;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Labor coverage (§7.5–7.6, K01)
// ---------------------------------------------------------------------------------------------------------------------------------

export const COVERAGE_STATES = ['COMPLETE', 'MISSING_ESTIMATE', 'UNMAPPED', 'STALE_RECIPE', 'AMBIGUOUS', 'AMBIGUOUS_EARNED_ALLOCATION', 'CONFLICT',
    'EMPTY_SCOPE', 'ZERO_WORKER_DENOMINATOR'] as const;
export type CoverageState = typeof COVERAGE_STATES[number];

export interface LaborCoverageProjection {
    coverageState: CoverageState;
    /** Worker labor only (machinists are stored but are not part of the general percent in the first version). */
    plannedWorkerHours: DecimalString | null;
    earnedWorkerHours: DecimalString | null;
    objectPhysicalPercent: DecimalString | null;
    calculationVersion: string;
    sourceVersion: string;
    computedAt: string;
}

/** The general physical readiness exists only for COMPLETE coverage with a positive worker denominator; everything else is null, never 0 or 100. */
export function validateLaborCoverage(p: LaborCoverageProjection): string[] {
    const v: string[] = [];
    const computable = p.coverageState === 'COMPLETE' && p.plannedWorkerHours !== null && isPositiveDecimal(p.plannedWorkerHours);
    if (p.objectPhysicalPercent !== null && !computable)
        v.push('objectPhysicalPercent must be null unless coverage is COMPLETE with a positive planned worker-hours denominator');
    if (p.coverageState === 'COMPLETE' && p.plannedWorkerHours === null)
        v.push('COMPLETE coverage must state its planned worker hours');
    if (p.earnedWorkerHours !== null && p.plannedWorkerHours !== null && compareDecimals(p.earnedWorkerHours, p.plannedWorkerHours) > 0 && p.coverageState === 'COMPLETE')
        v.push('earned worker hours cannot exceed planned (0 ≤ f ≤ q)');
    return v;
}
