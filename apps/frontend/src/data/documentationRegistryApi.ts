import { parseResponse } from '../http';
import { readSessionToken } from '../auth/sessionToken';
import type { Uuid } from '../types/api';

/**
 * ID-AUTO-2 — the Object documentation registry («Реестр ИД»). Real backend only. The server is the sole authority for everything in this
 * payload: which packages the viewer may see, readiness and its reasons, counts, filtering. This module only sends the request and types
 * the answer — no rule is restated here.
 */
export type RegistryAosrMethod = 'CORE' | 'EXTERNAL';
export type RegistryQuantitySource = 'CUSTOMER_ACCEPTED' | 'INTERNAL_SC' | 'RP_FACT';
export type RegistryDocxState = 'NOT_GENERATED' | 'CURRENT' | 'OUTDATED';

/** Where a blocker is fixed. The screen maps a target to an existing section of the package detail; the server only names it. */
export type RegistryReadinessTarget =
  | { kind: 'SCOPE' }
  | { kind: 'METHOD' }
  | { kind: 'AOSR_SECTION' }
  | { kind: 'AOSR'; aosrId: Uuid }
  | { kind: 'SCHEMES' };

export interface RegistryReadinessReason {
  code: string;
  message: string;
  target: RegistryReadinessTarget;
  aosrId?: Uuid;
  aosrTitle?: string;
}
export interface RegistryReadiness { ready: boolean; reasons: RegistryReadinessReason[] }

export type RegistryLastUpdateKind =
  | 'PACKAGE_CREATED' | 'PACKAGE_CHANGED' | 'STATUS_CHANGED' | 'METHOD_CHOSEN'
  | 'AOSR_CHANGED' | 'AOSR_GENERATED' | 'SCHEME_UPLOADED' | 'DOCUMENT_CHANGED' | 'CUSTOMER_QUANTITY_RECORDED';

export interface RegistryScope {
  hasScope: boolean;
  zoneSummary: string | null;
  zones: string[];
  currentQuantity: { quantity: string; unit: string; source: RegistryQuantitySource } | null;
}

export interface RegistryAosrItem {
  id: Uuid;
  number: number | null;
  title: string;
  workDescription: string | null;
  zones: string[];
  startDate: string | null;
  endDate: string | null;
  actDate: string | null;
  docx: { state: RegistryDocxState; revisionCount: number };
  schemeCoverage: { covered: boolean; schemes: { id: Uuid; title: string; hasFile: boolean }[] };
  readiness: RegistryReadiness;
  generationIssues: { code: string; message: string }[];
  projectDocumentation: string | null;
  normativeReferences: string | null;
  subsequentWork: string | null;
  lastUpdateAt: string;
  version: number;
}

export interface RegistryPackageItem {
  packageId: Uuid;
  workId: Uuid;
  workName: string;
  scope: RegistryScope;
  responsible: { id: Uuid; name: string };
  status: string;
  aosrMethod: RegistryAosrMethod | null;
  aosrCount: number;
  aosrGeneratedCount: number;
  schemeCount: number;
  schemeFileBackedCount: number;
  readiness: RegistryReadiness;
  awaitingEngineerAction: boolean;
  lastUpdate: { at: string; kind: RegistryLastUpdateKind };
  aosrs: RegistryAosrItem[];
}

export interface RegistryArchivedItem {
  packageId: Uuid;
  workId: Uuid;
  workName: string;
  scope: RegistryScope;
  responsible: { id: Uuid; name: string };
  status: string;
  aosrMethod: RegistryAosrMethod | null;
  archivedAt: string;
  archivedByName: string | null;
  archiveReason: string | null;
}

export interface RegistrySummaryCounts { activePackages: number; ready: number; notReady: number; awaitingEngineerAction: number }

export interface DocumentationRegistryPayload {
  objectId: Uuid;
  objectName: string;
  objectAddress: string | null;
  worksScope: 'ALL_WORKS' | 'ASSIGNED_WORKS';
  summary: RegistrySummaryCounts;
  matchedCount: number;
  filterOptions: { responsible: { id: Uuid; name: string }[] };
  rows: RegistryPackageItem[];
  archivedCount: number;
  archivedRows?: RegistryArchivedItem[];
}

export type RegistryMethodFilter = RegistryAosrMethod | 'UNSET';
/** Filters as the screen holds them — every field optional, absent = "all". */
export interface RegistryQuery {
  responsibleUserId?: Uuid;
  status?: string;
  ready?: boolean;
  method?: RegistryMethodFilter;
  q?: string;
  archived?: boolean;
}

export function registryQueryString(query: RegistryQuery): string {
  const p = new URLSearchParams();
  if (query.responsibleUserId) p.set('responsibleUserId', query.responsibleUserId);
  if (query.status) p.set('status', query.status);
  if (query.ready !== undefined) p.set('ready', String(query.ready));
  if (query.method) p.set('method', query.method);
  if (query.q && query.q.trim()) p.set('q', query.q.trim());
  if (query.archived) p.set('archived', 'true');
  const text = p.toString();
  return text ? `?${text}` : '';
}

export async function getObjectDocumentationRegistry(objectId: Uuid, query: RegistryQuery = {}): Promise<DocumentationRegistryPayload> {
  const token = readSessionToken();
  const response = await fetch(`/api/objects/${encodeURIComponent(objectId)}/documentation-registry${registryQueryString(query)}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return parseResponse(response) as Promise<DocumentationRegistryPayload>;
}
