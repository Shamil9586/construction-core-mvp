/**
 * Date formatting.
 *
 * Two shapes arrive from the backend. `DATE` columns come back as plain
 * "YYYY-MM-DD" strings — the pg type parser for OID 1082 is overridden precisely
 * so a civil date is not turned into an instant. Timestamps come back as ISO
 * strings with a zone.
 *
 * The distinction matters. `new Date("2026-09-21")` is parsed as UTC midnight, so
 * west of Greenwich it formats as the 20th. A planned finish date is a calendar
 * date, not a moment, and must not move because of where the browser is. Civil
 * dates are therefore read component-wise and never passed through a zone.
 */

import { NO_DATA_DASH } from './percent';

const CIVIL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const fullFormat = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

const dayMonthFormat = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
});

function toDate(value: string | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  const civil = CIVIL_DATE.exec(value);
  if (civil) {
    // Local midnight, so the calendar date survives formatting unchanged.
    return new Date(Number(civil[1]), Number(civil[2]) - 1, Number(civil[3]));
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Full date, e.g. "21.09.2026". */
export function formatDate(
  value: string | Date | null | undefined,
  absent: string = NO_DATA_DASH,
): string {
  const date = toDate(value);
  return date === null ? absent : fullFormat.format(date);
}

/**
 * Day and month, e.g. "21.09".
 *
 * Used in authorship lines — "Внесено РП: Сергей Волков · 21.09" — where the year
 * is context the reader already has.
 */
export function formatDayMonth(
  value: string | Date | null | undefined,
  absent: string = NO_DATA_DASH,
): string {
  const date = toDate(value);
  return date === null ? absent : dayMonthFormat.format(date);
}
