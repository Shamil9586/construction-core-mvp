/**
 * GPR-2 R02 — the one fact resolver (Technical Design §12.1, §8.3; decisions C13, C15; scenarios A05, A24).
 *
 * Pure domain: no database, no clock. Every production consumer — the read model, the dependency / transition guards, the GPR-1 scope reader,
 * the documentation and AOSR readers, the inspection-request guard — takes its figure from here, so two code paths can no longer disagree
 * about the same Work (C15). The SQL side (apps/backend/src/fact-resolver.ts) only fetches rows; every decision is made in this file.
 *
 * What it settles
 *   * RP_FACT / INTERNAL_SC: the latest confirmation of a portion, ordered by `recordedAt` and, for an exact tie, by the monotonic `sequence`
 *     of new confirmations. A legacy tie that cannot be proven (no sequence on the legacy rows, different quantities) is UNKNOWN_TIE — the
 *     resolver never invents an order and never rewrites a timestamp "to make latest pretty" (§12.1).
 *   * CUSTOMER_SC keeps its grouped semantics (F12.1): the whole latest-timestamp group goes to resolveCustomerScLatestGroup() unchanged.
 *   * The source of a Work's actual quantity is a PERSISTED mode (LEGACY_WORK | PORTION). Having a first execution unit is NOT a switch (C13).
 *     A Work whose mode was never persisted (a row older than migration 026, `persistedMode === null`) is UNCLASSIFIED: it is read from the
 *     evidence that exists, flagged DERIVED_UNCLASSIFIED, and never written back — classifying real Works is R19, after the live inventory.
 *   * Two clocks, never mixed (§12.1): KNOWN-AT (what the system knew on T — rows filtered by their immutable creation instant) and
 *     EFFECTIVE-AT (what belongs to the execution date T). The stored rows carry no execution date, so EFFECTIVE-AT is answered explicitly
 *     as EFFECTIVE_DATE_NOT_RECORDED rather than silently aliased to KNOWN-AT.
 *
 * Instants are compared as canonical microsecond text ('2026-10-20T07:21:00.123456Z'): a JS Date carries milliseconds only and could
 * either tie two distinct instants or order two equal ones, which is exactly what the existing readers were warned about (F12.1-R01).
 */
import Decimal from 'decimal.js';
import { resolveCustomerScLatestGroup } from '../index';
import type { FactSourceMode } from './lifecycle';

export const FACT_RESOLVER_VERSION = 'gpr2-r02.1';

export const CONFIRMATION_SOURCES = ['RP_FACT', 'INTERNAL_SC', 'CUSTOMER_SC'] as const;
export type ConfirmationSource = typeof CONFIRMATION_SOURCES[number];

// ---------------------------------------------------------------------------------------------------------------------------------
// Instants
// ---------------------------------------------------------------------------------------------------------------------------------

/** 'YYYY-MM-DDTHH:MM:SS.ffffffZ' — fixed width, UTC, microseconds: lexicographic order IS chronological order. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
export const isInstant = (v: unknown): v is string => typeof v === 'string' && INSTANT.test(v) && !Number.isNaN(Date.parse(v));
export function assertInstant(v: unknown, what: string): string {
    if (!isInstant(v))
        throw new TypeError('fact-resolver: ' + what + ' must be a canonical microsecond UTC instant, got ' + JSON.stringify(v));
    return v;
}
/** A JS instant as the canonical text (microseconds are zero — only for callers that have no better source, e.g. a test or a request clock). */
export const instantOf = (d: Date): string => d.toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');
const maxInstant = (values: string[]) => values.reduce((m, v) => (v > m ? v : m));
const qty = (v: unknown) => new Decimal(v as any).toFixed(4);

// ---------------------------------------------------------------------------------------------------------------------------------
// Portion confirmations
// ---------------------------------------------------------------------------------------------------------------------------------

export interface ConfirmationRecord {
    id: string;
    portionId: string;
    source: ConfirmationSource;
    quantity: string;
    /** The moment the confirmation is recorded for (ordering key). */
    recordedAt: string;
    /** The immutable instant the row was inserted (KNOWN-AT key). */
    createdAt: string;
    /** Monotonic number of a confirmation written after migration 026 (taken under the portion's row lock); null on every legacy row. */
    sequence: string | null;
}

export type LatestConfirmation =
    | { state: 'NONE' }
    | { state: 'RESOLVED'; basis: 'SOLE' | 'SEQUENCE' | 'EQUAL_QUANTITIES'; quantity: string; confirmationId: string; recordedAt: string }
    | { state: 'UNKNOWN_TIE'; recordedAt: string; candidates: { confirmationId: string; quantity: string; sequence: string | null }[] };

export interface AsOfOptions {
    /** KNOWN-AT: only rows whose `createdAt` is at or before this instant are visible. */
    knownAt?: string | null;
}

const visible = (records: ConfirmationRecord[], knownAt?: string | null) => (knownAt ? records.filter(r => r.createdAt <= knownAt) : records);
const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The rows of the latest-`recordedAt` group of one portion and one source. */
function latestGroup(records: ConfirmationRecord[], knownAt?: string | null): ConfirmationRecord[] {
    const rows = visible(records, knownAt);
    if (!rows.length)
        return [];
    const top = maxInstant(rows.map(r => assertInstant(r.recordedAt, 'recordedAt')));
    return rows.filter(r => r.recordedAt === top).sort(byId);
}

/**
 * Latest confirmation of ONE portion and ONE source (RP_FACT or INTERNAL_SC). `records` must all belong to that portion and source.
 * Deterministic: the same set of rows always yields the same answer, whatever order they arrive in.
 */
export function resolveLatestConfirmation(records: ConfirmationRecord[], opts: AsOfOptions = {}): LatestConfirmation {
    const group = latestGroup(records, opts.knownAt);
    if (!group.length)
        return { state: 'NONE' };
    const recordedAt = group[0].recordedAt;
    if (group.length === 1)
        return { state: 'RESOLVED', basis: 'SOLE', quantity: qty(group[0].quantity), confirmationId: group[0].id, recordedAt };
    // An exact tie. Every new confirmation carries a sequence assigned under the portion lock, so two of them are always ordered.
    if (group.every(r => r.sequence !== null)) {
        const ordered = [...group].sort((a, b) => (BigInt(a.sequence!) < BigInt(b.sequence!) ? 1 : BigInt(a.sequence!) > BigInt(b.sequence!) ? -1 : 0));
        if (BigInt(ordered[0].sequence!) !== BigInt(ordered[1].sequence!))
            return { state: 'RESOLVED', basis: 'SEQUENCE', quantity: qty(ordered[0].quantity), confirmationId: ordered[0].id, recordedAt };
    }
    // A tie that cannot be ordered is harmless when every candidate says the same thing.
    const distinct = new Set(group.map(r => qty(r.quantity)));
    if (distinct.size === 1)
        return { state: 'RESOLVED', basis: 'EQUAL_QUANTITIES', quantity: [...distinct][0], confirmationId: group[0].id, recordedAt };
    return { state: 'UNKNOWN_TIE', recordedAt, candidates: group.map(r => ({ confirmationId: r.id, quantity: qty(r.quantity), sequence: r.sequence })) };
}

export interface CustomerScResolution {
    ready: boolean;
    /** The single authoritative quantity, or null when the latest group holds several distinct values (or none). */
    quantity: string | null;
    groupSize: number;
}
/** CUSTOMER_SC: the whole latest-timestamp group, resolved by the F12.1 function exactly as before (its semantics are not replaced). */
export function resolveCustomerScGroup(records: ConfirmationRecord[], opts: AsOfOptions = {}): CustomerScResolution {
    const group = latestGroup(records, opts.knownAt);
    const r = resolveCustomerScLatestGroup(group.map(g => g.quantity));
    return { ready: r.ready, quantity: r.quantity, groupSize: group.length };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// A Work's actual quantity
// ---------------------------------------------------------------------------------------------------------------------------------

export interface LegacyProgressRecord { id: string; totalQuantity: string; createdAt: string }
export interface PortionEvidence { id: string; createdAt: string; rpFacts: ConfirmationRecord[] }
export interface UnitEvidence { id: string; unit: string; createdAt: string; portions: PortionEvidence[] }
export interface ModeTransitionRecord { toMode: FactSourceMode; at: string }

/** Everything the resolver needs to know about one Work. The SQL loader builds it; a test builds it by hand. */
export interface WorkFactEvidence {
    workId: string;
    workUnit: string;
    createdAt: string;
    /** works.fact_source_mode as stored: null = never classified (a row that predates migration 026). */
    persistedMode: FactSourceMode | null;
    /** The append-only history of mode changes, oldest first. */
    modeHistory: ModeTransitionRecord[];
    /** works.actual_quantity — the CURRENT legacy figure. */
    legacyActualQuantity: string;
    /** work_progress rows (append-only), the only history the legacy figure has. */
    legacyProgress: LegacyProgressRecord[];
    units: UnitEvidence[];
}

export type WorkFactState =
    | 'KNOWN'
    /** PORTION source and no portion has any RP fact yet: the quantity is 0, but nothing has been REPORTED (0 reported is KNOWN). */
    | 'NONE_REPORTED'
    | 'UNKNOWN_TIE'
    /** KNOWN-AT only: the legacy figure is positive but nothing proves when it became known. */
    | 'HISTORY_UNAVAILABLE'
    /** An unclassified Work carries legacy actual AND portion facts. The pre-R02 reading (portions) is shown; the legacy figure is kept visible. */
    | 'OVERLAP_UNRECONCILED'
    | 'NOT_YET_KNOWN';

export interface WorkFact {
    mode: FactSourceMode;
    modeProvenance: 'PERSISTED' | 'DERIVED_UNCLASSIFIED' | 'NOT_APPLICABLE';
    state: WorkFactState;
    /** The Work's actual quantity (4 decimals) or null when it cannot be stated (UNKNOWN_TIE, HISTORY_UNAVAILABLE, NOT_YET_KNOWN). Never a guess. */
    quantity: string | null;
    /** The legacy whole-Work figure, whichever mode is in force — never summed with the portion figure. */
    legacyQuantity: string | null;
    /** The sum of the compatible portions' latest RP facts; null when no portion has one or any is unknown. */
    portionQuantity: string | null;
    unknownPortionIds: string[];
    resolverVersion: string;
}

export const sumQuantities = (values: string[]): string => values.reduce((s, v) => s.add(v), new Decimal(0)).toFixed(4);

type LegacyAt = { state: 'KNOWN'; quantity: string; hasEvidence: boolean } | { state: 'UNKNOWN_TIE' } | { state: 'HISTORY_UNAVAILABLE' };

function legacyAt(ev: WorkFactEvidence, knownAt: string | null): LegacyAt {
    const hasProgress = ev.legacyProgress.length > 0;
    if (!knownAt) {
        const q = qty(ev.legacyActualQuantity);
        return { state: 'KNOWN', quantity: q, hasEvidence: hasProgress || new Decimal(q).gt(0) };
    }
    const seen = ev.legacyProgress.filter(p => p.createdAt <= knownAt);
    if (!seen.length) {
        // Nothing recorded yet. A positive current figure with no history at all cannot be placed in time.
        return !hasProgress && new Decimal(ev.legacyActualQuantity).gt(0) ? { state: 'HISTORY_UNAVAILABLE' } : { state: 'KNOWN', quantity: qty(0), hasEvidence: false };
    }
    const top = maxInstant(seen.map(p => p.createdAt));
    const totals = new Set(seen.filter(p => p.createdAt === top).map(p => qty(p.totalQuantity)));
    return totals.size === 1 ? { state: 'KNOWN', quantity: [...totals][0], hasEvidence: true } : { state: 'UNKNOWN_TIE' };
}

function persistedModeAt(ev: WorkFactEvidence, knownAt: string | null): FactSourceMode {
    if (!ev.persistedMode)
        throw new Error('persistedModeAt: unclassified');
    if (!knownAt)
        return ev.persistedMode;
    // History says when LEGACY_WORK became PORTION; with no history row a persisted PORTION has been PORTION since the Work existed.
    const change = ev.modeHistory.find(h => h.toMode === 'PORTION');
    if (!change)
        return ev.persistedMode;
    return change.at <= knownAt ? 'PORTION' : 'LEGACY_WORK';
}

export function resolveWorkFact(ev: WorkFactEvidence, opts: AsOfOptions = {}): WorkFact {
    const knownAt = opts.knownAt ? assertInstant(opts.knownAt, 'knownAt') : null;
    const base = { resolverVersion: FACT_RESOLVER_VERSION, unknownPortionIds: [] as string[] };
    if (knownAt && ev.createdAt > knownAt)
        return { ...base, mode: 'LEGACY_WORK', modeProvenance: 'NOT_APPLICABLE', state: 'NOT_YET_KNOWN', quantity: null, legacyQuantity: null, portionQuantity: null };

    const legacy = legacyAt(ev, knownAt);
    const units = ev.units.filter(u => !knownAt || u.createdAt <= knownAt);

    // Each portion's latest RP fact at the requested instant.
    const unknownPortionIds: string[] = [];
    let reportedPortions = 0;
    const portionQuantities: string[] = [];
    for (const u of units) {
        const compatible = u.unit === ev.workUnit; // a unit measured differently is never added in (F8.1-04)
        for (const p of u.portions.filter(p => !knownAt || p.createdAt <= knownAt)) {
            const r = resolveLatestConfirmation(p.rpFacts, { knownAt });
            if (r.state === 'NONE')
                continue;
            reportedPortions++;
            if (r.state === 'UNKNOWN_TIE') {
                if (compatible)
                    unknownPortionIds.push(p.id);
            }
            else if (compatible)
                portionQuantities.push(r.quantity);
        }
    }
    const portionQuantity = reportedPortions === 0 || unknownPortionIds.length ? null : sumQuantities(portionQuantities);
    const legacyQuantity = legacy.state === 'KNOWN' ? legacy.quantity : null;

    // Which source is in force.
    let mode: FactSourceMode, provenance: WorkFact['modeProvenance'], overlap = false;
    if (ev.persistedMode) {
        mode = persistedModeAt(ev, knownAt);
        provenance = 'PERSISTED';
    }
    else {
        provenance = 'DERIVED_UNCLASSIFIED';
        const legacyEvidence = legacy.state !== 'KNOWN' || legacy.hasEvidence;
        if (reportedPortions === 0)
            mode = 'LEGACY_WORK'; // creating units (even empty) never takes the figure away: 300 stays 300 (A05)
        else {
            mode = 'PORTION';
            overlap = legacyEvidence;
        }
    }

    if (mode === 'LEGACY_WORK') {
        if (legacy.state === 'UNKNOWN_TIE')
            return { ...base, mode, modeProvenance: provenance, state: 'UNKNOWN_TIE', quantity: null, legacyQuantity: null, portionQuantity };
        if (legacy.state === 'HISTORY_UNAVAILABLE')
            return { ...base, mode, modeProvenance: provenance, state: 'HISTORY_UNAVAILABLE', quantity: null, legacyQuantity: null, portionQuantity };
        // A persisted LEGACY_WORK Work that nevertheless holds portion facts is an integrity anomaly; it is surfaced, not summed.
        const anomaly = ev.persistedMode !== null && reportedPortions > 0;
        return { ...base, mode, modeProvenance: provenance, state: anomaly ? 'OVERLAP_UNRECONCILED' : 'KNOWN', quantity: legacy.quantity, legacyQuantity, portionQuantity };
    }
    if (unknownPortionIds.length)
        return { ...base, unknownPortionIds, mode, modeProvenance: provenance, state: 'UNKNOWN_TIE', quantity: null, legacyQuantity, portionQuantity: null };
    if (reportedPortions === 0)
        return { ...base, mode, modeProvenance: provenance, state: 'NONE_REPORTED', quantity: qty(0), legacyQuantity, portionQuantity: null };
    return { ...base, mode, modeProvenance: provenance, state: overlap ? 'OVERLAP_UNRECONCILED' : 'KNOWN', quantity: portionQuantity, legacyQuantity, portionQuantity };
}

/** Same as resolveWorkFact, with the quantity as a Decimal-safe string that is NEVER null: for guards that must fail closed on "unknown". */
export const knownQuantityOrNull = (f: WorkFact): string | null => (f.state === 'KNOWN' || f.state === 'NONE_REPORTED' || f.state === 'OVERLAP_UNRECONCILED' ? f.quantity : null);

// ---------------------------------------------------------------------------------------------------------------------------------
// EFFECTIVE-AT
// ---------------------------------------------------------------------------------------------------------------------------------

export type EffectiveAtAnswer = { state: 'EFFECTIVE_DATE_NOT_RECORDED'; reason: string };
/**
 * "What belongs to the execution date T". Neither work_progress nor portion_quantity_confirmations stores an execution date: `recorded_at` is the
 * insertion default, identical to `created_at` for every writer. Answering from it would pass KNOWN-AT off as EFFECTIVE-AT, so the contract is
 * explicit: not recorded. A later stage that stores an observed date with provenance replaces this function, not its callers.
 */
export const resolveWorkFactEffectiveAt = (_ev: WorkFactEvidence, _effectiveAt: string): EffectiveAtAnswer =>
    ({ state: 'EFFECTIVE_DATE_NOT_RECORDED', reason: 'Facts carry no execution date; only the instant the system recorded them' });

// ---------------------------------------------------------------------------------------------------------------------------------
// completionObservedAt
// ---------------------------------------------------------------------------------------------------------------------------------

export type CompletionObserved =
    | { state: 'OBSERVED'; at: string; provenance: 'SYSTEM_RECORDED_CREATED_AT' }
    | { state: 'NOT_COMPLETED' }
    | { state: 'UNKNOWN'; reason: 'CURRENT_FACT_UNKNOWN' | 'HISTORY_UNAVAILABLE' | 'TIE_UNORDERABLE' };

/**
 * The instant the system first recorded the fact that STARTED the Work's present, uninterrupted run at or above `targetQuantity`.
 * It is the proven moment the system learned of the completion (immutable `created_at`), not a claim about when the people finished — hence
 * the provenance label. A run that cannot be traced to its start (a legacy figure with no history, an unorderable tie) is UNKNOWN, never a date.
 */
export function resolveCompletionObservedAt(ev: WorkFactEvidence, targetQuantity: string): CompletionObserved {
    const target = new Decimal(targetQuantity);
    const now = resolveWorkFact(ev);
    const nowQty = knownQuantityOrNull(now);
    if (nowQty === null)
        return { state: 'UNKNOWN', reason: 'CURRENT_FACT_UNKNOWN' };
    if (new Decimal(nowQty).lt(target))
        return { state: 'NOT_COMPLETED' };
    const instants = [...new Set<string>([
        ...ev.legacyProgress.map(p => p.createdAt),
        ...ev.modeHistory.map(h => h.at),
        ...ev.units.flatMap(u => u.portions.flatMap(p => p.rpFacts.map(f => f.createdAt)))
    ])].sort();
    let start: string | null = null;
    for (let i = instants.length - 1; i >= 0; i--) {
        const f = resolveWorkFact(ev, { knownAt: instants[i] });
        if (f.state === 'HISTORY_UNAVAILABLE')
            return { state: 'UNKNOWN', reason: 'HISTORY_UNAVAILABLE' };
        const q = knownQuantityOrNull(f);
        if (q === null)
            return { state: 'UNKNOWN', reason: 'TIE_UNORDERABLE' };
        if (new Decimal(q).lt(target))
            break;
        start = instants[i];
    }
    if (start === null) // at or above the target now, but no recorded instant at which that was already true
        return { state: 'UNKNOWN', reason: 'HISTORY_UNAVAILABLE' };
    return { state: 'OBSERVED', at: start, provenance: 'SYSTEM_RECORDED_CREATED_AT' };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Fact source mode — the guarded edge
// ---------------------------------------------------------------------------------------------------------------------------------

export type ModeTransitionVerdict =
    | { allowed: true; action: 'NONE'; basis: 'ALREADY_PORTION' }
    /**
     * A Work that was never classified (every Work that exists today). The portion fact is accepted exactly as before R02 — the protected F8.x / F12.x
     * flows record portion facts on Works that also carry progress — and the Work stays unclassified. `overlap` says the Work now holds both a legacy
     * fact and a portion fact: the read model reports it as OVERLAP_UNRECONCILED until R19 classifies it; nothing is summed or hidden.
     */
    | { allowed: true; action: 'NONE'; basis: 'UNCLASSIFIED_PRE_R02_BEHAVIOUR'; overlap: boolean }
    /** An explicitly classified LEGACY_WORK Work with no legacy fact: the guarded edge LEGACY_WORK -> PORTION is taken, once, and recorded in the history. */
    | { allowed: true; action: 'PERSIST_PORTION'; basis: 'NO_LEGACY_FACT_AT_FIRST_PORTION_FACT' }
    | { allowed: false; rule: 'LEGACY_FACT_PRESENT' };

/**
 * May a portion RP fact be recorded on this Work, and does it take the Work to PORTION?
 *   * persisted PORTION            yes, nothing to change;
 *   * persisted LEGACY_WORK        not while a legacy fact exists (actual > 0 or any progress row) — it would create the very overlap the persisted
 *                                  mode exists to prevent ("Переход к portions при наличии legacy actual запрещён без отдельной доказанной
 *                                  reconciliation", §12.1); otherwise the first portion fact takes the Work to PORTION;
 *   * unclassified (null)          yes, as before R02 (see above) — classifying it is R19.
 * Creating an execution unit is never a transition and never calls this.
 */
export function evaluatePortionFactModeTransition(input: { persistedMode: FactSourceMode | null; legacyActualQuantity: string; hasLegacyProgress: boolean }): ModeTransitionVerdict {
    const legacyFact = input.hasLegacyProgress || new Decimal(input.legacyActualQuantity).gt(0);
    if (input.persistedMode === 'PORTION')
        return { allowed: true, action: 'NONE', basis: 'ALREADY_PORTION' };
    if (input.persistedMode === null)
        return { allowed: true, action: 'NONE', basis: 'UNCLASSIFIED_PRE_R02_BEHAVIOUR', overlap: legacyFact };
    return legacyFact ? { allowed: false, rule: 'LEGACY_FACT_PRESENT' } : { allowed: true, action: 'PERSIST_PORTION', basis: 'NO_LEGACY_FACT_AT_FIRST_PORTION_FACT' };
}
