import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildP01ViewModel } from '../apps/frontend/src/view-models/p01';
import type {
  DocumentationAttentionItem,
  DocumentationPackage,
  ObjectSummary,
  Work,
} from '../apps/frontend/src/types/api';

/**
 * P01 — PTO Workspace. Pure-logic coverage for `buildP01ViewModel`, no
 * React, no browser — the same style `tests/f8.1-w01-viewmodel.test.ts`
 * already uses for view-model functions in this directory.
 *
 * F8.2.1 redesign: one row per work (not per package), folding in the PTO
 * Attention Queue (Decision 4) — a work with no package at all is now a
 * real row (queue item, "create" action), not simply absent the way F8.2's
 * own package-only list left it.
 */

function baseObject(overrides: Partial<ObjectSummary> = {}): ObjectSummary {
  return {
    id: 'object-1',
    tenantId: 'tenant-1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    version: 1,
    externalCode: 'OBJ-1',
    source: 'core',
    name: 'Объект 1',
    address: 'Тест, 1',
    customerName: null,
    organizationName: 'ООО СЗ «Гор-Строй»',
    projectManagerId: 'pm-1',
    startDate: '2026-01-01',
    plannedFinishDate: '2026-12-31',
    actualFinishDate: null,
    status: 'ACTIVE',
    healthStatus: 'GREEN',
    responsible: 'РП Тестов',
    contractorIds: ['contractor-1'],
    contractors: ['Подрядчик 1'],
    actualProgress: 50,
    plannedProgress: 50,
    ...overrides,
  };
}

function baseWork(overrides: Partial<Work> = {}): Work {
  return {
    id: 'work-1',
    tenantId: 'tenant-1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    version: 1,
    objectId: 'object-1',
    workTypeId: 'work-type-1',
    contractorId: 'contractor-1',
    responsibleUserId: 'pm-1',
    name: 'Штукатурка стен',
    unit: 'м²',
    plannedQuantity: '500',
    actualQuantity: '0',
    plannedStartDate: '2026-01-01',
    plannedFinishDate: '2026-03-01',
    actualStartDate: null,
    actualFinishDate: null,
    status: 'ACTIVE',
    categoryId: 'category-1',
    requiresInspection: true,
    requiresMaterials: false,
    contractor: 'Подрядчик 1',
    responsible: 'РП Тестов',
    lastReportedAt: null,
    plannedProgress: 50,
    actualProgress: 0,
    variance: null,
    delayDays: 0,
    scheduleStatus: 'GREEN',
    accepted: false,
    docsReady: false,
    blockers: [],
    stale: false,
    ...overrides,
  };
}

function basePackage(overrides: Partial<DocumentationPackage> = {}): DocumentationPackage {
  return {
    id: 'package-1',
    tenantId: 'tenant-1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    version: 1,
    objectId: 'object-1',
    objectWorkId: 'work-1',
    status: 'DRAFT',
    responsibleUserId: 'pto-1',
    responsible: 'Ольга Морозова',
    createdBy: 'pto-1',
    ...overrides,
  };
}

function baseAttentionItem(overrides: Partial<DocumentationAttentionItem> = {}): DocumentationAttentionItem {
  return {
    objectId: 'object-1',
    objectName: 'Объект 1',
    objectWorkId: 'work-1',
    workName: 'Штукатурка стен',
    level: 'RED',
    reason: 'Нет пакета ИД',
    responsible: null,
    packageId: null,
    ...overrides,
  };
}

test('P01 view-model: a work with no package and no attention item — no package, no attention (the DoD "READY clears the queue" case, resting state)', () => {
  const vm = buildP01ViewModel([baseWork()], [baseObject()], [], []);
  assert.equal(vm.rows.length, 1);
  assert.equal(vm.rows[0]!.package, null);
  assert.equal(vm.rows[0]!.attentionLevel, null);
  assert.equal(vm.rows[0]!.attentionReason, null);
});

test('P01 view-model: a work with no package but a RED attention item — the row surfaces the "create package" case', () => {
  const vm = buildP01ViewModel([baseWork()], [baseObject()], [], [baseAttentionItem()]);
  assert.equal(vm.rows[0]!.package, null, 'nothing to open — there really is no package yet');
  assert.equal(vm.rows[0]!.attentionLevel, 'RED');
  assert.equal(vm.rows[0]!.attentionReason, 'Нет пакета ИД');
});

test('P01 view-model: a work with a DRAFT package and a YELLOW attention item — resolves the package by the queue\'s own packageId', () => {
  const pkg = basePackage({ status: 'DRAFT' });
  const attentionItem = baseAttentionItem({ level: 'YELLOW', reason: 'Документы формируются', responsible: 'Ольга Морозова', packageId: 'package-1' });
  const vm = buildP01ViewModel([baseWork()], [baseObject()], [pkg], [attentionItem]);
  assert.ok(vm.rows[0]!.package);
  assert.equal(vm.rows[0]!.package!.id, 'package-1');
  assert.equal(vm.rows[0]!.package!.status.label, 'Черновик');
  assert.equal(vm.rows[0]!.package!.responsible, 'Ольга Морозова');
  assert.equal(vm.rows[0]!.attentionLevel, 'YELLOW');
});

test('P01 view-model: a work whose package is READY_FOR_PRESENTATION and cleared from the queue still shows the package itself', () => {
  const pkg = basePackage({ status: 'READY_FOR_PRESENTATION' });
  // No attention item at all — the backend queue already omitted it (NONE level).
  const vm = buildP01ViewModel([baseWork()], [baseObject()], [pkg], []);
  assert.ok(vm.rows[0]!.package, 'the package itself must still be shown even though nothing is owed');
  assert.equal(vm.rows[0]!.package!.status.label, 'Готово к предъявлению');
  assert.equal(vm.rows[0]!.attentionLevel, null);
  assert.equal(vm.rows[0]!.attentionReason, null);
});

test('P01 view-model: a work resolves its object name from the objects array it is handed, and falls back to an explicit label when missing, never a blank or a thrown error', () => {
  const vm = buildP01ViewModel([baseWork({ objectId: 'gone' })], [], [], []);
  assert.equal(vm.rows[0]!.objectName, 'Объект не найден');
});

test('P01 view-model: objectOptions are deduplicated by object and sorted by name — every work counts, not just ones with a package', () => {
  const objectA = baseObject({ id: 'object-a', name: 'Спортивный комплекс' });
  const objectB = baseObject({ id: 'object-b', name: 'Административный корпус' });
  const works = [
    baseWork({ id: 'work-a1', objectId: 'object-a' }),
    baseWork({ id: 'work-a2', objectId: 'object-a' }),
    baseWork({ id: 'work-b1', objectId: 'object-b' }),
  ];
  const vm = buildP01ViewModel(works, [objectA, objectB], [], []);
  assert.equal(vm.rows.length, 3, 'every work is a row, none of them have a package');
  assert.deepEqual(
    vm.objectOptions.map((o) => o.name),
    ['Административный корпус', 'Спортивный комплекс'],
  );
});

test('P01 view-model: works are independent rows — one work\'s attention/package never bleeds into a sibling work\'s row', () => {
  const workA = baseWork({ id: 'work-a' });
  const workB = baseWork({ id: 'work-b', name: 'Кладка стен' });
  const packageA = basePackage({ id: 'package-a', objectWorkId: 'work-a', status: 'PRESENTED' });
  const attentionB = baseAttentionItem({ objectWorkId: 'work-b', workName: 'Кладка стен', level: 'RED', packageId: null });
  const vm = buildP01ViewModel([workA, workB], [baseObject()], [packageA], [attentionB]);
  const rowA = vm.rows.find((r) => r.objectWorkId === 'work-a')!;
  const rowB = vm.rows.find((r) => r.objectWorkId === 'work-b')!;
  assert.equal(rowA.package!.id, 'package-a');
  assert.equal(rowA.attentionLevel, null, 'work A has no attention item — its package is presented and cleared');
  assert.equal(rowB.package, null);
  assert.equal(rowB.attentionLevel, 'RED');
});
