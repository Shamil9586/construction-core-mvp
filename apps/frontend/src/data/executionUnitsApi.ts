import type { Inspection, PortionQuantityConfirmation, QuantityPortion, Uuid } from '../types/api';
import { parseResponse } from '../http';
import { readSessionToken } from '../auth/sessionToken';

/**
 * F8.1 — the write side of W01's new operational actions (RP fact entry,
 * portions management, Internal SC decision registration).
 *
 * Deliberately not a `DataProvider` method: that interface exists so
 * `mockDataProvider` and `realDataProvider` can stand in for each other
 * (`selectDataProvider.ts`), and there is no mock side to any of these —
 * they reach the real backend only, gated in `WorkRoute.tsx` on a real
 * session existing at all (`useCoreRuntime().session !== null`), same as the
 * demo/mock runtime already being read-only by construction (`App.tsx`'s
 * `MOCK_RUNTIME`). Widening `DataProvider` for methods one side can never
 * implement would invent a mock contract that isn't there.
 *
 * Otherwise this mirrors `realDataProvider.ts` exactly: the same session
 * token, the same `/api` prefix, the same frozen `parseResponse` turning a
 * non-OK response into the backend's own business message (including a 401
 * — a plain inline error here is an accepted simplification for a write
 * action; the full expired-session takeover is `SnapshotProvider`'s
 * `onAuthenticationError`, wired for reads).
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

export function recordPortionFact(
  portionId: Uuid,
  quantity: number,
  version: number,
  comment: string,
): Promise<PortionQuantityConfirmation> {
  return post(`portions/${portionId}/fact`, { quantity, version, comment });
}

export function createQuantityPortion(
  executionUnitId: Uuid,
  label: string,
  plannedQuantity: number,
): Promise<QuantityPortion> {
  return post(`execution-units/${executionUnitId}/portions`, { label, plannedQuantity });
}

export function requestInternalScInspection(portionId: Uuid, version: number): Promise<Inspection> {
  return post(`portions/${portionId}/inspection-request`, { inspectionType: 'INTERNAL_SC', version });
}

export function uploadInspectionPhotoAttachment(
  fileName: string,
  mimeType: 'image/png' | 'image/jpeg',
  base64: string,
): Promise<{ id: Uuid; fileName: string; mimeType: string }> {
  return post('attachments', { fileName, mimeType, base64 });
}

export function attachInspectionPhoto(inspectionId: Uuid, attachmentId: Uuid): Promise<unknown> {
  return post(`inspections/${inspectionId}/photos`, { attachmentId });
}

export function acceptInspection(inspectionId: Uuid, version: number, comment: string): Promise<Inspection> {
  return post(`inspections/${inspectionId}/accept`, { version, comment });
}

export function rejectInspection(inspectionId: Uuid, version: number, comment: string): Promise<Inspection> {
  return post(`inspections/${inspectionId}/reject`, { version, comment });
}
