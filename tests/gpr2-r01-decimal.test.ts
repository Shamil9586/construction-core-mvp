import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  QUANTITY, SIGNED_QUANTITY, NORMATIVE, parseDecimal, decimalOf, normalizeDecimal, serializeDecimal, addDecimals, subtractFloorZero, sumsExactly,
  decimalsEqual, compareDecimals, isZeroDecimal, isPositiveDecimal, Gpr2Error, type DecimalString
} from '../packages/domain/gpr2';

/**
 * GPR-2 R01 — decimal-as-string (TD §5.1, §6.1, §11.1; D02/D04/D19, K01). Pure domain: no database, no HTTP.
 * Pins: a decimal is a STRING (a JS number is refused), input is never rounded, rounding exists only in normalizeDecimal() (HALF_UP),
 * sums are exact at full column width, and null is not zero.
 */
const q = (s: string) => decimalOf(QUANTITY, s);
const rule = (profile: any, input: unknown) => { const r = parseDecimal(profile, input); return r.ok === true ? 'OK:' + r.value : r.rule; };

test('decimal-as-string: a quantity is accepted only as a string and is returned in the canonical column scale', () => {
  assert.equal(rule(QUANTITY, '1000'), 'OK:1000.0000');
  assert.equal(rule(QUANTITY, '1000.5'), 'OK:1000.5000');
  assert.equal(rule(QUANTITY, '0'), 'OK:0.0000');
  assert.equal(rule(QUANTITY, '0.0001'), 'OK:0.0001');
  assert.equal(rule(QUANTITY, '99999999999999999999.9999'), 'OK:99999999999999999999.9999', '20 integer digits + 4 fractional is the whole numeric(24,4) range');
  assert.equal(rule(NORMATIVE, '2'), 'OK:2.000000000000');
  assert.equal(rule(NORMATIVE, '999999999999999999.999999999999'), 'OK:999999999999999999.999999999999', 'numeric(30,12)');
});

test('decimal-as-string: a JS number is refused — even an integer, even a safe one — because the string is the contract', () => {
  for (const n of [1000, 0, 0.1, 1e21, NaN, Infinity, -0]) assert.equal(rule(QUANTITY, n), 'DECIMAL_NOT_A_STRING', String(n));
  for (const other of [null, undefined, true, {}, [], 10n]) assert.equal(rule(QUANTITY, other), 'DECIMAL_NOT_A_STRING', String(typeof other));
});

test('decimal-as-string: malformed text is refused with a rule code, never "repaired"', () => {
  for (const s of ['', ' 1', '1 ', '+1', '1e3', '1E3', '.5', '5.', '1,000', '1 000', '0x10', '01', '00.5', '1.2.3', 'NaN', 'Infinity', '--1', '1_000', '١٢٣'])
    assert.equal(rule(QUANTITY, s), 'DECIMAL_MALFORMED', JSON.stringify(s));
});

test('decimal-as-string: sign, scale and range are separate, named violations', () => {
  assert.equal(rule(QUANTITY, '-1'), 'DECIMAL_NEGATIVE_NOT_ALLOWED');
  assert.equal(rule(SIGNED_QUANTITY, '-1'), 'OK:-1.0000', 'a delta may be negative');
  assert.equal(rule(SIGNED_QUANTITY, '-0'), 'DECIMAL_NEGATIVE_ZERO');
  assert.equal(rule(SIGNED_QUANTITY, '-0.0000'), 'DECIMAL_NEGATIVE_ZERO');
  assert.equal(rule(SIGNED_QUANTITY, '-0.0001'), 'OK:-0.0001');
  assert.equal(rule(QUANTITY, '1.00001'), 'DECIMAL_SCALE_EXCEEDED', 'five fractional digits do not fit numeric(24,4)');
  assert.equal(rule(QUANTITY, '100000000000000000000'), 'DECIMAL_OUT_OF_RANGE', '21 integer digits');
  assert.equal(rule(NORMATIVE, '1000000000000000000'), 'DECIMAL_OUT_OF_RANGE', '19 integer digits do not fit numeric(30,12)');
  assert.equal(rule(NORMATIVE, '1.0000000000001'), 'DECIMAL_SCALE_EXCEEDED');
});

test('F12.1 boundary: input is never rounded; rounding is explicit, HALF_UP, and a "must be > 0" rule still sees the normalized value', () => {
  // the wire refuses a value that does not fit the column...
  assert.equal(rule(QUANTITY, '0.00001'), 'DECIMAL_SCALE_EXCEEDED');
  // ...while a COMPUTED value is normalized at an approved point, exactly as PostgreSQL numeric / service.ts do (ties away from zero)
  assert.equal(normalizeDecimal(QUANTITY, '0.00001'), '0.0000');
  assert.equal(normalizeDecimal(QUANTITY, '0.00004'), '0.0000');
  assert.equal(normalizeDecimal(QUANTITY, '0.00005'), '0.0001');
  assert.equal(normalizeDecimal(QUANTITY, '1.23455'), '1.2346');
  assert.equal(normalizeDecimal(SIGNED_QUANTITY, '-0.00005'), '-0.0001', 'ties round away from zero for negatives too');
  assert.equal(normalizeDecimal(SIGNED_QUANTITY, '-0.00001'), '0.0000', 'negative zero collapses to zero');
  assert.equal(isPositiveDecimal(normalizeDecimal(QUANTITY, '0.00001')), false, 'a positive input that normalizes to 0 is still not > 0 (no epsilon)');
  assert.equal(isPositiveDecimal(normalizeDecimal(QUANTITY, '0.00005')), true);
});

test('normalizeDecimal refuses what the column cannot hold instead of wrapping or truncating', () => {
  assert.throws(() => normalizeDecimal(QUANTITY, '100000000000000000000'), (e: any) => e instanceof Gpr2Error && e.code === 'VALIDATION_FAILED');
  assert.throws(() => normalizeDecimal(QUANTITY, -1), (e: any) => e instanceof Gpr2Error && e.code === 'VALIDATION_FAILED', 'a computed negative quantity is invalid');
  assert.throws(() => normalizeDecimal(QUANTITY, NaN), (e: any) => e instanceof Gpr2Error);
  assert.throws(() => normalizeDecimal(QUANTITY, Infinity), (e: any) => e instanceof Gpr2Error);
});

test('NULL is not zero: null stays null, 0 is a real "0.0000", and a missing value is a bug, not an unknown', () => {
  assert.equal(serializeDecimal(QUANTITY, null), null);
  assert.equal(serializeDecimal(QUANTITY, 0), '0.0000');
  assert.equal(serializeDecimal(QUANTITY, '0'), '0.0000');
  assert.notEqual(serializeDecimal(QUANTITY, null), serializeDecimal(QUANTITY, 0));
  assert.throws(() => serializeDecimal(QUANTITY, undefined), TypeError);
  // unknown cost must never become 0 (A12): the serializer has no path from null to a number
  for (const profile of [QUANTITY, SIGNED_QUANTITY, NORMATIVE]) assert.equal(serializeDecimal(profile, null), null, profile.name);
});

test('arithmetic is exact at the full column width (the default 20-digit decimal.js precision would silently round these)', () => {
  assert.equal(addDecimals(QUANTITY, [q('12345678901234567890.1234'), q('0.0001')]), '12345678901234567890.1235');
  assert.equal(addDecimals(QUANTITY, [q('99999999999999999999.9999'), q('0')]), '99999999999999999999.9999');
  assert.equal(addDecimals(NORMATIVE, [decimalOf(NORMATIVE, '123456789012345678.123456789012'), decimalOf(NORMATIVE, '0.000000000001')]), '123456789012345678.123456789013');
  assert.throws(() => addDecimals(QUANTITY, [q('99999999999999999999.9999'), q('0.0001')]), (e: any) => e instanceof Gpr2Error, 'overflow is refused, not wrapped');
});

test('D02/D04: a split or an allocation must add up to its total EXACTLY — no tolerance', () => {
  assert.equal(sumsExactly(QUANTITY, [q('700'), q('300')], q('1000')), true, 'A02: 1000 = 700 + 300');
  assert.equal(sumsExactly(QUANTITY, [q('700'), q('299.9999')], q('1000')), false);
  assert.equal(sumsExactly(QUANTITY, [q('700'), q('300.0001')], q('1000')), false);
  assert.equal(sumsExactly(QUANTITY, [], q('0')), false, 'no parts is not a split');
  assert.equal(sumsExactly(QUANTITY, [q('0.1'), q('0.2')], q('0.3')), true, 'exact decimal, unlike 0.1 + 0.2 in floating point');
});

test('comparison and "current − fact floored at zero" are numeric, not textual', () => {
  assert.equal(decimalsEqual(q('1000'), q('1000.0000')), true);
  assert.equal(compareDecimals(q('9'), q('10')), -1, 'not lexicographic');
  assert.equal(compareDecimals(q('10'), q('9')), 1);
  assert.equal(subtractFloorZero(QUANTITY, q('1000'), q('800')), '200.0000');
  assert.equal(subtractFloorZero(QUANTITY, q('800'), q('850')), '0.0000', 'the floor is arithmetic; the caller classifies a conflict separately');
  assert.equal(isZeroDecimal(q('0.0000')), true);
  assert.equal(isZeroDecimal(q('0.0001')), false);
});

test('decimalOf throws a contract error carrying the rule code, with no echo of the offending value', () => {
  try { decimalOf(QUANTITY, 'secret-1e3'); assert.fail('should throw'); }
  catch (e: any) {
    assert.ok(e instanceof Gpr2Error);
    assert.equal(e.code, 'VALIDATION_FAILED');
    assert.deepEqual(e.details, { violations: [{ path: '', rule: 'DECIMAL_MALFORMED' }] });
    assert.equal(JSON.stringify(e.toBody()).includes('secret'), false);
  }
});
