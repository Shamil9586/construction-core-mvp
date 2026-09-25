import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuantityPortionPolicy, InternalScPolicy, PortionCompletionService } from '../packages/domain';

/**
 * F8.1 Production Execution + Construction Control Foundation — pure domain
 * logic. No database, no server, same style as tests/domain.test.ts: these
 * test the functions directly, not through any HTTP or service layer.
 */

/* --------------------------------------------------------------------- *
 * D4 — a portion's quantity is bounded by its unit's planned quantity     *
 * --------------------------------------------------------------------- */

test('QuantityPortionPolicy: a portion fits when the running sum stays within the unit total', () => {
  const policy = new QuantityPortionPolicy();
  assert.equal(policy.fits('500', '0', '150'), true);
  assert.equal(policy.fits('500', '150', '200'), true);
  // Exactly filling the remainder is allowed — "cannot exceed", not "must stay strictly below".
  assert.equal(policy.fits('500', '350', '150'), true);
});

test('QuantityPortionPolicy: a portion that would push the sum past the unit total is rejected', () => {
  const policy = new QuantityPortionPolicy();
  assert.equal(policy.fits('500', '350', '150.0001'), false);
  assert.equal(policy.fits('500', '500', '0.0001'), false);
  assert.equal(policy.fits('100', '0', '100.01'), false);
});

test('QuantityPortionPolicy: partial coverage is legal — the sum need not reach the unit total', () => {
  // D4: "may cover partial planned quantity." A unit with 500 planned and only
  // 150 portioned so far is not itself invalid; only a portion that would
  // overshoot is rejected.
  const policy = new QuantityPortionPolicy();
  assert.equal(policy.fits('500', '0', '150'), true);
});

/* --------------------------------------------------------------------- *
 * "Mandatory for ООО СЗ «Гор-Строй» objects" — Internal SC                *
 * --------------------------------------------------------------------- */

test('InternalScPolicy: required only for the exact organization name, nothing else', () => {
  const policy = new InternalScPolicy();
  assert.equal(policy.required('ООО СЗ «Гор-Строй»'), true);
  assert.equal(policy.required('ООО Другая организация'), false);
  assert.equal(policy.required(null), false);
  assert.equal(policy.required(''), false);
  // Not a substring/case-insensitive match — the exact literal only, the same
  // value apps/backend/src/importer.ts already hardcodes for ГПО-sourced rows.
  assert.equal(policy.required('ооо сз «гор-строй»'), false);
  assert.equal(policy.required('ООО СЗ «Гор-Строй» (филиал)'), false);
});

/* --------------------------------------------------------------------- *
 * D8 — acceptance aggregates from portions, never any-portion-accepted   *
 * --------------------------------------------------------------------- */

test('PortionCompletionService.internalScComplete: true only when every portion of every unit is accepted', () => {
  const service = new PortionCompletionService();
  assert.equal(
    service.internalScComplete([{ portions: [{ internalScAccepted: true }, { internalScAccepted: true }] }]),
    true,
  );
  assert.equal(
    service.internalScComplete([{ portions: [{ internalScAccepted: true }, { internalScAccepted: false }] }]),
    false,
    'one unaccepted portion in an otherwise-accepted unit must not read as complete',
  );
  assert.equal(
    service.internalScComplete([
      { portions: [{ internalScAccepted: true }] },
      { portions: [{ internalScAccepted: false }] },
    ]),
    false,
    'one fully-accepted unit next to one unaccepted unit must not read as complete',
  );
});

test('PortionCompletionService.internalScComplete: a zero-portion unit blocks completion — never vacuously true', () => {
  // The exact bug class F4's hasCompleteScheduleData corrective patch fixed:
  // .every() over an empty array is true in JavaScript.
  const service = new PortionCompletionService();
  assert.equal(service.internalScComplete([{ portions: [] }]), false);
  assert.equal(
    service.internalScComplete([{ portions: [{ internalScAccepted: true }] }, { portions: [] }]),
    false,
    'one complete unit next to one empty unit must not read as complete',
  );
});

test('PortionCompletionService.internalScComplete: zero units is not vacuously complete either', () => {
  const service = new PortionCompletionService();
  assert.equal(service.internalScComplete([]), false);
});

test('PortionCompletionService: Internal SC completion and Customer SC acceptance are independent — never derived from each other', () => {
  const service = new PortionCompletionService();
  const units = [{ portions: [{ internalScAccepted: true, customerScAccepted: false }] }];
  assert.equal(service.internalScComplete(units), true);
  assert.equal(service.customerScAccepted(units), false);
  const reversed = [{ portions: [{ internalScAccepted: false, customerScAccepted: true }] }];
  assert.equal(service.internalScComplete(reversed), false);
  assert.equal(service.customerScAccepted(reversed), true);
});

test('PortionCompletionService.customerScAccepted: same all-portions rule and the same zero-portion guard', () => {
  const service = new PortionCompletionService();
  assert.equal(
    service.customerScAccepted([{ portions: [{ customerScAccepted: true }, { customerScAccepted: true }] }]),
    true,
  );
  assert.equal(
    service.customerScAccepted([{ portions: [{ customerScAccepted: true }, { customerScAccepted: false }] }]),
    false,
  );
  assert.equal(service.customerScAccepted([{ portions: [] }]), false);
  assert.equal(service.customerScAccepted([]), false);
});
