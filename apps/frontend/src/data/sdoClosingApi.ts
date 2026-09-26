import type { SdoClosingCase, SdoClosingPortionAllocation, SdoClosingStatus, Uuid } from '../types/api';
import { parseResponse } from '../http';
import { readSessionToken } from '../auth/sessionToken';

/**
 * F8.3 SDO / Closing — the write side of the SDO workspace itself (status
 * transitions, amount/allocation entry, responsible assignment, "Вернуть в
 * ПТО"). Mirrors `documentationApi.ts` exactly: not a `DataProvider` method,
 * the real backend only, gated by a real session existing at all. PTO's own
 * side of F8.3 (customer-acceptance registration, handoff) lives in
 * `documentationApi.ts` instead — these two files match the backend's own
 * split between `documentation.controller.ts` and `sdo-closing.controller.ts`.
 */
async function post<T>(path: string, body: unknown): Promise<T> {
  const token = readSessionToken();
  const response = await fetch(`/api/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return parseResponse(response) as Promise<T>;
}

/**
 * F8.3 decision 13 — SDO/ADMIN only. Unlocks the linked Documentation
 * Package's Portion composition and retains the same SDO Case; the case's
 * own reconciliation status is untouched ("resumes" on re-handoff).
 */
export function returnSdoCaseToPto(sdoCaseId: Uuid, version: number, comment?: string): Promise<SdoClosingCase> {
  return post(`sdo-closing-cases/${sdoCaseId}/return-to-pto`, { version, comment });
}

/**
 * F8.3 RESPONSIBILITY — SDO/ADMIN only; the backend requires the target to
 * be an active SDO user ("PTO does NOT assign work inside the SDO
 * department").
 */
export function assignSdoResponsible(sdoCaseId: Uuid, version: number, responsibleUserId: Uuid): Promise<SdoClosingCase> {
  return post(`sdo-closing-cases/${sdoCaseId}/responsible`, { version, responsibleUserId });
}

/**
 * F8.3 SDO STATUS WORKFLOW — the backend is the sole authority on which
 * transitions are legal (`isSdoClosingStatusTransitionAllowed()`,
 * packages/domain); this only sends the requested target status. `reason`
 * is required by the backend exactly for CLOSED -> ON_CORRECTION.
 */
export function changeSdoClosingStatus(
  sdoCaseId: Uuid,
  status: SdoClosingStatus,
  version: number,
  reason?: string,
): Promise<SdoClosingCase> {
  return post(`sdo-closing-cases/${sdoCaseId}/status`, { status, version, reason });
}

/** F8.3 CLOSING AMOUNT — never payment/invoice/accounting. Refused server-side once the case is CLOSED (must go back to ON_CORRECTION first). History is append-only and read from the snapshot, never from this call's own response. */
export function setSdoClosingAmount(sdoCaseId: Uuid, version: number, amount: string): Promise<SdoClosingCase> {
  return post(`sdo-closing-cases/${sdoCaseId}/amount`, { version, amount });
}

/** F8.3 optional Portion allocation — create-only. A duplicate allocation for the same Quantity Portion, or a Portion outside the linked package's own coverage, are both rejected server-side. */
export function addSdoClosingPortionAllocation(
  sdoCaseId: Uuid,
  quantityPortionId: Uuid,
  amount: string,
): Promise<SdoClosingPortionAllocation> {
  return post(`sdo-closing-cases/${sdoCaseId}/allocations`, { quantityPortionId, amount });
}
