/**
 * Money formatting.
 *
 * Amounts arrive as strings from `numeric(20,2)` columns and from
 * `Decimal.toFixed(2)`. Formatting converts to `number` only at the last step,
 * for display. Arithmetic on money stays in `decimal.js` — the repository already
 * depends on it, and the backend computes every sum that way.
 */

import Decimal from 'decimal.js';
import { NO_DATA_DASH } from './percent';

const MILLION = 1_000_000;

const rubleFormat = new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'RUB',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const millionFormat = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

function toDecimal(value: string | number | null | undefined): Decimal | null {
  if (value === null || value === undefined || value === '') return null;
  try {
    const amount = new Decimal(value);
    return amount.isFinite() ? amount : null;
  } catch {
    return null;
  }
}

/** Full amount, e.g. "2 000 000 ₽". */
export function formatMoney(
  value: string | number | null | undefined,
  absent: string = NO_DATA_DASH,
): string {
  const amount = toDecimal(value);
  return amount === null ? absent : rubleFormat.format(amount.toNumber());
}

/**
 * Compact amount for a summary slot, e.g. "2,0 млн ₽".
 *
 * Used where the design shows a closed sum at metric size and the exact rouble is
 * not the point. Amounts below a million keep their full form rather than becoming
 * "0,0 млн ₽", which would read as nothing closed at all.
 */
export function formatMoneyCompact(
  value: string | number | null | undefined,
  absent: string = NO_DATA_DASH,
): string {
  const amount = toDecimal(value);
  if (amount === null) return absent;
  if (amount.abs().lessThan(MILLION)) return rubleFormat.format(amount.toNumber());
  return `${millionFormat.format(amount.div(MILLION).toNumber())} млн ₽`;
}
