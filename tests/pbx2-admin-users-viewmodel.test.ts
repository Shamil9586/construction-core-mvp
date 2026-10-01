import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INTERNAL_ASSIGNABLE_ROLES, CURRENT_ASSIGNABLE_ROLES } from '../packages/domain';
import { ADMIN_ASSIGNABLE_ROLES, adminRoleLabel, canAdministerUsers } from '../apps/frontend/src/auth/internalRoles';
import { buildAdminUserRows, ASSIGNABLE_ROLE_OPTIONS } from '../apps/frontend/src/view-models/adminUsers';

const emp = (ID: string, extra: any = {}) => ({ ID, NAME: 'Имя' + ID, LAST_NAME: 'Фам' + ID, ACTIVE: true, WORK_POSITION: null, UF_DEPARTMENT: [], ...extra });
const core = (bitrixUserId: string, role: string, isActive = true) => ({ id: 'c' + bitrixUserId, name: 'Core ' + bitrixUserId, role, bitrixUserId, isActive, version: 1 });

test('PBX-2 frontend role list mirrors the backend internal-assignable list', () => {
  assert.deepEqual([...ADMIN_ASSIGNABLE_ROLES], [...INTERNAL_ASSIGNABLE_ROLES]);
  for (const legacyOrExternal of ['TECHNICAL_DIRECTOR', 'DEPARTMENT_HEAD', 'CONTRACTOR_VIEWER']) { // removed roles + external participant
    assert.ok(!(ADMIN_ASSIGNABLE_ROLES as readonly string[]).includes(legacyOrExternal), legacyOrExternal);
    assert.ok(!(INTERNAL_ASSIGNABLE_ROLES as readonly string[]).includes(legacyOrExternal), legacyOrExternal);
  }
  for (const removed of ['TECHNICAL_DIRECTOR', 'DEPARTMENT_HEAD']) assert.ok(!(CURRENT_ASSIGNABLE_ROLES as readonly string[]).includes(removed), removed);
  assert.ok((CURRENT_ASSIGNABLE_ROLES as readonly string[]).includes('CONTRACTOR_VIEWER'), 'the general POST /users external path is untouched');
  for (const head of ['PTO_HEAD', 'CONSTRUCTION_CONTROL_HEAD', 'SDO_HEAD']) assert.ok((CURRENT_ASSIGNABLE_ROLES as readonly string[]).includes(head), head);
  assert.equal(ASSIGNABLE_ROLE_OPTIONS.length, 10);
});

test('PBX-2 role labels are the locked Russian labels for every role, never a raw enum', () => {
  const labels: Record<string, string> = {
    GENERAL_DIRECTOR: 'Генеральный директор',
    DEPUTY_DIRECTOR: 'Заместитель директора',
    PROJECT_MANAGER: 'Руководитель проекта',
    CONSTRUCTION_CONTROL: 'Строительный контроль',
    CONSTRUCTION_CONTROL_HEAD: 'Начальник СК',
    PTO: 'Инженер ПТО',
    PTO_HEAD: 'Начальник ПТО',
    SDO: 'Инженер-сметчик',
    SDO_HEAD: 'Начальник СДО',
    ADMIN: 'Администратор',
  };
  for (const [role, label] of Object.entries(labels)) assert.equal(adminRoleLabel(role), label, role);
  for (const r of ['CONTRACTOR_VIEWER', 'WHATEVER']) assert.match(adminRoleLabel(r), /[А-Яа-я]/);
  assert.deepEqual(
    ASSIGNABLE_ROLE_OPTIONS.map((o) => o.label),
    ['Генеральный директор', 'Заместитель директора', 'Руководитель проекта', 'Строительный контроль', 'Начальник СК', 'Инженер ПТО', 'Начальник ПТО', 'Инженер-сметчик', 'Начальник СДО', 'Администратор'],
  );
  assert.equal(canAdministerUsers('ADMIN'), true);
  for (const r of ['PTO', 'PTO_HEAD', 'SDO_HEAD', 'CONSTRUCTION_CONTROL_HEAD', 'GENERAL_DIRECTOR', 'DEPUTY_DIRECTOR', 'CONTRACTOR_VIEWER', '']) assert.equal(canAdministerUsers(r), false, r);
});

test('PBX-2 rows: statuses, Bitrix context never yields a role', () => {
  const employees = [emp('1', { WORK_POSITION: 'Генеральный директор', UF_DEPARTMENT: [5] }), emp('2'), emp('3'), emp('4', { ACTIVE: false }), emp('5')];
  const rows = buildAdminUserRows(employees, [core('2', 'PTO'), core('3', 'SDO', false), core('5', 'DEPUTY_DIRECTOR')]);
  const by = Object.fromEntries(rows.map((r) => [r.bitrixUserId, r]));
  assert.equal(by['1'].status, 'NotInCore');
  assert.equal(by['1'].core, null, 'a director title never creates a Core role');
  assert.ok(!('position' in by['1']) && !('departments' in by['1']), 'Bitrix position/department are not part of the Core registry rows');
  assert.equal(by['2'].status, 'Active');
  assert.equal(by['3'].status, 'Disabled');
  assert.equal(by['4'].bitrixInactive, true);
  assert.equal(by['5'].core!.roleLabel, 'Заместитель директора');
});

test('PBX-2 rows: directory unavailable keeps Core users and does not flag them missing; loaded directory flags orphans', () => {
  const unavailable = buildAdminUserRows(null, [core('1', 'PTO')]);
  assert.equal(unavailable.length, 1);
  assert.equal(unavailable[0].missingInDirectory, false);
  const loaded = buildAdminUserRows([], [core('1', 'PTO')]);
  assert.equal(loaded[0].missingInDirectory, true);
  assert.equal(loaded[0].status, 'Active');
});
