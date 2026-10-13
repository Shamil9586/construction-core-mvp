/**
 * Package identity — what a Documentation Package card must answer at a glance:
 * WHAT documentation (the Work) · FOR WHICH production scope · HOW MUCH is the current quantity · HOW AOSRs are prepared · WHO.
 *
 * Everything here is formatted from the backend read model (`DocumentationPackage.scope` / `.aosrMethod` / `.workName` / `.createdByName`),
 * which in turn reads the existing Work / execution unit / Quantity Portion / quantity provenance / persisted method. Nothing is
 * hardcoded or inferred client-side: a package with no scope says so, and an undeclared AOSR method is NOT shown as «вне Core».
 */

import type { DocumentationPackage, PackageQuantitySource } from '../types/api';
import { formatDateTime, formatQuantityWithUnit } from '../formatters';

export const SCOPE_NOT_SELECTED_TEXT = 'Участок не выбран';
export const AOSR_METHOD_UNSET_TEXT = 'Способ подготовки АОСР не выбран';
export const CREATOR_UNKNOWN_TEXT = 'Создатель не зафиксирован';
export const ARCHIVED_BADGE_TEXT = 'Архивирован';
export const ARCHIVER_UNKNOWN_TEXT = 'Архивировал: не зафиксировано';

export const METHOD_TEXT = { CORE: 'Формируются в Core', EXTERNAL: 'Формируются вне Core' } as const;
export const SOURCE_TEXT: Record<PackageQuantitySource, string> = {
  CUSTOMER_ACCEPTED: 'принято заказчиком',
  INTERNAL_SC: 'подтверждено строительным контролем',
  RP_FACT: 'по факту РП',
};

export interface PackageIdentityViewModel {
  workName: string;
  /** "1 этаж" / "1 этаж, 2 этаж" / "3 участка" — or «Участок не выбран». */
  scopeText: string;
  scopeMissing: boolean;
  /** "498 м²" — the CURRENT business quantity only (no RP → SC → customer history); null when there is nothing confirmed yet. */
  quantityText: string | null;
  quantitySourceText: string | null;
  methodText: string;
  methodDeclared: boolean;
  responsible: string;
  createdText: string;
  /** Soft archive facts (who / when / why) when the package is archived; null for an active package. Archive is NOT a status. */
  archive: PackageArchiveViewModel | null;
  /** The server says this ACTIVE package may be archived right now (`archiveBlocker === null`). Absent/unknown = false: never guessed. */
  canArchive: boolean;
}

export interface PackageArchiveViewModel {
  badgeText: string;
  byText: string;
  reasonText: string;
}

export function buildPackageIdentity(pkg: DocumentationPackage, fallbackWorkName = 'Работа'): PackageIdentityViewModel {
  const current = pkg.scope.currentQuantity;
  return {
    workName: pkg.workName ?? fallbackWorkName,
    scopeText: pkg.scope.hasScope && pkg.scope.zoneSummary ? pkg.scope.zoneSummary : SCOPE_NOT_SELECTED_TEXT,
    scopeMissing: !pkg.scope.hasScope,
    quantityText: current ? formatQuantityWithUnit(current.quantity, current.unit) : null,
    quantitySourceText: current ? SOURCE_TEXT[current.source] : null,
    methodText: pkg.aosrMethod ? METHOD_TEXT[pkg.aosrMethod] : AOSR_METHOD_UNSET_TEXT,
    methodDeclared: pkg.aosrMethod !== null,
    responsible: pkg.responsible,
    createdText: pkg.createdByName ? `Создан: ${pkg.createdByName}, ${formatDateTime(pkg.createdAt)}` : CREATOR_UNKNOWN_TEXT,
    archive: pkg.archivedAt
      ? {
          badgeText: ARCHIVED_BADGE_TEXT,
          byText: pkg.archivedByName ? `Архивировал: ${pkg.archivedByName}, ${formatDateTime(pkg.archivedAt)}` : `${ARCHIVER_UNKNOWN_TEXT}, ${formatDateTime(pkg.archivedAt)}`,
          reasonText: pkg.archiveReason ? `Причина: ${pkg.archiveReason}` : 'Причина не указана',
        }
      : null,
    canArchive: !pkg.archivedAt && pkg.archiveBlocker === null,
  };
}
