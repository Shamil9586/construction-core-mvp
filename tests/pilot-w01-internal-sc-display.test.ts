import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildW01ViewModel, confirmationLabel } from '../apps/frontend/src/view-models/w01';
import type { Inspection, ObjectSummary, QuantityPortion, Work, WorkExecutionUnit } from '../apps/frontend/src/types/api';

/**
 * PILOT-W01 UI01 — the LIVE chain: plan 500 → RP fact 500 → INTERNAL_SC accepted 498, no
 * CUSTOMER_SC. Backend read model (apps/backend/src/read-service.ts) already sends
 * rpFactQuantity 500 / internalScAccepted true / internalScConfirmedQuantity 498, but
 * `work.accepted` stays false (498 < 500 coverage) and the whole-work inspection lookup excludes
 * portion-scoped inspections — so W01 fell through to NotSubmitted ("Не предъявлено") and never
 * rendered 498. Tested at the view-model boundary W01 renders from.
 */
const object = { id: 'o1', name: 'Тест после удаления ролей' } as ObjectSummary;
const work = { id: 'w1', objectId: 'o1', name: 'PILOT-W01 Штукатурка стен', unit: 'м²', plannedQuantity: '500.0000', actualQuantity: '500.0000', lastReportedAt: '2026-10-01T00:00:00Z', accepted: false, customerScAccepted: false, contractor: 'П', actualProgress: 100, blockers: [], status: 'ACTIVE', scheduleStatus: 'GREEN', plannedStartDate: '2026-01-01', plannedFinishDate: '2026-12-31', actualStartDate: null, actualFinishDate: null } as unknown as Work;
const unit = { id: 'u1', objectWorkId: 'w1', unit: 'м²', plannedQuantity: '500.0000', actualQuantity: '500.0000', location: null } as unknown as WorkExecutionUnit;
const portion = (over: Partial<QuantityPortion> = {}) => ({ id: 'p1', executionUnitId: 'u1', version: 3, label: 'Участок 1', plannedQuantity: '500.0000', rpFactQuantity: '500.0000', internalScAccepted: true, internalScConfirmedQuantity: '498.0000', customerScAccepted: false, customerScConfirmedQuantity: null, ...over }) as unknown as QuantityPortion;
const internalScInspection = { id: 'i1', objectWorkId: 'w1', portionId: 'p1', inspectionType: 'INTERNAL_SC', status: 'ACCEPTED', requestedAt: '2026-10-01T10:00:00Z', version: 2 } as unknown as Inspection;
const build = (portions: QuantityPortion[], inspections: Inspection[] = [internalScInspection]) => buildW01ViewModel(work, object, inspections, [unit], portions);

test('A: plan 500, RP fact 500 and Internal SC 498 render as three independent figures', () => {
  const vm = build([portion()]);
  assert.equal(vm.plan.value, '500');
  assert.equal(vm.fact.value, '500');
  assert.equal(vm.internalScAccepted?.value, '498');
  assert.match(vm.internalScAccepted!.meta, /м²/);
  const p = vm.executionUnits[0].portions[0];
  assert.equal(p.planned.value, '500'); assert.equal(p.fact.value, '500'); assert.equal(p.internalScConfirmed?.value, '498');
});

test('B: an accepted Internal SC never renders "Не предъявлено"', () => {
  const vm = build([portion()]);
  assert.notEqual(vm.confirmation.kind, 'NotSubmitted');
  assert.notEqual(confirmationLabel(vm.confirmation), 'Не предъявлено');
  assert.notEqual(confirmationLabel(vm.executionUnits[0].portions[0].internalSc), 'Не предъявлено');
});

test('C: the absence of CUSTOMER_SC does not hide or erase the accepted Internal SC', () => {
  const vm = build([portion({ customerScAccepted: false, customerScConfirmedQuantity: null })]);
  assert.equal(vm.internalScAccepted?.value, '498');
  assert.equal(vm.confirmation.kind, 'PortionsAccepted');
  // a CUSTOMER_SC inspection that is merely pending must not change the Internal SC figure either
  const pendingCustomer = { id: 'i2', objectWorkId: 'w1', portionId: 'p1', inspectionType: 'CUSTOMER_SC', status: 'WAITING', requestedAt: '2026-10-02T10:00:00Z', version: 1 } as unknown as Inspection;
  const vm2 = build([portion()], [internalScInspection, pendingCustomer]);
  assert.equal(vm2.internalScAccepted?.value, '498'); assert.equal(vm2.confirmation.kind, 'PortionsAccepted');
});

test('D: RP fact stays 500 after Internal SC 498 — nothing overwrites it', () => {
  const vm = build([portion()]);
  assert.equal(vm.fact.value, '500');
  assert.equal(vm.executionUnits[0].portions[0].fact.value, '500');
  assert.equal(vm.executionUnits[0].actual.value, '500');
  assert.notEqual(vm.internalScAccepted?.value, vm.fact.value);
});

test('no accepted portion: still "Не предъявлено" and no accepted figure; whole-work accepted keeps "Принято СК"', () => {
  const none = build([portion({ internalScAccepted: false, internalScConfirmedQuantity: null })], []);
  assert.equal(none.confirmation.kind, 'NotSubmitted'); assert.equal(none.internalScAccepted, null);
  assert.equal(none.executionUnits[0].portions[0].internalScConfirmed, null);
  const full = buildW01ViewModel({ ...work, accepted: true }, object, [internalScInspection], [unit], [portion({ internalScConfirmedQuantity: '500.0000' })]);
  assert.equal(full.confirmation.kind, 'Accepted'); assert.equal(full.internalScAccepted?.value, '500');
});
