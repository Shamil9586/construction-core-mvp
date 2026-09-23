/**
 * O01 — Object Overview.
 *
 * Single-object management view: header identity, physical readiness, the
 * object's plan/fact schedule state, and production attention. Quality (СК),
 * ИД and finance stay off this view by construction — nothing here reads
 * `inspections`, `packages`, `documents`, `sdo` or `closings`, so there is
 * nothing to accidentally mix in.
 */

import type { ObjectSummary, Work } from '../types/api';
import { formatDate, formatPercent, formatQuantityWithUnit, NO_DATA_DASH } from '../formatters';
import {
  aggregateScheduleStatus,
  scheduleStatusPresentation,
  workStatusPresentation,
  type StatusPresentation,
} from './status';

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

export interface O01ViewModel {
  id: string;
  name: string;
  details: O01Details;
  /** Physical readiness — the screen's one `display`-scale figure (Design Rules). */
  readiness: { value: number | null; formatted: string };
  schedule: { plan: string; fact: string; status: StatusPresentation };
  works: O01WorkRow[];
}

export function buildO01ViewModel(object: ObjectSummary, works: Work[]): O01ViewModel {
  const objectWorks = works.filter((work) => work.objectId === object.id);
  const scheduleStatus = aggregateScheduleStatus(objectWorks.map((w) => w.scheduleStatus));

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
      status: scheduleStatusPresentation(scheduleStatus),
    },
    works: works_,
  };
}
