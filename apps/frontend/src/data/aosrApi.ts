import { parseResponse } from '../http';
import { readSessionToken } from '../auth/sessionToken';
import type { Uuid } from '../types/api';
import { fileNameFromContentDisposition, safeDownloadName, saveBlobAsFile } from '../download/saveBlobAsFile';

/**
 * ID-AUTO-1 — AOSR inside a Documentation Package. Real backend only (same shape as
 * `documentationApi.ts`); the backend is the sole authority for readiness, numbering,
 * freeze and authorization — this file only sends requests and types the answers.
 */
export interface AosrIssue { code: string; message: string }
export type AosrStatus = 'DRAFT' | 'GENERATED' | 'NEEDS_REGENERATION';
export interface AosrListItem { id: Uuid; title: string; suggestionCode: string | null; officialNumber: number | null; status: AosrStatus; hasDocx: boolean; revisionCount: number; version: number; ready: boolean; issueCount: number }
export interface AosrSuggestion { suggestionCode: string; title: string; workDescription: string; normativeReferences: string; subsequentWork: string }
export type AosrPartyRole = 'DEVELOPER' | 'CONSTRUCTION_ENTITY' | 'DESIGNER' | 'WORK_EXECUTOR' | 'DEVELOPER_SC_REP' | 'CONSTRUCTION_REP' | 'INTERNAL_SC' | 'DESIGNER_REP' | 'EXECUTOR_REP';
export interface AosrPartyRecord { id: Uuid; partyRole: AosrPartyRole; organizationName: string | null; organizationDetails: string | null; personName: string | null; position: string | null; registryNumber: string | null; authorityDocument: string | null; version: number }
export type AosrQualityDocType = 'PASSPORT' | 'CERTIFICATE' | 'DECLARATION' | 'OTHER';
export interface AosrMaterial { id: Uuid; name: string; qualityDocuments: { id?: Uuid; docType: AosrQualityDocType; number: string; docDate: string | null; issuer: string | null }[] }
/** «АОСР формируются в Core» / «АОСР формируются вне Core»; null = not declared yet (never inferred). */
export type AosrMethod = 'CORE' | 'EXTERNAL';
/** A scheme is documentary evidence only when a real file backs it (`hasFile`). */
export interface ExecutiveScheme { id: Uuid; title: string; hasFile: boolean; fileName: string | null; mimeType: string | null; fileVersion: number | null }
export interface AosrPackageView {
  packageId: Uuid; objectId: Uuid; templateAvailable: boolean; method: AosrMethod | null;
  methodHistory: { id: Uuid; method: AosrMethod; chosenAt: string; chosenBy: string; comment: string | null }[]; hasFileBackedScheme: boolean;
  items: AosrListItem[]; suggestions: AosrSuggestion[];
  parties: AosrPartyRecord[]; partySuggestions: Record<string, string | null>; objectName: string; objectAddress: string;
  schemes: ExecutiveScheme[]; materials: AosrMaterial[]; workPortions: { id: Uuid; label: string; location: string | null; unit: string }[];
}
export interface AosrContent { id: Uuid; title: string; workDescription: string | null; startDate: string | null; endDate: string | null; actDate: string | null; projectDocumentation: string | null; normativeReferences: string | null; subsequentWork: string | null; additionalInfo: string | null; copiesCount: number | null; version: number }
export interface AosrDetail extends AosrListItem { aosr: AosrContent; packageId: Uuid; packageStatus: string; readiness: { ready: boolean; issues: AosrIssue[] }; portionIds: Uuid[]; materials: { id: Uuid; name: string }[]; schemes: ExecutiveScheme[]; revisions: { revisionNumber: number; officialNumber: number; generatedAt: string }[]; point1Proposal: string }
export type CurrentQuantitySource = 'CUSTOMER_ACCEPTED' | 'INTERNAL_SC' | 'RP_FACT';
export interface PackageQuantityView {
  portions: { portionId: Uuid; label: string; unit: string; rpFact: string | null; internalSc: string | null; customerAccepted: string | null }[];
  current: { quantity: string; unit: string; source: CurrentQuantitySource } | null;
  history: { id: Uuid; portionId: Uuid; source: 'RP_FACT' | 'INTERNAL_SC' | 'CUSTOMER_SC'; quantity: string; recordedAt: string; comment: string | null; recordedBy: string }[];
  customerAcceptances: { id: Uuid; quantityPortionId: Uuid; quantity: string; reference: string | null; comment: string | null; recordedAt: string }[];
}

async function send<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const token = readSessionToken();
  const response = await fetch(`/api/${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return parseResponse(response) as Promise<T>;
}

export const getAosrPackageView = (packageId: Uuid) => send<AosrPackageView>('GET', `documentation-packages/${packageId}/aosr`);
export const getAosr = (id: Uuid) => send<AosrDetail>('GET', `aosr/${id}`);
export const createAosr = (packageId: Uuid, body: { title?: string; suggestionCode?: string; workDescription?: string }) => send<{ id: Uuid }>('POST', `documentation-packages/${packageId}/aosr`, body);
export const dismissAosrSuggestion = (packageId: Uuid, suggestionCode: string) => send<unknown>('POST', `documentation-packages/${packageId}/aosr-suggestions/dismiss`, { suggestionCode });
export const editAosr = (id: Uuid, body: Record<string, unknown> & { version: number }) => send<AosrContent>('POST', `aosr/${id}/edit`, body);
export const deleteAosr = (id: Uuid) => send<unknown>('POST', `aosr/${id}/delete`, {});
export const setAosrLinks = (id: Uuid, body: { quantityPortionIds?: Uuid[]; materialRecordIds?: Uuid[]; schemeDocumentIds?: Uuid[]; version: number }) => send<AosrContent>('POST', `aosr/${id}/links`, body);
export const generateAosr = (id: Uuid, version: number) => send<AosrContent>('POST', `aosr/${id}/generate`, { version });
export const saveAosrParty = (packageId: Uuid, body: Partial<AosrPartyRecord> & { partyRole: AosrPartyRole }) => {
  const { id: _id, ...rest } = body as Record<string, unknown>;
  const payload = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== null && v !== ''));
  return send<AosrPartyRecord>('POST', `documentation-packages/${packageId}/aosr-parties`, payload);
};
export const createAosrMaterial = (packageId: Uuid, body: { name: string; qualityDocuments?: { docType: AosrQualityDocType; number: string; docDate?: string }[] }) => send<{ id: Uuid }>('POST', `documentation-packages/${packageId}/aosr-materials`, body);
export const setAosrMethod = (packageId: Uuid, method: AosrMethod, comment?: string) => send<{ id: Uuid; method: AosrMethod }>('POST', `documentation-packages/${packageId}/aosr-method`, { method, ...(comment ? { comment } : {}) });
export type SchemeFileMime = 'application/pdf' | 'image/png' | 'image/jpeg';
export interface SchemeFilePayload { fileName: string; mimeType: SchemeFileMime; base64: string }
/** Creates a scheme together with its file in one request — no metadata-only shell is ever created. */
export const createExecutiveScheme = (packageId: Uuid, title: string, file: SchemeFilePayload) => send<ExecutiveScheme>('POST', `documentation-packages/${packageId}/executive-schemes`, { title, ...file });
/** Attaches the real file to an existing scheme (e.g. one that so far had metadata only). */
export const attachExecutiveSchemeFile = (packageId: Uuid, schemeId: Uuid, file: SchemeFilePayload) => send<ExecutiveScheme>('POST', `documentation-packages/${packageId}/executive-schemes/${schemeId}/file`, file);
export const getPackageQuantity = (packageId: Uuid) => send<PackageQuantityView>('GET', `documentation-packages/${packageId}/quantity`);
/** «Зафиксировать объём, принятый заказчиком» — append-only; idempotencyKey is minted once per logical attempt by the caller. */
export const recordCustomerAcceptedQuantity = (packageId: Uuid, items: { quantityPortionId: Uuid; quantity: string }[], reference: string | undefined, idempotencyKey: string) =>
  send<unknown>('POST', `documentation-packages/${packageId}/customer-accepted-quantity`, { items, reference, idempotencyKey });

/** Authenticated binary fetch (a plain <a href> cannot send the bearer). Returns the bytes as a typed Blob plus a safe file name. */
export async function fetchAuthenticatedFile(path: string, fallbackName: string): Promise<{ blob: Blob; name: string }> {
  const token = readSessionToken();
  const response = await fetch(`/api/${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!response.ok) throw Error('Не удалось получить файл: HTTP ' + response.status);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength === 0) throw Error('Сервер вернул пустой файл');
  return {
    blob: new Blob([bytes], { type: response.headers.get('content-type') ?? 'application/octet-stream' }),
    name: safeDownloadName(fileNameFromContentDisposition(response.headers.get('content-disposition')), fallbackName),
  };
}
export const fetchAosrDocx = (id: Uuid, fallbackName: string) => fetchAuthenticatedFile(`aosr/${id}/docx`, fallbackName);
/** Fetch + user-initiated save in one step (see download/saveBlobAsFile.ts); used where prefetching would be wasteful. */
export async function downloadExecutiveSchemeFile(packageId: Uuid, schemeId: Uuid, fallbackName: string): Promise<void> {
  const { blob, name } = await fetchAuthenticatedFile(`documentation-packages/${packageId}/executive-schemes/${schemeId}/file`, fallbackName);
  saveBlobAsFile(blob, name);
}
