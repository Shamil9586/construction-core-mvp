import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Gantt, ganttLayout, type GanttTask } from '../apps/frontend/src/Gantt';

// R04 CP01 — the legacy object Gantt with Early Works whose provisional dates are NULL.
const task = (id: string, plannedStartDate: string | null, plannedFinishDate: string | null, extra: Partial<GanttTask> = {}): GanttTask =>
    ({ id, name: 'Работа ' + id, plannedStartDate, plannedFinishDate, actualProgress: null, plannedProgress: null, scheduleStatus: 'GRAY', ...extra });
const NOW = new Date('2026-03-16T00:00:00Z');
const dated = [task('a', '2026-03-01', '2026-03-31', { scheduleStatus: 'GREEN', actualProgress: 50, plannedProgress: 50 }), task('b', '2026-03-11', '2026-04-30', { scheduleStatus: 'RED' })];
const render = (tasks: GanttTask[]) => renderToStaticMarkup(React.createElement(Gantt, { tasks }));
const finite = (html: string) => { assert.doesNotMatch(html, /NaN|Infinity|Invalid Date|undefined%/); };

test('CP01-0 the component itself renders a mixed list with NULL planned dates without throwing', () => {
    const html = render([...dated, task('none', null, null), task('start', '2026-03-05', null)]);
    finite(html);
    assert.equal((html.match(/gantt-bar-chip/g) ?? []).length, 2);
    assert.match(html, /Работа none/);
});

test('CP01-1 dated works only: the layout is unchanged from the pre-R04 arithmetic', () => {
    const { rows, todayOffsetPct } = ganttLayout(dated, NOW);
    // range 2026-03-01 .. 2026-04-30 = 60 days; a: offset max(1,0)=1 day, width 30 days; b: offset 10 days, width 50 days; today: 15 days
    assert.deepEqual(rows.map(r => r.kind === 'interval' ? [r.task.id, +r.offsetPct.toFixed(4), +r.widthPct.toFixed(4)] : [r.task.id, r.kind]), [['a', 1.6667, 50], ['b', 16.6667, 83.3333]]);
    assert.equal(+todayOffsetPct!.toFixed(4), 25);
});

test('CP01-2 both NULL, only start, only finish and unparsable dates: listed without an interval and without moving the axis', () => {
    const mixed = [...dated, task('none', null, null), task('start', '2026-01-01', null), task('finish', null, '2027-12-31'), task('bad', 'not-a-date', '2026-04-01')];
    const { rows, todayOffsetPct } = ganttLayout(mixed, NOW);
    assert.deepEqual(rows.map(r => [r.task.id, r.kind]), [['a', 'interval'], ['b', 'interval'], ['none', 'undated'], ['start', 'undated'], ['finish', 'undated'], ['bad', 'undated']]);
    const same = ganttLayout(dated, NOW);
    assert.deepEqual(rows.filter(r => r.kind === 'interval'), same.rows, 'a lone start (2026-01-01) or finish (2027-12-31) does not stretch the axis');
    assert.equal(todayOffsetPct, same.todayOffsetPct);
    const html = render(mixed);
    finite(html);
    assert.equal((html.match(/gantt-bar-chip/g) ?? []).length, 2, 'bars only for the two complete intervals');
    assert.equal((html.match(/Даты не определены/g) ?? []).length, 4);
    assert.match(html, /class="today"/);
});

test('CP01-3 every work without dates: no axis, no "today" marker, no bar, no schedule colour — and no crash', () => {
    const none = [task('x', null, null, { actualProgress: 20 }), task('y', null, null)];
    assert.deepEqual(ganttLayout(none, NOW), { rows: none.map(t => ({ kind: 'undated', task: t })), todayOffsetPct: null });
    const html = render(none);
    finite(html);
    assert.doesNotMatch(html, /gantt-bar-chip|class="today"/);
    for (const colour of ['#279b82', '#dcb555', '#db655d', '#a5aeb6']) assert.ok(!html.includes(colour), 'no status colour ' + colour);
    assert.equal((html.match(/Даты не определены/g) ?? []).length, 2);
    assert.match(html, /Работа x/);
});

test('CP01-4 an empty list keeps its existing message', () => {
    assert.match(render([]), /Нет работ для отображения графика/);
});

test('CP01-5 the layout never derives a date from the clock: rows and positions of dated works do not depend on "now"', () => {
    const mixed = [...dated, task('none', null, null)];
    const early = ganttLayout(mixed, new Date('2020-01-01T00:00:00Z')), late = ganttLayout(mixed, new Date('2030-01-01T00:00:00Z'));
    assert.deepEqual(early.rows, late.rows);
    // only the marker moves, clamped to the axis; the pre-existing one-day minimum of daysBetween() is kept as it was (1 of 60 days)
    assert.deepEqual([early.todayOffsetPct, late.todayOffsetPct], [100 / 60, 100]);
});
