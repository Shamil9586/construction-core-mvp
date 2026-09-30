import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canCreateObject } from '../apps/frontend/src/auth/internalRoles';
import {
  DUPLICATE_CODE_LABEL,
  EMPTY_DRAFT,
  NO_ACTIVE_PM_LABEL,
  NO_CONTRACTORS_LABEL,
  classifySubmitFailure,
  optionsState,
  toInput,
  validateDraft,
  type CreateObjectDraft,
} from '../apps/frontend/src/view-models/createObject';

const valid: CreateObjectDraft = { ...EMPTY_DRAFT, externalCode: ' LIVE-PBX3A-001 ', name: 'LIVE TEST — PBX-3A', address: 'Тест, 1', organizationName: 'ООО СЗ «Гор-Строй»', projectManagerId: 'pm-1', startDate: '2026-01-01', plannedFinishDate: '2026-02-01', contractValue: '0.00' };

test('OBJ-1 role helper: only DEPUTY_DIRECTOR and ADMIN see «Добавить объект»', () => {
  for (const role of ['DEPUTY_DIRECTOR', 'ADMIN']) assert.equal(canCreateObject(role), true, role);
  for (const role of ['PROJECT_MANAGER', 'GENERAL_DIRECTOR', 'TECHNICAL_DIRECTOR', 'PTO_HEAD', 'PTO', 'SDO', 'CONSTRUCTION_CONTROL', 'DEPARTMENT_HEAD', 'CONTRACTOR_VIEWER', '']) assert.equal(canCreateObject(role), false, role);
});

test('OBJ-1 options states: loading is caller-owned; no РП fails closed; no contractors is neutral, not an error', () => {
  assert.deepEqual(optionsState({ projectManagers: [], contractors: [{ id: 'c', name: 'C' }] }), { kind: 'NoProjectManager' });
  const none = optionsState({ projectManagers: [{ id: 'p', name: 'P' }], contractors: [] });
  assert.equal(none.kind, 'Ready');
  assert.equal(none.kind === 'Ready' && none.hasContractors, false);
  const some = optionsState({ projectManagers: [{ id: 'p', name: 'P' }], contractors: [{ id: 'c', name: 'C' }] });
  assert.equal(some.kind === 'Ready' && some.hasContractors, true);
  assert.equal(NO_ACTIVE_PM_LABEL, 'Нет активного РП для назначения.');
  assert.equal(NO_CONTRACTORS_LABEL, 'Подрядчики пока не заведены. Их можно назначить позже.');
});

test('OBJ-1 validation: required fields, date order, money; zero contractors and empty customer are valid', () => {
  assert.deepEqual(validateDraft(valid), {});
  const errors = validateDraft(EMPTY_DRAFT);
  for (const key of ['externalCode', 'name', 'address', 'organizationName', 'projectManagerId', 'startDate', 'plannedFinishDate', 'contractValue'] as const) assert.ok(errors[key], key);
  assert.equal(errors.customerName, undefined);
  assert.equal(errors.contractorIds, undefined);
  assert.ok(validateDraft({ ...valid, plannedFinishDate: '2025-12-31' }).plannedFinishDate);
  assert.equal(validateDraft({ ...valid, plannedFinishDate: '2026-01-01' }).plannedFinishDate, undefined, 'same-day finish is allowed');
  for (const bad of ['-1', 'abc', '1.234', '1e3']) assert.ok(validateDraft({ ...valid, contractValue: bad }).contractValue, bad);
  assert.equal(validateDraft({ ...valid, contractValue: '100,50' }).contractValue, undefined, 'decimal comma accepted');
  assert.ok(validateDraft({ ...valid, name: '   ' }).name, 'whitespace-only is empty');
});

test('OBJ-1 payload: trimmed, optional customerName omitted, contractorIds defaults to [], comma normalised', () => {
  const input = toInput({ ...valid, contractValue: '100,50' });
  assert.equal(input.externalCode, 'LIVE-PBX3A-001');
  assert.equal(input.contractValue, '100.50');
  assert.deepEqual(input.contractorIds, []);
  assert.equal('customerName' in input, false);
  assert.equal(toInput({ ...valid, customerName: ' Заказчик ', contractorIds: ['c1'] }).customerName, 'Заказчик');
});

test('OBJ-1 submit failure mapping: 409 → duplicate-code conflict, anything else → API error text', () => {
  assert.deepEqual(classifySubmitFailure(409, 'x'), { kind: 'DuplicateCode', message: DUPLICATE_CODE_LABEL });
  assert.deepEqual(classifySubmitFailure(400, 'Назначьте активного РП'), { kind: 'Api', message: 'Назначьте активного РП' });
  assert.equal(classifySubmitFailure(0, '').kind, 'Api');
});
