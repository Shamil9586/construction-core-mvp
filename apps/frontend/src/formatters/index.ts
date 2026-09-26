/**
 * Value formatting for Construction Core.
 *
 * Pure functions, no React. Used by view-models and screens so that one value
 * never appears in two spellings on two screens.
 *
 * These are deliberately *not* a dependency of the design system. Components
 * receive finished strings; deciding what a value should say belongs to the data
 * chain, not to a presentational component.
 */

export { formatPercent, NO_DATA_DASH, NO_DATA_TEXT } from './percent';
export { formatQuantity, formatMeasure, joinMeta, formatQuantityWithUnit } from './quantity';
export type { Measure } from './quantity';
export { formatMoney, formatMoneyCompact } from './money';
export { formatDate, formatDayMonth } from './date';
