import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scheduleStatusPresentation,
  healthStatusPresentation,
} from '../apps/frontend/src/view-models/status';
import { buildC01ViewModel } from '../apps/frontend/src/view-models/c01';
import { buildO01ViewModel } from '../apps/frontend/src/view-models/o01';
import { buildW01ViewModel } from '../apps/frontend/src/view-models/w01';
import type { Inspection, ObjectSummary, Work } from '../apps/frontend/src/types/api';

/**
 * F4 corrective patch (Work review) — pure view-model coverage.
 *
 * These test the derivation functions directly, without a browser, for the
 * same reason `tests/domain.test.ts` tests the domain services directly:
 * the claims here are about a function's output for a given input, not about
 * anything rendered. Browser coverage for the same findings, where the claim
 * is about what actually appears on screen, lives in
 * tests/design-system/screens.spec.ts.
 */

function versioned(id: string) {
  return { id, tenantId: 'test-tenant', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', version: 1 };
}

function makeObject(overrides: Partial<ObjectSummary> = {}): ObjectSummary {
  return {
    ...versioned('obj-1'),
    externalCode: 'CC-001',
    source: 'MANUAL',
    name: 'Test Object',
    address: 'Test address',
    customerName: null,
    organizationName: null,
    projectManagerId: 'pm-1',
    startDate: '2026-01-01',
    plannedFinishDate: '2026-12-31',
    actualFinishDate: null,
    status: 'ACTIVE',
    healthStatus: 'GREEN',
    responsible: 'Test PM',
    contractorIds: [],
    contractors: [],
    actualProgress: 50,
    plannedProgress: 50,
    ...overrides,
  };
}

function makeWork(overrides: Partial<Work> = {}): Work {
  return {
    ...versioned('work-1'),
    objectId: 'obj-1',
    workTypeId: 'wt-1',
    contractorId: 'contractor-1',
    responsibleUserId: 'pm-1',
    name: 'Test Work',
    unit: 'м²',
    plannedQuantity: '100.0000',
    actualQuantity: '50.0000',
    plannedStartDate: '2026-01-01',
    plannedFinishDate: '2026-06-01',
    actualStartDate: '2026-01-01',
    actualFinishDate: null,
    status: 'ACTIVE',
    categoryId: 'cat-1',
    requiresInspection: true,
    requiresMaterials: false,
    contractor: 'Test Contractor',
    responsible: 'Test PM',
    lastReportedAt: '2026-03-01T00:00:00Z',
    plannedProgress: 50,
    actualProgress: 50,
    variance: 0,
    delayDays: 0,
    scheduleStatus: 'GREEN',
    accepted: false,
    docsReady: false,
    blockers: [],
    stale: false,
    ...overrides,
  };
}

function makeInspection(overrides: Partial<Inspection> = {}): Inspection {
  return {
    ...versioned('insp-1'),
    objectId: 'obj-1',
    objectWorkId: 'work-1',
    requestedBy: 'pm-1',
    requestedAt: '2026-03-01T00:00:00Z',
    inspectorId: null,
    status: 'WAITING',
    inspectionDate: null,
    decision: null,
    comment: null,
    acceptedAt: null,
    ...overrides,
  };
}

// --- Finding 2: unknown status must never read as a positive one ---------

test('scheduleStatusPresentation: an unrecognised value is Neutral, never OnTrack', () => {
  const result = scheduleStatusPresentation('SOMETHING_THE_FRONTEND_HAS_NEVER_SEEN' as any);
  assert.equal(result.variant, 'Neutral');
  assert.notEqual(result.variant, 'OnTrack');
});

test('healthStatusPresentation: an unrecognised value is Neutral, never OnTrack', () => {
  const result = healthStatusPresentation('SOMETHING_THE_FRONTEND_HAS_NEVER_SEEN' as any);
  assert.equal(result.variant, 'Neutral');
  assert.notEqual(result.variant, 'OnTrack');
});

test('scheduleStatusPresentation and healthStatusPresentation: GRAY is Neutral', () => {
  assert.equal(scheduleStatusPresentation('GRAY').variant, 'Neutral');
  assert.equal(healthStatusPresentation('GRAY').variant, 'Neutral');
});

// --- Finding 1: object-level status is healthStatus, not a frontend aggregate ---

test('C01 portfolio row status is healthStatus, not derived from the works array', () => {
  // healthStatus says GREEN even though a work is RED — if the portfolio badge
  // were still a worst-wins aggregate over works, it would read Delayed here.
  const object = makeObject({ healthStatus: 'GREEN' });
  const work = makeWork({ scheduleStatus: 'RED' });
  const vm = buildC01ViewModel([object], [work]);
  assert.equal(vm.portfolio[0].status.variant, 'OnTrack');
});

test('O01 schedule status is healthStatus, not derived from the works array', () => {
  const object = makeObject({ healthStatus: 'GREEN' });
  const work = makeWork({ scheduleStatus: 'RED' });
  const vm = buildO01ViewModel(object, [work]);
  assert.equal(vm.schedule.status.variant, 'OnTrack');
});

// --- Finding 4: "no data" and "no problems" must not collapse into one ---

test('C01 attention: an object with healthStatus GRAY is not reported as problem-free', () => {
  const object = makeObject({ healthStatus: 'GRAY' });
  const vm = buildC01ViewModel([object], []);
  assert.equal(vm.attention.length, 0, 'a GRAY object is not a confirmed problem');
  assert.equal(vm.unevaluatedObjectCount, 1, 'but it must be counted as unevaluated, not silently dropped');
});

test('C01 attention: an object with healthStatus GREEN and no problem works is genuinely problem-free', () => {
  const object = makeObject({ healthStatus: 'GREEN' });
  const work = makeWork({ scheduleStatus: 'GREEN' });
  const vm = buildC01ViewModel([object], [work]);
  assert.equal(vm.attention.length, 0);
  assert.equal(vm.unevaluatedObjectCount, 0, 'a real GREEN result must not be counted as unevaluated either');
});

test('C01 attention: mixed portfolio reports confirmed problems and unevaluated objects independently', () => {
  const delayed = makeObject({ id: 'obj-delayed', healthStatus: 'RED' });
  const unevaluated = makeObject({ id: 'obj-gray', healthStatus: 'GRAY' });
  const delayedWork = makeWork({ id: 'work-delayed', objectId: 'obj-delayed', scheduleStatus: 'RED' });
  const vm = buildC01ViewModel([delayed, unevaluated], [delayedWork]);
  assert.equal(vm.attention.length, 1);
  assert.equal(vm.attention[0].objectId, 'obj-delayed');
  assert.equal(vm.unevaluatedObjectCount, 1);
});

// --- Finding 5: real blocker reasons reach O01, not a generic label ------

test('O01 blockedWorks carries the real blocker reasons through unedited', () => {
  const object = makeObject();
  const work = makeWork({ blockers: ['Штукатурка стен: не завершена', 'Нет допуска строительного контроля'] });
  const vm = buildO01ViewModel(object, [work]);
  assert.equal(vm.blockedWorks.length, 1);
  assert.deepEqual(vm.blockedWorks[0].reasons, [
    'Штукатурка стен: не завершена',
    'Нет допуска строительного контроля',
  ]);
});

test('O01 blockedWorks is empty, not a placeholder, when nothing is blocked', () => {
  const object = makeObject();
  const work = makeWork({ blockers: [] });
  const vm = buildO01ViewModel(object, [work]);
  assert.deepEqual(vm.blockedWorks, []);
});

// --- Finding 3: SK confirmation is never inferred from `accepted` --------

test('W01 confirmation: accepted work is a status only, with no quantity field', () => {
  const object = makeObject();
  const work = makeWork({ accepted: true, actualQuantity: '500.0000' });
  const vm = buildW01ViewModel(work, object, []);
  assert.equal(vm.confirmation.kind, 'Accepted');
  assert.ok(!('value' in vm.confirmation), 'Accepted must carry no invented quantity');
  // Fact is unaffected by acceptance — the two remain genuinely separate figures.
  assert.equal(vm.fact.value, '500');
});

test('W01 confirmation: a requested but undecided inspection is Pending, not Confirmed', () => {
  const object = makeObject();
  const work = makeWork({ accepted: false });
  const inspection = makeInspection({ objectWorkId: work.id, status: 'WAITING' });
  const vm = buildW01ViewModel(work, object, [inspection]);
  assert.equal(vm.confirmation.kind, 'Pending');
});

test('W01 confirmation: no inspection at all is NotSubmitted', () => {
  const object = makeObject();
  const work = makeWork({ accepted: false });
  const vm = buildW01ViewModel(work, object, []);
  assert.equal(vm.confirmation.kind, 'NotSubmitted');
});

test('W01 confirmation: buildW01ViewModel never produces ConfirmedQuantity from real data', () => {
  // Exhaustive over every reachable combination of accepted/inspection state —
  // the only way to reach ConfirmedQuantity is the explicit demo override in
  // preview/Gallery.tsx, never this adapter.
  const object = makeObject();
  for (const accepted of [true, false]) {
    for (const inspections of [[], [makeInspection({ status: 'WAITING' })], [makeInspection({ status: 'ACCEPTED' })]]) {
      const work = makeWork({ accepted });
      const vm = buildW01ViewModel(work, object, inspections);
      assert.notEqual(vm.confirmation.kind, 'ConfirmedQuantity');
    }
  }
});
