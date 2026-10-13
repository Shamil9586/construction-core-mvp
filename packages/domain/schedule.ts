/**
 * GPR-1 — Production Schedule («График производства работ»): pure rules (no database).
 *
 * There is ONE general production schedule per Object. It is not a second Work model: a schedule entry points at the production scope
 * the domain already owns —
 *
 *   * a Work Execution Unit  (work_execution_units: work type + finish type + conditions + zone `location` + contractor + unit + planned
 *     quantity) — the narrowest scope that carries its own zone, contractor and planned quantity; or
 *   * the Work itself, only for a Work that has no execution units (the simple pre-F8.1 shape).
 *
 * The entry stores only what planning adds on top of that scope: planned start / finish, the order in the schedule and an optional
 * «follows» reference. The planned quantity, the unit, the contractor and the zone are READ from the production model — never copied.
 *
 * Dates live in versioned REVISIONS of the object's schedule: DRAFT (being prepared) → APPROVED (the current baseline) → SUPERSEDED (replaced
 * by a later approved revision, kept forever). Plan-versus-fact is always computed against the current APPROVED revision; a draft is never
 * authoritative. Correcting an approved plan = a new draft cloned from it, approved with a reason; the approved revision it replaces is not
 * rewritten.
 *
 * Physical progress comes from the production facts that already exist — see SCHEDULE_PROGRESS_SOURCE. Nothing here reads, or may ever
 * read, AOSR / executive schemes / documentation packages / SDO / closing amounts: documentation moves independently of construction.
 */
import Decimal from 'decimal.js';
import { ProgressCalculationService } from './index';

// ---------------------------------------------------------------------------------------------------------------------------------
// Civil dates. A planned date is a calendar date, not an instant; every comparison below is on whole days.
// ---------------------------------------------------------------------------------------------------------------------------------

const CIVIL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isCivilDate(value: unknown): value is string {
    if (typeof value !== 'string' || !CIVIL_DATE.test(value))
        return false;
    const parsed = new Date(value + 'T00:00:00Z');
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Whole days since 1970-01-01 (UTC) — an exact integer for any valid civil date. */
export function civilDayNumber(value: string): number {
    const m = CIVIL_DATE.exec(value);
    if (!m)
        throw new Error('Некорректная дата: ' + value);
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000;
}

/**
 * «Today» as a civil date. The same notion the rest of the system already uses (PostgreSQL CURRENT_DATE on the UTC session the pool opens,
 * `new Date().toISOString()` in the read model), so the schedule and the existing readiness figures never disagree about what day it is.
 */
export function todayCivil(now: Date = new Date()): string {
    return now.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------------------------------------------------

export const SCHEDULE_REVISION_STATUSES = ['DRAFT', 'APPROVED', 'SUPERSEDED', 'DISCARDED'] as const;
export type ScheduleRevisionStatus = (typeof SCHEDULE_REVISION_STATUSES)[number];

/**
 * The one allow-list for a revision's life, mirrored by the database trigger (pending migration): a draft is approved or discarded; an
 * approved revision can only be superseded; superseded and discarded revisions never change again.
 */
const ALLOWED_REVISION_TRANSITIONS: Record<ScheduleRevisionStatus, ScheduleRevisionStatus[]> = {
    DRAFT: ['APPROVED', 'DISCARDED'],
    APPROVED: ['SUPERSEDED'],
    SUPERSEDED: [],
    DISCARDED: [],
};
export function isScheduleRevisionTransitionAllowed(from: string, to: string): boolean {
    return (ALLOWED_REVISION_TRANSITIONS as Record<string, string[]>)[from]?.includes(to) ?? false;
}

/**
 * Where schedule PHYSICAL progress comes from, per management view. One answer for every GPR view, so the table, the Work card and the
 * Object overview can never show different figures for the same scope:
 *
 *   RP_FACT — the quantity the project manager reported (portion_quantity_confirmations.source = 'RP_FACT', latest per portion, summed per
 *             execution unit; works.actual_quantity only for a Work with no execution units). It is the very figure the existing
 *             «Физическая готовность» of the Object overview is built from (resolveActualQuantity), so GPR does not change global readiness.
 *
 * Internal СК accepted quantity (498 against 500) is a separate contour: it is shown NEXT to the fact where useful and never replaces it,
 * never gates «Выполнено», never feeds status or delay. Construction control confirms quality; the schedule asks whether the work is
 * being done on time. Customer СК, ПТО packages, SDO and closing amounts have no input here at all.
 */
export const SCHEDULE_PROGRESS_SOURCE = 'RP_FACT' as const;
export type ScheduleProgressSource = typeof SCHEDULE_PROGRESS_SOURCE;

/** Management states of one schedule entry. «Есть отставание» overrides «Не начато» / «В работе»; «Выполнено» is never delayed. */
export const SCHEDULE_ENTRY_STATES = ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'DELAYED'] as const;
export type ScheduleEntryState = (typeof SCHEDULE_ENTRY_STATES)[number];

/** Where the calendar says the entry should be on the day in question. */
export type ScheduleExpectedPhase = 'NOT_DUE' | 'UNDERWAY' | 'DUE_COMPLETE';

/** Why a delayed entry is delayed — the label of the cause, not a second delay figure. */
export type ScheduleDelayKind = 'START' | 'PROGRESS' | 'FINISH';

export type ObjectScheduleStatus = 'NO_BASELINE' | 'ON_TRACK' | 'DELAYED';

// ---------------------------------------------------------------------------------------------------------------------------------
// Plan versus fact for ONE entry
// ---------------------------------------------------------------------------------------------------------------------------------

export interface ScheduleEntryFacts {
    plannedStart: string;
    plannedFinish: string;
    /** The scope's planned quantity, read from the production model (execution unit or work). */
    plannedQuantity: string | number;
    /** Latest RP fact of the scope. `null` = nothing was ever reported — a different fact from a reported 0. */
    rpFactQuantity: string | number | null;
}

export interface ScheduleEntryStatus {
    /** Linear plan on the day: 0 before the start, 100 from the finish date on (business rule 2). */
    plannedProgress: number;
    /** min(100, fact / plan × 100) — the figure the existing readiness uses. `null` only if the plan quantity is not positive. */
    actualProgress: number | null;
    /** A fact row exists (a reported 0 counts). `false` renders as «—», never as 0%. */
    factReported: boolean;
    /** Reported quantity above the plan — a visible signal, kept apart from the clamped percentage. */
    overperformed: boolean;
    expectedPhase: ScheduleExpectedPhase;
    state: ScheduleEntryState;
    /** Whole calendar days; 0 unless the state is DELAYED. */
    delayDays: number;
    delayKind: ScheduleDelayKind | null;
}

/**
 * Planned progress on a day — the accepted linear plan (business rule 2), on whole civil days: 0 before the start, 100 on and after the
 * finish date (a zero-length plan is 100 on its date), linear in between.
 */
export function plannedProgressOn(plannedStart: string, plannedFinish: string, today: string): number {
    const start = civilDayNumber(plannedStart), finish = civilDayNumber(plannedFinish), t = civilDayNumber(today);
    if (t < start)
        return 0;
    if (t >= finish)
        return 100;
    return ((t - start) / (finish - start)) * 100;
}

export function expectedPhaseOn(plannedStart: string, plannedFinish: string, today: string): ScheduleExpectedPhase {
    const start = civilDayNumber(plannedStart), finish = civilDayNumber(plannedFinish), t = civilDayNumber(today);
    if (t < start)
        return 'NOT_DUE';
    return t >= finish ? 'DUE_COMPLETE' : 'UNDERWAY';
}

/**
 * The status of one entry on `today`, from the APPROVED dates and the production facts — never a colour somebody chose.
 *
 *  * Выполнено   — the reported quantity reached the planned quantity. Independent of СК acceptance, ИД, ПТО, СДО and money.
 *  * Есть отставание — behind the linear plan by at least one whole calendar day. `delayDays` is the accepted business rule 3: the number of
 *    days between today and the date on which the linear plan would have reached the share already done (not a CPM forecast). A lag below
 *    one day is not a delay, so a fact of 49% against a plan of 50% mid-flow does not raise an alarm; a work that has not started a day
 *    after its start date, or is unfinished on its finish date, always does. A completed entry is never delayed.
 *  * В работе    — a fact above zero, not behind the plan.
 *  * Не начато   — no fact (or a reported 0) and the start date has not passed.
 *
 * The delay is decided with exact decimal arithmetic on quantities (no division until the final floor), so 1/3 of a quantity never turns
 * into 0.9999999 of a day.
 */
export function deriveScheduleEntryStatus(facts: ScheduleEntryFacts, today: string): ScheduleEntryStatus {
    const start = civilDayNumber(facts.plannedStart), finish = civilDayNumber(facts.plannedFinish), t = civilDayNumber(today);
    const plannedProgress = plannedProgressOn(facts.plannedStart, facts.plannedFinish, today);
    const expectedPhase = expectedPhaseOn(facts.plannedStart, facts.plannedFinish, today);
    const plan = new Decimal(facts.plannedQuantity);
    const factReported = facts.rpFactQuantity !== null && facts.rpFactQuantity !== undefined;
    const fact = new Decimal(factReported ? facts.rpFactQuantity! : 0);
    const actualProgress = new ProgressCalculationService().calculate(fact, plan);
    const base = { plannedProgress, actualProgress, factReported, overperformed: plan.gt(0) && fact.gt(plan), expectedPhase };
    if (!plan.gt(0)) {
        // Defensive only: the schema forbids a non-positive planned quantity. Nothing can be measured, so nothing is claimed.
        return { ...base, state: 'NOT_STARTED', delayDays: 0, delayKind: null };
    }
    if (fact.gte(plan))
        return { ...base, state: 'COMPLETED', delayDays: 0, delayKind: null };
    // lag (days) = (t − start) − duration × fact/plan ; multiply through by plan > 0 to stay exact.
    const duration = finish - start;
    const scaledLag = new Decimal(t - start).mul(plan).minus(new Decimal(duration).mul(fact));
    const delayDays = scaledLag.gte(plan) ? scaledLag.divToInt(plan).toNumber() : 0;
    if (delayDays >= 1) {
        const delayKind: ScheduleDelayKind = t >= finish ? 'FINISH' : fact.lte(0) ? 'START' : 'PROGRESS';
        return { ...base, state: 'DELAYED', delayDays, delayKind };
    }
    return { ...base, state: fact.gt(0) ? 'IN_PROGRESS' : 'NOT_STARTED', delayDays: 0, delayKind: null };
}

/** The state of a Work from the states of its entries (one per execution unit): any delay wins; otherwise the least advanced common state. */
export function aggregateScheduleStates(states: ScheduleEntryState[]): ScheduleEntryState | null {
    if (states.length === 0)
        return null;
    if (states.includes('DELAYED'))
        return 'DELAYED';
    if (states.every(s => s === 'COMPLETED'))
        return 'COMPLETED';
    if (states.every(s => s === 'NOT_STARTED'))
        return 'NOT_STARTED';
    return 'IN_PROGRESS';
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The Object conclusion — «По графику» / «Есть отставание»
// ---------------------------------------------------------------------------------------------------------------------------------

export interface ObjectScheduleConclusion {
    status: ObjectScheduleStatus;
    entryCount: number;
    delayedCount: number;
    maxDelayDays: number;
    completedCount: number;
    inProgressCount: number;
    notStartedCount: number;
    /** What the calendar expects on the day: not yet due / should be underway / should already be finished. */
    expected: { notDue: number; underway: number; dueComplete: number };
}

/**
 * The production-level conclusion of one Object, from the entries of its APPROVED baseline (`null` = there is no approved baseline).
 *  * no approved baseline (or one with no entries) → NO_BASELINE: nothing is claimed — neither «По графику» nor a delay;
 *  * any entry delayed    → DELAYED;
 *  * otherwise            → ON_TRACK.
 * No finance, ИД, ПТО or СДО input exists in this function, by construction.
 */
export function resolveObjectScheduleConclusion(statuses: ScheduleEntryStatus[] | null): ObjectScheduleConclusion {
    const list = statuses ?? [];
    const count = (state: ScheduleEntryState) => list.filter(s => s.state === state).length;
    const phase = (p: ScheduleExpectedPhase) => list.filter(s => s.expectedPhase === p).length;
    const delayedCount = count('DELAYED');
    return {
        status: list.length === 0 ? 'NO_BASELINE' : delayedCount > 0 ? 'DELAYED' : 'ON_TRACK',
        entryCount: list.length,
        delayedCount,
        maxDelayDays: list.reduce((max, s) => Math.max(max, s.delayDays), 0),
        completedCount: count('COMPLETED'),
        inProgressCount: count('IN_PROGRESS'),
        notStartedCount: count('NOT_STARTED'),
        expected: { notDue: phase('NOT_DUE'), underway: phase('UNDERWAY'), dueComplete: phase('DUE_COMPLETE') },
    };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Revisions: what changed between two versions of the schedule
// ---------------------------------------------------------------------------------------------------------------------------------

export interface ScheduleEntrySnapshot {
    itemId: string;
    plannedStart: string;
    plannedFinish: string;
    sequence: number;
    predecessorItemId: string | null;
}
export type ScheduleChangedField = 'plannedStart' | 'plannedFinish' | 'sequence' | 'predecessorItemId';
export type ScheduleChangeKind = 'ADDED' | 'REMOVED' | 'CHANGED';
export interface ScheduleChange {
    itemId: string;
    kind: ScheduleChangeKind;
    before: ScheduleEntrySnapshot | null;
    after: ScheduleEntrySnapshot | null;
    /** Only for CHANGED: which fields differ. */
    fields: ScheduleChangedField[];
}

const COMPARED_FIELDS: ScheduleChangedField[] = ['plannedStart', 'plannedFinish', 'sequence', 'predecessorItemId'];

/** Before → after, per item. This is the evidence an approver reads before approving a correction, and what the history shows afterwards. */
export function diffScheduleEntries(before: ScheduleEntrySnapshot[], after: ScheduleEntrySnapshot[]): ScheduleChange[] {
    const was = new Map(before.map(e => [e.itemId, e])), is = new Map(after.map(e => [e.itemId, e]));
    const changes: ScheduleChange[] = [];
    for (const e of after) {
        const old = was.get(e.itemId);
        if (!old) {
            changes.push({ itemId: e.itemId, kind: 'ADDED', before: null, after: e, fields: [] });
            continue;
        }
        const fields = COMPARED_FIELDS.filter(f => old[f] !== e[f]);
        if (fields.length)
            changes.push({ itemId: e.itemId, kind: 'CHANGED', before: old, after: e, fields });
    }
    for (const e of before)
        if (!is.has(e.itemId))
            changes.push({ itemId: e.itemId, kind: 'REMOVED', before: e, after: null, fields: [] });
    const order = (c: ScheduleChange) => (c.after ?? c.before)!;
    return changes.sort((a, b) => order(a).sequence - order(b).sequence || order(a).plannedStart.localeCompare(order(b).plannedStart) || a.itemId.localeCompare(b.itemId));
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Draft validation
// ---------------------------------------------------------------------------------------------------------------------------------

export const FINISH_BEFORE_START_MESSAGE = 'Дата окончания раньше даты начала.';
export const SCOPE_ALREADY_SCHEDULED_MESSAGE = 'Этот участок производства уже есть в черновике графика.';
export const WORK_HAS_UNITS_MESSAGE = 'У работы есть участки производства: в график включаются участки, а не работа целиком.';
export const WORK_SCHEDULED_AS_WHOLE_MESSAGE = 'Работа уже включена в график целиком: сначала уберите строку «вся работа», затем добавляйте её участки.';
export const PREDECESSOR_NOT_IN_DRAFT_MESSAGE = 'Предшествующий участок не входит в черновик графика.';
export const PREDECESSOR_SELF_MESSAGE = 'Участок не может следовать сам за собой.';
export const PREDECESSOR_CYCLE_MESSAGE = 'Последовательность участков образует цикл.';
export const PREDECESSOR_IN_USE_MESSAGE = 'Этот участок указан как предшествующий для другого участка графика: сначала измените его последовательность.';
export const EMPTY_SCHEDULE_MESSAGE = 'Пустой график нельзя утвердить: добавьте хотя бы один участок производства.';
export const NO_CHANGES_MESSAGE = 'В черновике нет изменений относительно утверждённого графика.';
export const CORRECTION_REASON_REQUIRED_MESSAGE = 'Укажите причину корректировки утверждённого графика.';
export const DELAY_ONLY_MESSAGE = 'Причину отставания можно указать только для участка, по которому есть отставание.';

export function scheduleDatesViolation(plannedStart: string, plannedFinish: string): string | null {
    return civilDayNumber(plannedFinish) < civilDayNumber(plannedStart) ? FINISH_BEFORE_START_MESSAGE : null;
}

/** Works that appear BOTH as a whole-work entry and through execution-unit entries — a double plan of the same quantity. */
export function worksScheduledAtBothLevels(entries: { objectWorkId: string; executionUnitId: string | null }[]): string[] {
    const whole = new Set(entries.filter(e => e.executionUnitId === null).map(e => e.objectWorkId));
    return [...new Set(entries.filter(e => e.executionUnitId !== null && whole.has(e.objectWorkId)).map(e => e.objectWorkId))];
}

/** Each entry follows at most one other, so a cycle is found by walking each chain once. */
export function hasPredecessorCycle(entries: { itemId: string; predecessorItemId: string | null }[]): boolean {
    const next = new Map(entries.map(e => [e.itemId, e.predecessorItemId]));
    for (const start of next.keys()) {
        const seen = new Set<string>();
        for (let cur: string | null | undefined = start; cur; cur = next.get(cur)) {
            if (seen.has(cur))
                return true;
            seen.add(cur);
        }
    }
    return false;
}

/** Planned order: the entered sequence, then the earlier start, then the item id (stable, never chronology). */
export function compareScheduleOrder(a: { sequence: number; plannedStart: string; itemId: string }, b: { sequence: number; plannedStart: string; itemId: string }): number {
    return a.sequence - b.sequence || a.plannedStart.localeCompare(b.plannedStart) || a.itemId.localeCompare(b.itemId);
}

export function nextScheduleSequence(existing: number[]): number {
    return existing.reduce((max, n) => Math.max(max, n), 0) + 1;
}

export interface ScheduleApprovalInput {
    entries: (ScheduleEntrySnapshot & { objectWorkId: string; executionUnitId: string | null })[];
    /** An approved revision is in force, so this approval replaces it. */
    hasCurrentBaseline: boolean;
    /** Number of changes against that approved revision (0 when there is none). */
    changeCount: number;
    correctionReason: string | null | undefined;
}

/**
 * Everything that must hold before a draft may become the current baseline. Returns the violations (empty = may be approved), so the
 * caller can show them all at once rather than one per attempt.
 */
export function scheduleApprovalViolations(input: ScheduleApprovalInput): string[] {
    const problems: string[] = [];
    if (input.entries.length === 0)
        problems.push(EMPTY_SCHEDULE_MESSAGE);
    if (input.entries.some(e => scheduleDatesViolation(e.plannedStart, e.plannedFinish)))
        problems.push(FINISH_BEFORE_START_MESSAGE);
    if (worksScheduledAtBothLevels(input.entries).length)
        problems.push(WORK_SCHEDULED_AS_WHOLE_MESSAGE);
    const ids = new Set(input.entries.map(e => e.itemId));
    if (input.entries.some(e => e.predecessorItemId !== null && !ids.has(e.predecessorItemId)))
        problems.push(PREDECESSOR_NOT_IN_DRAFT_MESSAGE);
    if (hasPredecessorCycle(input.entries))
        problems.push(PREDECESSOR_CYCLE_MESSAGE);
    if (input.hasCurrentBaseline) {
        if (input.changeCount === 0)
            problems.push(NO_CHANGES_MESSAGE);
        else if (!input.correctionReason || !input.correctionReason.trim())
            problems.push(CORRECTION_REASON_REQUIRED_MESSAGE);
    }
    return problems;
}

/** A start earlier than the predecessor's finish is a planning inconsistency worth showing — advisory, never a block (flow planning overlaps on purpose). */
export function startsBeforePredecessorFinish(plannedStart: string, predecessorPlannedFinish: string): boolean {
    return civilDayNumber(plannedStart) < civilDayNumber(predecessorPlannedFinish);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Delay reasons
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * Delay-reason categories. These are the DEFAULTS a tenant starts with; the list is open — a tenant adds, renames or switches off
 * categories by code (schedule_delay_categories), and the effective list is the merge below. The three management examples (materials,
 * mobilisation, decisions) are entries, not the model. Construction defects / СК remarks are NOT a category here: they live in СК issues
 * and must not be mixed with planning delay reasons.
 */
export const DEFAULT_DELAY_REASON_CATEGORIES: readonly { code: string; name: string; sortOrder: number }[] = [
    { code: 'MATERIALS', name: 'Материалы', sortOrder: 10 },
    { code: 'MOBILIZATION', name: 'Мобилизация', sortOrder: 20 },
    { code: 'DECISIONS', name: 'Решения', sortOrder: 30 },
    { code: 'DESIGN_DOCUMENTATION', name: 'Проектная документация', sortOrder: 40 },
    { code: 'PREDECESSOR_WORK', name: 'Предшествующие работы', sortOrder: 50 },
    { code: 'WORKFORCE_EQUIPMENT', name: 'Рабочие и техника', sortOrder: 60 },
    { code: 'WEATHER', name: 'Погодные условия', sortOrder: 70 },
    { code: 'OTHER', name: 'Другое', sortOrder: 900 },
];
export const DELAY_CATEGORY_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,39}$/;

export interface DelayCategoryOverride {
    code: string;
    name: string;
    isActive: boolean;
    sortOrder: number;
}

/** Defaults overridden by the tenant's rows (same code = rename / reorder / switch off); a new code is an added category. */
export function effectiveDelayCategories(overrides: DelayCategoryOverride[]): { code: string; name: string }[] {
    const merged = new Map<string, DelayCategoryOverride>(DEFAULT_DELAY_REASON_CATEGORIES.map(c => [c.code, { ...c, isActive: true }]));
    for (const o of overrides)
        merged.set(o.code, { ...o });
    return [...merged.values()].filter(c => c.isActive).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'ru')).map(c => ({ code: c.code, name: c.name }));
}

/** A reason explains a REAL delay: recording one against an entry that is on schedule (or finished) would only create noise. */
export function delayReasonViolation(state: ScheduleEntryState): string | null {
    return state === 'DELAYED' ? null : DELAY_ONLY_MESSAGE;
}
