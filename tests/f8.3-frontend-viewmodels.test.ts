import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allowedNextSdoClosingStatuses,
  buildSdoCaseDetailViewModel,
  sdoClosingStatusActionLabel,
} from '../apps/frontend/src/view-models/sdoCaseDetail';
import { buildSdoWorkspaceViewModel } from '../apps/frontend/src/view-models/sdoWorkspace';
import { buildPackageDetailViewModel } from '../apps/frontend/src/view-models/documentationPackage';
import { buildW01ViewModel } from '../apps/frontend/src/view-models/w01';
import { sdoClosingStatusPresentation } from '../apps/frontend/src/view-models/status';
import type {
  DocumentationCustomerAcceptance,
  DocumentationPackage,
  ObjectSummary,
  QuantityPortion,
  SdoClosingAmountHistoryEntry,
  SdoClosingCase,
  SdoClosingHandoffHistoryEntry,
  SdoClosingPortionAllocation,
  SdoClosingStatusHistoryEntry,
  SdoPackageReadiness,
  Work,
  WorkExecutionUnit,
} from '../apps/frontend/src/types/api';

/**
 * F8.3 — pure-logic coverage for the frontend's own SDO view-models, the
 * same style tests/f8.2.1-package-detail-viewmodel.test.ts already uses.
 * Backend/domain behaviour is covered separately in
 * tests/f8.3-domain.test.ts and tests/f8.3-sdo-closing-http.test.ts.
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

function baseSdoCase(overrides: Partial<SdoClosingCase> = {}): SdoClosingCase {
  return {
    id: 'case-1',
    tenantId: 'tenant-1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    version: 1,
    objectId: 'object-1',
    objectName: 'Объект 1',
    objectWorkId: 'work-1',
    workName: 'Штукатурка стен',
    documentationPackageId: 'package-1',
    documentationPackageStatus: 'ACCEPTED_BY_CUSTOMER',
    coveredQuantityPortionIds: ['portion-1'],
    status: 'ON_RECONCILIATION',
    packageLocked: true,
    responsibleUserId: null,
    responsible: null,
    totalAmount: null,
    createdBy: 'pto-1',
    closedAt: null,
    attention: 'NONE',
    ...overrides,
  };
}

function baseReadiness(overrides: Partial<SdoPackageReadiness> = {}): SdoPackageReadiness {
  return {
    documentationPackageId: 'package-1',
    objectId: 'object-1',
    objectName: 'Объект 1',
    objectWorkId: 'work-1',
    workName: 'Штукатурка стен',
    documentationPackageStatus: 'DRAFT',
    responsible: 'Ольга Морозова',
    ready: false,
    missingReasons: ['Не зарегистрировано согласие заказчика по документации'],
    sdoClosingCaseId: null,
    packageLocked: false,
    handoffPending: false,
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
    label: 'Секция A',
    plannedQuantity: '200',
    rpFactQuantity: '200',
    internalScConfirmedQuantity: '200',
    customerScConfirmedQuantity: '200',
    internalScAccepted: true,
    customerScAccepted: true,
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
    actualQuantity: '200',
    internalScStatus: 'COMPLETE',
    customerScStatus: 'COMPLETE',
    ...overrides,
  };
}

function basePackage(overrides: Partial<DocumentationPackage> = {}): DocumentationPackage {
  return {
    id: 'package-1',
    tenantId: 'tenant-1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    version: 4,
    objectId: 'object-1',
    objectWorkId: 'work-1',
    status: 'PRESENTED',
    responsibleUserId: 'pto-1',
    responsible: 'Ольга Морозова',
    createdBy: 'pto-1',
    ...overrides,
  };
}

/* --------------------------------------------------------------------- *
 * Status presentation / allowed-action helpers                           *
 * --------------------------------------------------------------------- */

test('F8.3: sdoClosingStatusPresentation — one label/variant per status, ON_CORRECTION reads Attention', async () => {
  assert.equal(sdoClosingStatusPresentation('ON_RECONCILIATION').variant, 'Neutral');
  assert.equal(sdoClosingStatusPresentation('VERIFICATION_PASSED').variant, 'OnTrack');
  assert.equal(sdoClosingStatusPresentation('ON_CORRECTION').variant, 'Attention');
  assert.equal(sdoClosingStatusPresentation('CLOSED').variant, 'OnTrack');
});

test('F8.3: allowedNextSdoClosingStatuses — branching allow-list, not a single-next chain', async () => {
  assert.deepEqual(allowedNextSdoClosingStatuses('ON_RECONCILIATION'), ['VERIFICATION_PASSED', 'ON_CORRECTION']);
  assert.deepEqual(allowedNextSdoClosingStatuses('VERIFICATION_PASSED'), ['CLOSED', 'ON_CORRECTION']);
  assert.deepEqual(allowedNextSdoClosingStatuses('ON_CORRECTION'), ['ON_RECONCILIATION']);
  assert.deepEqual(allowedNextSdoClosingStatuses('CLOSED'), ['ON_CORRECTION']);
});

test('F8.3: sdoClosingStatusActionLabel — an action label for every reachable target', async () => {
  assert.equal(sdoClosingStatusActionLabel('CLOSED'), 'Закрыть дело');
  assert.equal(sdoClosingStatusActionLabel('ON_CORRECTION'), 'Вернуть на корректировку');
});

/* --------------------------------------------------------------------- *
 * SDO workspace view-model                                               *
 * --------------------------------------------------------------------- */

test('F8.3: buildSdoWorkspaceViewModel — "upcoming" is exactly readiness rows with no Case yet', async () => {
  const readiness = [
    baseReadiness({ documentationPackageId: 'pkg-a', sdoClosingCaseId: null }),
    baseReadiness({ documentationPackageId: 'pkg-b', sdoClosingCaseId: 'case-1', packageLocked: true, ready: true, missingReasons: [] }),
  ];
  const cases = [baseSdoCase({ id: 'case-1', documentationPackageId: 'pkg-b' })];
  const vm = buildSdoWorkspaceViewModel(readiness, cases);
  assert.equal(vm.upcoming.length, 1);
  assert.equal(vm.upcoming[0].documentationPackageId, 'pkg-a');
  assert.equal(vm.activeCases.length, 1);
  assert.equal(vm.activeCases[0].id, 'case-1');
});

test('F8.3: buildSdoWorkspaceViewModel — a returned-to-PTO Case (unlocked) stays in "active", never demoted back to "upcoming"', async () => {
  const readiness = [baseReadiness({ documentationPackageId: 'pkg-a', sdoClosingCaseId: 'case-1', packageLocked: false, ready: false })];
  const cases = [baseSdoCase({ id: 'case-1', documentationPackageId: 'pkg-a', packageLocked: false })];
  const vm = buildSdoWorkspaceViewModel(readiness, cases);
  assert.equal(vm.upcoming.length, 0, 'a package with an existing Case is never "upcoming", locked or not');
  assert.equal(vm.activeCases.length, 1);
});

test('F8.3: buildSdoWorkspaceViewModel — hasAttention reflects the case\'s own attention field, unformatted amount reads a dash when absent', async () => {
  const cases = [baseSdoCase({ attention: 'RED', totalAmount: null }), baseSdoCase({ id: 'case-2', documentationPackageId: 'pkg-2', attention: 'NONE', totalAmount: '1840000.00' })];
  const vm = buildSdoWorkspaceViewModel([], cases);
  assert.equal(vm.activeCases[0].hasAttention, true);
  assert.equal(vm.activeCases[0].totalAmount, '—');
  assert.equal(vm.activeCases[1].hasAttention, false);
  assert.match(vm.activeCases[1].totalAmount, /1.?840.?000/);
});

/* --------------------------------------------------------------------- *
 * SDO Case detail view-model                                             *
 * --------------------------------------------------------------------- */

test('F8.3: buildSdoCaseDetailViewModel — covered portions come from the case\'s own coveredQuantityPortionIds, never a documentationPackagePortions cross-reference', async () => {
  const sdoCase = baseSdoCase({ coveredQuantityPortionIds: ['portion-1'] });
  const vm = buildSdoCaseDetailViewModel(
    sdoCase,
    baseObject(),
    baseWork(),
    [baseUnit()],
    [basePortion(), basePortion({ id: 'portion-2', label: 'Секция B' })],
    [],
    [],
    [],
    [],
  );
  assert.equal(vm.portions.length, 1);
  assert.equal(vm.portions[0].id, 'portion-1');
  assert.match(vm.portions[0].plannedQuantity, /200/);
  assert.equal(vm.portions[0].allocatedAmount, null);
});

test('F8.3: buildSdoCaseDetailViewModel — an allocated portion shows its own amount, and allocatedSum reflects every allocation on this case only', async () => {
  const sdoCase = baseSdoCase({ id: 'case-1', coveredQuantityPortionIds: ['portion-1'] });
  const allocations: SdoClosingPortionAllocation[] = [
    { id: 'alloc-1', tenantId: 't', createdAt: 'x', updatedAt: 'x', version: 1, sdoClosingCaseId: 'case-1', quantityPortionId: 'portion-1', amount: '750.00', createdBy: 'sdo-1' },
    { id: 'alloc-2', tenantId: 't', createdAt: 'x', updatedAt: 'x', version: 1, sdoClosingCaseId: 'other-case', quantityPortionId: 'portion-1', amount: '999999.00', createdBy: 'sdo-1' },
  ];
  const vm = buildSdoCaseDetailViewModel(sdoCase, baseObject(), baseWork(), [baseUnit()], [basePortion()], allocations, [], [], []);
  assert.match(vm.portions[0].allocatedAmount ?? '', /750/);
  assert.match(vm.allocatedSum, /750/);
  assert.doesNotMatch(vm.allocatedSum, /999999/);
});

test('F8.3: buildSdoCaseDetailViewModel — allowedActions mirror the domain allow-list exactly, with labels', async () => {
  const vm = buildSdoCaseDetailViewModel(baseSdoCase({ status: 'VERIFICATION_PASSED' }), baseObject(), baseWork(), [], [], [], [], [], []);
  assert.deepEqual(
    vm.allowedActions.map((a) => a.status),
    ['CLOSED', 'ON_CORRECTION'],
  );
  assert.equal(vm.allowedActions[0].label, 'Закрыть дело');
});

test('F8.3: buildSdoCaseDetailViewModel — histories are scoped to this case and sorted newest first', async () => {
  const statusHistory: SdoClosingStatusHistoryEntry[] = [
    { id: 'h1', tenantId: 't', createdAt: 'x', updatedAt: 'x', version: 1, sdoClosingCaseId: 'case-1', fromStatus: 'ON_RECONCILIATION', toStatus: 'VERIFICATION_PASSED', reason: null, changedBy: 'sdo-1', changedAt: '2026-01-01T00:00:00Z' },
    { id: 'h2', tenantId: 't', createdAt: 'x', updatedAt: 'x', version: 1, sdoClosingCaseId: 'case-1', fromStatus: 'VERIFICATION_PASSED', toStatus: 'ON_CORRECTION', reason: null, changedBy: 'sdo-1', changedAt: '2026-01-02T00:00:00Z' },
    { id: 'h3', tenantId: 't', createdAt: 'x', updatedAt: 'x', version: 1, sdoClosingCaseId: 'other-case', fromStatus: 'ON_RECONCILIATION', toStatus: 'VERIFICATION_PASSED', reason: null, changedBy: 'sdo-1', changedAt: '2026-01-03T00:00:00Z' },
  ];
  const handoffHistory: SdoClosingHandoffHistoryEntry[] = [
    { id: 'e1', tenantId: 't', createdAt: 'x', updatedAt: 'x', version: 1, sdoClosingCaseId: 'case-1', event: 'HANDED_OFF', actorId: 'pto-1', occurredAt: '2026-01-01T00:00:00Z', comment: null },
  ];
  const amountHistory: SdoClosingAmountHistoryEntry[] = [
    { id: 'a1', tenantId: 't', createdAt: 'x', updatedAt: 'x', version: 1, sdoClosingCaseId: 'case-1', previousAmount: null, newAmount: '1840000.00', changedBy: 'sdo-1', changedAt: '2026-01-01T00:00:00Z' },
  ];
  const vm = buildSdoCaseDetailViewModel(baseSdoCase(), baseObject(), baseWork(), [], [], [], statusHistory, handoffHistory, amountHistory);
  assert.equal(vm.statusHistory.length, 2, 'only this case\'s own rows');
  assert.equal(vm.statusHistory[0].id, 'h2', 'newest first');
  assert.equal(vm.handoffHistory.length, 1);
  assert.equal(vm.handoffHistory[0].eventLabel, 'Передано в СДО');
  assert.equal(vm.amountHistory[0].previousAmount, '—');
});

/* --------------------------------------------------------------------- *
 * Package Detail's own F8.3 slice                                        *
 * --------------------------------------------------------------------- */

test('F8.3: buildPackageDetailViewModel — readiness/lock/handoff eligibility come from the matching sdoPackageReadiness row', async () => {
  const pkg = basePackage({ status: 'ACCEPTED_BY_CUSTOMER' });
  const readiness = [baseReadiness({ documentationPackageId: 'package-1', ready: true, missingReasons: [], packageLocked: true, sdoClosingCaseId: 'case-1' })];
  const vm = buildPackageDetailViewModel(pkg, baseObject(), baseWork(), [], [], [], [], [], [], readiness, []);
  assert.equal(vm.sdo.ready, true);
  assert.equal(vm.sdo.packageLocked, true);
  assert.equal(vm.sdo.canHandoffToSdo, false, 'already locked — nothing to hand off again right now');
  assert.equal(vm.sdo.canRegisterCustomerAcceptance, false, 'not PRESENTED');
});

test('F8.3: buildPackageDetailViewModel — canRegisterCustomerAcceptance is true only for PRESENTED, canHandoffToSdo only when ready and unlocked', async () => {
  const pkg = basePackage({ status: 'PRESENTED' });
  const readiness = [baseReadiness({ documentationPackageId: 'package-1', ready: true, missingReasons: [], packageLocked: false, sdoClosingCaseId: null })];
  const vm = buildPackageDetailViewModel(pkg, baseObject(), baseWork(), [], [], [], [], [], [], readiness, []);
  assert.equal(vm.sdo.canRegisterCustomerAcceptance, true);
  assert.equal(vm.sdo.canHandoffToSdo, true);
});

test('F8.3: buildPackageDetailViewModel — the latest customer acceptance is surfaced, formatted', async () => {
  const pkg = basePackage({ status: 'ACCEPTED_BY_CUSTOMER' });
  const acceptances: DocumentationCustomerAcceptance[] = [
    { id: 'acc-1', tenantId: 't', createdAt: '2026-01-01T00:00:00Z', updatedAt: 'x', version: 1, documentationPackageId: 'package-1', documentationPackageVersion: 3, acceptedDate: '2026-01-01', reference: 'Акт-1', comment: null, registeredBy: 'pto-1' },
    { id: 'acc-2', tenantId: 't', createdAt: '2026-02-01T00:00:00Z', updatedAt: 'x', version: 1, documentationPackageId: 'package-1', documentationPackageVersion: 5, acceptedDate: '2026-02-01', reference: 'Акт-2', comment: null, registeredBy: 'pto-1' },
  ];
  const vm = buildPackageDetailViewModel(pkg, baseObject(), baseWork(), [], [], [], [], [], [], [], acceptances);
  assert.equal(vm.sdo.customerAcceptance?.reference, 'Акт-2', 'the most recently registered acceptance, not the first');
});

/* --------------------------------------------------------------------- *
 * W01's own read-only slice                                              *
 * --------------------------------------------------------------------- */

test('F8.3: buildW01ViewModel — sdoClosingCases is scoped to this work and empty by default', async () => {
  const withoutCases = buildW01ViewModel(baseWork(), baseObject());
  assert.deepEqual(withoutCases.sdoClosingCases, []);

  const cases = [baseSdoCase({ objectWorkId: 'work-1' }), baseSdoCase({ id: 'case-2', objectWorkId: 'other-work' })];
  const vm = buildW01ViewModel(baseWork(), baseObject(), [], [], [], [], [], cases);
  assert.equal(vm.sdoClosingCases.length, 1);
  assert.equal(vm.sdoClosingCases[0].id, 'case-1');
});

test('F8.3: buildW01ViewModel — an unassigned SDO Case reads "Не назначен", never a blank/undefined name', async () => {
  const cases = [baseSdoCase({ responsible: null })];
  const vm = buildW01ViewModel(baseWork(), baseObject(), [], [], [], [], [], cases);
  assert.equal(vm.sdoClosingCases[0].responsible, 'Не назначен');
});
