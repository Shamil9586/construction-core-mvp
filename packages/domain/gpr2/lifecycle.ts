/**
 * GPR-2 R01 — lifecycles and allowed transitions (Technical Design §5.2–5.5, §8.1, §9.3, §11.2, §12.1; decisions D05/D11/D18/D21–D23, C10/C12/C13).
 *
 * Each lifecycle is a table, and the table is the whole truth: a (state, command) pair that is not a row is not a transition. Nothing here
 * touches a database — a service looks the row up, the HTTP guard checks the permission, and the same row answers both, so the matrix a
 * reviewer reads is the matrix that is enforced.
 *
 * What a row says beyond from/command/to:
 *   permission         who may issue it; null means the system or a reconciliation drives it and NO role may (so no role can ever do it by hand)
 *   reasonRequired     the actor must give a reason (return, reject, retract …)
 *   separationOfDuties the approver must be neither the author nor the submitter (§11.3: "combining roles does not let one user approve
 *                      their own submission")
 *   endpoint           the register id (endpoints.ts) of the command that performs it, or null when none exists
 *
 * Deliberately NOT here: import-batch edges. TD §7.3 fixes the batch STATES and the processing order, not the edges between them, so the
 * states are exported (IMPORT_BATCH_STATES) and the edge table is left to the import stages. Calendar-version and template publication
 * commands are likewise not enumerated by §11.2 and are left to R10 / R05.
 */
import { Gpr2Error } from './errors';
import { Gpr2Permission } from './permissions';

export interface LifecycleTransition<S extends string = string> {
    from: S;
    command: string;
    to: S;
    permission: Gpr2Permission | null;
    reasonRequired: boolean;
    separationOfDuties: boolean;
    endpoint: string | null;
}
export interface Lifecycle<S extends string = string> {
    name: string;
    states: readonly S[];
    initial: S;
    terminal: readonly S[];
    transitions: readonly LifecycleTransition<S>[];
}

const P = Gpr2Permission;
const t = <S extends string>(from: S, command: string, to: S, permission: Gpr2Permission | null, endpoint: string | null,
                              flags: { reason?: boolean; separation?: boolean } = {}): LifecycleTransition<S> =>
    ({ from, command, to, permission, reasonRequired: !!flags.reason, separationOfDuties: !!flags.separation, endpoint });
const freeze = <S extends string>(l: Lifecycle<S>): Lifecycle<S> => Object.freeze({ ...l, transitions: Object.freeze([...l.transitions]) }) as Lifecycle<S>;

// D11 / C10 — РП edits and submits; the deputy approves or returns; the deputy never edits. A returned revision stays as it was (RETURNED is
// final for that row — "return is not discard"); the РП continues in a NEW draft created from it, which is a creation, not a transition.
// A submitted revision cannot be withdrawn: only an unfinished draft can be discarded. Approving a later revision supersedes the approved one.
export const GPR_REVISION_STATES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'RETURNED', 'DISCARDED', 'SUPERSEDED'] as const;
export type GprRevisionState = typeof GPR_REVISION_STATES[number];
export const GPR_REVISION: Lifecycle<GprRevisionState> = freeze({
    name: 'GPR_REVISION',
    states: GPR_REVISION_STATES,
    initial: 'DRAFT',
    terminal: ['RETURNED', 'DISCARDED', 'SUPERSEDED'],
    transitions: [
        t('DRAFT', 'submit', 'SUBMITTED', P.SCHEDULE_AUTHOR, 'schedule.revision.submit'),
        t('DRAFT', 'discard', 'DISCARDED', P.SCHEDULE_AUTHOR, 'schedule.revision.discard'),
        t('SUBMITTED', 'approve', 'APPROVED', P.SCHEDULE_REVIEW, 'schedule.revision.approve', { separation: true }),
        t('SUBMITTED', 'return', 'RETURNED', P.SCHEDULE_REVIEW, 'schedule.revision.return', { reason: true }),
        t('APPROVED', 'supersede', 'SUPERSEDED', null, null)
    ]
});

// D17 / D18 — quantity approval is independent of schedule approval. A correction after a return is a new submission version of the same
// request, so a RETURNED request is reopened as DRAFT by the РП's PATCH (the register has no separate "revise" command).
export const QUANTITY_REQUEST_STATES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'RETURNED'] as const;
export type QuantityRequestState = typeof QUANTITY_REQUEST_STATES[number];
export const QUANTITY_CHANGE_REQUEST: Lifecycle<QuantityRequestState> = freeze({
    name: 'QUANTITY_CHANGE_REQUEST',
    states: QUANTITY_REQUEST_STATES,
    initial: 'DRAFT',
    terminal: ['APPROVED'],
    transitions: [
        t('DRAFT', 'submit', 'SUBMITTED', P.QUANTITY_AUTHOR, 'quantity.request.submit'),
        t('SUBMITTED', 'approve', 'APPROVED', P.QUANTITY_REVIEW, 'quantity.request.approve', { separation: true }),
        t('SUBMITTED', 'return', 'RETURNED', P.QUANTITY_REVIEW, 'quantity.request.return', { reason: true }),
        t('RETURNED', 'revise', 'DRAFT', P.QUANTITY_AUTHOR, 'quantity.request.patch')
    ]
});

// D05 — a rejection leaves the object-scope WorkType exactly as it was (a data postcondition owned by R05a, not a state of this request).
export const WORK_TYPE_PUBLICATION_STATES = ['PENDING', 'APPROVED', 'REJECTED'] as const;
export type WorkTypePublicationState = typeof WORK_TYPE_PUBLICATION_STATES[number];
export const WORK_TYPE_PUBLICATION_REQUEST: Lifecycle<WorkTypePublicationState> = freeze({
    name: 'WORK_TYPE_PUBLICATION_REQUEST',
    states: WORK_TYPE_PUBLICATION_STATES,
    initial: 'PENDING',
    terminal: ['APPROVED', 'REJECTED'],
    transitions: [
        t('PENDING', 'approve', 'APPROVED', P.CORPORATE_PUBLICATION, 'work-type.publication.approve'),
        t('PENDING', 'reject', 'REJECTED', P.CORPORATE_PUBLICATION, 'work-type.publication.reject', { reason: true })
    ]
});

// D22 / D23 / K03 — a ResultUse is REGISTERED, then superseded or retracted by the РП's correction record. There is no APPROVED and no
// REJECTED here and no command that could create one: the suitability decision is external, the system only records it.
export const RESULT_USE_STATES = ['REGISTERED', 'SUPERSEDED', 'RETRACTED'] as const;
export type ResultUseState = typeof RESULT_USE_STATES[number];
export const RESULT_USE: Lifecycle<ResultUseState> = freeze({
    name: 'RESULT_USE',
    states: RESULT_USE_STATES,
    initial: 'REGISTERED',
    terminal: ['SUPERSEDED', 'RETRACTED'],
    transitions: [
        t('REGISTERED', 'supersede', 'SUPERSEDED', P.EXTERNAL_OUTCOME_RECORD, 'finish-change.record-correction', { reason: true }),
        t('REGISTERED', 'retract', 'RETRACTED', P.EXTERNAL_OUTCOME_RECORD, 'finish-change.record-correction', { reason: true })
    ]
});

// D21 — an external-outcome record is append-only: it is never edited or deleted, a later record corrects it and the earlier one stays readable.
export const FINISH_CHANGE_RECORD_STATES = ['EFFECTIVE', 'SUPERSEDED'] as const;
export type FinishChangeRecordState = typeof FINISH_CHANGE_RECORD_STATES[number];
export const FINISH_CHANGE_RECORD: Lifecycle<FinishChangeRecordState> = freeze({
    name: 'FINISH_CHANGE_RECORD',
    states: FINISH_CHANGE_RECORD_STATES,
    initial: 'EFFECTIVE',
    terminal: ['SUPERSEDED'],
    transitions: [
        t('EFFECTIVE', 'record-correction', 'SUPERSEDED', P.EXTERNAL_OUTCOME_RECORD, 'finish-change.record-correction', { reason: true })
    ]
});

// C13 — the source of a Work's actual quantity is a PERSISTED mode. Having a first execution unit is not a transition: there is no command
// for it, so creating a WEU can never flip LEGACY_WORK → PORTION (the 300 → 0 defect). The one edge is a reconciliation that the inventory
// stages (R19) perform; no role may do it by hand, hence permission null. There is no mixed mode in the first implementation (§12.1).
export const FACT_SOURCE_MODES = ['LEGACY_WORK', 'PORTION'] as const;
export type FactSourceMode = typeof FACT_SOURCE_MODES[number];
export const FACT_SOURCE_MODE: Lifecycle<FactSourceMode> = freeze({
    name: 'FACT_SOURCE_MODE',
    states: FACT_SOURCE_MODES,
    initial: 'LEGACY_WORK',
    terminal: ['PORTION'],
    transitions: [
        t('LEGACY_WORK', 'reconcile-to-portion', 'PORTION', null, null)
    ]
});

/** TD §7.3 states of an import batch. Edges are intentionally not fixed here (see the header). */
export const IMPORT_BATCH_STATES = ['UPLOADED', 'PARSING', 'REVIEW_REQUIRED', 'READY', 'COMMITTED', 'FAILED', 'SUPERSEDED'] as const;
export type ImportBatchState = typeof IMPORT_BATCH_STATES[number];

export const LIFECYCLES: readonly Lifecycle[] = Object.freeze([GPR_REVISION, QUANTITY_CHANGE_REQUEST, WORK_TYPE_PUBLICATION_REQUEST, RESULT_USE,
    FINISH_CHANGE_RECORD, FACT_SOURCE_MODE]) as readonly Lifecycle[];

// ---------------------------------------------------------------------------------------------------------------------------------

export const findTransition = <S extends string>(l: Lifecycle<S>, from: S, command: string) =>
    l.transitions.find(x => x.from === from && x.command === command);
export const commandsFrom = <S extends string>(l: Lifecycle<S>, from: S) => l.transitions.filter(x => x.from === from).map(x => x.command);

export interface TransitionContext {
    /** The acting user; required by separation of duties. */
    actorId?: string | null;
    authorId?: string | null;
    submitterId?: string | null;
    reason?: string | null;
}
export const REASON_MAX_LENGTH = 2000;

/**
 * Structural validation of ONE step: the row must exist, a required reason must be real text, and a separation-of-duties row needs an
 * approver who can be shown to be neither the author nor the submitter (unknown ids fail closed). It does NOT check the role — that is
 * authorizeTransition(), so the two failures stay distinguishable (403 vs 422).
 */
export function applyTransition<S extends string>(l: Lifecycle<S>, from: S, command: string, ctx: TransitionContext = {}): LifecycleTransition<S> {
    const row = findTransition(l, from, command);
    if (!row)
        throw new Gpr2Error('INVALID_TRANSITION', { machine: l.name, from, command });
    if (row.reasonRequired) {
        const reason = typeof ctx.reason === 'string' ? ctx.reason.trim() : '';
        if (!reason || reason.length > REASON_MAX_LENGTH)
            throw new Gpr2Error('REASON_REQUIRED');
    }
    if (row.separationOfDuties)
        assertSeparationOfDuties(ctx);
    return row;
}

export function assertSeparationOfDuties(ctx: Pick<TransitionContext, 'actorId' | 'authorId' | 'submitterId'>): void {
    const { actorId, authorId, submitterId } = ctx;
    if (!actorId || !authorId || !submitterId || actorId === authorId || actorId === submitterId)
        throw new Gpr2Error('SEPARATION_OF_DUTIES');
}

/** A system-driven row (permission null) is authorised for nobody; every other row for exactly the roles holding its permission. */
export function authorizeTransition(row: LifecycleTransition, holds: (p: Gpr2Permission) => boolean): boolean {
    return row.permission !== null && holds(row.permission);
}
