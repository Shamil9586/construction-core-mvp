import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPackageDetailViewModel,
  documentTypeLabel,
  nextDocumentationStatus,
  nextDocumentationStatusLabel,
  storageProviderLabel,
} from '../apps/frontend/src/view-models/documentationPackage';
import type {
  DocumentationDocument,
  DocumentationPackage,
  DocumentationPackagePortion,
  DocumentationStatusHistoryEntry,
  DocumentationVersion,
  ObjectSummary,
  QuantityPortion,
  Work,
  WorkExecutionUnit,
} from '../apps/frontend/src/types/api';

/**
 * Package Detail — pure-logic coverage for `buildPackageDetailViewModel`,
 * the screen reachable from both P01 and W01 (Decision 1). No React, no
 * browser — the same style `tests/f8.2-p01-viewmodel.test.ts` already uses.
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

function baseUnit(overrides: Partial<WorkExecutionUnit> = {}): WorkExecutionUnit {
  return {
    id: 'unit-1',
    tenantId: 'tenant-1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    version: 1,
    objectWorkId: 'work-1',
    workTypeId: 'work-type-1',
    finishTypeId: null,
    executionConditions: null,
    location: null,
    contractorId: 'contractor-1',
    unit: 'м²',
    plannedQuantity: '500',
    actualQuantity: '0',
    internalScStatus: 'NONE',
    customerScStatus: 'NONE',
    ...overrides,
  };
}

function basePortion(overrides: Partial<QuantityPortion> = {}): QuantityPortion {
  return {
    id: 'portion-1',
    tenantId: 'tenant-1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    version: 1,
    executionUnitId: 'unit-1',
    label: 'Участок 1',
    plannedQuantity: '100',
    rpFactQuantity: null,
    internalScAccepted: false,
    internalScConfirmedQuantity: null,
    customerScAccepted: false,
    customerScConfirmedQuantity: null,
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

function baseDocument(overrides: Partial<DocumentationDocument> = {}): DocumentationDocument {
  return {
    id: 'doc-1',
    tenantId: 'tenant-1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    version: 1,
    documentationPackageId: 'package-1',
    type: 'AOSR',
    createdBy: 'pto-1',
    ...overrides,
  };
}

function baseVersion(overrides: Partial<DocumentationVersion> = {}): DocumentationVersion {
  return {
    id: 'version-1',
    tenantId: 'tenant-1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    version: 1,
    documentationDocumentId: 'doc-1',
    versionNumber: 1,
    storageProvider: 'NONE',
    storageReference: null,
    comment: null,
    createdBy: 'pto-1',
    ...overrides,
  };
}

function baseHistoryEntry(overrides: Partial<DocumentationStatusHistoryEntry> = {}): DocumentationStatusHistoryEntry {
  return {
    id: 'history-1',
    tenantId: 'tenant-1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    version: 1,
    documentationPackageId: 'package-1',
    fromStatus: 'DRAFT',
    toStatus: 'PREPARING',
    changedBy: 'pto-1',
    changedAt: '2026-01-02T00:00:00Z',
    comment: null,
    ...overrides,
  };
}

test('package detail view-model: resolves object/work names, status and the single next status for a fresh DRAFT package', () => {
  const vm = buildPackageDetailViewModel(basePackage(), baseObject(), baseWork(), [], [], [], [], [], []);
  assert.equal(vm.objectName, 'Объект 1');
  assert.equal(vm.workName, 'Штукатурка стен');
  assert.equal(vm.status.label, 'Черновик');
  assert.equal(vm.responsible, 'Ольга Морозова');
  assert.equal(vm.nextStatus, 'PREPARING');
  assert.equal(vm.nextStatusLabel, 'Начать подготовку');
});

test('package detail view-model (Corrective F8.2.1-01): RETURNED now leads into the correction loop, not a dead end — its next status is CORRECTING', () => {
  const vm = buildPackageDetailViewModel(basePackage({ status: 'RETURNED' }), baseObject(), baseWork(), [], [], [], [], [], []);
  assert.equal(vm.nextStatus, 'CORRECTING');
  assert.equal(vm.nextStatusLabel, 'Начать устранение замечаний');
});

test('package detail view-model (Corrective F8.2.1-01): ACCEPTED_BY_CUSTOMER is the only remaining dead end — no next status or label, no button to show', () => {
  const vm = buildPackageDetailViewModel(basePackage({ status: 'ACCEPTED_BY_CUSTOMER' }), baseObject(), baseWork(), [], [], [], [], [], []);
  assert.equal(vm.nextStatus, null);
  assert.equal(vm.nextStatusLabel, null);
});

test('package detail view-model: missing object/work resolve to explicit fallback labels, never blank or thrown', () => {
  const vm = buildPackageDetailViewModel(basePackage(), undefined, undefined, [], [], [], [], [], []);
  assert.equal(vm.objectName, 'Объект не найден');
  assert.equal(vm.workName, 'Работа не найдена');
});

test('package detail view-model: linked portions resolve through the work\'s own execution units, and unlinked ones become the "available to link" list', () => {
  const units = [baseUnit({ id: 'unit-1', objectWorkId: 'work-1' })];
  const portions = [
    basePortion({ id: 'portion-1', executionUnitId: 'unit-1', label: 'Участок 1' }),
    basePortion({ id: 'portion-2', executionUnitId: 'unit-1', label: 'Участок 2' }),
  ];
  const links = [baseLink({ id: 'link-1', quantityPortionId: 'portion-1' })];
  const vm = buildPackageDetailViewModel(basePackage(), baseObject(), baseWork(), units, links, portions, [], [], []);
  assert.deepEqual(vm.portions.map((p) => p.id), ['portion-1']);
  assert.deepEqual(vm.availablePortions.map((p) => p.id), ['portion-2']);
});

test('package detail view-model: a portion belonging to a different work is never offered, linked or not, even if a link row somehow names it', () => {
  const units = [
    baseUnit({ id: 'unit-1', objectWorkId: 'work-1' }),
    baseUnit({ id: 'unit-2', objectWorkId: 'work-2' }),
  ];
  const portions = [basePortion({ id: 'portion-foreign', executionUnitId: 'unit-2', label: 'Чужой участок' })];
  const links = [baseLink({ quantityPortionId: 'portion-foreign' })];
  const vm = buildPackageDetailViewModel(basePackage(), baseObject(), baseWork(), units, links, portions, [], [], []);
  assert.equal(vm.portions.length, 0);
  assert.equal(vm.availablePortions.length, 0);
});

test('package detail view-model: documents resolve only this package\'s own rows, each with its own versions newest-first', () => {
  const documents = [
    baseDocument({ id: 'doc-mine', documentationPackageId: 'package-1', type: 'AOSR' }),
    baseDocument({ id: 'doc-other', documentationPackageId: 'package-other', type: 'ACT_CERTIFICATE' }),
  ];
  const versions = [
    baseVersion({ id: 'v1', documentationDocumentId: 'doc-mine', versionNumber: 1 }),
    baseVersion({ id: 'v3', documentationDocumentId: 'doc-mine', versionNumber: 3 }),
    baseVersion({ id: 'v2', documentationDocumentId: 'doc-mine', versionNumber: 2 }),
  ];
  const vm = buildPackageDetailViewModel(basePackage(), baseObject(), baseWork(), [], [], [], documents, versions, []);
  assert.equal(vm.documents.length, 1, 'the other package\'s document is not this package\'s to show');
  assert.equal(vm.documents[0]!.id, 'doc-mine');
  assert.equal(vm.documents[0]!.typeLabel, 'АОСР');
  assert.deepEqual(vm.documents[0]!.versions.map((v) => v.versionNumber), [3, 2, 1]);
});

test('package detail view-model: status history resolves only this package\'s own entries, newest first', () => {
  const history = [
    baseHistoryEntry({ id: 'h1', documentationPackageId: 'package-1', changedAt: '2026-01-01T00:00:00Z', fromStatus: 'DRAFT', toStatus: 'PREPARING' }),
    baseHistoryEntry({ id: 'h2', documentationPackageId: 'package-1', changedAt: '2026-01-03T00:00:00Z', fromStatus: 'PREPARING', toStatus: 'READY_FOR_PRESENTATION' }),
    baseHistoryEntry({ id: 'h-other', documentationPackageId: 'package-other', changedAt: '2026-01-02T00:00:00Z' }),
  ];
  const vm = buildPackageDetailViewModel(basePackage(), baseObject(), baseWork(), [], [], [], [], [], history);
  assert.deepEqual(vm.history.map((h) => h.id), ['h2', 'h1']);
});

test('documentTypeLabel and storageProviderLabel: pure mappings to the Russian labels the screen renders', () => {
  assert.equal(documentTypeLabel('AOSR'), 'АОСР');
  assert.equal(documentTypeLabel('EXECUTIVE_SCHEME'), 'Исполнительная схема');
  assert.equal(storageProviderLabel('NONE'), 'Без ссылки на хранилище');
  assert.equal(storageProviderLabel('EXTERNAL_REFERENCE'), 'Внешняя ссылка');
});

test('nextDocumentationStatus / nextDocumentationStatusLabel (Corrective F8.2.1-01): mirrors exactly the backend\'s six-edge allow-list including the correction loop, only ACCEPTED_BY_CUSTOMER unreachable', () => {
  assert.equal(nextDocumentationStatus('DRAFT'), 'PREPARING');
  assert.equal(nextDocumentationStatus('PREPARING'), 'READY_FOR_PRESENTATION');
  assert.equal(nextDocumentationStatus('READY_FOR_PRESENTATION'), 'PRESENTED');
  assert.equal(nextDocumentationStatus('PRESENTED'), 'RETURNED');
  assert.equal(nextDocumentationStatus('RETURNED'), 'CORRECTING');
  assert.equal(nextDocumentationStatus('CORRECTING'), 'PRESENTED');
  assert.equal(nextDocumentationStatus('ACCEPTED_BY_CUSTOMER'), null);
  assert.equal(nextDocumentationStatusLabel('PRESENTED'), 'Предъявить заказчику');
  assert.equal(nextDocumentationStatusLabel('CORRECTING'), 'Начать устранение замечаний');
});
