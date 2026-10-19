/**
 * GPR-2 R01 — decimal-as-string (Technical Design §5.1, §6.1, §11.1; decisions D04/D19, K01).
 *
 * Every physical quantity, normative rate and worker-hour value crosses the API, the domain and the fingerprint as a STRING. A JS number is
 * refused outright — even `1000` — because a number has already lost the information the string carries, and the design forbids floating
 * point anywhere in commands, sums, shares or equality.
 *
 *   QUANTITY          numeric(24,4)  — 20 integer digits, 4 fractional; production quantities, never negative
 *   SIGNED_QUANTITY   numeric(24,4)  — the same scale, a delta may be negative (but never "-0")
 *   NORMATIVE         numeric(30,12) — norms / hours / lags: 18 integer digits, 12 fractional
 *
 * INPUT IS NEVER ROUNDED. A string with more fractional digits than the column holds is rejected (DECIMAL_SCALE_EXCEEDED); it is not silently
 * cut. Rounding exists only where the design approves it: normalizeDecimal(), HALF_UP (what PostgreSQL does for numeric and what service.ts
 * already does for Customer SC), used for computed values — so 0.00001 normalizes to 0.0000 and a "must be > 0" rule still refuses it
 * (F12.1: normalize first, then check; no global epsilon).
 *
 * NULL IS NOT ZERO. null means "not known / not applicable"; "0.0000" is a real zero. serializeDecimal() maps null → null and 0 → "0.0000",
 * and a missing (undefined) value is a programming error, not an unknown — it throws.
 */
import Decimal from 'decimal.js';
import { Gpr2Error, Gpr2ValidationRule } from './errors';

// A private Decimal with enough precision for the widest profile (30 significant digits) to be added exactly. The global default of 20
// significant digits would silently round a 24-digit quantity sum.
const D = Decimal.clone({ precision: 100, rounding: Decimal.ROUND_HALF_UP });

declare const decimalBrand: unique symbol;
export type DecimalString = string & { readonly [decimalBrand]: true };

export interface DecimalProfile { readonly name: string; readonly integerDigits: number; readonly scale: number; readonly signed: boolean }
export const QUANTITY: DecimalProfile = { name: 'QUANTITY', integerDigits: 20, scale: 4, signed: false };
export const SIGNED_QUANTITY: DecimalProfile = { name: 'SIGNED_QUANTITY', integerDigits: 20, scale: 4, signed: true };
export const NORMATIVE: DecimalProfile = { name: 'NORMATIVE', integerDigits: 18, scale: 12, signed: false };

const SHAPE = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

export type DecimalParse = { ok: true; value: DecimalString } | { ok: false; rule: Gpr2ValidationRule };

export function parseDecimal(profile: DecimalProfile, input: unknown): DecimalParse {
    if (typeof input !== 'string')
        return { ok: false, rule: 'DECIMAL_NOT_A_STRING' };
    const m = SHAPE.exec(input);
    if (!m)
        return { ok: false, rule: 'DECIMAL_MALFORMED' };
    const [, sign, int, frac = ''] = m;
    if (sign && !profile.signed)
        return { ok: false, rule: 'DECIMAL_NEGATIVE_NOT_ALLOWED' };
    if (int.length > profile.integerDigits)
        return { ok: false, rule: 'DECIMAL_OUT_OF_RANGE' };
    if (frac.length > profile.scale)
        return { ok: false, rule: 'DECIMAL_SCALE_EXCEEDED' };
    if (sign && /^0*$/.test(frac) && int === '0')
        return { ok: false, rule: 'DECIMAL_NEGATIVE_ZERO' };
    return { ok: true, value: (sign + int + '.' + frac.padEnd(profile.scale, '0')) as DecimalString };
}

/** Parse or throw — for domain code that already holds a trusted value. HTTP edges use the zod schemas, which report every violation at once. */
export function decimalOf(profile: DecimalProfile, input: unknown): DecimalString {
    const r = parseDecimal(profile, input);
    if (r.ok === false)
        throw new Gpr2Error('VALIDATION_FAILED', { violations: [{ path: '', rule: r.rule }] });
    return r.value;
}

/** Explicit, approved rounding: HALF_UP to the profile's scale, then a range check. -0 collapses to 0. */
export function normalizeDecimal(profile: DecimalProfile, value: Decimal.Value): DecimalString {
    const d = new D(value);
    if (!d.isFinite())
        throw new Gpr2Error('VALIDATION_FAILED', { violations: [{ path: '', rule: 'DECIMAL_MALFORMED' }] });
    const rounded = d.toDecimalPlaces(profile.scale, Decimal.ROUND_HALF_UP);
    const text = rounded.isZero() ? new D(0).toFixed(profile.scale) : rounded.toFixed(profile.scale);
    const r = parseDecimal(profile, text);
    if (r.ok === false)
        throw new Gpr2Error('VALIDATION_FAILED', { violations: [{ path: '', rule: r.rule }] });
    return r.value;
}

/** null stays null (unknown / not applicable); 0 becomes "0.0000"; undefined is a bug and throws. */
export function serializeDecimal(profile: DecimalProfile, value: Decimal.Value | null | undefined): DecimalString | null {
    if (value === undefined)
        throw new TypeError('serializeDecimal: undefined is neither a value nor an explicit null');
    return value === null ? null : normalizeDecimal(profile, value);
}

const dec = (v: DecimalString) => new D(v);
export const compareDecimals = (a: DecimalString, b: DecimalString): -1 | 0 | 1 => dec(a).cmp(dec(b)) as -1 | 0 | 1;
export const decimalsEqual = (a: DecimalString, b: DecimalString) => dec(a).eq(dec(b));
export const isZeroDecimal = (a: DecimalString) => dec(a).isZero();
export const isPositiveDecimal = (a: DecimalString) => dec(a).gt(0);
export const addDecimals = (profile: DecimalProfile, values: readonly DecimalString[]): DecimalString =>
    normalizeDecimal(profile, values.reduce((sum, v) => sum.plus(dec(v)), new D(0)));
/** current − fact, floored at zero, as an exact decimal. */
export const subtractFloorZero = (profile: DecimalProfile, a: DecimalString, b: DecimalString): DecimalString =>
    normalizeDecimal(profile, D.max(dec(a).minus(dec(b)), 0));
/** An allocation / BoQ split must add up to its total EXACTLY — no tolerance (D02, D04). */
export const sumsExactly = (profile: DecimalProfile, parts: readonly DecimalString[], total: DecimalString) =>
    parts.length > 0 && decimalsEqual(addDecimals(profile, parts), total);
