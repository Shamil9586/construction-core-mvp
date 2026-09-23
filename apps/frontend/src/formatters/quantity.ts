/**
 * Physical quantity formatting.
 *
 * Quantities arrive as strings from `numeric(20,4)` columns. The unit is kept
 * apart from the value because the design renders them at different sizes —
 * "500" as a metric and "м² · физически выполнено" as meta. Returning one glued
 * string would force every call site to split it again.
 */

import { NO_DATA_DASH } from './percent';

const quantityFormat = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 3,
});

/**
 * Format a measured quantity.
 *
 * A real zero and an absent value are different facts and must look different:
 * 0 м² on the second floor is a measurement, while nothing submitted is `—`.
 * So `0` formats as "0" and only `null`/`undefined` produce the absence marker.
 */
export function formatQuantity(
  value: string | number | null | undefined,
  absent: string = NO_DATA_DASH,
): string {
  if (value === null || value === undefined || value === '') return absent;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(numeric)) return absent;
  return quantityFormat.format(numeric);
}

/** A quantity split into the parts the design renders at different sizes. */
export interface Measure {
  /** The number alone, e.g. "500". Rendered as a metric style. */
  value: string;
  /** Unit and context, e.g. "м² · физически выполнено". Rendered as meta. */
  meta: string;
}

/**
 * Split a quantity into value and meta.
 *
 * `context` names what the figure is — "физически выполнено", "подтверждённый
 * объём", "оба этажа". It matters because several quantities of the same unit sit
 * next to each other on W01 and the unit alone would not tell them apart.
 */
export function formatMeasure(
  value: string | number | null | undefined,
  unit: string,
  context?: string,
): Measure {
  return {
    value: formatQuantity(value),
    meta: context ? `${unit} · ${context}` : unit,
  };
}

/** Join meta fragments with the separator used throughout the interface. */
export function joinMeta(...parts: Array<string | null | undefined>): string {
  return parts.filter((part): part is string => Boolean(part && part.trim())).join(' · ');
}
