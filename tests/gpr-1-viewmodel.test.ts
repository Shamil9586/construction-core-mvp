import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildGprViewModel, buildO01ScheduleView, buildW01ScheduleView, describeChange, formatDays, objectScheduleStatusPresentation,
  scheduleEntryStatePresentation, delayKindText,
} from '../apps/frontend/src/view-models/schedule';
import { isObjectSchedule, isWorkSchedule } from '../apps/frontend/src/data/scheduleApi';
import { afterFailure, initialScheduleState, keepForSameKey, loadFor, type ScheduleState } from '../apps/frontend/src/app/scheduleLoadState';
import type { ObjectSchedule, ScheduleAccess, ScheduleEntry, ScheduleLoad, WorkSchedule } from '../apps/frontend/src/types/schedule';

/**
 * GPR-1 — the frontend data chain: what the three consumers (the Object's schedule screen, O01's «Состояние графика», W01's summary) make of
 * the schedule API. Pure functions over a typed fixture shaped exactly like `GET /objects/:id/schedule` — no network, no DOM.
 */
const OBJECT = '11111111-1111-4111-8111-111111111111', WORK = '22222222-2222-4222-8222-222222222222';
const access = (over: Partial<ScheduleAccess> = {}): ScheduleAccess => ({ canEdit: false, canApprove: false, canRecordDelayReason: false, canCreateDraft: false, canManageCategories: false, ...over });

function entry(over: Partial<ScheduleEntry> & { itemId: string }): ScheduleEntry {
  return {
    entryId: 'e-' + over.itemId, revisionId: 'r1', sequence: 1, objectWorkId: WORK, workName: 'Штукатурка стен', executionUnitId: 'u-' + over.itemId, zone: '1 этаж', finishType: null, conditions: null,
    contractorId: 'c1', executor: 'ООО «Монолит»', unit: 'м²', plannedQuantity: '500.0000', plannedStart: '2026-03-01', plannedFinish: '2026-03-11',
    predecessorItemId: null, predecessorLabel: null, followsPredecessor: null, rpFactQuantity: '250.0000', internalScAcceptedQuantity: null,
    plannedProgress: 50, actualProgress: 50, factReported: true, overperformed: false, expectedPhase: 'UNDERWAY', state: 'IN_PROGRESS', delayDays: 0, delayKind: null,
    baselineShift: null, workNowHasUnits: false, delayReasons: [], ...over,
  };
}

function schedule(over: Partial<ObjectSchedule> = {}): ObjectSchedule {
  const entries = over.entries ?? [entry({ itemId: 'a' })];
  return {
    objectId: OBJECT, objectName: 'Тест после удаления ролей', asOf: '2026-03-06', progressSource: 'RP_FACT', access: access(), hasDraft: false,
    current: { revisionId: 'r1', revisionNo: 1, approvedAt: '2026-02-20T09:00:00.000Z', approvedByName: 'Виктор Соловьёв', approvalComment: null, correctionReason: null, basedOnRevisionNo: null },
    conclusion: { status: 'ON_TRACK', entryCount: entries.length, delayedCount: 0, maxDelayDays: 0, completedCount: 0, inProgressCount: 1, notStartedCount: 0, expected: { notDue: 0, underway: 1, dueComplete: 0 }, unscheduledCount: 0, openDelayReasonCount: 0 },
    entries, unscheduled: [], draft: null, availableScopes: [], history: [], delayReasonCategories: [{ code: 'MATERIALS', name: 'Материалы' }, { code: 'OTHER', name: 'Другое' }], ...over,
  };
}
const loaded = <T>(value: T): ScheduleLoad<T> => ({ status: 'Loaded', value });

test('delay is counted in Russian calendar days', () => {
  const cases: [number, string][] = [[1, '1 день'], [2, '2 дня'], [4, '4 дня'], [5, '5 дней'], [11, '11 дней'], [12, '12 дней'], [14, '14 дней'], [21, '21 день'], [22, '22 дня'], [25, '25 дней'], [101, '101 день'], [111, '111 дней'], [112, '112 дней']];
  for (const [n, text] of cases) assert.equal(formatDays(n), text);
});

test('the four management states and the object conclusion keep the existing terminology — and a missing baseline never reads as «По графику»', () => {
  assert.deepEqual(scheduleEntryStatePresentation('NOT_STARTED'), { variant: 'Neutral', label: 'Не начато' });
  assert.deepEqual(scheduleEntryStatePresentation('IN_PROGRESS'), { variant: 'OnTrack', label: 'В работе' });
  assert.deepEqual(scheduleEntryStatePresentation('COMPLETED'), { variant: 'OnTrack', label: 'Выполнено' });
  assert.deepEqual(scheduleEntryStatePresentation('DELAYED'), { variant: 'Delayed', label: 'Есть отставание' });
  assert.deepEqual(objectScheduleStatusPresentation('ON_TRACK'), { variant: 'OnTrack', label: 'По графику' });
  assert.deepEqual(objectScheduleStatusPresentation('DELAYED'), { variant: 'Delayed', label: 'Есть отставание' });
  assert.deepEqual(objectScheduleStatusPresentation('NO_BASELINE'), { variant: 'Neutral', label: 'График не утверждён' });
  assert.equal(delayKindText('START'), 'Работа не начата в срок');
  assert.equal(delayKindText(null), null);
});

test('a row presents the backend\'s figures as they are: plan and fact side by side, СК separate, «—» for nothing reported', () => {
  const reported = entry({ itemId: 'a', internalScAcceptedQuantity: '498.0000', rpFactQuantity: '500.0000', actualProgress: 100, state: 'COMPLETED', plannedProgress: 100 });
  const none = entry({ itemId: 'b', sequence: 2, zone: '2 этаж', rpFactQuantity: null, factReported: false, actualProgress: 0, plannedProgress: 0, state: 'NOT_STARTED', expectedPhase: 'NOT_DUE' });
  const zero = entry({ itemId: 'c', sequence: 3, rpFactQuantity: '0.0000', factReported: true, actualProgress: 0, state: 'DELAYED', delayDays: 5, delayKind: 'START' });
  const vm = buildGprViewModel(schedule({ entries: [reported, none, zero], access: access({ canRecordDelayReason: true }) }));
  const [a, b, c] = vm.rows;

  assert.equal(a.name, 'Штукатурка стен'); assert.equal(a.zone, '1 этаж'); assert.equal(a.executor, 'ООО «Монолит»');
  assert.equal(a.plan, '500 м²'); assert.equal(a.plannedStart, '01.03.2026'); assert.equal(a.plannedFinish, '11.03.2026');
  assert.equal(a.fact, '500 м²'); assert.equal(a.progress.formatted, '100%'); assert.equal(a.planOnDate, '100%');
  assert.equal(a.scAccepted, '498 м²', 'Internal СК 498 is its own figure beside the RP fact 500');
  assert.notEqual(a.fact, a.scAccepted);
  assert.equal(a.state.label, 'Выполнено'); assert.equal(a.needsAttention, false); assert.equal(a.delay, null);

  assert.equal(b.fact, '—', 'nothing reported is a dash, never a confident zero');
  assert.equal(b.progress.formatted, '—'); assert.equal(b.progress.value, null);
  assert.equal(b.state.label, 'Не начато'); assert.equal(b.scAccepted, null);

  assert.equal(c.fact, '0 м²', 'a reported zero IS a zero');
  assert.equal(c.progress.formatted, '0%');
  assert.equal(c.state.label, 'Есть отставание'); assert.equal(c.needsAttention, true);
  assert.equal(c.delay, '5 дней'); assert.equal(c.delayNote, 'Работа не начата в срок');
  assert.equal(c.canRecordReason, true, 'the viewer may explain a real delay');
  assert.equal(a.canRecordReason, false, 'but not a completed scope');
  assert.equal(buildGprViewModel(schedule({ entries: [zero], access: access() })).rows[0].canRecordReason, false, 'nor without the permission');
  // closing an OPEN reason is not tied to the entry still being late: a zone that has caught up must let its explanation be closed
  assert.equal(a.canResolveReason, true, 'a completed scope\'s old explanation can still be closed');
  assert.equal(b.canResolveReason, true);
  assert.equal(buildGprViewModel(schedule({ entries: [zero], access: access() })).rows[0].canResolveReason, false, 'but never without the permission');
  // never a percentage-points figure, never a difference of two percentages
  assert.equal(JSON.stringify(vm).includes('п.п.'), false);
});

test('the conclusion card and the calendar\'s answers for the day', () => {
  const delayedEntry = entry({ itemId: 'a', state: 'DELAYED', delayDays: 3, delayKind: 'PROGRESS', actualProgress: 50, plannedProgress: 80 });
  const vm = buildGprViewModel(schedule({
    entries: [delayedEntry],
    conclusion: { status: 'DELAYED', entryCount: 4, delayedCount: 1, maxDelayDays: 3, completedCount: 1, inProgressCount: 1, notStartedCount: 1, expected: { notDue: 1, underway: 2, dueComplete: 1 }, unscheduledCount: 0, openDelayReasonCount: 0 },
  }));
  assert.deepEqual(vm.conclusion.presentation, { variant: 'Delayed', label: 'Есть отставание' });
  assert.match(vm.conclusion.text, /Отстают позиции графика: 1 из 4\. Наибольшее отставание — 3 дня\./);
  assert.deepEqual(vm.expectation.map(i => [i.label, i.value]), [['Должно было начаться', '3'], ['Должно идти', '2'], ['Должно быть завершено', '1'], ['Есть отставание', '1']]);
  assert.deepEqual(vm.baseline!.lines, ['Утверждён: 20.02.2026, Виктор Соловьёв']);
  assert.equal(vm.baseline!.title, 'Утверждённый график — версия №1');

  const none = buildGprViewModel(schedule({ current: null, entries: [], conclusion: { status: 'NO_BASELINE', entryCount: 0, delayedCount: 0, maxDelayDays: 0, completedCount: 0, inProgressCount: 0, notStartedCount: 0, expected: { notDue: 0, underway: 0, dueComplete: 0 }, unscheduledCount: 0, openDelayReasonCount: 0 } }));
  assert.equal(none.conclusion.presentation.label, 'График не утверждён');
  assert.equal(none.baseline, null);
  assert.deepEqual(none.expectation, [], 'no calendar answers are invented without a baseline');
  assert.match(none.conclusion.text, /сроки не контролируются/);
});

test('a correction is shown with its provenance and the shift it made', () => {
  const moved = entry({ itemId: 'a', plannedFinish: '2026-03-18', baselineShift: { startDays: 0, finishDays: 7 } });
  const vm = buildGprViewModel(schedule({
    entries: [moved],
    current: { revisionId: 'r2', revisionNo: 2, approvedAt: '2026-03-02T09:00:00.000Z', approvedByName: 'Виктор Соловьёв', approvalComment: 'Согласовано', correctionReason: 'Поставка смеси сдвинута', basedOnRevisionNo: 1 },
  }));
  assert.deepEqual(vm.baseline!.lines, ['Утверждён: 02.03.2026, Виктор Соловьёв', 'Корректировка версии №1', 'Причина корректировки: Поставка смеси сдвинута', 'Комментарий: Согласовано']);
  assert.equal(vm.rows[0].shift, 'Относительно первого графика: окончание +7 дн.', 'a correction cannot hide itself');
  const back = buildGprViewModel(schedule({ entries: [entry({ itemId: 'a', baselineShift: { startDays: -2, finishDays: 0 } })] }));
  assert.equal(back.rows[0].shift, 'Относительно первого графика: начало −2 дн.');
});

test('delay reasons: category, comment, who recorded them and when, about whom, evidence, open / resolved', () => {
  const reason = (over: Record<string, unknown>) => ({
    id: 'r', itemId: 'a', categoryCode: 'MATERIALS', categoryName: 'Материалы', comment: 'Смесь задерживается', responsibleUserId: null, responsibleUserName: null, responsibleContractorId: null, responsibleContractorName: null,
    delayDaysAtRecord: 4, recordedByName: 'Сергей Павлов', recordedAt: '2026-03-05T10:00:00.000Z', status: 'OPEN' as const, resolvedByName: null, resolvedAt: null, resolutionComment: null, version: 1, ...over,
  });
  const vm = buildGprViewModel(schedule({ entries: [entry({ itemId: 'a', state: 'DELAYED', delayDays: 4, delayKind: 'PROGRESS', delayReasons: [
    reason({ id: 'r1', responsibleContractorId: 'c', responsibleContractorName: 'ООО «Монолит»' }),
    reason({ id: 'r2', categoryName: 'Решения', responsibleUserName: 'Виктор Соловьёв', status: 'RESOLVED', resolvedByName: 'Сергей Павлов', resolvedAt: '2026-03-06T10:00:00.000Z', resolutionComment: 'Решение принято' }),
  ] })] }));
  const [open, closed] = vm.rows[0].reasons;
  assert.equal(open.category, 'Материалы'); assert.equal(open.provenance, 'Записал: Сергей Павлов · 05.03.2026');
  assert.equal(open.responsible, 'Ответственный: ООО «Монолит» (подрядчик)'); assert.equal(open.evidence, 'На момент записи отставание — 4 дня');
  assert.equal(open.open, true); assert.equal(open.statusLabel, 'Открыта'); assert.equal(open.resolution, null);
  assert.equal(closed.open, false); assert.equal(closed.responsible, 'Ответственный: Виктор Соловьёв');
  assert.equal(closed.resolution, 'Закрыта: Сергей Павлов · 06.03.2026 — Решение принято');
  assert.equal(vm.rows[0].openReasonCount, 1);
});

test('the draft: dates and order only, the approved dates beside them, and the evidence an approver reads', () => {
  const vm = buildGprViewModel(schedule({
    access: access({ canEdit: true, canApprove: true, canCreateDraft: false }), hasDraft: true,
    availableScopes: [
      { objectWorkId: WORK, workName: 'Штукатурка стен', executionUnitId: 'u2', zone: '2 этаж', finishType: null, conditions: null, contractorId: 'c2', executor: 'ООО «Град»', unit: 'м²', plannedQuantity: '300.0000', suggestedStart: '2026-03-01', suggestedFinish: '2026-04-30' },
      { objectWorkId: 'w9', workName: 'Окна', executionUnitId: null, zone: null, finishType: null, conditions: null, contractorId: 'c3', executor: 'ООО «Окна»', unit: 'шт', plannedQuantity: '10.0000', suggestedStart: '2026-03-01', suggestedFinish: '2026-03-10' },
    ],
    draft: {
      revisionId: 'd2', revisionNo: 2, version: 7, basedOnRevisionNo: 1, createdByName: 'Сергей Павлов', createdAt: '2026-03-03T09:00:00.000Z',
      entries: [{
        entryId: 'e1', itemId: 'a', version: 3, sequence: 1, objectWorkId: WORK, workName: 'Штукатурка стен', executionUnitId: 'u1', zone: '1 этаж', finishType: null, conditions: null, contractorId: 'c1', executor: 'ООО «Монолит»', unit: 'м²', plannedQuantity: '500.0000',
        plannedStart: '2026-03-01', plannedFinish: '2026-03-18', predecessorItemId: null, predecessorLabel: null, followsPredecessor: null, baseline: { plannedStart: '2026-03-01', plannedFinish: '2026-03-11', sequence: 1 }, change: 'CHANGED',
      }],
      changes: [{ itemId: 'a', kind: 'CHANGED', fields: ['plannedFinish'], workName: 'Штукатурка стен', zone: '1 этаж', label: 'Штукатурка стен · 1 этаж', before: { itemId: 'a', plannedStart: '2026-03-01', plannedFinish: '2026-03-11', sequence: 1, predecessorItemId: null }, after: { itemId: 'a', plannedStart: '2026-03-01', plannedFinish: '2026-03-18', sequence: 1, predecessorItemId: null } }],
    },
  }));
  const d = vm.draft!;
  assert.equal(d.title, 'Черновик графика — версия №2'); assert.equal(d.isCorrection, true);
  assert.equal(d.basedOn, 'Корректировка утверждённого графика (версия №1)');
  assert.deepEqual([d.rows[0].start, d.rows[0].finish, d.rows[0].sequence], ['2026-03-01', '2026-03-18', 1], 'raw civil dates for the editing controls');
  assert.equal(d.rows[0].baselineText, 'Утверждено: 01.03.2026 — 11.03.2026'); assert.equal(d.rows[0].change, 'CHANGED');
  assert.deepEqual(d.changes[0].lines, ['Окончание: 11.03.2026 → 18.03.2026']);
  assert.equal(d.version, 7, 'the approver approves exactly this version of the draft');
  assert.deepEqual(vm.availableScopes.map(s => s.label), ['Штукатурка стен · 2 этаж — 300 м²', 'Окна · вся работа — 10 шт']);
  assert.equal(vm.availableScopes[0].unitId, 'u2'); assert.equal(vm.availableScopes[1].unitId, null);
  assert.deepEqual(d.predecessorOptions, [{ value: 'a', label: 'Штукатурка стен · 1 этаж' }]);
  // a first schedule is not a correction
  const first = buildGprViewModel(schedule({ draft: { ...(schedule({ access: access() }).draft ?? { revisionId: 'd1', revisionNo: 1, version: 1, basedOnRevisionNo: null, createdByName: null, createdAt: '2026-03-01T00:00:00Z', entries: [], changes: [] }) }, access: access({ canEdit: true }) }));
  assert.equal(first.draft!.isCorrection, false);
  assert.equal(first.draft!.basedOn, null);
});

test('every kind of change reads as before → after', () => {
  const snap = (over = {}) => ({ itemId: 'a', plannedStart: '2026-03-01', plannedFinish: '2026-03-10', sequence: 1, predecessorItemId: null, ...over });
  const base = { itemId: 'a', fields: [] as never[], workName: 'W', zone: null, label: 'W' };
  assert.deepEqual(describeChange({ ...base, kind: 'ADDED', before: null, after: snap() }), ['Добавлено в график: 01.03.2026 — 10.03.2026']);
  assert.deepEqual(describeChange({ ...base, kind: 'REMOVED', before: snap(), after: null }), ['Убрано из графика (было 01.03.2026 — 10.03.2026)']);
  assert.deepEqual(describeChange({ ...base, kind: 'CHANGED', fields: ['plannedStart', 'plannedFinish', 'sequence', 'predecessorItemId'], before: snap(), after: snap({ plannedStart: '2026-03-02', plannedFinish: '2026-03-12', sequence: 3, predecessorItemId: 'b' }) }), [
    'Начало: 01.03.2026 → 02.03.2026', 'Окончание: 10.03.2026 → 12.03.2026', 'Порядок: 1 → 3', 'Изменена последовательность («следует за»)',
  ]);
});

test('history: newest first, with who approved, why, and what changed', () => {
  const change = { itemId: 'a', kind: 'CHANGED' as const, fields: ['plannedFinish' as const], workName: 'W', zone: '1 этаж', label: 'W · 1 этаж', before: { itemId: 'a', plannedStart: '2026-03-01', plannedFinish: '2026-03-11', sequence: 1, predecessorItemId: null }, after: { itemId: 'a', plannedStart: '2026-03-01', plannedFinish: '2026-03-18', sequence: 1, predecessorItemId: null } };
  const rev = (no: number, status: 'APPROVED' | 'SUPERSEDED', over = {}) => ({ revisionId: 'r' + no, revisionNo: no, status, basedOnRevisionNo: no > 1 ? no - 1 : null, createdByName: 'Сергей Павлов', createdAt: '2026-03-01T00:00:00Z', approvedByName: 'Виктор Соловьёв', approvedAt: '2026-03-0' + no + 'T00:00:00Z', approvalComment: null, correctionReason: null, supersededAt: null, supersededByRevisionNo: null, entryCount: 1, changes: [], ...over });
  const vm = buildGprViewModel(schedule({ history: [rev(1, 'SUPERSEDED', { supersededByRevisionNo: 2 }), rev(2, 'APPROVED', { correctionReason: 'Сдвиг поставки', changes: [change] })] }));
  assert.deepEqual(vm.history.map(h => [h.title, h.statusLabel]), [['Версия №2', 'Действует'], ['Версия №1', 'Заменена версией №2']]);
  assert.equal(vm.history[0].correctionReason, 'Сдвиг поставки');
  assert.deepEqual(vm.history[0].changes[0].lines, ['Окончание: 11.03.2026 → 18.03.2026']);
  assert.match(vm.history[1].provenance, /Утверждена: 01\.03\.2026, Виктор Соловьёв · подготовил: Сергей Павлов/);
});

test('O01: the object\'s production conclusion comes from the schedule — and says nothing it does not know', () => {
  assert.deepEqual(buildO01ScheduleView({ status: 'Loading' }), { kind: 'Loading' });
  assert.deepEqual(buildO01ScheduleView({ status: 'Hidden' }), { kind: 'Hidden' });
  assert.deepEqual(buildO01ScheduleView({ status: 'Error', message: 'нет связи' }), { kind: 'Error', message: 'нет связи' });

  const noBaseline = buildO01ScheduleView(loaded(schedule({ current: null, entries: [], access: access({ canEdit: true }), conclusion: { ...schedule().conclusion, status: 'NO_BASELINE', entryCount: 0 } })));
  assert.equal(noBaseline.kind, 'NoBaseline');
  if (noBaseline.kind === 'NoBaseline') {
    assert.equal(noBaseline.status.label, 'График не утверждён'); assert.notEqual(noBaseline.status.variant, 'OnTrack'); assert.equal(noBaseline.canPrepare, true);
    assert.match(noBaseline.text, /нет — сроки не контролируются/);
  }
  const drafting = buildO01ScheduleView(loaded(schedule({ current: null, entries: [], hasDraft: true, conclusion: { ...schedule().conclusion, status: 'NO_BASELINE', entryCount: 0 } })));
  assert.equal(drafting.kind === 'NoBaseline' && drafting.canPrepare, false);
  assert.match(drafting.kind === 'NoBaseline' ? drafting.text : '', /График готовится/);

  const onTrack = buildO01ScheduleView(loaded(schedule()));
  assert.equal(onTrack.kind, 'Ready');
  if (onTrack.kind === 'Ready') {
    assert.deepEqual(onTrack.status, { variant: 'OnTrack', label: 'По графику' });
    assert.deepEqual(onTrack.delayed, []);
    assert.match(onTrack.baseline, /версия №1 · расчёт на 06\.03\.2026/);
  }

  const mk = (id: string, days: number, reasons: { name: string; status: 'OPEN' | 'RESOLVED' }[]) => entry({ itemId: id, sequence: days, state: 'DELAYED', delayDays: days, delayKind: 'PROGRESS', zone: 'Зона ' + id, delayReasons: reasons.map(r => ({
    id: id + r.name, itemId: id, categoryCode: 'X', categoryName: r.name, comment: 'c', responsibleUserId: null, responsibleUserName: null, responsibleContractorId: null, responsibleContractorName: null, delayDaysAtRecord: days,
    recordedByName: 'a', recordedAt: '2026-03-05T00:00:00Z', status: r.status, resolvedByName: null, resolvedAt: null, resolutionComment: null, version: 1 })) });
  const delayedView = buildO01ScheduleView(loaded(schedule({
    entries: [mk('a', 2, []), mk('b', 9, [{ name: 'Материалы', status: 'OPEN' }, { name: 'Решения', status: 'RESOLVED' }, { name: 'Материалы', status: 'OPEN' }]), mk('c', 5, [{ name: 'Мобилизация', status: 'OPEN' }]), mk('d', 1, [])],
    conclusion: { ...schedule().conclusion, status: 'DELAYED', entryCount: 6, delayedCount: 4, maxDelayDays: 9, unscheduledCount: 2 },
  })));
  assert.equal(delayedView.kind, 'Ready');
  if (delayedView.kind === 'Ready') {
    assert.deepEqual(delayedView.status, { variant: 'Delayed', label: 'Есть отставание' });
    assert.deepEqual(delayedView.delayed.map(d => [d.label, d.delay]), [['Штукатурка стен · Зона b', '9 дней'], ['Штукатурка стен · Зона c', '5 дней'], ['Штукатурка стен · Зона a', '2 дня']], 'the three worst, worst first');
    assert.deepEqual(delayedView.delayed[0].reasons, ['Материалы'], 'only OPEN reasons, each category once');
    assert.deepEqual(delayedView.delayed[1].reasons, ['Мобилизация']);
    assert.deepEqual(delayedView.notes, ['и ещё 1 с отставанием', 'Не включено в график: 2']);
    assert.match(delayedView.text, /Отстают позиции графика: 4 из 6\./);
  }
});

test('W01: the work\'s own summary — start, finish, state, delay — and an honest statement when there is none', () => {
  const work = (over: Partial<WorkSchedule> = {}): WorkSchedule => ({
    objectId: OBJECT, objectWorkId: WORK, asOf: '2026-03-15', progressSource: 'RP_FACT', canOpenObjectSchedule: true, hasBaseline: true, revisionNo: 1,
    summary: { plannedStart: '2026-03-01', plannedFinish: '2026-03-22', state: 'DELAYED', delayDays: 14, entryCount: 2 },
    entries: [entry({ itemId: 'a' }), entry({ itemId: 'b', zone: '2 этаж' })], ...over,
  });
  assert.deepEqual(buildW01ScheduleView({ status: 'Hidden' }), { kind: 'Hidden' });
  assert.deepEqual(buildW01ScheduleView({ status: 'Loading' }), { kind: 'Loading' });
  const ready = buildW01ScheduleView(loaded(work()));
  assert.deepEqual(ready, { kind: 'Ready', canOpenObject: true, plannedStart: '01.03.2026', plannedFinish: '22.03.2026', state: { variant: 'Delayed', label: 'Есть отставание' }, delay: '14 дней', entryCount: 2, zones: '1 этаж, 2 этаж' });
  const done = buildW01ScheduleView(loaded(work({ summary: { plannedStart: '2026-03-01', plannedFinish: '2026-03-22', state: 'COMPLETED', delayDays: 0, entryCount: 2 } })));
  assert.equal(done.kind === 'Ready' && done.delay, null, 'a delay is shown only while there is one');
  assert.equal(buildW01ScheduleView(loaded(work({ hasBaseline: false, revisionNo: null, summary: null, entries: [] }))).kind, 'NoBaseline');
  assert.equal(buildW01ScheduleView(loaded(work({ summary: null, entries: [] }))).kind, 'NotScheduled');
  // the way into the object's schedule is offered only when the backend says it leads somewhere (a handoff-only PTO engineer gets a 403 there)
  const closed = { canOpenObjectSchedule: false };
  const views = [
    buildW01ScheduleView(loaded(work(closed))),
    buildW01ScheduleView(loaded(work({ ...closed, hasBaseline: false, revisionNo: null, summary: null, entries: [] }))),
    buildW01ScheduleView(loaded(work({ ...closed, summary: null, entries: [] }))),
  ];
  assert.deepEqual(views.map((view) => view.kind), ['Ready', 'NoBaseline', 'NotScheduled']);
  for (const view of views) assert.equal('canOpenObject' in view && view.canOpenObject, false);
});

test('API guards: only the documented read model, for the requested object / work, ever reaches a screen', () => {
  const good = schedule();
  assert.equal(isObjectSchedule(good, OBJECT), true);
  assert.equal(isObjectSchedule(good, 'someone-else'), false, 'the schedule of another object');
  assert.equal(isObjectSchedule([], OBJECT), false, 'a proxy / mock answering []');
  assert.equal(isObjectSchedule({}, OBJECT), false);
  assert.equal(isObjectSchedule(null, OBJECT), false);
  assert.equal(isObjectSchedule({ ...good, progressSource: 'INTERNAL_SC' }, OBJECT), false, 'progress provenance is pinned to the RP fact');
  assert.equal(isObjectSchedule({ ...good, asOf: 'вчера' }, OBJECT), false);
  assert.equal(isObjectSchedule({ ...good, access: { canEdit: true } }, OBJECT), false);
  assert.equal(isObjectSchedule({ ...good, conclusion: { ...good.conclusion, status: 'FINE' } }, OBJECT), false);
  assert.equal(isObjectSchedule({ ...good, entries: [{ ...good.entries[0], state: 'GREEN' }] }, OBJECT), false, 'an unknown state is not guessed');
  assert.equal(isObjectSchedule({ ...good, entries: [{ ...good.entries[0], plannedStart: '01.03.2026' }] }, OBJECT), false);
  assert.equal(isObjectSchedule({ ...good, draft: { revisionId: 'x' } }, OBJECT), false);

  const w: WorkSchedule = { objectId: OBJECT, objectWorkId: WORK, asOf: '2026-03-15', progressSource: 'RP_FACT', canOpenObjectSchedule: true, hasBaseline: true, revisionNo: 1, summary: { plannedStart: '2026-03-01', plannedFinish: '2026-03-22', state: 'DELAYED', delayDays: 14, entryCount: 2 }, entries: [entry({ itemId: 'a' })] };
  assert.equal(isWorkSchedule(w, WORK), true);
  assert.equal(isWorkSchedule(w, 'other-work'), false);
  assert.equal(isWorkSchedule({ ...w, summary: null }, WORK), true);
  assert.equal(isWorkSchedule({ ...w, canOpenObjectSchedule: undefined }, WORK), false, 'whether the object\'s schedule is open to this viewer is part of the model');
  assert.equal(isWorkSchedule({ ...w, summary: { ...w.summary, state: 'RED' } }, WORK), false);
  assert.equal(isWorkSchedule([], WORK), false);
});

test('the schedule\'s frontend never reaches documentation / СК / money and never invents a percentage-points gap', () => {
  const files = [
    'apps/frontend/src/view-models/schedule.ts', 'apps/frontend/src/data/scheduleApi.ts', 'apps/frontend/src/types/schedule.ts', 'apps/frontend/src/app/useSchedule.ts',
    'apps/frontend/src/app/routes/ScheduleRoute.tsx', 'apps/frontend/src/screens/W01/ScheduleSection.tsx', 'apps/frontend/src/screens/O01/ScheduleConclusion.tsx',
    ...fs.readdirSync('apps/frontend/src/screens/GPR').filter(f => /\.(ts|tsx)$/.test(f)).map(f => 'apps/frontend/src/screens/GPR/' + f),
  ];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const forbidden of ['documentationPackage', 'sdoClosing', 'estimatedCost', 'contractValue', 'financial', 'п.п.', 'healthStatus', 'scheduleStatus'])
      assert.equal(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').includes(forbidden), false, `${f} must not use ${forbidden}`);
  }
});

test('a schedule is shown only for the object / work it was fetched for: a key change never paints the previous plan', () => {
  const plan = loaded(schedule());
  const forA: ScheduleState<ObjectSchedule> = { key: 'A', load: plan };
  // the same object refreshing keeps its table on screen
  assert.equal(keepForSameKey(forA, 'A'), forA);
  // stepping from object A straight to object B (history reuses the route element): B starts from Loading, A's plan is gone
  assert.deepEqual(keepForSameKey(forA, 'B'), { key: 'B', load: { status: 'Loading' } });
  assert.deepEqual(loadFor(forA, 'B'), { status: 'Loading' }, 'even before the effect runs, the screen is not handed A\'s plan');
  assert.equal(loadFor(forA, 'A'), plan);
  // a failed refresh of the same key keeps the last good plan; a failure for a new key is stated, never covered by the old plan
  assert.equal(afterFailure(forA, 'A', 'сеть'), forA);
  assert.deepEqual(afterFailure(forA, 'B', 'сеть'), { key: 'B', load: { status: 'Error', message: 'сеть' } });
  assert.deepEqual(afterFailure({ key: 'A', load: { status: 'Loading' } }, 'A', 'сеть'), { key: 'A', load: { status: 'Error', message: 'сеть' } });
  // nothing is fetched without a real session or a key: the block is simply absent, not "loading" forever
  assert.deepEqual(initialScheduleState('A', false), { key: 'A', load: { status: 'Hidden' } });
  assert.deepEqual(initialScheduleState(undefined, true), { key: undefined, load: { status: 'Hidden' } });
  assert.deepEqual(initialScheduleState('A', true), { key: 'A', load: { status: 'Loading' } });
});
