import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canViewCompanyStructure, canManageCompanyStructure } from '../apps/frontend/src/auth/internalRoles';
import { buildRedistributeCommand, orgExpectationLookup } from '../apps/frontend/src/view-models/teams';
import { reasonIsValid, targetManagers, positionTitle, FUNCTION_TITLE, employeeActions, ACTION_LABEL, departmentHeads, hasActiveHead, hasLocalHead, projectManagers, visibleUnresolved, unassignedEmployees, NO_HEAD_LABEL } from '../apps/frontend/src/view-models/orgStructure';

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

const emp = (id: string, extra: any = {}) => ({ userId: id, name: id, isActive: true, role: 'PTO', roleMatches: true, orgManagerUserId: null, startedAt: null, assignment: null, ...extra });
const mgr = (id: string, extra: any = {}) => ({ userId: id, name: id, isActive: true, role: 'PTO_HEAD', roleMatches: true, orgMembers: [], ...extra });

test('positions are human titles (no enum names, no prefixes)', () => {
  assert.equal(positionTitle('PTO_HEAD'), 'Начальник ПТО'); assert.equal(positionTitle('PTO'), 'Инженер ПТО');
  assert.equal(positionTitle('PROJECT_MANAGER'), 'Руководитель проекта'); assert.equal(positionTitle('DEPUTY_DIRECTOR'), 'Заместитель директора');
  assert.equal(positionTitle('CONSTRUCTION_CONTROL'), 'Инженер строительного контроля');
  assert.equal(positionTitle('TECHNICAL_DIRECTOR'), 'Должность не определена');
  assert.deepEqual(Object.values(FUNCTION_TITLE), ['ПТО', 'Строительный контроль', 'СДО', 'Руководители проектов']);
});

test('Project Managers: no local head, flat list, Deputy side never surfaced; PTO/SC/SDO keep head cards', () => {
  assert.equal(hasLocalHead('PROJECT_MANAGEMENT'), false);
  for (const fn of ['PTO', 'CONSTRUCTION_CONTROL', 'SDO'] as const) assert.equal(hasLocalHead(fn), true);
  const pm = { managers: [{ ...mgr('dep', { role: 'DEPUTY_DIRECTOR', orgMembers: [emp('b', { role: 'PROJECT_MANAGER' })] }) }], unassigned: [emp('a', { role: 'PROJECT_MANAGER' })] } as any;
  assert.deepEqual(projectManagers(pm).map((e) => e.userId), ['a', 'b']);
  const unresolved = [{ kind: 'MANAGER_UNAVAILABLE' }, { kind: 'MEMBER_UNAVAILABLE' }] as any;
  assert.deepEqual(visibleUnresolved({ functionCode: 'PROJECT_MANAGEMENT', unresolved }).map((u) => u.kind), ['MEMBER_UNAVAILABLE']);
  assert.equal(visibleUnresolved({ functionCode: 'PTO', unresolved }).length, 2);
});

test('missing head / empty exception group are derived from real data only', () => {
  assert.equal(NO_HEAD_LABEL, 'Руководитель подразделения не назначен');
  assert.equal(hasActiveHead({ managers: [] }), false);
  assert.equal(hasActiveHead({ managers: [mgr('x', { isActive: false })] as any }), false);
  assert.equal(hasActiveHead({ managers: [mgr('x')] as any }), true);
  assert.deepEqual(departmentHeads({ managers: [mgr('idle', { isActive: false }), mgr('busy', { isActive: false, orgMembers: [emp('e')] }), mgr('ok')] as any }).map((m) => m.userId), ['busy', 'ok']);
  assert.deepEqual(unassignedEmployees({ unassigned: [] }), [], 'nothing unassigned => no exception group content');
});

test('⋯ menu actions: business language only, derived from capability; no end-membership, no cross-function transfer', () => {
  const assigned = { assignment: { assignmentId: 'a', version: 1 }, orgManagerUserId: 'h' };
  const unassigned = { assignment: null, orgManagerUserId: null };
  assert.deepEqual(employeeActions({ fn: 'PTO', canManage: true, employee: assigned, hasTargets: true }), ['change-manager', 'history']);
  assert.deepEqual(employeeActions({ fn: 'PTO', canManage: true, employee: unassigned, hasTargets: true }), ['assign']);
  assert.deepEqual(employeeActions({ fn: 'PTO', canManage: false, employee: assigned, hasTargets: true }), ['history'], 'GD / heads: read-only');
  assert.deepEqual(employeeActions({ fn: 'PTO', canManage: true, employee: { assignment: null, orgManagerUserId: 'h' }, hasTargets: true }), ['history'], 'no assignment ref handed out => no mutation');
  assert.deepEqual(employeeActions({ fn: 'PTO', canManage: true, employee: assigned, hasTargets: false }), ['history']);
  assert.deepEqual(employeeActions({ fn: 'PROJECT_MANAGEMENT', canManage: true, employee: assigned, hasTargets: true }), ['history']);
  const labels = Object.values(ACTION_LABEL).join('|');
  assert.ok(!/Завершить|членств|Уволить|подразделение/.test(labels), labels);
  assert.deepEqual(Object.values(ACTION_LABEL).sort(), ['История изменений', 'Назначить руководителя', 'Сменить руководителя']);
});

test('target managers: active, exact role, not the current one; reason must be non-blank', () => {
  assert.equal(reasonIsValid('  '), false); assert.equal(reasonIsValid(' ок '), true);
  const group = { managers: [{ userId: 'a', name: 'A', isActive: true, roleMatches: true }, { userId: 'b', name: 'B', isActive: false, roleMatches: true }, { userId: 'c', name: 'C', isActive: true, roleMatches: false }, { userId: 'd', name: 'D', isActive: true, roleMatches: true }] } as any;
  assert.deepEqual(targetManagers(group, 'a'), [{ value: 'd', label: 'D' }]);
});
