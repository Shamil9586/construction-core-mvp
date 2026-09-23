/**
 * W01 — Work Card.
 *
 * Work execution control: identity, plan, fact and СК confirmation kept as
 * three separate figures, never merged or auto-corrected.
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

import type { Inspection, InspectionStatus, ObjectSummary, Work } from '../types/api';
import { formatDate, formatMeasure, type Measure } from '../formatters';
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
}

export function buildW01ViewModel(
  work: Work,
  object: ObjectSummary,
  inspections: Inspection[] = [],
): W01ViewModel {
  const factReported = work.lastReportedAt !== null;

  const latestInspection = inspections
    .filter((inspection) => inspection.objectWorkId === work.id)
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
  };
}
