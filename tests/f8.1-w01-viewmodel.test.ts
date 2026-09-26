import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildW01ViewModel,
  confirmationLabel,
  confirmationVariant,
  parseConfirmedQuantityInput,
} from '../apps/frontend/src/view-models/w01';
import type {
  DocumentationPackage,
  DocumentationPackagePortion,
  Inspection,
  ObjectSummary,
  QuantityPortion,
  Work,
  WorkExecutionUnit,
} from '../apps/frontend/src/types/api';

/**
 * F8.1 (Phase 4) — pure-logic coverage for `buildW01ViewModel`'s new
 * execution-unit/portion handling. No React, no browser: these are the same
 * plain-TS view-model functions C01/O01/W01 have always been unit-testable
 * as, run the same way `tests/production-execution.test.ts` already tests
 * `packages/domain`'s pure classes.
 *
 * The one thing this file cannot exercise is the rendered UI itself — that
 * is `tests/f8.1-w01-browser/` (Playwright, intercepted, real dev server).
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
    location: '1 этаж',
    contractorId: 'contractor-1',
    unit: 'м²',
    internalScStatus: 'NONE',
    customerScStatus: 'NONE',
    plannedQuantity: '500',
    actualQuantity: '0',
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
    plannedQuantity: '300',
    rpFactQuantity: null,
    internalScAccepted: false,
    internalScConfirmedQuantity: null,
    customerScAccepted: false,
    customerScConfirmedQuantity: null,
    ...overrides,
  };
}

function baseDocumentationPackage(overrides: Partial<DocumentationPackage> = {}): DocumentationPackage {
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

function baseDocumentationPackagePortion(
  overrides: Partial<DocumentationPackagePortion> = {},
): DocumentationPackagePortion {
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

function baseInspection(overrides: Partial<Inspection> = {}): Inspection {
  return {
    id: 'inspection-1',
    tenantId: 'tenant-1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    version: 1,
    objectId: 'object-1',
    objectWorkId: 'work-1',
    requestedBy: 'pm-1',
    requestedAt: '2026-01-02T00:00:00Z',
    inspectorId: null,
    status: 'WAITING',
    inspectionDate: null,
    decision: null,
    comment: null,
    acceptedAt: null,
    portionId: null,
    inspectionType: 'INTERNAL_SC',
    ...overrides,
  };
}

test('F8.1 W01 view-model: backward compatible with the pre-Phase-4 3-arg call (Gallery.tsx, existing WorkRoute callers)', () => {
  const vm = buildW01ViewModel(baseWork(), baseObject(), []);
  assert.deepEqual(vm.executionUnits, []);
});

test('F8.1 W01 view-model: a work with no execution units in the snapshot still builds an empty executionUnits array', () => {
  const vm = buildW01ViewModel(baseWork(), baseObject(), [], [], []);
  assert.deepEqual(vm.executionUnits, []);
});

test('F8.1 W01 view-model: portion status, fact/request eligibility across the lifecycle', () => {
  const unit = baseUnit();
  const notStarted = basePortion({ id: 'p-not-started', label: 'Секция A' });
  const factRecorded = basePortion({
    id: 'p-fact-recorded',
    label: 'Секция B',
    plannedQuantity: '200',
    rpFactQuantity: '200',
  });
  const pendingSc = basePortion({
    id: 'p-pending-sc',
    label: 'Секция C',
    plannedQuantity: '100',
    rpFactQuantity: '100',
  });
  const accepted = basePortion({
    id: 'p-accepted',
    label: 'Секция D',
    plannedQuantity: '150',
    rpFactQuantity: '150',
    internalScAccepted: true,
    internalScConfirmedQuantity: '150',
  });
  const rejected = basePortion({
    id: 'p-rejected',
    label: 'Секция E',
    plannedQuantity: '50',
    rpFactQuantity: '50',
  });

  const pendingInspection = baseInspection({
    id: 'insp-pending',
    portionId: 'p-pending-sc',
    status: 'WAITING',
    version: 3,
  });
  const acceptedInspection = baseInspection({
    id: 'insp-accepted',
    portionId: 'p-accepted',
    status: 'ACCEPTED',
    version: 2,
  });
  const rejectedInspection = baseInspection({
    id: 'insp-rejected',
    portionId: 'p-rejected',
    status: 'REJECTED',
    version: 2,
  });

  const work = baseWork();
  const vm = buildW01ViewModel(
    work,
    baseObject(),
    [pendingInspection, acceptedInspection, rejectedInspection],
    [unit],
    [notStarted, factRecorded, pendingSc, accepted, rejected],
  );

  assert.equal(vm.executionUnits.length, 1);
  const byId = Object.fromEntries(vm.executionUnits[0]!.portions.map((p) => [p.id, p]));

  // No fact yet: can enter fact, cannot request (not full), nothing to decide.
  assert.equal(byId['p-not-started']!.internalSc.kind, 'NotSubmitted');
  assert.equal(byId['p-not-started']!.canEnterFact, true);
  assert.equal(byId['p-not-started']!.canRequestInternalSc, false);
  assert.equal(byId['p-not-started']!.decidableInspection, null);

  // Full fact, no inspection requested yet: can still enter fact (correction), and can now request.
  assert.equal(byId['p-fact-recorded']!.canEnterFact, true);
  assert.equal(byId['p-fact-recorded']!.canRequestInternalSc, true);

  // An active (WAITING) inspection freezes fact entry and offers a decision, not a new request.
  assert.equal(byId['p-pending-sc']!.internalSc.kind, 'Pending');
  assert.equal(byId['p-pending-sc']!.canEnterFact, false);
  assert.equal(byId['p-pending-sc']!.canRequestInternalSc, false);
  assert.deepEqual(byId['p-pending-sc']!.decidableInspection, { id: 'insp-pending', version: 3 });

  // Accepted: the aggregate flag wins over the inspection's own status (ReadService's own
  // derivation), fact stays frozen, and there is nothing left to decide.
  assert.equal(byId['p-accepted']!.internalSc.kind, 'Accepted');
  assert.equal(byId['p-accepted']!.canEnterFact, false);
  assert.equal(byId['p-accepted']!.decidableInspection, null);

  // Rejected unblocks fact entry again — the one inspection status that does not freeze it.
  assert.equal(byId['p-rejected']!.internalSc.kind, 'Rejected');
  assert.equal(byId['p-rejected']!.canEnterFact, true);
  assert.equal(byId['p-rejected']!.canRequestInternalSc, true);
  assert.equal(byId['p-rejected']!.decidableInspection, null);
});

test('F8.1 W01 view-model: a portion-scoped inspection never leaks into the whole-work confirmation slot', () => {
  const work = baseWork({ accepted: false });
  const unit = baseUnit();
  const portion = basePortion({ rpFactQuantity: '300' });
  // The only inspection in the snapshot is portion-scoped and WAITING — if the
  // whole-work confirmation picked it up (the pre-fix bug: filtering only on
  // objectWorkId, which a portion-scoped row shares with its parent work), it
  // would misreport 'Pending' for a work nothing has actually been submitted
  // on at the whole-work level.
  const inspection = baseInspection({ portionId: portion.id, status: 'WAITING' });

  const vm = buildW01ViewModel(work, baseObject(), [inspection], [unit], [portion]);

  assert.equal(vm.confirmation.kind, 'NotSubmitted');
  // The same inspection is still visible at the portion's own level.
  assert.equal(vm.executionUnits[0]!.portions[0]!.internalSc.kind, 'Pending');
});

test('F8.1 W01 view-model: a whole-work inspection (portionId null) still drives the whole-work confirmation exactly as before F8.1', () => {
  const work = baseWork({ accepted: false });
  const inspection = baseInspection({ portionId: null, status: 'ISSUES_FOUND' });

  const vm = buildW01ViewModel(work, baseObject(), [inspection]);

  assert.equal(vm.confirmation.kind, 'IssuesFound');
  assert.deepEqual(vm.executionUnits, []);
});

test('F8.1 W01 view-model: remainingForNewPortion reflects the sum-bound (D4), informational only', () => {
  const unit = baseUnit({ plannedQuantity: '500' });
  const portions = [
    basePortion({ id: 'p1', plannedQuantity: '300' }),
    basePortion({ id: 'p2', plannedQuantity: '150' }),
  ];
  const vm = buildW01ViewModel(baseWork(), baseObject(), [], [unit], portions);
  assert.equal(vm.executionUnits[0]!.remainingForNewPortion, '50 м²');
});

test('F8.1 W01 view-model: remainingForNewPortion never goes negative even if portions were somehow over-committed', () => {
  const unit = baseUnit({ plannedQuantity: '100' });
  const portions = [basePortion({ id: 'p1', plannedQuantity: '150' })];
  const vm = buildW01ViewModel(baseWork(), baseObject(), [], [unit], portions);
  assert.equal(vm.executionUnits[0]!.remainingForNewPortion, '0 м²');
});

test('F8.1 W01 view-model: confirmationVariant/confirmationLabel cover every WorkConfirmation kind', () => {
  assert.equal(confirmationVariant({ kind: 'Accepted' }), 'OnTrack');
  assert.equal(confirmationLabel({ kind: 'Accepted' }), 'Принято СК');
  assert.equal(confirmationVariant({ kind: 'Pending' }), 'Neutral');
  assert.equal(confirmationVariant({ kind: 'IssuesFound' }), 'Attention');
  assert.equal(confirmationVariant({ kind: 'Rejected' }), 'Attention');
  assert.equal(confirmationVariant({ kind: 'Unknown' }), 'Neutral');
  assert.equal(confirmationVariant({ kind: 'NotSubmitted' }), 'Neutral');
  assert.equal(confirmationVariant({ kind: 'ConfirmedQuantity', value: '498', meta: 'м²' }), 'OnTrack');
});

/**
 * F8.1 Final corrective — `Number('')` and `Number('   ')` both evaluate to
 * `0` in JavaScript, so `ExecutionSection.tsx`'s Internal SC decision form
 * used to submit a confirmed quantity of zero for a field the user left
 * blank, instead of refusing to submit at all. `parseConfirmedQuantityInput`
 * is the extracted, unit-testable fix — see also
 * tests/f8.1-browser/w01-execution.spec.ts for the real-DOM proof that a
 * blank field never reaches the backend.
 */
test('parseConfirmedQuantityInput: an empty string is a validation error, not a silent zero', () => {
  const result = parseConfirmedQuantityInput('');
  assert.equal(result.ok, false);
});

test('parseConfirmedQuantityInput: a whitespace-only string is a validation error, not a silent zero', () => {
  assert.equal(parseConfirmedQuantityInput('   ').ok, false);
  assert.equal(parseConfirmedQuantityInput('\t\n').ok, false);
});

test('parseConfirmedQuantityInput: a non-numeric string is a validation error', () => {
  assert.equal(parseConfirmedQuantityInput('abc').ok, false);
  assert.equal(parseConfirmedQuantityInput('12abc').ok, false);
});

test('parseConfirmedQuantityInput: a negative number is a validation error', () => {
  assert.equal(parseConfirmedQuantityInput('-5').ok, false);
});

test('parseConfirmedQuantityInput: an explicitly typed zero is a real value, not rejected — only an absent one is', () => {
  const result = parseConfirmedQuantityInput('0');
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value, 0);
});

test('parseConfirmedQuantityInput: a plain positive number, with or without surrounding whitespace, parses to its value', () => {
  const a = parseConfirmedQuantityInput('298');
  assert.equal(a.ok, true);
  assert.equal(a.ok && a.value, 298);
  const b = parseConfirmedQuantityInput('  150.5  ');
  assert.equal(b.ok, true);
  assert.equal(b.ok && b.value, 150.5);
});

/**
 * F8.2 (W01 Integration) — "Исполнительная документация" section data:
 * package existence, status, covered portions, responsible PTO. BR-02/BR-03
 * (documentation never influences physical readiness, progress or quantity
 * confirmation) is checked here at the view-model boundary: building the
 * same work with and without a documentation package must not change any of
 * `plan`/`fact`/`readiness`/`confirmation`/`executionUnits` — only the new
 * `documentationPackages` slice differs.
 */
test('F8.2 W01 view-model: a work with no Documentation Package has an empty documentationPackages list', () => {
  const vm = buildW01ViewModel(baseWork(), baseObject(), [], [], [], [], []);
  assert.deepEqual(vm.documentationPackages, []);
});

test('F8.2 W01 view-model: a Documentation Package covering this work reports its status, responsible PTO and covered portion count', () => {
  const pkg = baseDocumentationPackage({ status: 'PREPARING' });
  const link = baseDocumentationPackagePortion();
  const vm = buildW01ViewModel(baseWork(), baseObject(), [], [], [], [pkg], [link]);
  assert.equal(vm.documentationPackages.length, 1);
  assert.equal(vm.documentationPackages[0]!.id, 'package-1');
  assert.equal(vm.documentationPackages[0]!.status.label, 'В подготовке');
  assert.equal(vm.documentationPackages[0]!.responsible, 'Ольга Морозова');
  assert.equal(vm.documentationPackages[0]!.coveredPortionCount, 1);
});

test('F8.2 W01 view-model: a Documentation Package covering a *different* work is excluded, the same scoping executionUnits already gets', () => {
  const foreignPackage = baseDocumentationPackage({ id: 'package-2', objectWorkId: 'work-2' });
  const vm = buildW01ViewModel(baseWork(), baseObject(), [], [], [], [foreignPackage], []);
  assert.deepEqual(vm.documentationPackages, []);
});

test('F8.2 W01 view-model: coveredPortionCount only counts links for *this* package, not a sibling package\'s own links', () => {
  const pkgA = baseDocumentationPackage({ id: 'package-a' });
  const pkgB = baseDocumentationPackage({ id: 'package-b' });
  const links = [
    baseDocumentationPackagePortion({ id: 'link-a1', documentationPackageId: 'package-a', quantityPortionId: 'portion-1' }),
    baseDocumentationPackagePortion({ id: 'link-a2', documentationPackageId: 'package-a', quantityPortionId: 'portion-2' }),
    baseDocumentationPackagePortion({ id: 'link-b1', documentationPackageId: 'package-b', quantityPortionId: 'portion-3' }),
  ];
  const vm = buildW01ViewModel(baseWork(), baseObject(), [], [], [], [pkgA, pkgB], links);
  const rowA = vm.documentationPackages.find((row) => row.id === 'package-a')!;
  const rowB = vm.documentationPackages.find((row) => row.id === 'package-b')!;
  assert.equal(rowA.coveredPortionCount, 2);
  assert.equal(rowB.coveredPortionCount, 1);
});

test('F8.2 W01 view-model: BR-02/BR-03 — a Documentation Package never changes plan/fact/readiness/confirmation/executionUnits', () => {
  const work = baseWork({ actualProgress: 50, accepted: false });
  const object = baseObject();
  const withoutPackage = buildW01ViewModel(work, object, [], [], [], [], []);
  const withPackage = buildW01ViewModel(
    work,
    object,
    [],
    [],
    [],
    [baseDocumentationPackage({ status: 'ACCEPTED_BY_CUSTOMER' })],
    [],
  );
  assert.deepEqual(withPackage.plan, withoutPackage.plan);
  assert.deepEqual(withPackage.fact, withoutPackage.fact);
  assert.equal(withPackage.readiness, withoutPackage.readiness);
  assert.deepEqual(withPackage.confirmation, withoutPackage.confirmation);
  assert.deepEqual(withPackage.executionUnits, withoutPackage.executionUnits);
  assert.notDeepEqual(withPackage.documentationPackages, withoutPackage.documentationPackages);
});
