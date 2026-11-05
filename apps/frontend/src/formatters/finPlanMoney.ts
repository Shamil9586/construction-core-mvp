/**
 * FIN-SDO-1 plan money (DEC-02): input in millions RUB with exactly two
 * decimals, storage/API in RUB NUMERIC(20,2) decimal strings. Everything here is
 * exact — integer hundredths of a million via BigInt, never a JS Number — and
 * nothing is rounded: a value that is not exactly representable is reported as
 * invalid/absent instead of being shown as a nearby number or a false 0,00.
 */

import { NO_DATA_DASH } from './percent';

/** API canonical form of `amountMln` (same pattern as the backend DTO). */
const CANONICAL_MLN = /^(?:0|[1-9]\d{0,13})\.\d{2}$/;
const RUB = /^(0|[1-9]\d*)\.(\d{2})$/;
const NBSP = ' ';

/** The user may type the Russian decimal comma; the API always receives a point. */
export function normalizeMlnInput(raw: string): string {
  return raw.trim().replace(',', '.');
}

/** Canonical `amountMln` or null when the input is not exactly two decimals of a non-negative million amount. */
export function canonicalMln(raw: string): string | null {
  const value = normalizeMlnInput(raw);
  return CANONICAL_MLN.test(value) ? value : null;
}

/** Hundredths of a million (0.01 млн ₽ = 1) of a canonical value. */
function mlnHundredths(canonical: string): bigint {
  const [whole, fraction] = canonical.split('.');
  return BigInt(whole) * 100n + BigInt(fraction);
}

/** Exact sum in hundredths of a million, or null if any input is not canonical. */
export function sumMlnHundredths(raw: readonly string[]): bigint | null {
  let total = 0n;
  for (const value of raw) {
    const canonical = canonicalMln(value);
    if (canonical === null) return null;
    total += mlnHundredths(canonical);
  }
  return total;
}

function groupDigits(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
}

/** "10,00", "1 250,75" — hundredths of a million in ru-RU spelling. */
export function formatMlnHundredths(hundredths: bigint): string {
  const sign = hundredths < 0n ? '-' : '';
  const abs = hundredths < 0n ? -hundredths : hundredths;
  return sign + groupDigits((abs / 100n).toString()) + ',' + (abs % 100n).toString().padStart(2, '0');
}

/** Hundredths of a million for an exact RUB decimal string, or null if it is not a whole 0.01 млн. */
export function rubToMlnHundredths(rub: string | null | undefined): bigint | null {
  const match = rub ? RUB.exec(rub) : null;
  if (!match) return null;
  const kopecks = BigInt(match[1]) * 100n + BigInt(match[2]);
  return kopecks % 1_000_000n === 0n ? kopecks / 1_000_000n : null;
}

/** "10,50" for "10500000.00"; "—" when absent or not representable (never a false zero). */
export function formatRubAsMln(rub: string | null | undefined, absent: string = NO_DATA_DASH): string {
  const hundredths = rubToMlnHundredths(rub);
  return hundredths === null ? absent : formatMlnHundredths(hundredths);
}

/** Canonical API `amountMln` ("10.50") for an exact RUB decimal string, or null. */
export function rubToCanonicalMln(rub: string | null | undefined): string | null {
  const hundredths = rubToMlnHundredths(rub);
  return hundredths === null ? null : (hundredths / 100n).toString() + '.' + (hundredths % 100n).toString().padStart(2, '0');
}

/** "10 000 000,00 ₽" — the exact stored RUB amount, unrounded. */
export function formatRubExact(rub: string | null | undefined, absent: string = NO_DATA_DASH): string {
  const match = rub ? RUB.exec(rub) : null;
  return match ? groupDigits(match[1]) + ',' + match[2] + NBSP + '₽' : absent;
}
