/**
 * F8.3 — the SDO Case detail screen's own view-model: one SDO Case, its
 * linked Documentation Package's lock/handoff state, the Quantity Portions
 * it covers with any optional allocation, and its three independent
 * append-only histories (status, handoff/return, amount).
 */

import Decimal from 'decimal.js';
import type {
  ObjectSummary,
  QuantityPortion,
  SdoClosingAmountHistoryEntry,
  SdoClosingCase,
  SdoClosingHandoffHistoryEntry,
  SdoClosingPortionAllocation,
  SdoClosingPortionAllocationHistoryEntry,
  SdoClosingStatus,
  SdoClosingStatusHistoryEntry,
  Work,
  WorkExecutionUnit,
} from '../types/api';
import { formatDate, formatMoney, formatQuantityWithUnit } from '../formatters';
import { sdoClosingStatusPresentation, type StatusPresentation } from './status';

/**
 * F8.3 SDO STATUS WORKFLOW — every legal next status for the current one,
 * mirroring `isSdoClosingStatusTransitionAllowed()` (packages/domain) as a
 * branching allow-list (unlike the Documentation Package's own single-next-
 * status chain, an SDO Case can legally move to either of two statuses from
 * `ON_RECONCILIATION`/`VERIFICATION_PASSED`) — "allowed status actions
 * only", never a free picker. The backend remains the sole authority that
 * actually enforces it.
 */
export function allowedNextSdoClosingStatuses(current: SdoClosingStatus): SdoClosingStatus[] {
  switch (current) {
    case 'ON_RECONCILIATION':
      return ['VERIFICATION_PASSED', 'ON_CORRECTION'];
    case 'VERIFICATION_PASSED':
      return ['CLOSED', 'ON_CORRECTION'];
    case 'ON_CORRECTION':
      return ['ON_RECONCILIATION'];
    case 'CLOSED':
      return ['ON_CORRECTION'];
    default: {
      const exhaustive: never = current;
      return exhaustive;
    }
  }
}

/** The action button's own label for moving *to* this status — never the status badge's own label, which describes a state, not an action. */
export function sdoClosingStatusActionLabel(next: SdoClosingStatus): string {
  switch (next) {
    case 'VERIFICATION_PASSED':
      return 'Отметить: выверка пройдена';
    case 'ON_CORRECTION':
      return 'Вернуть на корректировку';
    case 'CLOSED':
      return 'Закрыть дело';
    case 'ON_RECONCILIATION':
      return 'Вернуть на выверку';
    default: {
      const exhaustive: never = next;
      return exhaustive;
    }
  }
}

export interface SdoCaseDetailPortionViewModel {
  id: string;
  label: string;
  plannedQuantity: string;
  /** `null` exactly when this covered portion has no allocation of its own yet — "optional". */
  allocatedAmount: string | null;
  /** F8.3-R05 — the existing allocation's own `version`, required to correct it; `null` alongside `allocatedAmount === null` (nothing to correct yet). */
  allocationVersion: number | null;
}

export interface SdoCaseDetailStatusHistoryItem {
  id: string;
  fromStatus: StatusPresentation;
  toStatus: StatusPresentation;
  changedAt: string;
  reason: string | null;
}

export interface SdoCaseDetailHandoffHistoryItem {
  id: string;
  eventLabel: string;
  occurredAt: string;
  comment: string | null;
}

export interface SdoCaseDetailAmountHistoryItem {
  id: string;
  previousAmount: string;
  newAmount: string;
  changedAt: string;
}

/** F8.3-R05 — one corrected-in-place Portion allocation, named by its Portion label (there is no case-wide total here, unlike amount history). */
export interface SdoCaseDetailAllocationHistoryItem {
  id: string;
  portionLabel: string;
  previousAmount: string;
  newAmount: string;
  changedAt: string;
}

export interface SdoCaseDetailViewModel {
  id: string;
  version: number;
  objectId: string;
  objectName: string;
  objectWorkId: string;
  workName: string;
  documentationPackageId: string;
  packageLocked: boolean;
  status: StatusPresentation;
  rawStatus: SdoClosingStatus;
  allowedActions: { status: SdoClosingStatus; label: string }[];
  responsibleUserId: string | null;
  responsible: string;
  totalAmount: string;
  rawTotalAmount: string | null;
  portions: SdoCaseDetailPortionViewModel[];
  /** Sum of every allocation on this case — compared against `rawTotalAmount` by the screen, never re-decided here (the backend is the sole authority on whether CLOSED is actually allowed). */
  allocatedSum: string;
  statusHistory: SdoCaseDetailStatusHistoryItem[];
  handoffHistory: SdoCaseDetailHandoffHistoryItem[];
  amountHistory: SdoCaseDetailAmountHistoryItem[];
  allocationHistory: SdoCaseDetailAllocationHistoryItem[];
}

function handoffEventLabel(event: SdoClosingHandoffHistoryEntry['event']): string {
  return event === 'HANDED_OFF' ? 'Передано в СДО' : 'Возвращено в ПТО';
}

export function buildSdoCaseDetailViewModel(
  sdoCase: SdoClosingCase,
  object: ObjectSummary | undefined,
  work: Work | undefined,
  executionUnits: WorkExecutionUnit[],
  portions: QuantityPortion[],
  allocations: SdoClosingPortionAllocation[],
  statusHistory: SdoClosingStatusHistoryEntry[],
  handoffHistory: SdoClosingHandoffHistoryEntry[],
  amountHistory: SdoClosingAmountHistoryEntry[],
  allocationHistory: SdoClosingPortionAllocationHistoryEntry[],
): SdoCaseDetailViewModel {
  const unitById = new Map(executionUnits.map((unit) => [unit.id, unit]));
  // SDO has no other F8.2 access at all — `sdoCase.coveredQuantityPortionIds`
  // (carried on the case row itself, ReadService.snapshot()) is the one
  // bridge to this, never `documentationPackagePortions` directly, which
  // SDO's own snapshot omits entirely (canAccessDocumentation()).
  const coveredPortionIds = new Set(sdoCase.coveredQuantityPortionIds);
  const ownAllocations = allocations.filter((a) => a.sdoClosingCaseId === sdoCase.id);
  const allocationByPortion = new Map(ownAllocations.map((a) => [a.quantityPortionId, a]));
  const allocatedSum = ownAllocations.reduce((sum, a) => sum.add(a.amount), new Decimal(0));

  const ownStatusHistory = statusHistory
    .filter((entry) => entry.sdoClosingCaseId === sdoCase.id)
    .sort((a, b) => (a.changedAt < b.changedAt ? 1 : -1));
  const ownHandoffHistory = handoffHistory
    .filter((entry) => entry.sdoClosingCaseId === sdoCase.id)
    .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1));
  const ownAmountHistory = amountHistory
    .filter((entry) => entry.sdoClosingCaseId === sdoCase.id)
    .sort((a, b) => (a.changedAt < b.changedAt ? 1 : -1));
  const portionLabelById = new Map(portions.map((portion) => [portion.id, portion.label]));
  const ownAllocationHistory = allocationHistory
    .filter((entry) => entry.sdoClosingCaseId === sdoCase.id)
    .sort((a, b) => (a.changedAt < b.changedAt ? 1 : -1));

  return {
    id: sdoCase.id,
    version: sdoCase.version,
    objectId: sdoCase.objectId,
    objectName: object?.name ?? sdoCase.objectName ?? 'Объект не найден',
    objectWorkId: sdoCase.objectWorkId,
    workName: work?.name ?? sdoCase.workName ?? 'Работа не найдена',
    documentationPackageId: sdoCase.documentationPackageId,
    packageLocked: sdoCase.packageLocked,
    status: sdoClosingStatusPresentation(sdoCase.status),
    rawStatus: sdoCase.status,
    allowedActions: allowedNextSdoClosingStatuses(sdoCase.status).map((status) => ({
      status,
      label: sdoClosingStatusActionLabel(status),
    })),
    responsibleUserId: sdoCase.responsibleUserId,
    responsible: sdoCase.responsible ?? 'Не назначен',
    totalAmount: formatMoney(sdoCase.totalAmount),
    rawTotalAmount: sdoCase.totalAmount,
    portions: portions
      .filter((portion) => coveredPortionIds.has(portion.id))
      .map((portion) => {
        const unit = unitById.get(portion.executionUnitId);
        const allocation = allocationByPortion.get(portion.id);
        return {
          id: portion.id,
          label: portion.label,
          plannedQuantity: formatQuantityWithUnit(portion.plannedQuantity, unit?.unit ?? ''),
          allocatedAmount: allocation ? formatMoney(allocation.amount) : null,
          allocationVersion: allocation ? allocation.version : null,
        };
      }),
    allocatedSum: formatMoney(allocatedSum.isZero() && ownAllocations.length === 0 ? null : allocatedSum.toFixed(2)),
    statusHistory: ownStatusHistory.map((entry) => ({
      id: entry.id,
      fromStatus: sdoClosingStatusPresentation(entry.fromStatus),
      toStatus: sdoClosingStatusPresentation(entry.toStatus),
      changedAt: formatDate(entry.changedAt),
      reason: entry.reason,
    })),
    handoffHistory: ownHandoffHistory.map((entry) => ({
      id: entry.id,
      eventLabel: handoffEventLabel(entry.event),
      occurredAt: formatDate(entry.occurredAt),
      comment: entry.comment,
    })),
    amountHistory: ownAmountHistory.map((entry) => ({
      id: entry.id,
      previousAmount: formatMoney(entry.previousAmount),
      newAmount: formatMoney(entry.newAmount),
      changedAt: formatDate(entry.changedAt),
    })),
    allocationHistory: ownAllocationHistory.map((entry) => ({
      id: entry.id,
      portionLabel: portionLabelById.get(entry.quantityPortionId) ?? 'Участок не найден',
      previousAmount: formatMoney(entry.previousAmount),
      newAmount: formatMoney(entry.newAmount),
      changedAt: formatDate(entry.changedAt),
    })),
  };
}
