/**
 * F8.3 — the SDO workspace's own view-model: the "Upcoming packages" queue
 * (readiness not yet reached, or ready but not yet handed off) and the
 * "Active SDO Cases" table (every SDO Case that exists, whatever its own
 * status or lock state — a case returned to PTO for correction is still an
 * active case, not demoted back to "upcoming").
 */

import type { SdoClosingCase, SdoPackageReadiness } from '../types/api';
import { formatMoney } from '../formatters';
import { sdoClosingStatusPresentation, type StatusPresentation } from './status';

export interface SdoUpcomingRow {
  documentationPackageId: string;
  objectId: string;
  objectName: string;
  objectWorkId: string;
  workName: string;
  responsible: string;
  ready: boolean;
  missingReasons: string[];
  handoffPending: boolean;
}

export interface SdoActiveCaseRow {
  id: string;
  objectId: string;
  objectName: string;
  objectWorkId: string;
  workName: string;
  documentationPackageId: string;
  status: StatusPresentation;
  responsible: string;
  totalAmount: string;
  hasAttention: boolean;
}

export interface SdoWorkspaceViewModel {
  upcoming: SdoUpcomingRow[];
  activeCases: SdoActiveCaseRow[];
}

export function buildSdoWorkspaceViewModel(
  readiness: SdoPackageReadiness[],
  cases: SdoClosingCase[],
): SdoWorkspaceViewModel {
  const upcoming = readiness
    // A package that already has a Case belongs in "Active SDO Cases"
    // instead, even while temporarily returned to PTO — "upcoming" means no
    // Case exists for it yet at all.
    .filter((item) => item.sdoClosingCaseId === null)
    .map((item) => ({
      documentationPackageId: item.documentationPackageId,
      objectId: item.objectId,
      objectName: item.objectName ?? 'Объект не найден',
      objectWorkId: item.objectWorkId,
      workName: item.workName ?? 'Работа не найдена',
      responsible: item.responsible,
      ready: item.ready,
      missingReasons: item.missingReasons,
      handoffPending: item.handoffPending,
    }));

  const activeCases = cases.map((c) => ({
    id: c.id,
    objectId: c.objectId,
    objectName: c.objectName ?? 'Объект не найден',
    objectWorkId: c.objectWorkId,
    workName: c.workName ?? 'Работа не найдена',
    documentationPackageId: c.documentationPackageId,
    status: sdoClosingStatusPresentation(c.status),
    responsible: c.responsible ?? 'Не назначен',
    totalAmount: formatMoney(c.totalAmount),
    hasAttention: c.attention === 'RED',
  }));

  return { upcoming, activeCases };
}
