import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INTERNAL_ASSIGNABLE_ROLES, CURRENT_ASSIGNABLE_ROLES } from '../packages/domain';
import { ADMIN_ASSIGNABLE_ROLES, adminRoleLabel, canAdministerUsers } from '../apps/frontend/src/auth/internalRoles';
import { buildAdminUserRows, ASSIGNABLE_ROLE_OPTIONS } from '../apps/frontend/src/view-models/adminUsers';

const emp = (ID: string, extra: any = {}) => ({ ID, NAME: 'Имя' + ID, LAST_NAME: 'Фам' + ID, ACTIVE: true, WORK_POSITION: null, UF_DEPARTMENT: [], ...extra });
const core = (bitrixUserId: string, role: string, isActive = true) => ({ id: 'c' + bitrixUserId, name: 'Core ' + bitrixUserId, role, bitrixUserId, isActive, version: 1 });

test('PBX-2 frontend role list mirrors the backend internal-assignable list', () => {
  assert.deepEqual([...ADMIN_ASSIGNABLE_ROLES], [...INTERNAL_ASSIGNABLE_ROLES]);
  assert.ok(!(ADMIN_ASSIGNABLE_ROLES as readonly string[]).includes('TECHNICAL_DIRECTOR'));
  assert.ok(!(ADMIN_ASSIGNABLE_ROLES as readonly string[]).includes('CONTRACTOR_VIEWER'));
  assert.ok((CURRENT_ASSIGNABLE_ROLES as readonly string[]).includes('CONTRACTOR_VIEWER'), 'the legacy POST /users list is untouched');
  assert.equal(ASSIGNABLE_ROLE_OPTIONS.length, 8);
});

test('PBX-2 role labels are Russian for every role, never a raw enum', () => {
  for (const r of ['GENERAL_DIRECTOR', 'TECHNICAL_DIRECTOR', 'DEPUTY_DIRECTOR', 'ADMIN', 'CONTRACTOR_VIEWER', 'WHATEVER']) assert.match(adminRoleLabel(r), /[А-Яа-я]/);
  assert.equal(adminRoleLabel('DEPUTY_DIRECTOR'), 'Заместитель директора');
  assert.equal(canAdministerUsers('ADMIN'), true);
  for (const r of ['PTO', 'GENERAL_DIRECTOR', 'DEPUTY_DIRECTOR', 'CONTRACTOR_VIEWER', '']) assert.equal(canAdministerUsers(r), false);
});

test('PBX-2 rows: statuses, Bitrix context never yields a role, legacy role flagged', () => {
  const employees = [emp('1', { WORK_POSITION: 'Генеральный директор', UF_DEPARTMENT: [5] }), emp('2'), emp('3'), emp('4', { ACTIVE: false }), emp('5')];
  const rows = buildAdminUserRows(employees, [core('2', 'PTO'), core('3', 'SDO', false), core('5', 'TECHNICAL_DIRECTOR')], new Map([['5', 'Дирекция']]));
  const by = Object.fromEntries(rows.map((r) => [r.bitrixUserId, r]));
  assert.equal(by['1'].status, 'NotInCore');
  assert.equal(by['1'].core, null, 'a director title never creates a Core role');
  assert.deepEqual(by['1'].departments, ['Дирекция']);
  assert.equal(by['2'].status, 'Active');
  assert.equal(by['3'].status, 'Disabled');
  assert.equal(by['4'].bitrixInactive, true);
  assert.equal(by['5'].core!.legacyRole, true);
  assert.equal(by['5'].core!.roleLabel, 'Технический директор');
  assert.deepEqual(buildAdminUserRows([emp('9', { UF_DEPARTMENT: [7] })], [], null)[0].departments, ['Подразделение № 7']);
});

test('PBX-2 rows: directory unavailable keeps Core users and does not flag them missing; loaded directory flags orphans', () => {
  const unavailable = buildAdminUserRows(null, [core('1', 'PTO')], null);
  assert.equal(unavailable.length, 1);
  assert.equal(unavailable[0].missingInDirectory, false);
  const loaded = buildAdminUserRows([], [core('1', 'PTO')], null);
  assert.equal(loaded[0].missingInDirectory, true);
  assert.equal(loaded[0].status, 'Active');
});
