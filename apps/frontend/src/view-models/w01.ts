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
 * СК confirmation has the same shape of gap. `POST /inspections/:id/accept`
 * decides a work as a whole — the backend cannot express "498 of the 500
 * reported". `buildW01ViewModel` therefore only ever produces `Confirmed` (the
 * fact figure, once the whole work is accepted), `Pending` or `NotSubmitted`
 * from real data. `PartiallyConfirmed` exists in the type so the screen can
 * render the two-figure layout the product spec calls for, but it is reachable
 * only through explicitly-labelled demo data — see `screens/demo/fixtures.ts`
 * and the F4 report's "Known limitations".
 */

import type { Inspection, ObjectSummary, Work } from '../types/api';
import { formatDate, formatMeasure, type Measure } from '../formatters';
import { workStatusPresentation, type StatusPresentation } from './status';

export type WorkConfirmation =
  | { kind: 'NotSubmitted' }
  | { kind: 'Pending' }
  | { kind: 'Confirmed'; value: string; meta: string }
  | { kind: 'PartiallyConfirmed'; value: string; meta: string };

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

  const confirmation: WorkConfirmation = work.accepted
    ? {
        kind: 'Confirmed',
        value: formatMeasure(work.actualQuantity, work.unit).value,
        meta: `${work.unit} · подтверждено СК полностью`,
      }
    : latestInspection
      ? { kind: 'Pending' }
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
