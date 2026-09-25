import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildP01ViewModel } from '../apps/frontend/src/view-models/p01';
import type { DocumentationPackage, DocumentationPackagePortion, ObjectSummary, Work } from '../apps/frontend/src/types/api';

/**
 * P01 — PTO Workspace. Pure-logic coverage for `buildP01ViewModel`, no
 * React, no browser — the same style `tests/f8.1-w01-viewmodel.test.ts`
 * already uses for view-model functions in this directory.
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

function baseLink(overrides: Partial<DocumentationPackagePortion> = {}): DocumentationPackagePortion {
  return {
    id: 'link-1',
    tenantId: 'tenant-1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    version: 1,
    documentationPackageId: 'package-1',
    quantityPortionId: 'portion-1',
    ...overrides,
  };
}

test('P01 view-model: no packages produces an empty list and no object filter options', () => {
  const vm = buildP01ViewModel([], [baseObject()], [baseWork()], []);
  assert.deepEqual(vm.packages, []);
  assert.deepEqual(vm.objectOptions, []);
});

test('P01 view-model: a package resolves its object and work names from the snapshot arrays it is handed', () => {
  const vm = buildP01ViewModel([basePackage()], [baseObject()], [baseWork()], []);
  assert.equal(vm.packages.length, 1);
  assert.equal(vm.packages[0]!.objectName, 'Объект 1');
  assert.equal(vm.packages[0]!.workName, 'Штукатурка стен');
  assert.equal(vm.packages[0]!.responsible, 'Ольга Морозова');
});

test('P01 view-model: a package whose object or work is missing from the arrays falls back to an explicit label, never a blank or a thrown error', () => {
  const vm = buildP01ViewModel([basePackage({ objectId: 'gone', objectWorkId: 'also-gone' })], [], [], []);
  assert.equal(vm.packages[0]!.objectName, 'Объект не найден');
  assert.equal(vm.packages[0]!.workName, 'Работа не найдена');
});

test('P01 view-model: objectOptions are deduplicated by object and sorted by name', () => {
  const objectA = baseObject({ id: 'object-a', name: 'Спортивный комплекс' });
  const objectB = baseObject({ id: 'object-b', name: 'Административный корпус' });
  const workA = baseWork({ id: 'work-a', objectId: 'object-a' });
  const workB = baseWork({ id: 'work-b', objectId: 'object-b' });
  const workA2 = baseWork({ id: 'work-a2', objectId: 'object-a' });
  const packages = [
    basePackage({ id: 'package-a1', objectId: 'object-a', objectWorkId: 'work-a' }),
    basePackage({ id: 'package-a2', objectId: 'object-a', objectWorkId: 'work-a2' }),
    basePackage({ id: 'package-b1', objectId: 'object-b', objectWorkId: 'work-b' }),
  ];
  const vm = buildP01ViewModel(packages, [objectA, objectB], [workA, workB, workA2], []);
  assert.equal(vm.packages.length, 3, 'two packages on object A plus one on object B, all listed');
  assert.deepEqual(
    vm.objectOptions.map((o) => o.name),
    ['Административный корпус', 'Спортивный комплекс'],
    'sorted, and object A only counted once despite having two packages',
  );
});

test('P01 view-model: coveredPortionCount only counts links for that package, not a sibling package\'s own links', () => {
  const packages = [basePackage({ id: 'package-a' }), basePackage({ id: 'package-b' })];
  const links = [
    baseLink({ id: 'link-a1', documentationPackageId: 'package-a', quantityPortionId: 'portion-1' }),
    baseLink({ id: 'link-a2', documentationPackageId: 'package-a', quantityPortionId: 'portion-2' }),
    baseLink({ id: 'link-b1', documentationPackageId: 'package-b', quantityPortionId: 'portion-3' }),
  ];
  const vm = buildP01ViewModel(packages, [baseObject()], [baseWork()], links);
  assert.equal(vm.packages.find((p) => p.id === 'package-a')!.coveredPortionCount, 2);
  assert.equal(vm.packages.find((p) => p.id === 'package-b')!.coveredPortionCount, 1);
});

test('P01 view-model: package status maps to a real StatusPresentation for every value in the closed set', () => {
  const statuses: DocumentationPackage['status'][] = [
    'DRAFT',
    'PREPARING',
    'READY_FOR_PRESENTATION',
    'PRESENTED',
    'RETURNED',
    'CORRECTING',
    'ACCEPTED_BY_CUSTOMER',
  ];
  for (const status of statuses) {
    const vm = buildP01ViewModel([basePackage({ status })], [baseObject()], [baseWork()], []);
    assert.ok(vm.packages[0]!.status.label.length > 0, `${status} must produce a non-empty label`);
  }
  // The two statuses that mean "the customer sent this back" read as Attention — never OnTrack or Neutral.
  const returned = buildP01ViewModel([basePackage({ status: 'RETURNED' })], [baseObject()], [baseWork()], []);
  assert.equal(returned.packages[0]!.status.variant, 'Attention');
  const correcting = buildP01ViewModel([basePackage({ status: 'CORRECTING' })], [baseObject()], [baseWork()], []);
  assert.equal(correcting.packages[0]!.status.variant, 'Attention');
});
