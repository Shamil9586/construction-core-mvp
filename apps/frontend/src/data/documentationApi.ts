import type {
  DocumentationDocument,
  DocumentationDocumentType,
  DocumentationPackage,
  DocumentationPackagePortion,
  DocumentationPackageStatus,
  DocumentationVersion,
  StorageProvider,
  UserSummary,
  Uuid,
} from '../types/api';
import { parseResponse } from '../http';
import { readSessionToken } from '../auth/sessionToken';

/**
 * F8.2.1 — the write side of the PTO Operations Layer (create/open a
 * Documentation Package, link portions, manage documents/versions, drive
 * status). Mirrors `executionUnitsApi.ts` exactly: not a `DataProvider`
 * method (no mock side exists or is asked for), the real backend only,
 * gated by a real session existing at all — same reasoning, same shape.
 *
 * Decision 1 (hybrid entry points, one shared implementation): both P01 and
 * W01's own "create/open package" actions call these same functions — never
 * a second, screen-local copy of the request shape.
 */

/**
 * F8.2.1-04 (Corrective Patch) — how a "Создать пакет" action resolves the
 * package's `responsibleUserId`, which the backend requires to name an
 * active PTO user (`ensure(responsible.role === 'PTO' && responsible.isActive, ...)`,
 * `service.ts`, unchanged by this patch). A PTO session is itself an active
 * PTO user and defaults to itself; ADMIN is not a PTO user at all and has
 * nothing to default to, so it must choose one from `ptoUsers`. Shared by
 * P01 and W01 (Decision 1) rather than each screen re-deriving which mode
 * applies to the current actor.
 */
export type CreatePackageResponsible =
  | { mode: 'self'; userId: Uuid }
  | { mode: 'pick'; ptoUsers: UserSummary[] };
async function post<T>(path: string, body: unknown): Promise<T> {
  const token = readSessionToken();
  const response = await fetch(`/api/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return parseResponse(response) as Promise<T>;
}

export function createDocumentationPackage(
  objectWorkId: Uuid,
  responsibleUserId: Uuid,
): Promise<DocumentationPackage> {
  return post('documentation-packages', { objectWorkId, responsibleUserId });
}

export function editDocumentationPackage(
  packageId: Uuid,
  responsibleUserId: Uuid,
  version: number,
): Promise<DocumentationPackage> {
  return post(`documentation-packages/${packageId}/edit`, { responsibleUserId, version });
}

export function linkDocumentationPackagePortion(
  packageId: Uuid,
  quantityPortionId: Uuid,
): Promise<DocumentationPackagePortion> {
  return post(`documentation-packages/${packageId}/portions`, { quantityPortionId });
}

export function createDocumentationDocument(
  packageId: Uuid,
  type: DocumentationDocumentType,
): Promise<DocumentationDocument> {
  return post(`documentation-packages/${packageId}/documents`, { type });
}

/**
 * `storageReference` is required by the backend exactly when `storageProvider`
 * is `EXTERNAL_REFERENCE`, and rejected otherwise (`documentationVersionDto`,
 * `apps/backend/src/validation.ts`) — this passes whatever the caller gives it
 * straight through, the validation itself is not re-implemented here.
 */
export function createDocumentationVersion(
  documentId: Uuid,
  storageProvider: StorageProvider,
  storageReference: string | undefined,
  comment: string | undefined,
): Promise<DocumentationVersion> {
  return post(`documentation-documents/${documentId}/versions`, { storageProvider, storageReference, comment });
}

/**
 * F8.2.1 Decision 5 — the backend is the sole authority on which
 * transitions are legal (`isDocumentationStatusTransitionAllowed()`,
 * packages/domain); this only sends the requested target status. The
 * package-detail screen decides which button to even show using the same
 * allow-list, mirrored in `view-models/documentationPackage.ts` — never two
 * independently-typed copies of the graph.
 */
export function changeDocumentationPackageStatus(
  packageId: Uuid,
  status: DocumentationPackageStatus,
  version: number,
  comment?: string,
): Promise<DocumentationPackage> {
  return post(`documentation-packages/${packageId}/status`, { status, version, comment });
}
