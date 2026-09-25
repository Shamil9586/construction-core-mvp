/**
 * P01 — PTO Workspace.
 *
 * F8.2 PTO / Executive Documentation Foundation MVP: a package list, filtered
 * by object, showing status, covered portions and the responsible PTO
 * employee. Deliberately thin — the same "derive exactly what the screen
 * renders, nothing else" rule every other view-model in this directory
 * follows. `objectId`/`workId` cross-references resolve against the same
 * snapshot arrays every other screen already reads (`ObjectSummary[]`,
 * `Work[]`) rather than a second fetch; `responsible` is the one field with
 * no such array to join against (`Snapshot` carries no `users` collection),
 * so it arrives pre-resolved from the backend (`read-service.ts`'s own JOIN,
 * the same treatment `works.responsible`/`objects.responsible` already get).
 */

import type { DocumentationPackage, DocumentationPackagePortion, ObjectSummary, Work } from '../types/api';
import { documentationPackageStatusPresentation, type StatusPresentation } from './status';

export interface P01ObjectOption {
  id: string;
  name: string;
}

export interface P01PackageRow {
  id: string;
  objectId: string;
  objectName: string;
  workId: string;
  workName: string;
  status: StatusPresentation;
  responsible: string;
  /** Count of linked Quantity Portions — informational only; F8.2 does not confirm quantity (BR-03), it only shows how many portions this package currently covers. */
  coveredPortionCount: number;
}

export interface P01ViewModel {
  packages: P01PackageRow[];
  /** For the object filter control — every object that has at least one package, sorted by name. */
  objectOptions: P01ObjectOption[];
}

export function buildP01ViewModel(
  packages: DocumentationPackage[],
  objects: ObjectSummary[],
  works: Work[],
  packagePortions: DocumentationPackagePortion[],
): P01ViewModel {
  const rows: P01PackageRow[] = packages.map((pkg) => {
    const object = objects.find((candidate) => candidate.id === pkg.objectId);
    const work = works.find((candidate) => candidate.id === pkg.objectWorkId);
    return {
      id: pkg.id,
      objectId: pkg.objectId,
      objectName: object?.name ?? 'Объект не найден',
      workId: pkg.objectWorkId,
      workName: work?.name ?? 'Работа не найдена',
      status: documentationPackageStatusPresentation(pkg.status),
      responsible: pkg.responsible,
      coveredPortionCount: packagePortions.filter((link) => link.documentationPackageId === pkg.id).length,
    };
  });

  const objectOptionsById = new Map<string, string>();
  for (const row of rows) objectOptionsById.set(row.objectId, row.objectName);
  const objectOptions = Array.from(objectOptionsById, ([id, name]) => ({ id, name })).sort((a, b) =>
    a.name.localeCompare(b.name, 'ru'),
  );

  return { packages: rows, objectOptions };
}

export const P01_NO_PACKAGES_LABEL = 'Пакетов исполнительной документации нет';
export const P01_NO_PACKAGES_FOR_OBJECT_LABEL = 'По выбранному объекту пакетов нет';
