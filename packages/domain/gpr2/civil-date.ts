/**
 * GPR-2 — civil (local) dates and timestamps, parsed WITHOUT the host Date (Technical Design §5.1, §8.2, §11.1; finding R01-B01).
 *
 * A plan date is a calendar day (ISO `YYYY-MM-DD`), not an instant. Everything below is integer arithmetic on the three fields, so no input can make
 * a parser throw: the previous check built `new Date(text).toISOString()`, and for `2026-13-01` that is a RangeError out of a zod transform, i.e.
 * an HTTP 500 for a client mistake. Here an impossible date is just a refusal with the rule DATE_MALFORMED.
 *
 *   year   0001–9999 (PostgreSQL `date` has no year 0)
 *   month  01–12
 *   day    01 – the real length of that month, leap years included
 *
 * The canonical form is the input itself (fixed width, zero padded), so two dates compare correctly as plain strings.
 */
import type { Gpr2ValidationRule } from './errors';

const CIVIL = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
export const isLeapYear = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
export const daysInMonth = (year: number, month: number) => (month === 2 && isLeapYear(year) ? 29 : MONTH_DAYS[month - 1]);

export type CivilDateParse = { ok: true; value: string } | { ok: false; rule: Extract<Gpr2ValidationRule, 'DATE_MALFORMED'> };

export function parseCivilDate(input: unknown): CivilDateParse {
    const m = typeof input === 'string' ? CIVIL.exec(input) : null;
    if (!m)
        return { ok: false, rule: 'DATE_MALFORMED' };
    const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month))
        return { ok: false, rule: 'DATE_MALFORMED' };
    return { ok: true, value: input as string };
}
export const isCivilDate = (input: unknown): input is string => parseCivilDate(input).ok === true;

const TIMESTAMP = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(\.\d{1,9})?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/;
/** An ISO-8601 instant with an explicit offset (`computedAt`, `assignedAt` …). The date part is checked like a civil date; nothing throws. */
export const isIsoTimestamp = (input: unknown): input is string => {
    const m = typeof input === 'string' ? TIMESTAMP.exec(input) : null;
    return !!m && parseCivilDate(m[1]).ok === true;
};

/** An IANA time zone name (`Europe/Moscow`). Validated with Intl inside try/catch, so an unknown name is a refusal, not an exception. */
export function isTimeZoneName(input: unknown): input is string {
    if (typeof input !== 'string' || !/^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+){0,2}$/.test(input))
        return false;
    try {
        new Intl.DateTimeFormat('en', { timeZone: input });
        return true;
    }
    catch {
        return false;
    }
}
