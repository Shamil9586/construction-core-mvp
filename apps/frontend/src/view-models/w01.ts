/**
 * W01 — Work Card.
 *
 * Work execution control: identity, plan, fact and СК confirmation kept as
 * three separate figures, never merged or auto-corrected.
 *
 * F8.1 (Phase 4) adds a fourth, optional concern below the original one:
 * Work Execution Units and their Quantity Portions, with the three minimal
 * operational actions the domain contract names (RP fact entry, portions
 * management, Internal SC decision registration). It is additive by
 * construction — `buildW01ViewModel`'s three new parameters default to `[]`,
 * so a work with no execution units (every work before this phase, and any
 * work that stays on the simpler model) builds exactly the `W01ViewModel`
 * this file already produced, with `executionUnits: []`.
 *
 * The specified work definition — work type, finish type, layer/pie, execution
 * conditions, zone — is wider than what `Work` can express today. Only the work
 * type (`name`) and its performer exist on the record; finish type, layer,
 * execution conditions and zone are a capability the domain model does not have
 * yet, not a value this particular work happens to be missing. Per the
 * capability-vs-data rule, those blocks are not rendered — not even as a
 * placeholder or an explanatory sentence, the same choice F1 recorded for
 * `ConfirmedVolume`/`ZoneRow`/`Sequence` on `WorkIdentityCard`.
 *
 * Corrective note, first pass (Work review, F4 patch 1): this adapter used to
 * treat `work.accepted` as proof that the *fact* quantity was confirmed by
 * СК, restating `actualQuantity` under a "подтверждено СК полностью"
 * caption. That was an inference, not a read: `POST
 * /inspections/:id/accept` records a decision about the work as a whole and
 * carries no quantity field at all, so there is no explicit source for "this
 * many square metres were confirmed". `Confirmed quantity != fact` stays
 * true by construction: this function has no way to produce a number for the
 * confirmation slot at all. `ConfirmedQuantity` remains in the type for the
 * day an explicit confirmed-volume field exists, and is exercised today only
 * through an explicitly-labelled demo override — see `preview/Gallery.tsx`'s
 * `demoConfirmedQuantity`.
 *
 * Corrective note, second pass (Work review, F4 patch 2): the non-accepted
 * branch used to collapse every `Inspection.status` into one `Pending`
 * ("на проверке") the moment *any* inspection record existed, regardless of
 * what that record actually said. Studied against the backend
 * (`apps/backend/src/service.ts`'s `addIssue`/`inspectionAction`, which both
 * gate on the exact same set) and the legacy app's own established labels
 * (`main.tsx`'s `stateNames`): `WAITING`, `IN_REVIEW` and `REINSPECTION` are
 * the only genuinely still-open, awaiting-decision states — kept together as
 * `Pending`. `ISSUES_FOUND` is a distinct, real outcome (an inspector raised
 * remarks) and gets its own `IssuesFound`; folding it into "on review" would
 * hide that something concrete happened. `REJECTED` is one of the two
 * terminal decisions (`ACCEPTED` is the other, already handled via
 * `work.accepted`) and must never read as still-pending. Any other status
 * string — including the contradictory case of an inspection that itself
 * says `ACCEPTED` while `work.accepted` is false, which the backend's own
 * derivation (`accepted = inspections.some(i => i.status === 'ACCEPTED')`)
 * means should not occur — resolves to `Unknown`, neutral rather than a
 * guess. Absence of any inspection record stays `NotSubmitted`, still
 * distinct from `Unknown`.
 */

import Decimal from 'decimal.js';
import type {
  Inspection,
  InspectionStatus,
  ObjectSummary,
  QuantityPortion,
  Work,
  WorkExecutionUnit,
} from '../types/api';
import { formatDate, formatMeasure, formatQuantityWithUnit, type Measure } from '../formatters';
import { workStatusPresentation, type StatusPresentation } from './status';

export type WorkConfirmation =
  | { kind: 'NotSubmitted' }
  | { kind: 'Pending' }
  | { kind: 'IssuesFound' }
  | { kind: 'Rejected' }
  | { kind: 'Unknown' }
  | { kind: 'Accepted' }
  | { kind: 'ConfirmedQuantity'; value: string; meta: string };

/**
 * Classifies one inspection's real `status` into a confirmation state — used
 * only when `work.accepted` is false, so `ACCEPTED` here would be the
 * contradictory case described above, not the normal path to `Accepted`.
 */
function confirmationFromInspectionStatus(status: InspectionStatus): WorkConfirmation {
  switch (status) {
    case 'WAITING':
    case 'IN_REVIEW':
    case 'REINSPECTION':
      return { kind: 'Pending' };
    case 'ISSUES_FOUND':
      return { kind: 'IssuesFound' };
    case 'REJECTED':
      return { kind: 'Rejected' };
    default:
      return { kind: 'Unknown' };
  }
}

/**
 * F8.1 — a `WorkConfirmation` as a status-badge variant and label, for the
 * new per-portion Internal SC badge (`ExecutionSection.tsx`). Deliberately
 * not shared with `screens/W01/index.tsx`'s existing `ConfirmationBlock`,
 * which renders `ConfirmedQuantity` as its own `PlanFact` figure rather than
 * a badge — that component is pre-F8.1, visually covered by `test:ds`, and
 * out of scope to change. `ConfirmedQuantity` cannot actually reach a
 * portion today (`buildW01PortionViewModel` below never produces it), so its
 * arm here only satisfies exhaustiveness.
 */
export function confirmationVariant(confirmation: WorkConfirmation): 'OnTrack' | 'Attention' | 'Neutral' {
  switch (confirmation.kind) {
    case 'ConfirmedQuantity':
    case 'Accepted':
      return 'OnTrack';
    case 'IssuesFound':
    case 'Rejected':
      return 'Attention';
    case 'Pending':
    case 'Unknown':
    case 'NotSubmitted':
      return 'Neutral';
    default: {
      const exhaustive: never = confirmation;
      return exhaustive;
    }
  }
}

export function confirmationLabel(confirmation: WorkConfirmation): string {
  switch (confirmation.kind) {
    case 'ConfirmedQuantity':
      return `Подтверждено СК: ${confirmation.value} ${confirmation.meta}`;
    case 'Accepted':
      return 'Принято СК';
    case 'Pending':
      return 'На проверке';
    case 'IssuesFound':
      return 'Есть замечания';
    case 'Rejected':
      return 'Отклонено';
    case 'Unknown':
      return 'Статус проверки не определён';
    case 'NotSubmitted':
      return 'Не предъявлено';
    default: {
      const exhaustive: never = confirmation;
      return exhaustive;
    }
  }
}

/**
 * F8.1 — Work Execution Unit / Quantity Portion, added to W01 for the three
 * minimal operational actions the domain contract names: RP enters fact,
 * portions management, Internal SC decision registration. Deliberately not
 * here: Customer SC. Decision 6/clarification 1 give it a backend model with
 * no customer UI workflow at all — not even a read-only badge — so nothing
 * in this module reads `portion.customerScAccepted` or
 * `inspectionType === 'CUSTOMER_SC'`.
 *
 * `canEnterFact`/`canRequestInternalSc` mirror `recordPortionFact`'s and
 * `requestPortionInspection`'s own guards in apps/backend/src/service.ts
 * exactly (an Internal SC inspection blocks further fact entry once it
 * exists and is not REJECTED; a request needs a full fact and no such
 * blocking inspection) — a read of already-fetched data, the same kind of
 * derived presentation decision `ConfirmationBlock`'s switch already makes,
 * not a second copy of the backend's authorization or a new rule. The
 * backend stays authoritative regardless: these only decide which action is
 * worth showing, never whether it is allowed.
 */
const DECIDABLE_INTERNAL_SC_STATUSES = new Set<InspectionStatus>([
  'WAITING',
  'IN_REVIEW',
  'ISSUES_FOUND',
  'REINSPECTION',
]);

export interface W01PortionViewModel {
  id: string;
  /** For `POST portions/:id/fact` and `.../inspection-request`'s optimistic-concurrency `version`. */
  version: number;
  label: string;
  planned: Measure;
  fact: Measure;
  internalSc: WorkConfirmation;
  /** The one Internal SC inspection to register a decision on, when one is awaiting a decision. */
  decidableInspection: { id: string; version: number } | null;
  canEnterFact: boolean;
  canRequestInternalSc: boolean;
}

export interface W01ExecutionUnitViewModel {
  id: string;
  location: string | null;
  plan: Measure;
  /** Sum of portions' latest RP fact — `ReadService.snapshot()`'s own derived figure (F8.1 decision 2). */
  actual: Measure;
  /** Informational only (D4's sum-bound is enforced server-side); never negative even if portions were somehow over-committed. */
  remainingForNewPortion: string;
  portions: W01PortionViewModel[];
}

function latestPortionInternalSc(portionId: string, inspections: Inspection[]): Inspection | undefined {
  return inspections
    .filter((inspection) => inspection.portionId === portionId && inspection.inspectionType === 'INTERNAL_SC')
    .sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1))[0];
}

function buildW01PortionViewModel(
  portion: QuantityPortion,
  unit: string,
  inspections: Inspection[],
): W01PortionViewModel {
  const latest = latestPortionInternalSc(portion.id, inspections);
  const hasBlockingInternalSc = latest !== undefined && latest.status !== 'REJECTED';
  const factIsFull =
    portion.rpFactQuantity !== null && new Decimal(portion.rpFactQuantity).gte(portion.plannedQuantity);

  // Same shape as the whole-work `confirmation` above: `internalScAccepted`
  // (ReadService's own aggregate) decides Accepted first, exactly as
  // `work.accepted` does, before falling back to the latest inspection's raw
  // status — never the reverse, so an accepted portion cannot be read as
  // merely pending by a stale or missing inspection row.
  const internalSc: WorkConfirmation = portion.internalScAccepted
    ? { kind: 'Accepted' }
    : latest
      ? confirmationFromInspectionStatus(latest.status)
      : { kind: 'NotSubmitted' };

  return {
    id: portion.id,
    version: portion.version,
    label: portion.label,
    planned: formatMeasure(portion.plannedQuantity, unit, 'плановый объём участка'),
    fact: formatMeasure(portion.rpFactQuantity, unit, 'факт участка'),
    internalSc,
    decidableInspection:
      latest && DECIDABLE_INTERNAL_SC_STATUSES.has(latest.status) ? { id: latest.id, version: latest.version } : null,
    canEnterFact: !hasBlockingInternalSc,
    canRequestInternalSc: !hasBlockingInternalSc && factIsFull,
  };
}

function buildW01ExecutionUnitViewModel(
  unit: WorkExecutionUnit,
  portions: QuantityPortion[],
  inspections: Inspection[],
): W01ExecutionUnitViewModel {
  const ownPortions = portions.filter((portion) => portion.executionUnitId === unit.id);
  const plannedSum = ownPortions.reduce((sum, portion) => sum.add(portion.plannedQuantity), new Decimal(0));
  const remaining = Decimal.max(0, new Decimal(unit.plannedQuantity).minus(plannedSum));

  return {
    id: unit.id,
    location: unit.location,
    plan: formatMeasure(unit.plannedQuantity, unit.unit, 'плановый объём единицы'),
    actual: formatMeasure(unit.actualQuantity, unit.unit, 'факт по участкам'),
    remainingForNewPortion: formatQuantityWithUnit(remaining.toFixed(4), unit.unit),
    portions: ownPortions.map((portion) => buildW01PortionViewModel(portion, unit.unit, inspections)),
  };
}

function buildW01ExecutionUnits(
  work: Work,
  executionUnits: WorkExecutionUnit[],
  portions: QuantityPortion[],
  inspections: Inspection[],
): W01ExecutionUnitViewModel[] {
  return executionUnits
    .filter((unit) => unit.objectWorkId === work.id)
    .map((unit) => buildW01ExecutionUnitViewModel(unit, portions, inspections));
}

export interface W01Schedule {
  plannedStart: string;
  plannedFinish: string;
  actualStart: string;
  actualFinish: string;
}

export interface W01ViewModel {
  id: string;
  objectId: string;
  objectName: string;
  name: string;
  performer: string;
  status: StatusPresentation;
  plan: Measure;
  fact: Measure;
  confirmation: WorkConfirmation;
  /** For the readiness bar — physical execution, not acceptance (see `ProgressBar`). */
  readiness: number | null;
  blockers: string[];
  schedule: W01Schedule;
  /** F8.1 — empty for a work with no execution units, exactly like today. */
  executionUnits: W01ExecutionUnitViewModel[];
}

export function buildW01ViewModel(
  work: Work,
  object: ObjectSummary,
  inspections: Inspection[] = [],
  executionUnits: WorkExecutionUnit[] = [],
  portions: QuantityPortion[] = [],
): W01ViewModel {
  const factReported = work.lastReportedAt !== null;

  // F8.1 corrective: a portion-scoped inspection carries the same
  // `objectWorkId` as its parent work (it is still, transitively, an
  // inspection of that work), so without the `!portionId` guard a work with
  // execution units would have this whole-work confirmation block pick up
  // one arbitrary portion's status — the exact "one figure standing in for
  // several disagreeing ones" the confirmation-history model exists to
  // prevent. Portion-level status has its own slot, `W01PortionViewModel`
  // above; this stays the whole-work figure only. A work with no execution
  // units has no portion-scoped inspections in the array at all, so this is
  // a no-op there — F7 behaviour for non-portioned works is unchanged.
  const latestInspection = inspections
    .filter((inspection) => inspection.objectWorkId === work.id && !inspection.portionId)
    .sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1))[0];

  // No branch here ever attaches a quantity — `work.accepted` is a decision
  // about the whole work, not a measurement, so it can only produce a status.
  const confirmation: WorkConfirmation = work.accepted
    ? { kind: 'Accepted' }
    : latestInspection
      ? confirmationFromInspectionStatus(latestInspection.status)
      : { kind: 'NotSubmitted' };

  return {
    id: work.id,
    objectId: work.objectId,
    objectName: object.name,
    name: work.name,
    performer: work.contractor,
    status: workStatusPresentation(work),
    plan: formatMeasure(work.plannedQuantity, work.unit, 'плановый объём'),
    fact: formatMeasure(factReported ? work.actualQuantity : null, work.unit, 'физически выполнено'),
    confirmation,
    readiness: work.actualProgress,
    blockers: work.blockers,
    schedule: {
      plannedStart: formatDate(work.plannedStartDate),
      plannedFinish: formatDate(work.plannedFinishDate),
      actualStart: formatDate(work.actualStartDate),
      actualFinish: formatDate(work.actualFinishDate),
    },
    executionUnits: buildW01ExecutionUnits(work, executionUnits, portions, inspections),
  };
}
