/** GPR-2 R10 pure calendar engine. A version is a frozen value, never a mutable global calendar. */
import Decimal from 'decimal.js';
import { isScheduleDate, isCivilDate, civilDayNumber } from './schedule';

export type WorkingDays = number & { readonly __unit: 'working-days' };
export type ElapsedSeconds = number & { readonly __unit: 'elapsed-seconds' };
export type WeekPattern = readonly [boolean, boolean, boolean, boolean, boolean, boolean, boolean]; // Monday first
export type CalendarVersion = Readonly<{
    id: string; timezone: string; week: WeekPattern;
    exceptions: Readonly<Record<string, Readonly<{ working: boolean; reason: string }>>>;
}>;

export const FIVE_DAY_WEEK: WeekPattern = Object.freeze([true, true, true, true, true, false, false]);
export const SIX_DAY_WEEK: WeekPattern = Object.freeze([true, true, true, true, true, true, false]);
const DAY_MS = 86400000;

function date(value: string): number {
    if (!isScheduleDate(value)) throw new Error('Дата вне диапазона графика: ' + value);
    return civilDayNumber(value);
}
function reportDay(value: string): number {
    if (!isCivilDate(value)) throw new Error('Некорректная отчётная дата: ' + value);
    return civilDayNumber(value);
}
function civil(day: number): string { return new Date(day * DAY_MS).toISOString().slice(0, 10); }
function zone(value: string): void {
    try { new Intl.DateTimeFormat('en-US', { timeZone: value }); }
    catch { throw new Error('Некорректный часовой пояс: ' + value); }
}

/** Validates and copies input so editing the source object cannot alter an already pinned version. */
export function calendarVersion(id: string, timezone: string, week: readonly boolean[], exceptions: Readonly<Record<string, Readonly<{ working: boolean; reason: string }>>> = {}): CalendarVersion {
    if (!id || week.length !== 7 || week.some(v => typeof v !== 'boolean') || !week.some(Boolean)) throw new Error('Некорректная календарная версия');
    zone(timezone);
    const copied: Record<string, Readonly<{ working: boolean; reason: string }>> = {};
    for (const [day, entry] of Object.entries(exceptions)) {
        date(day);
        if (typeof entry?.working !== 'boolean' || typeof entry?.reason !== 'string' || !entry.reason.trim()) throw new Error('Некорректное исключение календаря');
        copied[day] = Object.freeze({ working: entry.working, reason: entry.reason });
    }
    return Object.freeze({ id, timezone, week: Object.freeze([...week]) as unknown as WeekPattern, exceptions: Object.freeze(copied) });
}

export function isWorkingDay(version: CalendarVersion, day: string): boolean {
    const n = date(day);
    const exception = version.exceptions[day];
    return exception ? exception.working : version.week[((n + 3) % 7 + 7) % 7];
}

/** Inclusive boundaries. A zero-working-day interval is valid for counting, but invalid as a positive-quantity plan. */
export function countWorkingDays(version: CalendarVersion, start: string, finish: string): WorkingDays {
    const a = date(start), b = date(finish);
    if (b < a) throw new Error('Конец интервала раньше начала');
    let count = 0;
    for (let n = a; n <= b; n++) if (isWorkingDay(version, civil(n))) count++;
    return count as WorkingDays;
}

/** Search includes the supplied date. Bounded by the schedule date range and fails for an impossible pattern. */
export function nextWorkingDay(version: CalendarVersion, from: string, direction: 1 | -1 = 1): string {
    let n = date(from);
    while (true) {
        const candidate = civil(n);
        if (!isScheduleDate(candidate)) throw new Error('Рабочий день вне диапазона графика');
        if (isWorkingDay(version, candidate)) return candidate;
        n += direction;
    }
}
export function previousWorkingDay(version: CalendarVersion, from: string): string { return nextWorkingDay(version, from, -1); }

/** Explicit unit conversion at the caller boundary; elapsed seconds cannot enter working-day arithmetic. */
export function workingDays(value: number): WorkingDays {
    if (!Number.isSafeInteger(value)) throw new Error('Некорректное число рабочих дней');
    return value as WorkingDays;
}
export function addWorkingDays(version: CalendarVersion, from: string, days: WorkingDays): string {
    if (!Number.isSafeInteger(days)) throw new Error('Некорректное число рабочих дней');
    let n = date(from), remaining = Math.abs(days), direction = days < 0 ? -1 : 1;
    while (remaining) {
        n += direction;
        const candidate = civil(n);
        if (!isScheduleDate(candidate)) throw new Error('Рабочий день вне диапазона графика');
        if (isWorkingDay(version, candidate)) remaining--;
    }
    return civil(n);
}

/** Equal weight per working day, with exact decimal arithmetic until presentation. */
export function plannedQuantityThrough(version: CalendarVersion, start: string, finish: string, through: string, quantity: string | number): string {
    const total = countWorkingDays(version, start, finish);
    const q = new Decimal(quantity);
    if (!q.isFinite() || q.lte(0) || total === 0) throw new Error('Положительный объём требует рабочий день');
    // A report cutoff may be outside 2000–2100; the pinned plan boundaries may not.
    const cutoff = reportDay(through);
    const elapsed = cutoff < date(start) ? 0 : countWorkingDays(version, start, civil(Math.min(cutoff, date(finish))));
    return q.mul(elapsed).div(total).toString();
}

/** The latest fully completed local date at an instant. No process timezone or host clock is consulted. */
export function evaluatedThroughLocalDate(version: CalendarVersion, instant: Date): string {
    if (Number.isNaN(instant.getTime())) throw new Error('Некорректный момент');
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: version.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
    const part = (type: string) => parts.find(x => x.type === type)!.value;
    const today = `${part('year')}-${part('month')}-${part('day')}`;
    return civil(reportDay(today) - 1);
}

export function normalizeElapsed(value: number, unit: 'HOURS' | 'CALENDAR_DAYS'): ElapsedSeconds {
    if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(value * (unit === 'HOURS' ? 3600 : 86400))) throw new Error('Некорректная выдержка');
    return (value * (unit === 'HOURS' ? 3600 : 86400)) as ElapsedSeconds;
}
export function elapsedRelease(start: Date | null, seconds: ElapsedSeconds): Date | null {
    if (start === null) return null;
    if (Number.isNaN(start.getTime()) || !Number.isSafeInteger(seconds) || seconds < 0) throw new Error('Некорректный момент выдержки');
    return new Date(start.getTime() + seconds * 1000);
}
