import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Permission, hasPermission } from '../packages/domain';
import {
  applyRegistry, buildAdminUserRows, DEFAULT_QUERY, matchesSearch, registryOptions, rowInTab, sortOptionsFor, tabCounts, bitrixStateOf,
  type RegistryQuery,
} from '../apps/frontend/src/view-models/adminUsers';

const emp = (ID: string, LAST_NAME: string, NAME: string, extra: any = {}) => ({ ID, NAME, LAST_NAME, ACTIVE: true, WORK_POSITION: null, UF_DEPARTMENT: [], ...extra });
const core = (bitrixUserId: string, name: string, role: string, extra: any = {}) => ({ id: 'c' + bitrixUserId, name, role, bitrixUserId, isActive: true, version: 1, ...extra });
const depts = new Map([['5', 'Дирекция'], ['6', 'Производство']]);

const rows = buildAdminUserRows(
  [
    emp('1', 'Админов', 'Админ', { WORK_POSITION: 'Системный администратор', UF_DEPARTMENT: [5] }),
    emp('2', 'Громов', 'Николай', { WORK_POSITION: 'Начальник отдела', UF_DEPARTMENT: [6] }),
    emp('3', 'Петрова', 'Ирина', { WORK_POSITION: 'Генеральный директор', UF_DEPARTMENT: [5] }),
    emp('4', 'Ёлкина', 'Дарья', { UF_DEPARTMENT: [6] }),
    emp('5', 'Беляев', 'Олег', { ACTIVE: false, WORK_POSITION: 'Инженер ПТО', UF_DEPARTMENT: [6] }),
    emp('6', 'Уволенный', 'Сергей', { ACTIVE: false }),
  ],
  [
    core('1', 'Админов Админ', 'ADMIN', { email: 'admin@example.org' }),
    core('2', 'Громов Николай', 'PTO_HEAD'),
    core('5', 'Беляев Олег', 'PTO', { isActive: false }), // Core record disabled AND Bitrix-inactive: independent facts
    core('9', 'Только Core', 'SDO'),                       // not in the directory at all
  ],
  depts,
);
const q = (extra: Partial<RegistryQuery>): RegistryQuery => ({ ...DEFAULT_QUERY, ...extra });
const names = (r: typeof rows) => r.map((x) => x.displayName);

test('tabs: «В Core» = has a Core record; «Не добавлены» = active in Bitrix24, no record; «Неактивны» = ACTIVE=false in Bitrix24 (overlaps «В Core»)', () => {
  assert.deepEqual(names(applyRegistry(rows, q({ tab: 'core' }))), ['Админов Админ', 'Беляев Олег', 'Громов Николай', 'Только Core']);
  assert.deepEqual(names(applyRegistry(rows, q({ tab: 'notInCore' }))), ['Ёлкина Дарья', 'Петрова Ирина']);
  assert.deepEqual(names(applyRegistry(rows, q({ tab: 'inactive' }))), ['Беляев Олег', 'Уволенный Сергей']);
  assert.deepEqual(tabCounts(rows), { core: 4, notInCore: 2, inactive: 2 });
  const by = Object.fromEntries(rows.map((r) => [r.bitrixUserId, r]));
  assert.equal(rowInTab(by['5']!, 'core') && rowInTab(by['5']!, 'inactive'), true, 'overlap is intentional and visible in both');
  assert.equal(by['5']!.core!.isActive, false);
  assert.equal(bitrixStateOf(by['5']!), 'inactive');
  // Bitrix inactivity is never inferred from the Core flag: a disabled Core user active in Bitrix is NOT in the inactive tab
  const t = buildAdminUserRows([emp('1', 'А', 'Б')], [core('1', 'А Б', 'PTO', { isActive: false })], null);
  assert.equal(rowInTab(t[0]!, 'inactive'), false);
  assert.equal(bitrixStateOf(t[0]!), 'active');
  // a Core user missing from the directory is not "inactive in Bitrix24"; with no directory at all nothing is invented
  assert.equal(bitrixStateOf(by['9']!), 'unknown');
  assert.deepEqual(tabCounts(buildAdminUserRows(null, [core('1', 'А', 'PTO')], null)), { core: 1, notInCore: 0, inactive: 0 });
});

test('search: name, e-mail, position, department; case-insensitive, partial, ё≡е, multi-token', () => {
  const hit = (text: string, tab: RegistryQuery['tab'] = 'core') => names(applyRegistry(rows, q({ tab, search: text })));
  assert.deepEqual(hit('ГРОМ'), ['Громов Николай']);
  assert.deepEqual(hit('admin@EXAMPLE'), ['Админов Админ']);
  assert.deepEqual(hit('системн'), ['Админов Админ']);
  assert.deepEqual(hit('производ'), ['Беляев Олег', 'Громов Николай']);
  assert.deepEqual(hit('елкина', 'notInCore'), ['Ёлкина Дарья']);
  assert.deepEqual(hit('ёлкина', 'notInCore'), ['Ёлкина Дарья']);
  assert.deepEqual(hit('  николай   гром '), ['Громов Николай']);
  assert.deepEqual(hit('несуществует'), []);
  assert.equal(matchesSearch(rows[0]!, ''), true);
  assert.deepEqual(hit('громов', 'notInCore'), [], 'search stays inside the selected tab');
});

test('filters are derived from the tab data; role filter does not exist for «Не добавлены»', () => {
  assert.deepEqual(registryOptions(rows, 'core'), { departments: ['Дирекция', 'Производство'], roles: ['Администратор', 'Инженер ПТО', 'Начальник ПТО', 'Инженер-сметчик'].sort((a, b) => a.localeCompare(b, 'ru')), positions: ['Инженер ПТО', 'Начальник отдела', 'Системный администратор'] });
  assert.deepEqual(registryOptions(rows, 'notInCore').roles, []);
  assert.deepEqual(names(applyRegistry(rows, q({ department: 'Производство' }))), ['Беляев Олег', 'Громов Николай']);
  assert.deepEqual(names(applyRegistry(rows, q({ role: 'Начальник ПТО' }))), ['Громов Николай']);
  assert.deepEqual(names(applyRegistry(rows, q({ position: 'Инженер ПТО' }))), ['Беляев Олег']);
  assert.deepEqual(names(applyRegistry(rows, q({ department: 'Производство', search: 'о', role: 'Инженер ПТО' }))), ['Беляев Олег']);
});

test('sorting: А–Я, Я–А, подразделение, должность, роль — stable, empty values last', () => {
  assert.deepEqual(names(applyRegistry(rows, q({ sort: 'name-desc' }))), ['Только Core', 'Громов Николай', 'Беляев Олег', 'Админов Админ']);
  assert.deepEqual(names(applyRegistry(rows, q({ sort: 'position' }))), ['Беляев Олег', 'Громов Николай', 'Админов Админ', 'Только Core']);
  assert.deepEqual(names(applyRegistry(rows, q({ sort: 'department' }))), ['Админов Админ', 'Беляев Олег', 'Громов Николай', 'Только Core']);
  assert.equal(names(applyRegistry(rows, q({ sort: 'role' })))[0], 'Админов Админ');
  assert.deepEqual(names(applyRegistry(rows, q({ sort: 'name-asc' }))), names(applyRegistry([...rows].reverse(), q({ sort: 'name-asc' }))), 'input order never matters');
  assert.ok(!sortOptionsFor('notInCore').includes('role')); assert.ok(sortOptionsFor('core').includes('role'));
});

test('authorization: Users & Access stays ADMIN-only — Deputy Director has no ADMIN_USERS', () => {
  assert.equal(hasPermission('ADMIN' as any, Permission.ADMIN_USERS), true);
  for (const r of ['DEPUTY_DIRECTOR', 'GENERAL_DIRECTOR', 'PTO_HEAD', 'SDO_HEAD', 'CONSTRUCTION_CONTROL_HEAD', 'PTO', 'PROJECT_MANAGER']) assert.equal(hasPermission(r as any, Permission.ADMIN_USERS), false, r);
});
