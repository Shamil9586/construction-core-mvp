/**
 * P01 — PTO Workspace.
 *
 * F8.2.1 PTO Operations Layer: one row per work (not per package) — every
 * work shows its object, its current Documentation Package status (or "no
 * package yet"), the responsible PTO, and — folding in Decision 4's PTO
 * Attention Queue — why it still needs attention, when it does. This is a
 * deliberate redesign from F8.2's own "package list" (which only ever
 * listed works that already *had* a package): the flow the Decision Lock
 * describes — "Открыть очередь ПТО → Выбрать работу → Создать
 * Documentation Package" — starts from a work with no package at all, so
 * the queue and the list are the same table, not two separate ones.
 *
 * `objectId`/`workId` cross-references resolve against the same snapshot
 * arrays every other screen already reads (`ObjectSummary[]`, `Work[]`)
 * rather than a second fetch; `responsible`/`level`/`reason`/`packageId`
 * arrive pre-resolved from `ReadService.snapshot()`'s own JOIN and its
 * `resolveDocumentationAttention()` call (packages/domain) — this module
 * does not re-derive either.
 */

import type { DocumentationAttentionItem, DocumentationPackage, ObjectSummary, Work } from '../types/api';
import { documentationPackageStatusPresentation, type StatusPresentation } from './status';

export interface P01ObjectOption {
  id: string;
  name: string;
}

export interface P01WorkRow {
  objectId: string;
  objectName: string;
  objectWorkId: string;
  workName: string;
  /** `null` when this work has no Documentation Package at all yet — the row's action is "Создать пакет", never "Открыть". */
  package: { id: string; status: StatusPresentation; responsible: string } | null;
  /** `null` once the work's documentation is cleared (Decision 4: READY_FOR_PRESENTATION or later) — the row carries no attention badge or reason then. */
  attentionLevel: 'RED' | 'YELLOW' | null;
  attentionReason: string | null;
}

export interface P01ViewModel {
  rows: P01WorkRow[];
  /** For the object filter control — every object with at least one visible work, sorted by name. */
  objectOptions: P01ObjectOption[];
}

export function buildP01ViewModel(
  works: Work[],
  objects: ObjectSummary[],
  packages: DocumentationPackage[],
  attentionQueue: DocumentationAttentionItem[],
): P01ViewModel {
  const rows: P01WorkRow[] = works.map((work) => {
    const object = objects.find((candidate) => candidate.id === work.objectId);
    const attentionItem = attentionQueue.find((item) => item.objectWorkId === work.id);
    // The package a cleared work's row still opens: the queue only carries
    // an item (and so a packageId) while attention is owed, so a cleared
    // work's own "current" package is resolved here instead, the same
    // "latest package for this work" reading the queue's own worst-package
    // pick already uses when attention *is* owed.
    const relevantPackage = attentionItem
      ? packages.find((pkg) => pkg.id === attentionItem.packageId)
      : packages.filter((pkg) => pkg.objectWorkId === work.id).slice(-1)[0];

    return {
      objectId: work.objectId,
      objectName: object?.name ?? 'Объект не найден',
      objectWorkId: work.id,
      workName: work.name,
      package: relevantPackage
        ? {
            id: relevantPackage.id,
            status: documentationPackageStatusPresentation(relevantPackage.status),
            responsible: relevantPackage.responsible,
          }
        : null,
      attentionLevel: attentionItem?.level ?? null,
      attentionReason: attentionItem?.reason ?? null,
    };
  });

  const objectOptionsById = new Map<string, string>();
  for (const row of rows) objectOptionsById.set(row.objectId, row.objectName);
  const objectOptions = Array.from(objectOptionsById, ([id, name]) => ({ id, name })).sort((a, b) =>
    a.name.localeCompare(b.name, 'ru'),
  );

  return { rows, objectOptions };
}

export const P01_NO_WORKS_LABEL = 'Работ нет';
export const P01_NO_WORKS_FOR_OBJECT_LABEL = 'По выбранному объекту работ нет';
