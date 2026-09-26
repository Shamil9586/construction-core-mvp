/**
 * Percentage formatting.
 *
 * Design Rules §7 allows exactly one form: a number with a `%` sign. Percentage
 * points are not used, and the arithmetic difference between two percentages is
 * never renamed into a "relative deviation" or presented as п.п.
 *
 * The correct way to express a gap is to show both figures and let the status say
 * what it means — "План на дату 75% · факт 62%" together with "Есть отставание".
 * That is why this module offers no `formatVariance` and no difference helper:
 * the omission is the rule. A screen needing to express a gap renders both values
 * and the status badge beside them.
 */

/** Shown where a figure is structurally absent, in a narrow slot such as a cell. */
export const NO_DATA_DASH = '—';

/** Shown where a figure is structurally absent and there is room for words. */
export const NO_DATA_TEXT = 'Нет данных';

const percentFormat = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/**
 * Format a percentage for display.
 *
 * `null` and `undefined` are real states here, not missing inputs: the backend
 * returns `plannedProgress: null` for work without dates, and progress is `null`
 * when planned quantity is zero. They render as an absence marker, never as `0%`
 * — a confident zero would claim a measurement the system does not have.
 */
export function formatPercent(
  value: number | null | undefined,
  absent: string = NO_DATA_DASH,
): string {
  if (value === null || value === undefined || Number.isNaN(value)) return absent;
  return `${percentFormat.format(value)}%`;
}
