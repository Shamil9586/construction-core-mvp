/**
 * O01 — Object Overview.
 *
 * Single-object management view: header identity, physical readiness, plan
 * vs. fact, and production attention — including which works are blocked and
 * why. Quality (СК), ИД and finance stay off this view by construction —
 * nothing here reads `inspections`, `packages`, `documents`, `sdo` or
 * `closings`, so there is nothing to accidentally mix in.
 *
 * Corrective note, first pass (Work review, F4 patch 1): `schedule.status`
 * used to come from a frontend-computed worst-wins aggregate of the object's
 * works — removed for inventing a business rule the backend does not have.
 *
 * Corrective note, second pass (Work review, F4 patch 2): the replacement,
 * `healthStatusPresentation(object.healthStatus)`, was itself still wrong —
 * `healthStatus` mixes in critical/overdue issues, staleness and late
 * ИД/СДО, so presenting it next to "Состояние графика" over-claims a
 * schedule-specific verdict the value does not confirm. There is no API
 * field for a confirmed per-object schedule status, so the badge is removed
 * outright rather than replaced again — `schedule` now carries only `plan`
 * and `fact`, the two real percentages Design Rules §7 asks for side by side.
 * Separately, a work with `blockers` used to show only a generic
 * "Заблокировано" badge in the works table, with the real reason
 * (`work.blockers`, already confirmed data) dropped on the floor.
 * `blockedWorks` now carries those reasons through unedited — never a
 * generic label standing in for a reason nobody supplied.
 */

import type { ObjectSummary, Work } from '../types/api';
import { formatDate, formatPercent, formatQuantityWithUnit, NO_DATA_DASH } from '../formatters';
import { workStatusPresentation, type StatusPresentation } from './status';

export interface O01Details {
  externalCode: string;
  address: string;
  customerName: string;
  organizationName: string;
  responsible: string;
  startDate: string;
  plannedFinishDate: string;
}

export interface O01WorkRow {
  id: string;
  name: string;
  performer: string;
  plan: string;
  fact: string;
  smr: string;
  status: StatusPresentation;
  /** `true` for the one tone the row list actually uses — see `RowTone`. */
  needsAttention: boolean;
}

/** One blocked work and the real reasons it cannot proceed — never invented. */
export interface O01BlockedWork {
  workId: string;
  workName: string;
  reasons: string[];
}

export interface O01ViewModel {
  id: string;
  name: string;
  details: O01Details;
  /** Physical readiness — the screen's one `display`-scale figure (Design Rules). */
  readiness: { value: number | null; formatted: string };
  /**
   * Plan-on-date vs. fact, per Design Rules §7 — the two figures shown side
   * by side. No status badge: no API field gives a confirmed per-object
   * schedule status (see `view-models/status.ts`'s `NO_SCHEDULE_STATUS`).
   */
  schedule: { plan: string; fact: string };
  works: O01WorkRow[];
  /** Works with a non-empty `blockers` list, reasons intact. Empty when nothing is blocked. */
  blockedWorks: O01BlockedWork[];
}

export function buildO01ViewModel(object: ObjectSummary, works: Work[]): O01ViewModel {
  const objectWorks = works.filter((work) => work.objectId === object.id);

  const workRows: O01WorkRow[] = objectWorks.map((work) => {
    const status = workStatusPresentation(work);
    const factReported = work.lastReportedAt !== null;

    return {
      id: work.id,
      name: work.name,
      performer: work.contractor,
      plan: formatQuantityWithUnit(work.plannedQuantity, work.unit),
      fact: factReported ? formatQuantityWithUnit(work.actualQuantity, work.unit) : NO_DATA_DASH,
      smr: formatPercent(work.actualProgress),
      status,
      needsAttention: status.variant === 'Blocked' || status.variant === 'Delayed' || status.variant === 'Attention',
    };
  });
  // Attention-needing works surface first; a stable sort keeps the backend's own
  // ordering (planned start, then name) within each group.
  const works_ = [...workRows].sort((a, b) => Number(b.needsAttention) - Number(a.needsAttention));

  const blockedWorks: O01BlockedWork[] = objectWorks
    .filter((work) => work.blockers.length > 0)
    .map((work) => ({ workId: work.id, workName: work.name, reasons: work.blockers }));

  return {
    id: object.id,
    name: object.name,
    details: {
      externalCode: object.externalCode,
      address: object.address,
      customerName: object.customerName ?? NO_DATA_DASH,
      organizationName: object.organizationName ?? NO_DATA_DASH,
      responsible: object.responsible,
      startDate: formatDate(object.startDate),
      plannedFinishDate: formatDate(object.plannedFinishDate),
    },
    readiness: { value: object.actualProgress, formatted: formatPercent(object.actualProgress) },
    schedule: {
      plan: formatPercent(object.plannedProgress),
      fact: formatPercent(object.actualProgress),
    },
    works: works_,
    blockedWorks,
  };
}
