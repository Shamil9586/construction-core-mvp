import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { calendarVersion, FIVE_DAY_WEEK, SIX_DAY_WEEK, countWorkingDays, isWorkingDay, nextWorkingDay, previousWorkingDay, addWorkingDays, plannedQuantityThrough, evaluatedThroughLocalDate, normalizeElapsed, elapsedRelease } from '../packages/domain/working-calendar';

test('R10 frozen 5/6/custom calendars, inclusivity, overrides, leap and year boundary', () => {
    const exceptions = { '2028-02-29': { working: false, reason: 'object closure' }, '2028-03-04': { working: true, reason: 'replacement Saturday' } };
    const v = calendarVersion('v1', 'Europe/Moscow', FIVE_DAY_WEEK, exceptions);
    exceptions['2028-02-29'].working = true;
    assert.equal(isWorkingDay(v, '2028-02-29'), false);
    assert.equal(isWorkingDay(v, '2028-03-04'), true);
    assert.equal(countWorkingDays(v, '2028-02-28', '2028-03-05'), 5);
    assert.equal(nextWorkingDay(v, '2028-02-29'), '2028-03-01');
    assert.equal(previousWorkingDay(v, '2028-02-29'), '2028-02-28');
    assert.equal(addWorkingDays(v, '2028-02-28', 2), '2028-03-02');
    assert.equal(addWorkingDays(v, '2028-03-02', -2), '2028-02-28');
    assert.equal(countWorkingDays(calendarVersion('v2','UTC',SIX_DAY_WEEK), '2026-12-31','2027-01-02'), 3);
    assert.equal(countWorkingDays(calendarVersion('custom','UTC',[false,true,false,false,false,false,false]), '2026-11-02','2026-11-02'), 0);
    assert.throws(() => plannedQuantityThrough(v, '2028-03-05','2028-03-05','2028-03-05','10'));
    assert.throws(() => calendarVersion('bad','Invalid/Zone', FIVE_DAY_WEEK));
});

test('R10 uniform plan and old approved version remain pinned', () => {
    const original = calendarVersion('approved','UTC',FIVE_DAY_WEEK);
    const revised = calendarVersion('draft','UTC',SIX_DAY_WEEK);
    assert.equal(plannedQuantityThrough(original,'2026-11-02','2026-11-06','2026-11-04','1000'), '600');
    assert.equal(plannedQuantityThrough(original,'2026-11-02','2026-11-06','2026-11-01','1000'), '0');
    assert.equal(plannedQuantityThrough(original,'2026-11-02','2026-11-06','2026-11-07','1000'), '1000');
    assert.equal(plannedQuantityThrough(original,'2026-11-02','2026-11-07','2026-11-07','1000'), '1000');
    assert.equal(plannedQuantityThrough(revised,'2026-11-02','2026-11-07','2026-11-04','1000'), '500');
    assert.equal(plannedQuantityThrough(original,'2026-11-02','2026-11-06','2026-11-04','1000'), '600');
});

test('R10 completed local day, DST and elapsed cure are independent of working days', () => {
    const ny = calendarVersion('ny','America/New_York',FIVE_DAY_WEEK);
    assert.equal(evaluatedThroughLocalDate(ny,new Date('2026-03-08T04:59:59Z')), '2026-03-06');
    assert.equal(evaluatedThroughLocalDate(ny,new Date('2026-03-08T05:00:00Z')), '2026-03-07');
    const seconds = normalizeElapsed(48,'HOURS');
    assert.equal(seconds,172800);
    assert.equal(normalizeElapsed(2,'CALENDAR_DAYS'), seconds);
    assert.equal(elapsedRelease(new Date('2026-03-07T17:00:00Z'),seconds)?.toISOString(),'2026-03-09T17:00:00.000Z');
    assert.equal(elapsedRelease(null,seconds),null);
    assert.equal(countWorkingDays(ny,'2026-03-07','2026-03-08'),0);
});
