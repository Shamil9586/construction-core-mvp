import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  QuantityPortionPolicy,
  InternalScPolicy,
  PortionCompletionService,
  resolveInternalScAccepted,
  resolveActualQuantity,
} from '../packages/domain';

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
 * D8 — acceptance aggregates from portions, never any-portion-accepted,  *
 * AND (F8.1-02 corrective) never any-created-portion-accepted either:    *
 * an accepted portion only counts toward its unit's total if the sum of  *
 * accepted portions' own planned quantity actually covers the unit's     *
 * planned quantity. Portions that were never created count as zero,      *
 * never as satisfied.                                                    *
 * --------------------------------------------------------------------- */

test('PortionCompletionService.unitCoverage: 100 of 500 planned, fully accepted, is PARTIAL — not COMPLETE', () => {
  // The exact F8.1-02 bug: a single 100 m² portion, itself fully accepted,
  // used to read the whole 500 m² unit as complete because .every() over
  // the one portion that happens to exist is trivially true. The unit's own
  // remaining 400 m² was never portioned at all.
  const service = new PortionCompletionService();
  assert.equal(
    service.unitCoverage('500', [{ plannedQuantity: '100', accepted: true }]),
    'PARTIAL',
  );
});

test('PortionCompletionService.unitCoverage: 500 of 500 planned, fully accepted, is COMPLETE', () => {
  const service = new PortionCompletionService();
  assert.equal(
    service.unitCoverage('500', [{ plannedQuantity: '500', accepted: true }]),
    'COMPLETE',
  );
  assert.equal(
    service.unitCoverage('500', [
      { plannedQuantity: '300', accepted: true },
      { plannedQuantity: '200', accepted: true },
    ]),
    'COMPLETE',
  );
});

test('PortionCompletionService.unitCoverage: zero accepted quantity — including zero portions at all — is NONE', () => {
  const service = new PortionCompletionService();
  assert.equal(service.unitCoverage('500', []), 'NONE');
  assert.equal(service.unitCoverage('500', [{ plannedQuantity: '500', accepted: false }]), 'NONE');
});

test('PortionCompletionService.unitCoverage: an accepted portion alongside an unaccepted one is PARTIAL, not COMPLETE', () => {
  const service = new PortionCompletionService();
  assert.equal(
    service.unitCoverage('500', [
      { plannedQuantity: '300', accepted: true },
      { plannedQuantity: '200', accepted: false },
    ]),
    'PARTIAL',
  );
});

test('PortionCompletionService.internalScComplete: true only when every unit is fully covered by accepted portions', () => {
  const service = new PortionCompletionService();
  assert.equal(
    service.internalScComplete([
      { plannedQuantity: '500', portions: [{ plannedQuantity: '500', internalScAccepted: true }] },
    ]),
    true,
  );
  assert.equal(
    service.internalScComplete([
      { plannedQuantity: '500', portions: [{ plannedQuantity: '100', internalScAccepted: true }] },
    ]),
    false,
    'partial coverage (100 of 500) must not read as complete',
  );
  assert.equal(
    service.internalScComplete([
      {
        plannedQuantity: '500',
        portions: [
          { plannedQuantity: '300', internalScAccepted: true },
          { plannedQuantity: '200', internalScAccepted: false },
        ],
      },
    ]),
    false,
    'one unaccepted portion in an otherwise-accepted unit must not read as complete',
  );
  assert.equal(
    service.internalScComplete([
      { plannedQuantity: '500', portions: [{ plannedQuantity: '500', internalScAccepted: true }] },
      { plannedQuantity: '300', portions: [{ plannedQuantity: '300', internalScAccepted: false }] },
    ]),
    false,
    'one fully-covered unit next to one unaccepted unit must not read as complete',
  );
});

test('PortionCompletionService.internalScComplete: a zero-portion unit blocks completion — never vacuously true', () => {
  // The exact bug class F4's hasCompleteScheduleData corrective patch fixed:
  // .every() over an empty array is true in JavaScript.
  const service = new PortionCompletionService();
  assert.equal(service.internalScComplete([{ plannedQuantity: '500', portions: [] }]), false);
  assert.equal(
    service.internalScComplete([
      { plannedQuantity: '500', portions: [{ plannedQuantity: '500', internalScAccepted: true }] },
      { plannedQuantity: '300', portions: [] },
    ]),
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
  const units = [
    { plannedQuantity: '500', portions: [{ plannedQuantity: '500', internalScAccepted: true, customerScAccepted: false }] },
  ];
  assert.equal(service.internalScComplete(units), true);
  assert.equal(service.customerScAccepted(units), false);
  const reversed = [
    { plannedQuantity: '500', portions: [{ plannedQuantity: '500', internalScAccepted: false, customerScAccepted: true }] },
  ];
  assert.equal(service.internalScComplete(reversed), false);
  assert.equal(service.customerScAccepted(reversed), true);
});

test('PortionCompletionService.customerScAccepted: same coverage rule and the same zero-portion guard', () => {
  const service = new PortionCompletionService();
  assert.equal(
    service.customerScAccepted([
      { plannedQuantity: '500', portions: [{ plannedQuantity: '500', customerScAccepted: true }] },
    ]),
    true,
  );
  assert.equal(
    service.customerScAccepted([
      { plannedQuantity: '500', portions: [{ plannedQuantity: '100', customerScAccepted: true }] },
    ]),
    false,
    'partial coverage must not read as complete',
  );
  assert.equal(service.customerScAccepted([{ plannedQuantity: '500', portions: [] }]), false);
  assert.equal(service.customerScAccepted([]), false);
});

/* --------------------------------------------------------------------- *
 * F8.1-03 — resolveInternalScAccepted: the exact same coverage rule a    *
 * work with execution units gets, applied uniformly whether the caller   *
 * is the read model or a backend transition/dependency check; a work     *
 * with no execution units falls back to its whole-work inspection flag   *
 * unchanged.                                                             *
 * --------------------------------------------------------------------- */

test('resolveInternalScAccepted: no execution units falls back to the whole-work flag, unchanged', () => {
  assert.equal(resolveInternalScAccepted(true, []), true);
  assert.equal(resolveInternalScAccepted(false, []), false);
});

test('resolveInternalScAccepted: with execution units, the whole-work flag is ignored — only coverage counts', () => {
  const partiallyCovered = [{ plannedQuantity: '500', portions: [{ plannedQuantity: '100', internalScAccepted: true }] }];
  assert.equal(resolveInternalScAccepted(true, partiallyCovered), false, 'a stale/irrelevant whole-work flag must not override real portion coverage');
  const fullyCovered = [{ plannedQuantity: '500', portions: [{ plannedQuantity: '500', internalScAccepted: true }] }];
  assert.equal(resolveInternalScAccepted(false, fullyCovered), true);
});

/* --------------------------------------------------------------------- *
 * F8.1-04 — resolveActualQuantity: execution units, once they exist on a *
 * work, are its sole production fact source; the legacy figure is used   *
 * only when there are none. F8.1-04 corrective, second pass (Independent *
 * Re-Review, Patch 2): summing every unit's own total blindly assumed    *
 * every unit shared the work's own measurement unit — nothing enforced   *
 * that. A unit whose `unit` string disagrees with the work's own is      *
 * excluded from the sum, not silently combined into it (м² + м³ is not a *
 * quantity). createExecutionUnit() (service.ts) is the primary           *
 * prevention; this is the aggregate's own defence for anything that      *
 * reaches it regardless.                                                 *
 * --------------------------------------------------------------------- */

test('resolveActualQuantity: no execution units returns the legacy figure unchanged', () => {
  assert.equal(resolveActualQuantity('250.5000', 'м²', []), '250.5000');
});

test('resolveActualQuantity: with execution units sharing the work\'s own unit, the legacy figure is ignored and the totals are summed', () => {
  assert.equal(resolveActualQuantity('999', 'м²', [{ unit: 'м²', actualQuantity: '300' }, { unit: 'м²', actualQuantity: '150' }]), '450.0000');
  assert.equal(resolveActualQuantity('0', 'м²', [{ unit: 'м²', actualQuantity: '0' }]), '0.0000');
});

test('resolveActualQuantity: a unit measured in a different unit is excluded from the sum, not blindly aggregated — the Review\'s own м² + м³ example', () => {
  const mixed = [
    { unit: 'м²', actualQuantity: '300' },
    { unit: 'м³', actualQuantity: '150' },
  ];
  assert.equal(resolveActualQuantity('999', 'м²', mixed), '300.0000', 'only the м² unit counts; the м³ one must not be added in');
});

test('resolveActualQuantity: execution units exist but none share the work\'s own unit — reads as zero, never the stale legacy figure', () => {
  const incompatibleOnly = [{ unit: 'м³', actualQuantity: '500' }];
  assert.equal(resolveActualQuantity('999', 'м²', incompatibleOnly), '0.0000');
});
