/**
 * F8.2.1 — the package-detail screen's own view-model: one Documentation
 * Package, its linked portions, its documents and their versions, its
 * status history, and the single next status a PTO action can move it to.
 *
 * Decision 1 (hybrid entry points, one shared implementation): both the
 * package-detail route reached from P01 and the "Open package" link on
 * W01's Documentation Section land on this same screen/view-model — there
 * is exactly one place that decides what a package detail view shows.
 */

import type {
  DocumentationDocument,
  DocumentationDocumentType,
  DocumentationPackage,
  DocumentationPackagePortion,
  DocumentationPackageStatus,
  DocumentationStatusHistoryEntry,
  DocumentationVersion,
  ObjectSummary,
  QuantityPortion,
  StorageProvider,
  Work,
  WorkExecutionUnit,
} from '../types/api';
import { formatDate } from '../formatters';
import { documentationPackageStatusPresentation, type StatusPresentation } from './status';

/**
 * F8.2.1 Decision 5, extended by the F8.2.1-01 corrective patch — the single
 * legal next status for the current one, or `null` when there is none in
 * this phase (only ACCEPTED_BY_CUSTOMER — still not a PTO user action). The
 * correction loop closes RETURNED's own dead end: RETURNED -> CORRECTING ->
 * PRESENTED, and PRESENTED's own next status is still RETURNED, so the loop
 * repeats on a second return. Mirrors packages/domain's own
 * isDocumentationStatusTransitionAllowed() as the one legal edge out of each
 * status; the backend is still the sole authority that actually enforces it,
 * this only decides which single button to show.
 */
export function nextDocumentationStatus(current: DocumentationPackageStatus): DocumentationPackageStatus | null {
  switch (current) {
    case 'DRAFT':
      return 'PREPARING';
    case 'PREPARING':
      return 'READY_FOR_PRESENTATION';
    case 'READY_FOR_PRESENTATION':
      return 'PRESENTED';
    case 'PRESENTED':
      return 'RETURNED';
    case 'RETURNED':
      return 'CORRECTING';
    case 'CORRECTING':
      return 'PRESENTED';
    case 'ACCEPTED_BY_CUSTOMER':
      return null;
    default: {
      const exhaustive: never = current;
      return exhaustive;
    }
  }
}

/** The action button's own label for moving *to* this status — never the status badge's own label, which describes a state, not an action. */
export function nextDocumentationStatusLabel(next: DocumentationPackageStatus): string {
  switch (next) {
    case 'PREPARING':
      return 'Начать подготовку';
    case 'READY_FOR_PRESENTATION':
      return 'Отметить готовность к предъявлению';
    case 'PRESENTED':
      return 'Предъявить заказчику';
    case 'RETURNED':
      return 'Отметить возврат заказчиком';
    case 'CORRECTING':
      return 'Начать устранение замечаний';
    default:
      return 'Изменить статус';
  }
}

export function documentTypeLabel(type: DocumentationDocumentType): string {
  switch (type) {
    case 'AOSR':
      return 'АОСР';
    case 'ACT_CERTIFICATE':
      return 'Акт / сертификат';
    case 'EXECUTIVE_SCHEME':
      return 'Исполнительная схема';
    default: {
      const exhaustive: never = type;
      return exhaustive;
    }
  }
}

export function storageProviderLabel(provider: StorageProvider): string {
  switch (provider) {
    case 'NONE':
      return 'Без ссылки на хранилище';
    case 'EXTERNAL_REFERENCE':
      return 'Внешняя ссылка';
    default: {
      const exhaustive: never = provider;
      return exhaustive;
    }
  }
}

export interface PackageDetailVersionViewModel {
  id: string;
  versionNumber: number;
  storageProvider: StorageProvider;
  storageProviderLabel: string;
  storageReference: string | null;
  comment: string | null;
}

export interface PackageDetailDocumentViewModel {
  id: string;
  type: DocumentationDocumentType;
  typeLabel: string;
  /** Newest first — the version a reader most likely wants is the current one. */
  versions: PackageDetailVersionViewModel[];
}

export interface PackageDetailPortionViewModel {
  id: string;
  label: string;
}

export interface PackageDetailHistoryItemViewModel {
  id: string;
  fromStatus: DocumentationPackageStatus;
  toStatus: DocumentationPackageStatus;
  changedAt: string;
  comment: string | null;
}

export interface PackageDetailViewModel {
  id: string;
  version: number;
  objectId: string;
  objectName: string;
  objectWorkId: string;
  workName: string;
  status: StatusPresentation;
  rawStatus: DocumentationPackageStatus;
  responsible: string;
  portions: PackageDetailPortionViewModel[];
  /** This work's portions (via its execution units) not yet linked to this package — the "link portion" picker's own options, never a portion already linked elsewhere excluded (F8.2: many-to-many, no uniqueness). */
  availablePortions: PackageDetailPortionViewModel[];
  documents: PackageDetailDocumentViewModel[];
  history: PackageDetailHistoryItemViewModel[];
  nextStatus: DocumentationPackageStatus | null;
  nextStatusLabel: string | null;
}

export function buildPackageDetailViewModel(
  pkg: DocumentationPackage,
  object: ObjectSummary | undefined,
  work: Work | undefined,
  executionUnits: WorkExecutionUnit[],
  packagePortions: DocumentationPackagePortion[],
  portions: QuantityPortion[],
  documents: DocumentationDocument[],
  versions: DocumentationVersion[],
  statusHistory: DocumentationStatusHistoryEntry[],
): PackageDetailViewModel {
  const ownPortionIds = new Set(
    packagePortions.filter((link) => link.documentationPackageId === pkg.id).map((link) => link.quantityPortionId),
  );
  const ownDocuments = documents.filter((doc) => doc.documentationPackageId === pkg.id);
  const ownHistory = statusHistory
    .filter((entry) => entry.documentationPackageId === pkg.id)
    .sort((a, b) => (a.changedAt < b.changedAt ? 1 : -1));

  const workUnitIds = new Set(
    executionUnits.filter((unit) => unit.objectWorkId === pkg.objectWorkId).map((unit) => unit.id),
  );
  const workPortions = portions.filter((portion) => workUnitIds.has(portion.executionUnitId));

  const next = nextDocumentationStatus(pkg.status);

  return {
    id: pkg.id,
    version: pkg.version,
    objectId: pkg.objectId,
    objectName: object?.name ?? 'Объект не найден',
    objectWorkId: pkg.objectWorkId,
    workName: work?.name ?? 'Работа не найдена',
    status: documentationPackageStatusPresentation(pkg.status),
    rawStatus: pkg.status,
    responsible: pkg.responsible,
    portions: workPortions
      .filter((portion) => ownPortionIds.has(portion.id))
      .map((portion) => ({ id: portion.id, label: portion.label })),
    availablePortions: workPortions
      .filter((portion) => !ownPortionIds.has(portion.id))
      .map((portion) => ({ id: portion.id, label: portion.label })),
    documents: ownDocuments.map((doc) => ({
      id: doc.id,
      type: doc.type,
      typeLabel: documentTypeLabel(doc.type),
      versions: versions
        .filter((version) => version.documentationDocumentId === doc.id)
        .sort((a, b) => b.versionNumber - a.versionNumber)
        .map((version) => ({
          id: version.id,
          versionNumber: version.versionNumber,
          storageProvider: version.storageProvider,
          storageProviderLabel: storageProviderLabel(version.storageProvider),
          storageReference: version.storageReference,
          comment: version.comment,
        })),
    })),
    history: ownHistory.map((entry) => ({
      id: entry.id,
      fromStatus: entry.fromStatus,
      toStatus: entry.toStatus,
      changedAt: formatDate(entry.changedAt),
      comment: entry.comment,
    })),
    nextStatus: next,
    nextStatusLabel: next ? nextDocumentationStatusLabel(next) : null,
  };
}
