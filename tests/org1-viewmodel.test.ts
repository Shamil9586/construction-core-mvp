import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canViewCompanyStructure, canManageCompanyStructure } from '../apps/frontend/src/auth/internalRoles';
import { buildRedistributeCommand, orgExpectationLookup } from '../apps/frontend/src/view-models/teams';
import { reasonIsValid, targetManagers, roleLabel, objectRelationText, FUNCTION_TITLE } from '../apps/frontend/src/view-models/orgStructure';

test('ORG-1 screen predicates: leadership + functional heads see the screen, only Deputy/Admin mutate, nobody else', () => {
  for (const r of ['GENERAL_DIRECTOR', 'DEPUTY_DIRECTOR', 'ADMIN', 'PTO_HEAD', 'CONSTRUCTION_CONTROL_HEAD', 'SDO_HEAD']) assert.equal(canViewCompanyStructure(r), true, r);
  for (const r of ['PTO', 'SDO', 'CONSTRUCTION_CONTROL', 'PROJECT_MANAGER', 'CONTRACTOR_VIEWER', 'TECHNICAL_DIRECTOR', 'DEPARTMENT_HEAD', '']) assert.equal(canViewCompanyStructure(r), false, r);
  assert.deepEqual(['GENERAL_DIRECTOR', 'DEPUTY_DIRECTOR', 'ADMIN', 'PTO_HEAD', 'PTO', 'PROJECT_MANAGER'].filter(canManageCompanyStructure), ['DEPUTY_DIRECTOR', 'ADMIN']);
});

test('redistribution command carries the exact (assignment id, version) the screen read for transfer/end', () => {
  const overview = { heads: [{ userId: 'h1', name: 'H', isActive: false, role: 'PTO_HEAD', ledObjects: [], orgMembers: [{ userId: 'e1', name: 'E', isActive: true, assignmentId: 'a1', version: 3, startedAt: '' }] }] } as any;
  const cmd = buildRedistributeCommand('причина', [{ kind: 'orgTransfer', memberUserId: 'e1', toManagerUserId: 'h2' }, { kind: 'orgEnd', memberUserId: 'e1' }, { kind: 'orgTransfer', memberUserId: 'new', toManagerUserId: 'h2' }], orgExpectationLookup(overview));
  assert.deepEqual(cmd.orgTransfers[0], { memberUserId: 'e1', toManagerUserId: 'h2', expectedAssignmentId: 'a1', expectedVersion: 3 });
  assert.deepEqual(cmd.orgEnds[0], { memberUserId: 'e1', expectedAssignmentId: 'a1', expectedVersion: 3 });
  assert.deepEqual(cmd.orgTransfers[1], { memberUserId: 'new', toManagerUserId: 'h2' }, 'initial assignment: no precondition');
});

test('org-structure view-model: reason, target managers, Russian labels without storage names', () => {
  assert.equal(reasonIsValid('  '), false); assert.equal(reasonIsValid(' ок '), true);
  const group = { managers: [{ userId: 'a', name: 'A', isActive: true, roleMatches: true }, { userId: 'b', name: 'B', isActive: false, roleMatches: true }, { userId: 'c', name: 'C', isActive: true, roleMatches: false }, { userId: 'd', name: 'D', isActive: true, roleMatches: true }] } as any;
  assert.deepEqual(targetManagers(group, 'a'), [{ value: 'd', label: 'D' }]);
  assert.equal(roleLabel('PTO_HEAD'), 'Начальник ПТО'); assert.equal(roleLabel('TECHNICAL_DIRECTOR'), 'Роль не определена');
  assert.equal(objectRelationText({ relation: 'PROJECT_MANAGER' } as any), 'руководитель проекта объекта');
  assert.deepEqual(Object.values(FUNCTION_TITLE), ['ПТО', 'Строительный контроль', 'СДО', 'Руководители проектов']);
  for (const t of Object.values(FUNCTION_TITLE)) assert.ok(!/_/.test(t));
});
