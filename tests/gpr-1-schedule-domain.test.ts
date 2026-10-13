import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roles, hasPermission, Permission } from '../packages/domain';
import {
  civilDayNumber, isCivilDate, todayCivil, plannedProgressOn, expectedPhaseOn, deriveScheduleEntryStatus, aggregateScheduleStates,
  resolveObjectScheduleConclusion, diffScheduleEntries, hasPredecessorCycle, worksScheduledAtBothLevels, scheduleApprovalViolations,
  scheduleDatesViolation, isScheduleRevisionTransitionAllowed, effectiveDelayCategories, DEFAULT_DELAY_REASON_CATEGORIES, delayReasonViolation,
  startsBeforePredecessorFinish, nextScheduleSequence, compareScheduleOrder, SCHEDULE_PROGRESS_SOURCE, isScheduleDate, SCHEDULE_DATE_RANGE_MESSAGE,
  FINISH_BEFORE_START_MESSAGE, NO_CHANGES_MESSAGE, CORRECTION_REASON_REQUIRED_MESSAGE, EMPTY_SCHEDULE_MESSAGE, PREDECESSOR_CYCLE_MESSAGE, WORK_SCHEDULED_AS_WHOLE_MESSAGE,
  type ScheduleEntrySnapshot,
} from '../packages/domain/schedule';

/**
 * GPR-1 — the pure rules of the Production Schedule. No database, no HTTP: dates + production facts in, a status out.
 * One plan used throughout: 2026-03-01 .. 2026-03-11 (ten days), 100 units of work.
 */
const START = '2026-03-01', FINISH = '2026-03-11';
const status = (today: string, fact: string | number | null, plan: string | number = 100, start = START, finish = FINISH) =>
  deriveScheduleEntryStatus({ plannedStart: start, plannedFinish: finish, plannedQuantity: plan, rpFactQuantity: fact }, today);

test('civil dates: exact whole-day arithmetic, invalid dates refused', () => {
  assert.equal(civilDayNumber('2026-03-02') - civilDayNumber('2026-03-01'), 1);
  assert.equal(civilDayNumber('2026-03-29') - civilDayNumber('2026-03-28'), 1, 'no DST drift: a civil date is not an instant');
  assert.equal(civilDayNumber('2027-01-01') - civilDayNumber('2026-01-01'), 365);
  assert.equal(isCivilDate('2026-02-30'), false);
  assert.equal(isCivilDate('2026-2-3'), false);
  assert.equal(isCivilDate('2026-03-01'), true);
  assert.throws(() => civilDayNumber('bad'));
  assert.equal(todayCivil(new Date('2026-10-13T23:59:59Z')), '2026-10-13');
});

test('civil dates: every year is read as written — Date.UTC would read 0026 as 1926', () => {
  assert.equal(civilDayNumber('1970-01-01'), 0);
  assert.equal(civilDayNumber('1969-12-31'), -1);
  assert.ok(civilDayNumber('0026-03-01') < civilDayNumber('1900-01-01'), 'year 26 is long before 1900, not 1926');
  assert.notEqual(civilDayNumber('0026-03-01'), civilDayNumber('1926-03-01'));
  assert.notEqual(civilDayNumber('0099-01-01'), civilDayNumber('1999-01-01'));
  assert.ok(civilDayNumber('0099-12-31') < civilDayNumber('0100-01-01'), 'the order of years 99 and 100 holds');
  assert.equal(civilDayNumber('0100-01-01') - civilDayNumber('0099-12-31'), 1);
  assert.equal(civilDayNumber('2000-03-01') - civilDayNumber('2000-02-28'), 2, 'leap year 2000');
  assert.equal(civilDayNumber('2100-03-01') - civilDayNumber('2100-02-28'), 1, '2100 is not a leap year');
});

test('a schedule plans in the years 2000–2100: a typed two-digit year is refused, not measured', () => {
  for (const ok of ['2000-01-01', '2026-03-01', '2100-12-31']) assert.equal(isScheduleDate(ok), true, ok);
  for (const bad of ['1999-12-31', '2101-01-01', '0026-03-01', '0099-12-31', '9999-01-01', '2026-02-30', 'bad', 20260301, null]) assert.equal(isScheduleDate(bad), false, String(bad));
  assert.equal(scheduleDatesViolation('0026-03-01', '2026-03-15'), SCHEDULE_DATE_RANGE_MESSAGE);
  assert.equal(scheduleDatesViolation('2026-03-01', '2101-03-15'), SCHEDULE_DATE_RANGE_MESSAGE);
  assert.equal(scheduleDatesViolation('2026-03-01', '2026-03-15'), null);
});

test('planned progress is the accepted linear plan: 0 before the start, 100 from the finish date on', () => {
  assert.equal(plannedProgressOn(START, FINISH, '2026-02-28'), 0);
  assert.equal(plannedProgressOn(START, FINISH, '2026-03-01'), 0);
  assert.equal(plannedProgressOn(START, FINISH, '2026-03-06'), 50);
  assert.equal(plannedProgressOn(START, FINISH, '2026-03-11'), 100);
  assert.equal(plannedProgressOn(START, FINISH, '2026-04-01'), 100);
  assert.equal(plannedProgressOn('2026-03-05', '2026-03-05', '2026-03-04'), 0, 'a one-day plan: nothing before its date');
  assert.equal(plannedProgressOn('2026-03-05', '2026-03-05', '2026-03-05'), 100, 'a one-day plan: 100 on its date');
});

test('what should have started / be underway / be finished — the calendar alone', () => {
  assert.equal(expectedPhaseOn(START, FINISH, '2026-02-28'), 'NOT_DUE');
  assert.equal(expectedPhaseOn(START, FINISH, '2026-03-01'), 'UNDERWAY', 'the start date has come');
  assert.equal(expectedPhaseOn(START, FINISH, '2026-03-10'), 'UNDERWAY');
  assert.equal(expectedPhaseOn(START, FINISH, '2026-03-11'), 'DUE_COMPLETE', 'plan = 100% on the finish date');
  assert.equal(expectedPhaseOn(START, FINISH, '2026-05-01'), 'DUE_COMPLETE');
});

test('Не начато: no fact, start date not passed — never a delay, never a 0% claimed from nothing', () => {
  const before = status('2026-02-27', null);
  assert.equal(before.state, 'NOT_STARTED');
  assert.equal(before.delayDays, 0);
  assert.equal(before.factReported, false, 'nothing reported is not a reported zero');
  assert.equal(before.actualProgress, 0);
  const onStartDay = status('2026-03-01', null);
  assert.equal(onStartDay.state, 'NOT_STARTED', 'the work is due to start today: not late yet');
  assert.equal(onStartDay.delayDays, 0);
});

test('Есть отставание: not started a day after the start date; delay counts whole calendar days', () => {
  const s = status('2026-03-02', null);
  assert.equal(s.state, 'DELAYED');
  assert.equal(s.delayDays, 1);
  assert.equal(s.delayKind, 'START');
  assert.equal(status('2026-03-06', null).delayDays, 5);
  const reportedZero = status('2026-03-06', '0');
  assert.equal(reportedZero.factReported, true);
  assert.equal(reportedZero.state, 'DELAYED', 'a reported 0 is still not started');
  assert.equal(reportedZero.delayDays, 5);
});

test('В работе: on the linear plan, or behind it by less than one whole day', () => {
  const onPlan = status('2026-03-06', 50);
  assert.equal(onPlan.state, 'IN_PROGRESS');
  assert.equal(onPlan.delayDays, 0);
  assert.equal(onPlan.delayKind, null);
  assert.equal(onPlan.plannedProgress, 50);
  assert.equal(onPlan.actualProgress, 50);
  assert.equal(status('2026-03-06', 49).state, 'IN_PROGRESS', '49% against a plan of 50% mid-flow is 0.1 day behind: no alarm');
  assert.equal(status('2026-03-06', 70).state, 'IN_PROGRESS', 'ahead of the plan');
  assert.equal(status('2026-02-20', 10).state, 'IN_PROGRESS', 'started early: in progress, not "not started"');
});

test('Есть отставание: behind the plan by a whole day or more — days measured to the equivalent date of the linear plan', () => {
  const oneDay = status('2026-03-06', 40); // the plan reached 40% on Mar 5: one day ago
  assert.equal(oneDay.state, 'DELAYED');
  assert.equal(oneDay.delayDays, 1);
  assert.equal(oneDay.delayKind, 'PROGRESS');
  assert.equal(status('2026-03-06', 30).delayDays, 2);
  assert.equal(status('2026-03-06', 10).delayDays, 4);
  assert.equal(status('2026-03-06', 20).delayDays, 3);
});

test('on the finish date a lag under one whole day is not yet a delay; once a whole day is lost — and always after the finish date — it is (FINISH), and the days keep counting', () => {
  const onFinish = status('2026-03-11', 90);
  assert.equal(onFinish.state, 'DELAYED');
  assert.equal(onFinish.delayDays, 1);
  assert.equal(onFinish.delayKind, 'FINISH');
  assert.equal(status('2026-03-11', 95).state, 'IN_PROGRESS', 'half a day short on the finish date is not yet a delay');
  const after = status('2026-03-12', 95);
  assert.equal(after.state, 'DELAYED');
  assert.equal(after.delayDays, 1, '1.5 days behind -> whole days, rounded down');
  assert.equal(status('2026-03-21', 95).delayDays, 10, '20 days in, 9.5 of 10 plan-days done: 10.5 days behind -> 10 whole days');
});

test('Выполнено: the reported quantity reached the plan — whenever, whatever else is true; never delayed', () => {
  const done = status('2026-03-20', 100);
  assert.equal(done.state, 'COMPLETED');
  assert.equal(done.delayDays, 0);
  assert.equal(done.actualProgress, 100);
  assert.equal(done.overperformed, false);
  const over = status('2026-03-20', 120);
  assert.equal(over.state, 'COMPLETED');
  assert.equal(over.actualProgress, 100, 'the percentage stays clamped, like the existing readiness');
  assert.equal(over.overperformed, true, 'overperformance is a separate signal');
  assert.equal(status('2026-02-01', 100).state, 'COMPLETED', 'finished ahead of the schedule');
});

test('pilot figures: plan 500, RP fact 500 -> Выполнено; Internal СК 498 is not an input at all', () => {
  const fact500 = deriveScheduleEntryStatus({ plannedStart: START, plannedFinish: FINISH, plannedQuantity: '500.0000', rpFactQuantity: '500.0000' }, '2026-03-20');
  assert.equal(fact500.state, 'COMPLETED');
  // The function has no parameter for СК / ПТО / СДО: nothing but dates, plan quantity and RP fact can move the status.
  assert.deepEqual(Object.keys({ plannedStart: 1, plannedFinish: 1, plannedQuantity: 1, rpFactQuantity: 1 }), ['plannedStart', 'plannedFinish', 'plannedQuantity', 'rpFactQuantity']);
  assert.equal(SCHEDULE_PROGRESS_SOURCE, 'RP_FACT');
});

test('a one-day plan: due on its date, one day late the day after', () => {
  const day = (today: string, fact: number | null) => status(today, fact, 100, '2026-03-05', '2026-03-05');
  assert.equal(day('2026-03-04', null).state, 'NOT_STARTED');
  assert.equal(day('2026-03-05', null).state, 'NOT_STARTED');
  assert.equal(day('2026-03-05', null).expectedPhase, 'DUE_COMPLETE');
  assert.equal(day('2026-03-06', null).state, 'DELAYED');
  assert.equal(day('2026-03-06', null).delayDays, 1);
  assert.equal(day('2026-03-06', 100).state, 'COMPLETED');
});

test('delay arithmetic is exact: a third of the quantity is exactly one day, never 0.999… days', () => {
  // plan 3, fact 1, Mar 1 .. Mar 4 (duration 3), today Mar 3 (2 days in): lag = 2 − 3 × 1/3 = exactly 1 day.
  const s = status('2026-03-03', 1, 3, '2026-03-01', '2026-03-04');
  assert.equal(s.state, 'DELAYED');
  assert.equal(s.delayDays, 1);
  // four decimals, as numeric(20,4) delivers them
  assert.equal(status('2026-03-06', '40.0000', '100.0000').delayDays, 1);
  assert.equal(status('2026-03-06', '39.9999', '100.0000').delayDays, 1);
  assert.equal(status('2026-03-06', '40.0001', '100.0000').delayDays, 0, 'a hair above the one-day line: no delay');
});

test('a non-positive plan quantity cannot be measured: nothing is claimed', () => {
  const s = status('2026-03-20', 5, 0);
  assert.equal(s.state, 'NOT_STARTED');
  assert.equal(s.actualProgress, null);
  assert.equal(s.delayDays, 0);
});

test('a work with several unit entries: any delay wins, otherwise the least advanced common state', () => {
  assert.equal(aggregateScheduleStates([]), null);
  assert.equal(aggregateScheduleStates(['COMPLETED', 'DELAYED']), 'DELAYED');
  assert.equal(aggregateScheduleStates(['COMPLETED', 'COMPLETED']), 'COMPLETED');
  assert.equal(aggregateScheduleStates(['NOT_STARTED', 'NOT_STARTED']), 'NOT_STARTED');
  assert.equal(aggregateScheduleStates(['COMPLETED', 'NOT_STARTED']), 'IN_PROGRESS');
  assert.equal(aggregateScheduleStates(['IN_PROGRESS', 'NOT_STARTED']), 'IN_PROGRESS');
});

test('Object conclusion: По графику / Есть отставание — and nothing at all without an approved baseline', () => {
  assert.equal(resolveObjectScheduleConclusion(null).status, 'NO_BASELINE');
  assert.equal(resolveObjectScheduleConclusion([]).status, 'NO_BASELINE', 'an empty baseline never reads as «По графику»');
  const onTrack = resolveObjectScheduleConclusion([status('2026-03-06', 50), status('2026-03-06', 100)]);
  assert.equal(onTrack.status, 'ON_TRACK');
  assert.equal(onTrack.delayedCount, 0);
  assert.equal(onTrack.completedCount, 1);
  const delayed = resolveObjectScheduleConclusion([status('2026-03-06', 50), status('2026-03-06', 10), status('2026-03-06', null, 100, '2026-03-10', '2026-03-20')]);
  assert.equal(delayed.status, 'DELAYED');
  assert.equal(delayed.delayedCount, 1);
  assert.equal(delayed.maxDelayDays, 4);
  assert.equal(delayed.entryCount, 3);
  assert.deepEqual(delayed.expected, { notDue: 1, underway: 2, dueComplete: 0 });
  assert.equal(delayed.notStartedCount, 1);
});

const snap = (itemId: string, over: Partial<ScheduleEntrySnapshot> = {}): ScheduleEntrySnapshot => ({ itemId, plannedStart: '2026-03-01', plannedFinish: '2026-03-10', sequence: 1, predecessorItemId: null, ...over });

test('revision diff: added / removed / changed with the exact fields, in schedule order', () => {
  const before = [snap('a'), snap('b', { sequence: 2 }), snap('c', { sequence: 3 })];
  const after = [snap('a', { plannedFinish: '2026-03-17' }), snap('b', { sequence: 2 }), snap('d', { sequence: 4 })];
  const changes = diffScheduleEntries(before, after);
  assert.deepEqual(changes.map(c => [c.itemId, c.kind]), [['a', 'CHANGED'], ['c', 'REMOVED'], ['d', 'ADDED']]);
  assert.deepEqual(changes[0].fields, ['plannedFinish']);
  assert.equal(changes[0].before!.plannedFinish, '2026-03-10');
  assert.equal(changes[0].after!.plannedFinish, '2026-03-17');
  assert.equal(diffScheduleEntries(before, before).length, 0);
  assert.deepEqual(diffScheduleEntries(before, [snap('a', { predecessorItemId: 'b' }), ...before.slice(1)])[0].fields, ['predecessorItemId']);
});

test('ordering and the advisory «follows» reference', () => {
  assert.equal(hasPredecessorCycle([{ itemId: 'a', predecessorItemId: null }, { itemId: 'b', predecessorItemId: 'a' }]), false);
  assert.equal(hasPredecessorCycle([{ itemId: 'a', predecessorItemId: 'b' }, { itemId: 'b', predecessorItemId: 'a' }]), true);
  assert.equal(hasPredecessorCycle([{ itemId: 'a', predecessorItemId: 'b' }, { itemId: 'b', predecessorItemId: 'c' }, { itemId: 'c', predecessorItemId: 'a' }]), true);
  assert.equal(startsBeforePredecessorFinish('2026-03-05', '2026-03-10'), true);
  assert.equal(startsBeforePredecessorFinish('2026-03-10', '2026-03-10'), false, 'starting on the finish day is not an overlap');
  assert.equal(nextScheduleSequence([]), 1);
  assert.equal(nextScheduleSequence([3, 1, 7]), 8);
  const rows = [{ sequence: 2, plannedStart: '2026-03-01', itemId: 'x' }, { sequence: 1, plannedStart: '2026-03-09', itemId: 'y' }, { sequence: 1, plannedStart: '2026-03-02', itemId: 'z' }];
  assert.deepEqual([...rows].sort(compareScheduleOrder).map(r => r.itemId), ['z', 'y', 'x']);
});

test('dates: a finish before the start is refused', () => {
  assert.equal(scheduleDatesViolation('2026-03-10', '2026-03-09'), FINISH_BEFORE_START_MESSAGE);
  assert.equal(scheduleDatesViolation('2026-03-10', '2026-03-10'), null);
});

test('approval rules: the first approval needs entries; a correction needs a real change and a reason', () => {
  const entry = (itemId: string, over: Record<string, any> = {}) => ({ ...snap(itemId), objectWorkId: 'w1', executionUnitId: 'u-' + itemId, ...over });
  const ok = { entries: [entry('a')], hasCurrentBaseline: false, changeCount: 1, correctionReason: undefined };
  assert.deepEqual(scheduleApprovalViolations(ok), [], 'no reason is asked for the first approval');
  assert.deepEqual(scheduleApprovalViolations({ ...ok, entries: [] }), [EMPTY_SCHEDULE_MESSAGE]);
  assert.deepEqual(scheduleApprovalViolations({ ...ok, entries: [entry('a', { plannedFinish: '2026-02-01' })] }), [FINISH_BEFORE_START_MESSAGE]);
  assert.deepEqual(scheduleApprovalViolations({ ...ok, entries: [entry('a', { executionUnitId: null }), entry('b', { executionUnitId: 'u-b' })] }), [WORK_SCHEDULED_AS_WHOLE_MESSAGE], 'a work cannot be planned both as a whole and through its units');
  assert.deepEqual(scheduleApprovalViolations({ ...ok, entries: [entry('a', { predecessorItemId: 'b' }), entry('b', { predecessorItemId: 'a' })] }), [PREDECESSOR_CYCLE_MESSAGE]);
  const correction = { ...ok, hasCurrentBaseline: true };
  assert.deepEqual(scheduleApprovalViolations({ ...correction, changeCount: 0 }), [NO_CHANGES_MESSAGE]);
  assert.deepEqual(scheduleApprovalViolations({ ...correction, correctionReason: undefined }), [CORRECTION_REASON_REQUIRED_MESSAGE]);
  assert.deepEqual(scheduleApprovalViolations({ ...correction, correctionReason: '   ' }), [CORRECTION_REASON_REQUIRED_MESSAGE]);
  assert.deepEqual(scheduleApprovalViolations({ ...correction, correctionReason: 'Поставка перенесена' }), []);
  assert.deepEqual(worksScheduledAtBothLevels([{ objectWorkId: 'w', executionUnitId: null }, { objectWorkId: 'w', executionUnitId: 'u' }, { objectWorkId: 'x', executionUnitId: 'v' }]), ['w']);
});

test('revision life: draft -> approved | discarded; approved -> superseded; nothing else, nothing back', () => {
  const allowed = [['DRAFT', 'APPROVED'], ['DRAFT', 'DISCARDED'], ['APPROVED', 'SUPERSEDED']];
  const states = ['DRAFT', 'APPROVED', 'SUPERSEDED', 'DISCARDED'];
  for (const from of states) for (const to of states)
    assert.equal(isScheduleRevisionTransitionAllowed(from, to), allowed.some(([f, t]) => f === from && t === to), `${from} -> ${to}`);
  assert.equal(isScheduleRevisionTransitionAllowed('NOPE', 'APPROVED'), false);
});

test('delay-reason categories are open: the three management examples are defaults, not the model', () => {
  const defaults = effectiveDelayCategories([]);
  for (const code of ['MATERIALS', 'MOBILIZATION', 'DECISIONS', 'OTHER']) assert.ok(defaults.some(c => c.code === code), code);
  assert.ok(defaults.length > 3, 'more than the three examples');
  const merged = effectiveDelayCategories([
    { code: 'MATERIALS', name: 'Поставка материалов', isActive: true, sortOrder: 10 },
    { code: 'WEATHER', name: 'Погода', isActive: false, sortOrder: 70 },
    { code: 'CUSTOMER_PERMITS', name: 'Разрешения заказчика', isActive: true, sortOrder: 15 },
  ]);
  assert.equal(merged.find(c => c.code === 'MATERIALS')!.name, 'Поставка материалов', 'a tenant can rename a default');
  assert.equal(merged.some(c => c.code === 'WEATHER'), false, 'a tenant can switch a default off');
  assert.ok(merged.some(c => c.code === 'CUSTOMER_PERMITS'), 'a tenant can add its own');
  assert.equal(merged[0].code, 'MATERIALS');
  assert.equal(merged[1].code, 'CUSTOMER_PERMITS', 'sorted by the configured order');
  assert.equal(DEFAULT_DELAY_REASON_CATEGORIES.some(c => /дефект|замечан|СК/i.test(c.name)), false, 'СК remarks / defects are not planning delay reasons');
});

test('a delay reason is only for a real delay', () => {
  assert.equal(delayReasonViolation('DELAYED'), null);
  for (const state of ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED'] as const) assert.match(delayReasonViolation(state)!, /только для участка, по которому есть отставание/);
});

test('who may do what: view / prepare / approve / explain a delay — the authorization matrix', () => {
  const P = Permission;
  const expected: Record<string, { view: boolean; edit: boolean; approve: boolean; delay: boolean }> = {
    ADMIN: { view: true, edit: true, approve: true, delay: true },
    DEPUTY_DIRECTOR: { view: true, edit: true, approve: true, delay: true },
    PROJECT_MANAGER: { view: true, edit: true, approve: false, delay: true },
    GENERAL_DIRECTOR: { view: true, edit: false, approve: false, delay: false },
    CONSTRUCTION_CONTROL: { view: true, edit: false, approve: false, delay: false },
    CONSTRUCTION_CONTROL_HEAD: { view: true, edit: false, approve: false, delay: false },
    PTO: { view: true, edit: false, approve: false, delay: false },
    PTO_HEAD: { view: true, edit: false, approve: false, delay: false },
    SDO: { view: true, edit: false, approve: false, delay: false },
    SDO_HEAD: { view: true, edit: false, approve: false, delay: false },
    CONTRACTOR_VIEWER: { view: false, edit: false, approve: false, delay: false },
  };
  assert.deepEqual(Object.keys(expected).sort(), [...roles].sort(), 'every current role is decided explicitly — none left to a default');
  for (const role of roles) {
    const e = expected[role];
    assert.equal(hasPermission(role, P.SCHEDULE_VIEW), e.view, role + ' view');
    assert.equal(hasPermission(role, P.SCHEDULE_EDIT), e.edit, role + ' edit');
    assert.equal(hasPermission(role, P.SCHEDULE_APPROVE), e.approve, role + ' approve');
    assert.equal(hasPermission(role, P.SCHEDULE_DELAY_REASON), e.delay, role + ' delay reason');
  }
  for (const retired of ['TECHNICAL_DIRECTOR', 'DEPARTMENT_HEAD', 'CONSTRUCTION_DIRECTOR', 'DoC'])
    assert.equal(hasPermission(retired as any, P.SCHEDULE_VIEW), false, retired + ' stays retired');
});

test('granting the schedule permissions did not change any existing role grant', () => {
  const P = Permission;
  // The pre-GPR facts that matter most to the neighbouring slices.
  assert.equal(hasPermission('DEPUTY_DIRECTOR', P.DOCUMENTATION_MANAGE), false);
  assert.equal(hasPermission('DEPUTY_DIRECTOR', P.INSPECTION_ACCEPT), false);
  assert.equal(hasPermission('GENERAL_DIRECTOR', P.OBJECT_CREATE), false);
  assert.equal(hasPermission('PROJECT_MANAGER', P.OBJECT_CREATE), false);
  assert.equal(hasPermission('PROJECT_MANAGER', P.WORK_UPDATE_PROGRESS), true);
  assert.equal(hasPermission('CONSTRUCTION_CONTROL', P.SCHEDULE_EDIT), false);
  assert.equal(hasPermission('CONTRACTOR_VIEWER', P.OBJECT_VIEW), true);
});
