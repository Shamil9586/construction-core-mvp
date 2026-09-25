import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSnapshot } from '../apps/frontend/src/data/validateSnapshot';

/**
 * F8.1-05 corrective (Independent Review, result NOT ACCEPTED first pass):
 * the new F8.1 quantity/boolean/coverage-status fields used to pass through
 * validateSnapshot() completely unchecked. These tests use the review's own
 * two named examples (`internalScAccepted: "false"`, `quantity: "abc"`) plus
 * the coverage-status enum, and confirm a well-formed snapshot still passes.
 *
 * Pure logic, no browser, no server — the same "import the frontend module
 * directly under node:test" pattern tests/f8.1-w01-viewmodel.test.ts already
 * uses for view-model coverage.
 */

function validSnapshot(): any {
  return {
    objects: [
      { id: 'object-1', name: 'Объект 1', externalCode: 'OBJ-1', address: 'Тест, 1', responsible: 'РП', customerName: null, organizationName: 'ООО СЗ «Гор-Строй»' },
    ],
    works: [
      { id: 'work-1', objectId: 'object-1', name: 'Работа 1', contractor: 'Подрядчик 1', unit: 'м²', blockers: [], customerScAccepted: false },
    ],
    contractors: [],
    dependencies: [],
    inspections: [{ objectWorkId: 'work-1', status: 'WAITING' }],
    executionUnits: [
      {
        id: 'unit-1',
        objectWorkId: 'work-1',
        unit: 'м²',
        location: '1 этаж',
        executionConditions: null,
        plannedQuantity: '500.0000',
        actualQuantity: '300.0000',
        internalScStatus: 'PARTIAL',
        customerScStatus: 'NONE',
      },
    ],
    portions: [
      {
        id: 'portion-1',
        executionUnitId: 'unit-1',
        label: 'Секция A',
        plannedQuantity: '300.0000',
        rpFactQuantity: '300.0000',
        internalScConfirmedQuantity: null,
        customerScConfirmedQuantity: null,
        internalScAccepted: false,
        customerScAccepted: false,
      },
    ],
  };
}

test('validateSnapshot: a well-formed F8.1 snapshot passes unchanged', () => {
  const snapshot = validSnapshot();
  assert.deepEqual(validateSnapshot(snapshot), snapshot);
});

test('validateSnapshot: portion.internalScAccepted as the string "false" is rejected — the Review\'s own example', () => {
  const snapshot = validSnapshot();
  snapshot.portions[0].internalScAccepted = 'false';
  assert.throws(() => validateSnapshot(snapshot), /искажённый снимок данных/);
});

test('validateSnapshot: portion.customerScAccepted as the string "true" is rejected too, not just "false"', () => {
  const snapshot = validSnapshot();
  snapshot.portions[0].customerScAccepted = 'true';
  assert.throws(() => validateSnapshot(snapshot));
});

test('validateSnapshot: portion.plannedQuantity: "abc" is rejected — the Review\'s own example', () => {
  const snapshot = validSnapshot();
  snapshot.portions[0].plannedQuantity = 'abc';
  assert.throws(() => validateSnapshot(snapshot));
});

test('validateSnapshot: unit.actualQuantity: "abc" is rejected the same way', () => {
  const snapshot = validSnapshot();
  snapshot.executionUnits[0].actualQuantity = 'abc';
  assert.throws(() => validateSnapshot(snapshot));
});

test('validateSnapshot: a nullable quantity (portion.rpFactQuantity) accepts null but not a non-numeric string', () => {
  const okNull = validSnapshot();
  okNull.portions[0].rpFactQuantity = null;
  assert.doesNotThrow(() => validateSnapshot(okNull));

  const badString = validSnapshot();
  badString.portions[0].rpFactQuantity = 'not-a-number';
  assert.throws(() => validateSnapshot(badString));
});

test('validateSnapshot: an unrecognised internalScStatus is rejected — a closed set, not a Known<T> graceful fallback', () => {
  const snapshot = validSnapshot();
  snapshot.executionUnits[0].internalScStatus = 'MOSTLY_DONE';
  assert.throws(() => validateSnapshot(snapshot));
});

test('validateSnapshot: a missing internalScStatus (not merely an unrecognised one) is also rejected once executionUnits is present', () => {
  const snapshot = validSnapshot();
  delete snapshot.executionUnits[0].internalScStatus;
  assert.throws(() => validateSnapshot(snapshot));
});

test('validateSnapshot: work.customerScAccepted as a string is rejected; null and omitted are both still fine', () => {
  const badString = validSnapshot();
  badString.works[0].customerScAccepted = 'false';
  assert.throws(() => validateSnapshot(badString));

  const okNull = validSnapshot();
  okNull.works[0].customerScAccepted = null;
  assert.doesNotThrow(() => validateSnapshot(okNull));

  const okOmitted = validSnapshot();
  delete okOmitted.works[0].customerScAccepted;
  assert.doesNotThrow(() => validateSnapshot(okOmitted), 'omitted entirely must still pass — CONTRACTOR_VIEWER/pre-F8.1 fixtures never had this field at all');
});

test('validateSnapshot: executionUnits/portions entirely absent from the response is still fine — a pre-F8.1 fixture, not a transport defect', () => {
  const snapshot = validSnapshot();
  delete snapshot.executionUnits;
  delete snapshot.portions;
  assert.doesNotThrow(() => validateSnapshot(snapshot));
});
