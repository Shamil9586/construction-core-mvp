import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildO01ViewModel } from '../apps/frontend/src/view-models/o01';
import { buildW01ViewModel } from '../apps/frontend/src/view-models/w01';
import { aggregateWorkEntryStates, buildW01ScheduleView, buildObjectWorkCompliance } from '../apps/frontend/src/view-models/schedule';
import { workExecutionPresentation, workExecutionState } from '../apps/frontend/src/view-models/status';
import { aggregateScheduleStates } from '../packages/domain/schedule';
import type { ObjectSummary, Work } from '../apps/frontend/src/types/api';
import type { ObjectSchedule, ScheduleEntry, ScheduleEntryState, ScheduleLoad, WorkSchedule } from '../apps/frontend/src/types/schedule';

/**
 * GPR-UX-D01 — once an object's GPR is approved, compliance with the production deadlines is decided by the GPR alone; the actual physical
 * state («Не начато» / «В работе» / «Выполнено») is shown separately, and the legacy `work.scheduleStatus` produces NO schedule verdict on
 * O01 / W01. Pure view-model coverage over fixtures shaped like the real snapshot and schedule API.
 */
const OBJECT = 'obj-1', OTHER_OBJECT = 'obj-2';
const versioned = (id: string) => ({ id, tenantId: 't', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', version: 1 });
const object = (over: Partial<ObjectSummary> = {}): ObjectSummary => ({
  ...versioned(OBJECT), externalCode: 'CC-001', source: 'MANUAL', name: 'Объект', address: 'Адрес', customerName: null, organizationName: null, projectManagerId: 'pm',
  startDate: '2026-01-01', plannedFinishDate: '2026-12-31', actualFinishDate: null, status: 'ACTIVE', healthStatus: 'GREEN', responsible: 'РП', contractorIds: [], contractors: [],
  actualProgress: 50, plannedProgress: 50, ...over,
});
const work = (id: string, over: Partial<Work> = {}): Work => ({
  ...versioned(id), objectId: OBJECT, workTypeId: 'wt', contractorId: 'c', responsibleUserId: 'pm', name: 'Работа ' + id, unit: 'м²', plannedQuantity: '100.0000', actualQuantity: '50.0000',
  plannedStartDate: '2026-01-01', plannedFinishDate: '2026-06-01', actualStartDate: '2026-01-01', actualFinishDate: null, status: 'ACTIVE', categoryId: 'cat', requiresInspection: true,
  requiresMaterials: false, contractor: 'Подрядчик', responsible: 'РП', lastReportedAt: '2026-03-01T00:00:00Z', plannedProgress: 50, actualProgress: 50, variance: 0, delayDays: 0,
  scheduleStatus: 'GREEN', accepted: false, docsReady: false, blockers: [], stale: false, ...over,
});
const entry = (workId: string, unit: string, state: ScheduleEntryState): ScheduleEntry => ({
  entryId: 'e-' + unit, itemId: 'i-' + unit, revisionId: 'r1', sequence: 1, objectWorkId: workId, workName: 'Работа ' + workId, executionUnitId: unit, zone: unit, finishType: null, conditions: null,
  contractorId: 'c', executor: 'Подрядчик', unit: 'м²', plannedQuantity: '100.0000', plannedStart: '2026-03-01', plannedFinish: '2026-03-11', predecessorItemId: null, predecessorLabel: null,
  followsPredecessor: null, rpFactQuantity: '10.0000', internalScAcceptedQuantity: null, plannedProgress: 50, actualProgress: 10, factReported: true, overperformed: false,
  expectedPhase: 'UNDERWAY', state, delayDays: state === 'DELAYED' ? 4 : 0, delayKind: state === 'DELAYED' ? 'PROGRESS' : null, baselineShift: null, workNowHasUnits: false, delayReasons: [],
});
const schedule = (entries: ScheduleEntry[], over: Partial<ObjectSchedule> = {}): ObjectSchedule => ({
  objectId: OBJECT, objectName: 'Объект', asOf: '2026-03-06', progressSource: 'RP_FACT',
  access: { canEdit: false, canApprove: false, canRecordDelayReason: false, canCreateDraft: false, canManageCategories: false }, hasDraft: false,
  current: { revisionId: 'r1', revisionNo: 1, approvedAt: '2026-02-20T09:00:00.000Z', approvedByName: null, approvalComment: null, correctionReason: null, basedOnRevisionNo: null },
  conclusion: { status: entries.some((e) => e.state === 'DELAYED') ? 'DELAYED' : 'ON_TRACK', entryCount: entries.length, delayedCount: entries.filter((e) => e.state === 'DELAYED').length, maxDelayDays: 0, completedCount: 0, inProgressCount: 0, notStartedCount: 0, expected: { notDue: 0, underway: 0, dueComplete: 0 }, unscheduledCount: 0, openDelayReasonCount: 0 },
  entries, unscheduled: [], draft: null, availableScopes: [], history: [], delayReasonCategories: [], ...over,
});
const loaded = <T>(value: T): ScheduleLoad<T> => ({ status: 'Loaded', value });
const rowOf = (vm: ReturnType<typeof buildO01ViewModel>, id: string) => vm.works.find((w) => w.id === id)!;

test('1. legacy says «По графику» (GREEN), the approved GPR says delayed → O01 shows the GPR delay, not the old verdict', () => {
  const w = work('w1', { scheduleStatus: 'GREEN', delayDays: 0 });
  const vm = buildO01ViewModel(object(), [w], loaded(schedule([entry('w1', 'z1', 'DELAYED')])));
  assert.deepEqual(rowOf(vm, 'w1').scheduleCompliance, { variant: 'Delayed', label: 'Есть отставание' });
  assert.equal(rowOf(vm, 'w1').needsAttention, true);
});

test('2. legacy says delayed (RED), the approved GPR says on schedule → O01 uses the GPR', () => {
  const w = work('w1', { scheduleStatus: 'RED', delayDays: 30 });
  const vm = buildO01ViewModel(object(), [w], loaded(schedule([entry('w1', 'z1', 'IN_PROGRESS')])));
  assert.deepEqual(rowOf(vm, 'w1').scheduleCompliance, { variant: 'OnTrack', label: 'По графику' });
  assert.equal(rowOf(vm, 'w1').needsAttention, false, 'a legacy RED no longer raises attention on O01');
  for (const status of ['GREEN', 'YELLOW', 'RED', 'GRAY', 'SOMETHING_NEW'] as Work['scheduleStatus'][]) {
    const label = buildO01ViewModel(object(), [work('w1', { scheduleStatus: status })], loaded(schedule([entry('w1', 'z1', 'NOT_STARTED')]))).works[0]!.scheduleCompliance.label;
    assert.equal(label, 'По графику', `legacy ${status} cannot move the verdict`);
  }
});

test('3. the physical state is its own fact, distinct from schedule compliance — and an unreported fact is not a reported zero', () => {
  const none = work('none', { lastReportedAt: null, actualQuantity: '0.0000', actualProgress: null });
  const staleNumber = work('stale', { lastReportedAt: null, actualQuantity: '40.0000' }); // nothing reported: the number is not evidence
  const zero = work('zero', { lastReportedAt: '2026-03-01T00:00:00Z', actualQuantity: '0.0000', actualProgress: 0 });
  const some = work('some', { actualQuantity: '40.0000' });
  const done = work('done', { actualQuantity: '100.0000' });
  const over = work('over', { actualQuantity: '120.0000' });
  assert.deepEqual([none, staleNumber, zero, some, done, over].map((w) => workExecutionState(w)), ['NOT_STARTED', 'NOT_STARTED', 'NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'COMPLETED']);
  assert.deepEqual(workExecutionPresentation(some), { variant: 'Neutral', label: 'В работе' });
  assert.deepEqual(workExecutionPresentation(none), { variant: 'Neutral', label: 'Не начато' });
  assert.deepEqual(workExecutionPresentation(done), { variant: 'OnTrack', label: 'Выполнено' });
  const vm = buildO01ViewModel(object(), [none, zero, some], loaded(schedule([entry('none', 'a', 'DELAYED'), entry('zero', 'b', 'NOT_STARTED'), entry('some', 'c', 'IN_PROGRESS')])));
  assert.equal(rowOf(vm, 'none').fact, '—', 'nothing reported stays «—»');
  assert.match(rowOf(vm, 'zero').fact, /^0/, 'an explicit zero stays a number');
  // physical state and compliance are separate fields: a not-started work can be delayed by the GPR, an in-progress one on schedule
  assert.equal(rowOf(vm, 'none').execution.label, 'Не начато');
  assert.equal(rowOf(vm, 'none').scheduleCompliance.label, 'Есть отставание');
  assert.equal(rowOf(vm, 'some').execution.label, 'В работе');
  assert.equal(rowOf(vm, 'some').scheduleCompliance.label, 'По графику');
  assert.ok(!('status' in rowOf(vm, 'some')), 'the old single status slot is gone');
});

test('4. several execution units aggregate with the GPR rule (any delay wins; all done; all not started; otherwise in progress)', () => {
  const cases: [ScheduleEntryState[], string][] = [
    [['COMPLETED', 'DELAYED', 'NOT_STARTED'], 'Есть отставание'],
    [['COMPLETED', 'IN_PROGRESS'], 'По графику'],
    [['COMPLETED', 'COMPLETED'], 'По графику'],
    [['NOT_STARTED', 'NOT_STARTED'], 'По графику'],
  ];
  for (const [states, label] of cases) {
    const entries = states.map((s, i) => entry('w1', 'z' + i, s));
    assert.equal(rowOf(buildO01ViewModel(object(), [work('w1')], loaded(schedule(entries))), 'w1').scheduleCompliance.label, label, states.join('+'));
  }
  // the same aggregation as the backend's W01 summary (packages/domain/schedule.ts)
  const all: ScheduleEntryState[] = ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'DELAYED'];
  const combos: ScheduleEntryState[][] = [[], ...all.map((a) => [a]), ...all.flatMap((a) => all.map((b) => [a, b])), ...all.flatMap((a) => all.flatMap((b) => all.map((c) => [a, b, c])))];
  for (const states of combos) assert.equal(aggregateWorkEntryStates(states), aggregateScheduleStates(states), states.join('+') || '(none)');
});

test('5. no approved GPR → no schedule-compliance claim at all (never «По графику»)', () => {
  const noBaseline = schedule([], { current: null, conclusion: { ...schedule([]).conclusion, status: 'NO_BASELINE' }, hasDraft: true });
  const vm = buildO01ViewModel(object(), [work('w1', { scheduleStatus: 'RED' }), work('w2', { scheduleStatus: 'GREEN' })], loaded(noBaseline));
  for (const row of vm.works) assert.deepEqual(row.scheduleCompliance, { variant: 'Neutral', label: 'График не утверждён' });
  assert.ok(vm.works.every((row) => !row.needsAttention));
  const w01 = buildW01ScheduleView(loaded<WorkSchedule>({ objectId: OBJECT, objectWorkId: 'w1', asOf: '2026-03-06', progressSource: 'RP_FACT', canOpenObjectSchedule: true, hasBaseline: false, revisionNo: null, summary: null, entries: [] }), 'w1');
  assert.equal(w01.kind, 'NoBaseline');
});

test('6. a work absent from the approved GPR is explicitly «Не включена в график», whatever the legacy status says', () => {
  const vm = buildO01ViewModel(object(), [work('w1', { scheduleStatus: 'GREEN' }), work('w2', { scheduleStatus: 'RED' })], loaded(schedule([entry('w1', 'z1', 'IN_PROGRESS')])));
  assert.deepEqual(rowOf(vm, 'w2').scheduleCompliance, { variant: 'Neutral', label: 'Не включена в график' });
  assert.equal(rowOf(vm, 'w1').scheduleCompliance.label, 'По графику');
  const w01 = buildW01ScheduleView(loaded<WorkSchedule>({ objectId: OBJECT, objectWorkId: 'w2', asOf: '2026-03-06', progressSource: 'RP_FACT', canOpenObjectSchedule: true, hasBaseline: true, revisionNo: 1, summary: null, entries: [] }), 'w2');
  assert.equal(w01.kind, 'NotScheduled');
});

test('loading / unavailable / error GPR: no substitute verdict and no «По графику»', () => {
  const works = [work('w1', { scheduleStatus: 'GREEN' }), work('w2', { scheduleStatus: 'RED' })];
  const expectations: [ScheduleLoad<ObjectSchedule> | undefined, string][] = [
    [{ status: 'Loading' }, 'Загрузка графика…'], [{ status: 'Hidden' }, 'График недоступен'], [undefined, 'График недоступен'], [{ status: 'Error', message: 'x' }, 'График не загружен'],
  ];
  for (const [load, label] of expectations) {
    const vm = buildO01ViewModel(object(), works, load);
    for (const row of vm.works) { assert.deepEqual(row.scheduleCompliance, { variant: 'Neutral', label }); assert.equal(row.needsAttention, false); }
  }
});

test('7. operational blockers stay visible beside the execution state and in blockedWorks; they are not a schedule verdict', () => {
  const blocked = work('w1', { blockers: ['Нет допуска строительного контроля'], scheduleStatus: 'GREEN' });
  const vm = buildO01ViewModel(object(), [blocked, work('w2')], loaded(schedule([entry('w1', 'z', 'IN_PROGRESS'), entry('w2', 'y', 'IN_PROGRESS')])));
  assert.deepEqual(rowOf(vm, 'w1').blocker, { variant: 'Blocked', label: 'Заблокировано' });
  assert.equal(rowOf(vm, 'w1').scheduleCompliance.label, 'По графику', 'a blocker does not change the schedule verdict');
  assert.equal(rowOf(vm, 'w1').needsAttention, true);
  assert.equal(rowOf(vm, 'w2').blocker, null);
  assert.deepEqual(vm.blockedWorks, [{ workId: 'w1', workName: 'Работа w1', reasons: ['Нет допуска строительного контроля'] }]);
  assert.equal(vm.works[0]!.id, 'w1', 'attention rows first');
  const w01 = buildW01ViewModel(blocked, object());
  assert.deepEqual(w01.blocker, { variant: 'Blocked', label: 'Заблокировано' });
  assert.deepEqual(w01.blockers, ['Нет допуска строительного контроля']);
  assert.equal(w01.execution.label, 'В работе');
  assert.ok(!('status' in w01), 'the W01 header no longer has a status slot that could carry a schedule verdict');
});

test('8. switching objects / works never shows another object\'s or work\'s schedule', () => {
  const foreign = schedule([entry('w1', 'z', 'DELAYED')], { objectId: OTHER_OBJECT });
  const vm = buildO01ViewModel(object(), [work('w1', { scheduleStatus: 'RED' })], loaded(foreign));
  assert.deepEqual(rowOf(vm, 'w1').scheduleCompliance, { variant: 'Neutral', label: 'Загрузка графика…' });
  assert.equal(buildObjectWorkCompliance(loaded(foreign), OBJECT)('w1').kind, 'Loading');
  // works of another object are never in this object's list, whatever the schedule holds
  const mixed = buildO01ViewModel(object(), [work('w1'), work('wx', { objectId: OTHER_OBJECT })], loaded(schedule([entry('w1', 'z', 'IN_PROGRESS'), entry('wx', 'q', 'DELAYED')])));
  assert.deepEqual(mixed.works.map((r) => r.id), ['w1']);
  const summary: WorkSchedule = { objectId: OBJECT, objectWorkId: 'w-other', asOf: '2026-03-06', progressSource: 'RP_FACT', canOpenObjectSchedule: true, hasBaseline: true, revisionNo: 1,
    summary: { plannedStart: '2026-03-01', plannedFinish: '2026-03-11', state: 'DELAYED', delayDays: 4, entryCount: 1 }, entries: [] };
  assert.equal(buildW01ScheduleView(loaded(summary), 'w1').kind, 'Loading');
  assert.equal(buildW01ScheduleView(loaded(summary), 'w-other').kind, 'Ready');
});

test('guard: O01 / W01 view-models and screens never read the legacy work.scheduleStatus', () => {
  for (const file of ['view-models/o01.ts', 'view-models/w01.ts', 'screens/O01/index.tsx', 'screens/W01/index.tsx', 'screens/W01/ScheduleSection.tsx', 'app/routes/ObjectRoute.tsx', 'app/routes/WorkRoute.tsx']) {
    const code = fs.readFileSync('apps/frontend/src/' + file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /scheduleStatus|workStatusPresentation|scheduleStatusPresentation/, file);
  }
  assert.doesNotMatch(fs.readFileSync('apps/frontend/src/view-models/status.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''), /export function workStatusPresentation/);
});
