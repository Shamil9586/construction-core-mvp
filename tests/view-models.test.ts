import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scheduleStatusPresentation, NO_SCHEDULE_STATUS } from '../apps/frontend/src/view-models/status';
import { buildC01ViewModel } from '../apps/frontend/src/view-models/c01';
import { buildO01ViewModel } from '../apps/frontend/src/view-models/o01';
import { buildW01ViewModel } from '../apps/frontend/src/view-models/w01';
import type { Inspection, InspectionStatus, ObjectSummary, Work } from '../apps/frontend/src/types/api';

/**
 * F4 corrective patch (Work review, two passes) — pure view-model coverage.
 *
 * These test the derivation functions directly, without a browser, for the
 * same reason `tests/domain.test.ts` tests the domain services directly:
 * the claims here are about a function's output for a given input, not about
 * anything rendered. Browser coverage for the same findings, where the claim
 * is about what actually appears on screen, lives in
 * tests/design-system/screens.spec.ts.
 *
 * Several tests below replace ones from the first corrective pass that
 * pinned `healthStatus === schedule status` — itself a finding of the second
 * review round. Their replacements are marked accordingly.
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

// --- Unknown status must never read as a positive one ---------------------

test('scheduleStatusPresentation: an unrecognised value is Neutral, never OnTrack', () => {
  const result = scheduleStatusPresentation('SOMETHING_THE_FRONTEND_HAS_NEVER_SEEN' as any);
  assert.equal(result.variant, 'Neutral');
  assert.notEqual(result.variant, 'OnTrack');
});

test('scheduleStatusPresentation: GRAY is Neutral', () => {
  assert.equal(scheduleStatusPresentation('GRAY').variant, 'Neutral');
});

// --- Blocker 1 (2nd review round): no object-level status is a schedule claim ---

test('C01 portfolio row status is always the neutral no-data marker, never healthStatus and never a works aggregate', () => {
  // Replaces the first pass's "status is healthStatus" test — that was
  // itself the second round's finding: healthStatus is not a confirmed
  // per-object *schedule* status, so it must not appear under "График" either.
  const redHealth = makeObject({ healthStatus: 'RED' });
  const greenWork = makeWork({ scheduleStatus: 'GREEN' });
  const vm = buildC01ViewModel([redHealth], [greenWork]);
  assert.deepEqual(vm.portfolio[0].status, NO_SCHEDULE_STATUS);
});

test('O01 schedule carries only plan and fact — no status field at all', () => {
  const object = makeObject({ healthStatus: 'RED' });
  const work = makeWork({ scheduleStatus: 'RED' });
  const vm = buildO01ViewModel(object, [work]);
  assert.ok(!('status' in vm.schedule), 'no confirmed per-object schedule status exists to show');
  assert.equal(vm.schedule.plan, '50%');
  assert.equal(vm.schedule.fact, '50%');
});

test('Required test 1: healthStatus RED from a non-schedule cause (e.g. ИД/СДО) does not read as a schedule delay', () => {
  // healthStatus RED with every work GREEN and no blockers simulates exactly
  // the case the review named: RED for a reason that has nothing to do with
  // schedule. Nothing about this object may say "Есть отставание" anywhere.
  const object = makeObject({ healthStatus: 'RED' });
  const work = makeWork({ scheduleStatus: 'GREEN', blockers: [] });
  const c01 = buildC01ViewModel([object], [work]);
  assert.notEqual(c01.portfolio[0].status.label, 'Есть отставание');
  assert.equal(c01.attention.length, 0, 'no real schedule or blocker problem exists on this object');
});

// --- Blocker 3 (2nd review round): attention derived from real per-work data, independent of healthStatus ---

test('Required test 2: an object with no works (unknown) is never reported as "no problems"', () => {
  const object = makeObject({ healthStatus: 'GREEN' });
  const vm = buildC01ViewModel([object], []);
  assert.equal(vm.attention.length, 0, 'no confirmed problem exists to report');
  assert.equal(vm.unevaluatedObjectCount, 1, 'but zero works means nothing was actually evaluated either');
});

test('Required test 3: a GRAY-health object with a real blocker still reports the blocker', () => {
  // The reachable case the review flagged: ObjectHealthService's own
  // `blocked` signal requires `delayDays > 0`, so a work can carry
  // `blockers` while healthStatus still reads GRAY. Blockers must be checked
  // unconditionally, never gated on healthStatus.
  const object = makeObject({ healthStatus: 'GRAY' });
  const work = makeWork({ scheduleStatus: 'GRAY', delayDays: 0, blockers: ['Штукатурка стен: не завершена'] });
  const vm = buildC01ViewModel([object], [work]);
  assert.equal(vm.attention.length, 1);
  assert.equal(vm.attention[0].reason, 'Blocked');
  assert.equal(vm.unevaluatedObjectCount, 0, 'a confirmed problem was found, so this object is not "unevaluated"');
});

test('Required test 4: an unevaluated object and a confirmed problem are both reported, at once', () => {
  const problem = makeObject({ id: 'obj-problem', healthStatus: 'RED' });
  const unevaluated = makeObject({ id: 'obj-unevaluated', healthStatus: 'GRAY' });
  const redWork = makeWork({ id: 'work-red', objectId: 'obj-problem', scheduleStatus: 'RED' });
  const vm = buildC01ViewModel([problem, unevaluated], [redWork]);
  assert.equal(vm.attention.length, 1);
  assert.equal(vm.attention[0].objectId, 'obj-problem');
  assert.equal(vm.unevaluatedObjectCount, 1);
});

test('attention item status reflects the specific reason, not a mixed object status', () => {
  const redObject = makeObject({ healthStatus: 'GREEN' }); // deliberately mismatched
  const redWork = makeWork({ scheduleStatus: 'RED' });
  const vm = buildC01ViewModel([redObject], [redWork]);
  assert.equal(vm.attention[0].status.variant, 'Delayed');
  assert.equal(vm.attention[0].status.label, 'Есть отставание');
});

test('a genuinely evaluated, problem-free object is neither in attention nor counted as unevaluated', () => {
  const object = makeObject({ healthStatus: 'GREEN' });
  const work = makeWork({ scheduleStatus: 'GREEN' });
  const vm = buildC01ViewModel([object], [work]);
  assert.equal(vm.attention.length, 0);
  assert.equal(vm.unevaluatedObjectCount, 0);
});

test('an empty portfolio produces no items and no unevaluated count — the screen distinguishes this case itself', () => {
  const vm = buildC01ViewModel([], []);
  assert.deepEqual(vm.attention, []);
  assert.equal(vm.unevaluatedObjectCount, 0);
  assert.deepEqual(vm.portfolio, []);
});

// --- Blocker (3rd review round): one known work is not proof of complete evaluation ---
//
// Patch 2's own "unevaluated" check used `.some()` — one known reading
// anywhere on the object made the whole object look fully evaluated, even
// with other works still GRAY or unrecognised. These four tests are the
// review's own numbered list.

test('Round-3 required test 1: GREEN + GRAY in the same object does not produce "no problems"', () => {
  const object = makeObject({ healthStatus: 'GREEN' });
  const greenWork = makeWork({ id: 'work-green', scheduleStatus: 'GREEN' });
  const grayWork = makeWork({ id: 'work-gray', scheduleStatus: 'GRAY' });
  const vm = buildC01ViewModel([object], [greenWork, grayWork]);
  assert.equal(vm.attention.length, 0, 'no blocker and no RED/YELLOW work — no confirmed problem');
  assert.equal(
    vm.unevaluatedObjectCount,
    1,
    'the GRAY work makes the object incomplete even though another work is GREEN',
  );
});

test('Round-3 required test 2: GREEN + an unrecognised schedule status in the same object does not produce "no problems"', () => {
  const object = makeObject({ healthStatus: 'GREEN' });
  const greenWork = makeWork({ id: 'work-green', scheduleStatus: 'GREEN' });
  const unknownWork = makeWork({ id: 'work-unknown', scheduleStatus: 'SOME_FUTURE_SCHEDULE_STATUS' as any });
  const vm = buildC01ViewModel([object], [greenWork, unknownWork]);
  assert.equal(vm.attention.length, 0);
  assert.equal(vm.unevaluatedObjectCount, 1, 'an unrecognised status is not a known reading either');
});

test('Round-3 required test 3: GRAY schedule status and a real blocker in the same object — the blocker still shows', () => {
  const object = makeObject({ healthStatus: 'GRAY' });
  // The blocker sits on a work whose own scheduleStatus is GRAY — data
  // completeness and problem detection must not interfere with each other.
  const work = makeWork({ scheduleStatus: 'GRAY', blockers: ['Штукатурка стен: не завершена'] });
  const vm = buildC01ViewModel([object], [work]);
  assert.equal(vm.attention.length, 1);
  assert.equal(vm.attention[0].reason, 'Blocked');
});

test('Round-3 required test 4: no works at all is insufficient data, not vacuously "complete"', () => {
  const object = makeObject({ healthStatus: 'GREEN' });
  const vm = buildC01ViewModel([object], []);
  assert.equal(vm.attention.length, 0);
  assert.equal(vm.unevaluatedObjectCount, 1, '`.every()` on an empty array must not read as complete evaluation');
});

// --- Blocker 5 (1st review round, unaffected by round 2): real blocker reasons reach O01 ---

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

// --- Blocker 2 (2nd review round): real Inspection.status semantics -------

const stillOpenStatuses: InspectionStatus[] = ['WAITING', 'IN_REVIEW', 'REINSPECTION'];

test('Required test 5a: WAITING / IN_REVIEW / REINSPECTION are all Pending — genuinely still open', () => {
  for (const status of stillOpenStatuses) {
    const object = makeObject();
    const work = makeWork({ accepted: false });
    const inspection = makeInspection({ objectWorkId: work.id, status });
    const vm = buildW01ViewModel(work, object, [inspection]);
    assert.equal(vm.confirmation.kind, 'Pending', `expected Pending for ${status}`);
  }
});

test('Required test 5b: ISSUES_FOUND is its own state, not folded into Pending', () => {
  const object = makeObject();
  const work = makeWork({ accepted: false });
  const inspection = makeInspection({ objectWorkId: work.id, status: 'ISSUES_FOUND' });
  const vm = buildW01ViewModel(work, object, [inspection]);
  assert.equal(vm.confirmation.kind, 'IssuesFound');
});

test('Required test 5c: REJECTED is a terminal decision, never shown as Pending', () => {
  const object = makeObject();
  const work = makeWork({ accepted: false });
  const inspection = makeInspection({ objectWorkId: work.id, status: 'REJECTED' });
  const vm = buildW01ViewModel(work, object, [inspection]);
  assert.equal(vm.confirmation.kind, 'Rejected');
  assert.notEqual(vm.confirmation.kind, 'Pending');
});

test('Required test 5d: an unrecognised inspection status is Unknown, not Pending', () => {
  const object = makeObject();
  const work = makeWork({ accepted: false });
  const inspection = makeInspection({ objectWorkId: work.id, status: 'SOME_FUTURE_STATUS' as InspectionStatus });
  const vm = buildW01ViewModel(work, object, [inspection]);
  assert.equal(vm.confirmation.kind, 'Unknown');
});

test('Required test 5e: absence of any inspection (NotSubmitted) is distinct from an unrecognised status (Unknown)', () => {
  const object = makeObject();
  const work = makeWork({ accepted: false });

  const noInspection = buildW01ViewModel(work, object, []);
  assert.equal(noInspection.confirmation.kind, 'NotSubmitted');

  const unknownInspection = buildW01ViewModel(
    work,
    object,
    [makeInspection({ objectWorkId: work.id, status: 'SOME_FUTURE_STATUS' as InspectionStatus })],
  );
  assert.equal(unknownInspection.confirmation.kind, 'Unknown');
  assert.notEqual(unknownInspection.confirmation.kind, noInspection.confirmation.kind);
});

test('work.accepted always wins over inspection.status, including the contradictory case the backend should never produce', () => {
  const object = makeObject();
  // work.accepted true while the latest inspection record somehow still says
  // WAITING — accepted is the authoritative decision field.
  const work = makeWork({ accepted: true });
  const inspection = makeInspection({ objectWorkId: work.id, status: 'WAITING' });
  const vm = buildW01ViewModel(work, object, [inspection]);
  assert.equal(vm.confirmation.kind, 'Accepted');
});

// --- Required test 6 / Blocker 3 (1st review round, unaffected by round 2): accepted work carries no invented quantity ---

test('Required test 6: Accepted never gets a quantity from actualQuantity', () => {
  const object = makeObject();
  const work = makeWork({ accepted: true, actualQuantity: '500.0000' });
  const vm = buildW01ViewModel(work, object, []);
  assert.equal(vm.confirmation.kind, 'Accepted');
  assert.ok(!('value' in vm.confirmation), 'Accepted must carry no invented quantity');
  // Fact is unaffected by acceptance — the two remain genuinely separate figures.
  assert.equal(vm.fact.value, '500');
});

test('buildW01ViewModel never produces ConfirmedQuantity from real data', () => {
  // Exhaustive over every reachable combination of accepted/inspection state —
  // the only way to reach ConfirmedQuantity is the explicit demo override in
  // preview/Gallery.tsx, never this adapter.
  const object = makeObject();
  const statuses: InspectionStatus[] = ['WAITING', 'IN_REVIEW', 'REINSPECTION', 'ISSUES_FOUND', 'REJECTED', 'ACCEPTED'];
  for (const accepted of [true, false]) {
    for (const inspections of [[], ...statuses.map((status) => [makeInspection({ status })])]) {
      const work = makeWork({ accepted });
      const vm = buildW01ViewModel(work, object, inspections);
      assert.notEqual(vm.confirmation.kind, 'ConfirmedQuantity');
    }
  }
});
