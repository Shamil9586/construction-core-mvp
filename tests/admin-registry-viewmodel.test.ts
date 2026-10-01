import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Permission, hasPermission } from '../packages/domain';
import {
  applyRegistry, buildAdminUserRows, DEFAULT_QUERY, matchesSearch, registryOptions, rowInTab, sortOptionsFor, tabCounts, bitrixStateOf,
  type RegistryQuery,
} from '../apps/frontend/src/view-models/adminUsers';

const emp = (ID: string, LAST_NAME: string, NAME: string, extra: any = {}) => ({ ID, NAME, LAST_NAME, ACTIVE: true, WORK_POSITION: null, UF_DEPARTMENT: [], ...extra });
const core = (bitrixUserId: string, name: string, role: string, extra: any = {}) => ({ id: 'c' + bitrixUserId, name, role, bitrixUserId, isActive: true, version: 1, ...extra });

// The directory still carries WORK_POSITION / UF_DEPARTMENT (global contract); the registry must ignore them completely.
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
);
const q = (extra: Partial<RegistryQuery>): RegistryQuery => ({ ...DEFAULT_QUERY, ...extra });
const names = (r: typeof rows) => r.map((x) => x.displayName);

test('registry rows carry no Bitrix position / department at all', () => {
  for (const r of rows) {
    assert.ok(!('position' in r) && !('departments' in r), r.displayName);
    assert.ok(!JSON.stringify(r).match(/Системный администратор|Начальник отдела|Дирекция|Производство|Генеральный директор/), r.displayName);
  }
  assert.deepEqual(Object.keys(DEFAULT_QUERY).sort(), ['role', 'search', 'sort', 'tab']);
});

test('tabs keep their semantics: «В Core» = Core record; «Не добавлены» = active in Bitrix24, no record; «Неактивны» = ACTIVE=false (overlaps «В Core»)', () => {
  assert.deepEqual(names(applyRegistry(rows, q({ tab: 'core' }))), ['Админов Админ', 'Беляев Олег', 'Громов Николай', 'Только Core']);
  assert.deepEqual(names(applyRegistry(rows, q({ tab: 'notInCore' }))), ['Ёлкина Дарья', 'Петрова Ирина']);
  assert.deepEqual(names(applyRegistry(rows, q({ tab: 'inactive' }))), ['Беляев Олег', 'Уволенный Сергей']);
  assert.deepEqual(tabCounts(rows), { core: 4, notInCore: 2, inactive: 2 });
  const by = Object.fromEntries(rows.map((r) => [r.bitrixUserId, r]));
  assert.equal(rowInTab(by['5']!, 'core') && rowInTab(by['5']!, 'inactive'), true);
  assert.equal(by['5']!.core!.isActive, false);
  assert.equal(bitrixStateOf(by['5']!), 'inactive');
  const t = buildAdminUserRows([emp('1', 'А', 'Б')], [core('1', 'А Б', 'PTO', { isActive: false })]);
  assert.equal(rowInTab(t[0]!, 'inactive'), false, 'Bitrix inactivity is never inferred from the Core flag');
  assert.equal(bitrixStateOf(by['9']!), 'unknown');
  assert.deepEqual(tabCounts(buildAdminUserRows(null, [core('1', 'А', 'PTO')])), { core: 1, notInCore: 0, inactive: 0 });
});

test('search matches ONLY name and Core-held e-mail (case-insensitive, partial, ё≡е, multi-token) — never position or department', () => {
  const hit = (text: string, tab: RegistryQuery['tab'] = 'core') => names(applyRegistry(rows, q({ tab, search: text })));
  assert.deepEqual(hit('ГРОМ'), ['Громов Николай']);
  assert.deepEqual(hit('  николай   гром '), ['Громов Николай']);
  assert.deepEqual(hit('admin@EXAMPLE'), ['Админов Админ']);
  assert.deepEqual(hit('елкина', 'notInCore'), ['Ёлкина Дарья']);
  assert.deepEqual(hit('ёлкина', 'notInCore'), ['Ёлкина Дарья']);
  // position / department words no longer match anything
  for (const word of ['системн', 'начальник отдела', 'инженер пто', 'дирекц', 'производ', 'генеральный']) assert.deepEqual(hit(word), [], word);
  assert.deepEqual(hit('несуществует'), []);
  assert.equal(matchesSearch(rows[0]!, ''), true);
  assert.deepEqual(hit('громов', 'notInCore'), [], 'search stays inside the selected tab');
});

test('the only filter is the Core role; it does not exist for «Не добавлены»; options come from the tab data', () => {
  assert.deepEqual(registryOptions(rows, 'core'), { roles: ['Администратор', 'Инженер ПТО', 'Начальник ПТО', 'Инженер-сметчик'].sort((a, b) => a.localeCompare(b, 'ru')) });
  assert.deepEqual(registryOptions(rows, 'notInCore'), { roles: [] });
  assert.deepEqual(registryOptions(rows, 'inactive'), { roles: ['Инженер ПТО'] }, 'inactive tab: only rows that have a Core record contribute');
  assert.deepEqual(names(applyRegistry(rows, q({ role: 'Начальник ПТО' }))), ['Громов Николай']);
  assert.deepEqual(names(applyRegistry(rows, q({ tab: 'inactive', role: 'Инженер ПТО' }))), ['Беляев Олег']);
  assert.deepEqual(names(applyRegistry(rows, q({ role: 'Инженер ПТО', search: 'олег' }))), ['Беляев Олег']);
});

test('sorting: ФИО А–Я (default), Я–А, and Core role where it exists — no department / position sort', () => {
  assert.equal(DEFAULT_QUERY.sort, 'name-asc');
  assert.deepEqual(names(applyRegistry(rows, q({ sort: 'name-desc' }))), ['Только Core', 'Громов Николай', 'Беляев Олег', 'Админов Админ']);
  assert.equal(names(applyRegistry(rows, q({ sort: 'role' })))[0], 'Админов Админ');
  assert.equal(names(applyRegistry(rows, q({ tab: 'inactive', sort: 'role' })))[0], 'Беляев Олег', 'rows without a Core role sort last');
  assert.deepEqual(names(applyRegistry(rows, q({ sort: 'name-asc' }))), names(applyRegistry([...rows].reverse(), q({ sort: 'name-asc' }))), 'input order never matters');
  assert.deepEqual(sortOptionsFor('core'), ['name-asc', 'name-desc', 'role']);
  assert.deepEqual(sortOptionsFor('inactive'), ['name-asc', 'name-desc', 'role']);
  assert.deepEqual(sortOptionsFor('notInCore'), ['name-asc', 'name-desc']);
});

test('authorization: Users & Access stays ADMIN-only — Deputy Director has no ADMIN_USERS', () => {
  assert.equal(hasPermission('ADMIN' as any, Permission.ADMIN_USERS), true);
  for (const r of ['DEPUTY_DIRECTOR', 'GENERAL_DIRECTOR', 'PTO_HEAD', 'SDO_HEAD', 'CONSTRUCTION_CONTROL_HEAD', 'PTO', 'PROJECT_MANAGER']) assert.equal(hasPermission(r as any, Permission.ADMIN_USERS), false, r);
});
