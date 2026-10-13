/**
 * GPR-1 — Production Schedule («График производства работ»): shapes of the schedule API.
 *
 * Verified against `apps/backend/src/schedule-service.ts` (`objectSchedule()` / `workSchedule()`), not aspirational. Kept in its own module
 * rather than in `types/api.ts` so the schedule slice adds nothing to the file every slice edits; the shared primitives are imported.
 *
 * What the schedule does NOT carry is as informative as what it does: no planned-quantity input, no actual-quantity input, no colour. The
 * quantity, unit, zone and executor of an entry are read by the backend from the production model on every request; the state, the delay
 * and the object conclusion are derived there from the approved dates and the RP fact (`progressSource`). The client only presents them.
 */
import type { CivilDate, Numeric, Timestamp, Uuid } from './api';

/** Management states of one schedule entry. «Есть отставание» overrides «Не начато» / «В работе»; «Выполнено» is never delayed. */
export type ScheduleEntryState = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'DELAYED';

/** Where the calendar says the entry should be on the day in question. */
export type ScheduleExpectedPhase = 'NOT_DUE' | 'UNDERWAY' | 'DUE_COMPLETE';

/** Why a delayed entry is delayed — the cause of the delay, not a second delay figure. */
export type ScheduleDelayKind = 'START' | 'PROGRESS' | 'FINISH';

/** The production-level conclusion of one object. `NO_BASELINE` claims nothing: there is no approved schedule to be on or off. */
export type ObjectScheduleStatus = 'NO_BASELINE' | 'ON_TRACK' | 'DELAYED';

export type ScheduleRevisionStatus = 'DRAFT' | 'APPROVED' | 'SUPERSEDED' | 'DISCARDED';

/** The only provenance schedule progress has today: the quantity the project manager reported. */
export type ScheduleProgressSource = 'RP_FACT';

export type ScheduleChangeKind = 'ADDED' | 'REMOVED' | 'CHANGED';
export type ScheduleChangedField = 'plannedStart' | 'plannedFinish' | 'sequence' | 'predecessorItemId';

/** A production scope — an execution unit (a zone), or a whole work that has no units — as the production model describes it. */
export interface ScheduleScope {
  objectWorkId: Uuid;
  workName: string;
  /** `null` = the whole work (only for a work with no execution units). */
  executionUnitId: Uuid | null;
  /** The unit's zone (`work_execution_units.location`); `null` when the unit names none. */
  zone: string | null;
  finishType: string | null;
  conditions: string | null;
  contractorId: Uuid;
  executor: string;
  unit: string;
  plannedQuantity: Numeric;
}

export interface ScheduleDelayReason {
  id: Uuid;
  itemId: Uuid;
  categoryCode: string;
  /** The category's readable name — kept readable even after the tenant switches the category off. */
  categoryName: string;
  comment: string;
  responsibleUserId: Uuid | null;
  responsibleUserName: string | null;
  responsibleContractorId: Uuid | null;
  responsibleContractorName: string | null;
  /** Evidence: how many calendar days late the scope was when the reason was recorded. */
  delayDaysAtRecord: number;
  recordedByName: string | null;
  recordedAt: Timestamp;
  status: 'OPEN' | 'RESOLVED';
  resolvedByName: string | null;
  resolvedAt: Timestamp | null;
  resolutionComment: string | null;
  version: number;
}

/** One entry of the current APPROVED baseline, measured against the production facts on `ObjectSchedule.asOf`. */
export interface ScheduleEntry extends ScheduleScope {
  entryId: Uuid;
  /** The stable identity of the planned scope — what a delay reason and a follows-reference point at. */
  itemId: Uuid;
  revisionId: Uuid;
  sequence: number;
  plannedStart: CivilDate;
  plannedFinish: CivilDate;
  predecessorItemId: Uuid | null;
  predecessorLabel: string | null;
  /** `false` = the entry starts before its predecessor finishes (advisory — flow planning overlaps on purpose). `null` = no predecessor. */
  followsPredecessor: boolean | null;
  /** Latest RP fact of the scope; `null` = nothing was ever reported (not a reported 0). */
  rpFactQuantity: Numeric | null;
  /** Internal СК accepted quantity — a separate contour, shown next to the fact and never merged into it. */
  internalScAcceptedQuantity: Numeric | null;
  plannedProgress: number;
  actualProgress: number | null;
  factReported: boolean;
  overperformed: boolean;
  expectedPhase: ScheduleExpectedPhase;
  state: ScheduleEntryState;
  /** Whole calendar days; 0 unless `state` is `DELAYED`. */
  delayDays: number;
  delayKind: ScheduleDelayKind | null;
  /** How far corrections moved this entry against the FIRST approved plan; `null` = never moved. */
  baselineShift: { startDays: number; finishDays: number } | null;
  /** The entry plans a whole work that has since gained execution units — re-plan it by units at the next correction. */
  workNowHasUnits: boolean;
  delayReasons: ScheduleDelayReason[];
}

export interface ScheduleChange {
  itemId: Uuid;
  kind: ScheduleChangeKind;
  fields: ScheduleChangedField[];
  workName: string;
  zone: string | null;
  label: string;
  before: ScheduleEntrySnapshot | null;
  after: ScheduleEntrySnapshot | null;
}

export interface ScheduleEntrySnapshot {
  itemId: Uuid;
  plannedStart: CivilDate;
  plannedFinish: CivilDate;
  sequence: number;
  predecessorItemId: Uuid | null;
}

export interface ScheduleHistoryRevision {
  revisionId: Uuid;
  revisionNo: number;
  status: 'APPROVED' | 'SUPERSEDED';
  basedOnRevisionNo: number | null;
  createdByName: string | null;
  createdAt: Timestamp;
  approvedByName: string | null;
  approvedAt: Timestamp | null;
  approvalComment: string | null;
  correctionReason: string | null;
  supersededAt: Timestamp | null;
  supersededByRevisionNo: number | null;
  entryCount: number;
  changes: ScheduleChange[];
}

/** A draft entry: dates and order only, with the approved dates beside them when this draft is a correction. Not authoritative. */
export interface ScheduleDraftEntry extends ScheduleScope {
  entryId: Uuid;
  itemId: Uuid;
  /** Optimistic-lock version of the entry — sent back on edit / remove. */
  version: number;
  sequence: number;
  plannedStart: CivilDate;
  plannedFinish: CivilDate;
  predecessorItemId: Uuid | null;
  predecessorLabel: string | null;
  followsPredecessor: boolean | null;
  baseline: { plannedStart: CivilDate; plannedFinish: CivilDate; sequence: number } | null;
  change: 'ADDED' | 'CHANGED' | null;
}

export interface ScheduleDraft {
  revisionId: Uuid;
  revisionNo: number;
  /** Optimistic-lock version of the draft — an approval is only valid for exactly the draft the approver saw. */
  version: number;
  basedOnRevisionNo: number | null;
  createdByName: string | null;
  createdAt: Timestamp;
  entries: ScheduleDraftEntry[];
  changes: ScheduleChange[];
}

/** A production scope that can still be added to the draft. The dates are the work's own window, offered as a default only. */
export interface ScheduleAvailableScope extends ScheduleScope {
  suggestedStart: CivilDate;
  suggestedFinish: CivilDate;
}

export interface ScheduleAccess {
  canEdit: boolean;
  canApprove: boolean;
  canRecordDelayReason: boolean;
  canCreateDraft: boolean;
  canManageCategories: boolean;
}

export interface ObjectScheduleConclusion {
  status: ObjectScheduleStatus;
  entryCount: number;
  delayedCount: number;
  maxDelayDays: number;
  completedCount: number;
  inProgressCount: number;
  notStartedCount: number;
  expected: { notDue: number; underway: number; dueComplete: number };
  /** Production scopes of the object that are not part of the approved schedule. */
  unscheduledCount: number;
  openDelayReasonCount: number;
}

export interface ScheduleCurrentRevision {
  revisionId: Uuid;
  revisionNo: number;
  approvedAt: Timestamp;
  approvedByName: string | null;
  approvalComment: string | null;
  correctionReason: string | null;
  basedOnRevisionNo: number | null;
}

export interface DelayReasonCategory {
  code: string;
  name: string;
}

/** `GET /objects/:id/schedule` — ONE object's schedule. */
export interface ObjectSchedule {
  objectId: Uuid;
  objectName: string;
  /** The day plan-versus-fact is computed for (today unless `?asOf=` was given). */
  asOf: CivilDate;
  progressSource: ScheduleProgressSource;
  access: ScheduleAccess;
  hasDraft: boolean;
  current: ScheduleCurrentRevision | null;
  conclusion: ObjectScheduleConclusion;
  entries: ScheduleEntry[];
  unscheduled: ScheduleScope[];
  /** Present only for those who prepare / approve the schedule. */
  draft: ScheduleDraft | null;
  availableScopes: ScheduleAvailableScope[];
  history: ScheduleHistoryRevision[];
  delayReasonCategories: DelayReasonCategory[];
}

/** `GET /works/:id/schedule` — one work's entries of the current baseline, and their summary (W01). */
export interface WorkSchedule {
  objectId: Uuid;
  objectWorkId: Uuid;
  asOf: CivilDate;
  progressSource: ScheduleProgressSource;
  /** `false` = the viewer may read this work's summary but not the object's whole schedule (a PTO engineer holding only this work's handoff). */
  canOpenObjectSchedule: boolean;
  hasBaseline: boolean;
  revisionNo: number | null;
  summary: {
    plannedStart: CivilDate;
    plannedFinish: CivilDate;
    state: ScheduleEntryState | null;
    delayDays: number;
    entryCount: number;
  } | null;
  entries: ScheduleEntry[];
}

/** Request bodies — note what is absent: quantities, executors, zones, progress and colours are not the schedule's to accept. */
export interface AddScheduleEntryInput {
  objectWorkId: Uuid;
  executionUnitId: Uuid | null;
  plannedStart: CivilDate;
  plannedFinish: CivilDate;
  sequence?: number;
  predecessorItemId?: Uuid | null;
}
export interface EditScheduleEntryInput {
  version: number;
  plannedStart?: CivilDate;
  plannedFinish?: CivilDate;
  sequence?: number;
  predecessorItemId?: Uuid | null;
}
export interface ApproveScheduleInput {
  version: number;
  comment?: string;
  correctionReason?: string;
}
export interface RecordDelayReasonInput {
  itemId: Uuid;
  categoryCode: string;
  comment: string;
  responsibleUserId?: Uuid;
  responsibleContractorId?: Uuid;
}

/**
 * What a screen knows about a schedule it asked for. `Hidden` = the role / object / runtime does not offer a schedule (a 403, or no real
 * session): the schedule block is simply absent — a different statement from "there is no data", which is a `Loaded` schedule with no baseline.
 */
export type ScheduleLoad<T> =
  | { status: 'Loading' }
  | { status: 'Loaded'; value: T }
  | { status: 'Hidden' }
  | { status: 'Error'; message: string };

/** Who a delay reason can be about: internal people and the object's active contractors — fetched when the reason form opens. */
export interface ResponsibleOptions {
  people: { id: Uuid; name: string }[];
  contractors: { id: Uuid; name: string }[];
}
