import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalMln, formatMlnHundredths, formatRubAsMln, formatRubExact, rubToCanonicalMln, sumMlnHundredths,
} from '../apps/frontend/src/formatters/finPlanMoney';

// FIN-SDO-1 UI money (DEC-02): exact, unrounded, ru-RU spelling; mirrors the backend canonical DTO.
test('FIN UI accepts the decimal comma but only exactly two decimals of a non-negative amount', () => {
  assert.equal(canonicalMln('10,50'), '10.50');
  assert.equal(canonicalMln(' 25.75 '), '25.75');
  assert.equal(canonicalMln('0.00'), '0.00');
  for (const bad of ['10.001', '-0.01', '1e7', 'NaN', '10', '10.5', '', '00.50', '10,5,0', '１０.００'])
    assert.equal(canonicalMln(bad), null, bad);
});

test('FIN UI sums exactly in hundredths of a million: 9.99 + 0.01 = 10,00, no IEEE-754 drift', () => {
  assert.equal(sumMlnHundredths(['9.99', '0,01']), 1000n);
  assert.equal(sumMlnHundredths(['0.10', '0.20']), 30n);
  assert.equal(sumMlnHundredths(['99999999999999.99', '0.01']), 10000000000000000n);
  assert.equal(sumMlnHundredths(['6.00', '4.001']), null);
  assert.equal(formatMlnHundredths(1000n), '10,00');
  assert.equal(formatMlnHundredths(125075n), '1 250,75');
});

test('FIN UI shows RUB as млн ₽ with 2 decimals and never invents a zero', () => {
  const cases: Array<[string, string, string]> = [
    ['10000000.00', '10,00', '10.00'], ['10500000.00', '10,50', '10.50'],
    ['25750000.00', '25,75', '25.75'], ['120000000.00', '120,00', '120.00'], ['0.00', '0,00', '0.00'],
  ];
  for (const [rub, shown, canonical] of cases) {
    assert.equal(formatRubAsMln(rub), shown);
    assert.equal(rubToCanonicalMln(rub), canonical);
  }
  for (const absent of [null, undefined, '', 'abc', '10000000', '10005000.00'])
    assert.equal(formatRubAsMln(absent as string | null | undefined), '—', String(absent));
  assert.equal(formatRubExact('10000000.00'), '10 000 000,00 ₽');
  assert.equal(formatRubExact(null), '—');
});
