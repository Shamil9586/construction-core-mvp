import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  millionRubToKopeks, kopeksToRub, rubToMillionRub,
  sumPlanLinesMln, requireQuarterMinimum, canReadFinPlan, canWriteFinPlan
} from '../packages/domain/fin-sdo-1';

test('FIN1-06 FIN1-07 FIN1-08: exact conversion and the quarter-wide minimum', () => {
  assert.equal(sumPlanLinesMln(['6.00', '4.00']).totalRub, '10000000.00');
  assert.equal(requireQuarterMinimum(['6.00', '4.00']).totalMln, '10.00');
  assert.equal(requireQuarterMinimum(['9.99', '0.01']).totalMln, '10.00');
  for (const value of ['10.00', '10.50', '25.75', '120.00']) {
    assert.equal(rubToMillionRub(kopeksToRub(millionRubToKopeks(value))), value);
    assert.equal(requireQuarterMinimum([value]).totalMln, value);
  }
  for (const value of ['9.99', '0.00']) assert.throws(() => requireQuarterMinimum([value]), /FIN_QUARTER_TOTAL_BELOW_MIN|10.00 million/);
});
test('FIN1-22: never round or accept exponential / numeric plan input', () => {
  for (const v of [10.00, '-1.00', '10.001', '1e2', 'NaN', 'Infinity', '0.0', '10,00', ' 10.00', '.50']) {
    assert.throws(() => millionRubToKopeks(v), /FIN_MONEY_INVALID|canonical/);
  }
  assert.equal(kopeksToRub(millionRubToKopeks('0.01')), '10000.00');
});
test('FIN1-19: financial roles are independent of broad legacy SDO_VIEW/FINANCE_VIEW', () => {
  for (const role of ['SDO', 'SDO_HEAD', 'ADMIN']) assert.equal(canWriteFinPlan(role), true);
  for (const role of ['GENERAL_DIRECTOR', 'DEPUTY_DIRECTOR']) { assert.equal(canReadFinPlan(role), true); assert.equal(canWriteFinPlan(role), false); }
  for (const role of ['PTO', 'PTO_HEAD', 'PROJECT_MANAGER', 'CONSTRUCTION_CONTROL', 'CONSTRUCTION_CONTROL_HEAD', 'CONTRACTOR_VIEWER', 'UNKNOWN']) {
    assert.equal(canReadFinPlan(role), false);
    assert.equal(canWriteFinPlan(role), false);
  }
});