import type { AdminCoreUser, BitrixEmployee } from '../data/adminUsersApi';
import { ADMIN_ASSIGNABLE_ROLES, adminRoleLabel } from '../auth/internalRoles';

/**
 * PBX-2 — one row per person on the «Пользователи и доступ» screen.
 *
 * Bitrix data (position, departments, ACTIVE) is descriptive context only and is
 * carried through as strings/flags for display. Nothing here derives, suggests or
 * changes a Core role from it — the role always comes from the Core user row.
 */
export type CoreAccessStatus = 'NotInCore' | 'Active' | 'Disabled';

export const CORE_STATUS_LABEL: Record<CoreAccessStatus, string> = {
  NotInCore: 'Не добавлен в Core',
  Active: 'Активен в Core',
  Disabled: 'Доступ отключён',
};

export interface AdminUserRow {
  key: string;
  bitrixUserId: string;
  displayName: string;
  /** Core-held e-mail, when the person has a Core record that carries one. */
  email: string | null;
  /** `false` only when the directory was read and the employee is ACTIVE=false there. */
  bitrixInactive: boolean;
  /** The Core user exists but the (successfully read) directory no longer lists that employee. */
  missingInDirectory: boolean;
  position: string | null;
  departments: string[];
  status: CoreAccessStatus;
  core: null | {
    id: string;
    role: string;
    roleLabel: string;
    /** CONTRACTOR_VIEWER: outside this internal screen — shown, not administrable. */
    external: boolean;
    isActive: boolean;
  };
}

export const employeeName = (e: Pick<BitrixEmployee, 'NAME' | 'LAST_NAME' | 'SECOND_NAME'>): string =>
  [e.LAST_NAME, e.NAME, e.SECOND_NAME].filter((part): part is string => !!part && part.trim().length > 0).join(' ');

export function departmentLabels(ids: number[], names: ReadonlyMap<string, string> | null): string[] {
  return ids.map((id) => names?.get(String(id)) ?? `Подразделение № ${id}`);
}

export function buildAdminUserRows(
  employees: readonly BitrixEmployee[] | null,
  coreUsers: readonly AdminCoreUser[],
  departmentNames: ReadonlyMap<string, string> | null,
): AdminUserRow[] {
  const coreByBitrixId = new Map(coreUsers.map((user) => [user.bitrixUserId, user]));
  const toCore = (user: AdminCoreUser): NonNullable<AdminUserRow['core']> => ({
    id: user.id,
    role: user.role,
    roleLabel: adminRoleLabel(user.role),
    external: user.role === 'CONTRACTOR_VIEWER',
    isActive: user.isActive,
  });
  const statusOf = (user: AdminCoreUser | undefined): CoreAccessStatus =>
    !user ? 'NotInCore' : user.isActive ? 'Active' : 'Disabled';

  const rows: AdminUserRow[] = [];
  const seen = new Set<string>();
  for (const employee of employees ?? []) {
    const core = coreByBitrixId.get(employee.ID);
    seen.add(employee.ID);
    rows.push({
      key: employee.ID,
      bitrixUserId: employee.ID,
      displayName: employeeName(employee) || `Сотрудник ${employee.ID}`,
      email: core?.email ?? null,
      bitrixInactive: employee.ACTIVE === false,
      missingInDirectory: false,
      position: employee.WORK_POSITION,
      departments: departmentLabels(employee.UF_DEPARTMENT, departmentNames),
      status: statusOf(core),
      core: core ? toCore(core) : null,
    });
  }
  // Core users the directory does not list (or every Core user when the directory
  // could not be read) stay visible — Core, not Bitrix, owns who is a Core user.
  for (const user of coreUsers) {
    if (seen.has(user.bitrixUserId)) continue;
    rows.push({
      key: user.bitrixUserId,
      bitrixUserId: user.bitrixUserId,
      displayName: user.name,
      email: user.email ?? null,
      bitrixInactive: false,
      missingInDirectory: employees !== null,
      position: null,
      departments: [],
      status: statusOf(user),
      core: toCore(user),
    });
  }
  return rows.sort((a, b) => a.displayName.localeCompare(b.displayName, 'ru'));
}

export interface RoleOption {
  value: (typeof ADMIN_ASSIGNABLE_ROLES)[number];
  label: string;
}

export const ASSIGNABLE_ROLE_OPTIONS: readonly RoleOption[] = ADMIN_ASSIGNABLE_ROLES.map((value) => ({
  value,
  label: adminRoleLabel(value),
}));

// ---------------------------------------------------------------------------
// Registry: tabs, search, filters, sorting. Pure functions over the rows above.
// ---------------------------------------------------------------------------
export type RegistryTab = 'core' | 'notInCore' | 'inactive';
export const REGISTRY_TABS: readonly { key: RegistryTab; label: string }[] = [
  { key: 'core', label: 'В Core' },
  { key: 'notInCore', label: 'Не добавлены в Core' },
  { key: 'inactive', label: 'Неактивны в Bitrix24' },
];

/**
 * Tab membership. The tabs are different questions and may overlap: «В Core» = has a Core record; «Не добавлены» = ACTIVE in the
 * (successfully read) directory with no Core record; «Неактивны в Bitrix24» = ACTIVE=false in the directory, whether or not a Core
 * record still exists. Bitrix inactivity is never inferred from the Core `isActive` flag.
 */
export function rowInTab(row: AdminUserRow, tab: RegistryTab): boolean {
  if (tab === 'core') return row.core !== null;
  if (tab === 'inactive') return row.bitrixInactive;
  return row.core === null && !row.bitrixInactive;
}

export const tabCounts = (rows: readonly AdminUserRow[]): Record<RegistryTab, number> => ({
  core: rows.filter((r) => rowInTab(r, 'core')).length,
  notInCore: rows.filter((r) => rowInTab(r, 'notInCore')).length,
  inactive: rows.filter((r) => rowInTab(r, 'inactive')).length,
});

export type RegistrySort = 'name-asc' | 'name-desc' | 'department' | 'position' | 'role';
export const SORT_LABEL: Record<RegistrySort, string> = {
  'name-asc': 'ФИО: А–Я',
  'name-desc': 'ФИО: Я–А',
  department: 'Подразделение',
  position: 'Должность',
  role: 'Роль в Core',
};
export const sortOptionsFor = (tab: RegistryTab): RegistrySort[] => (tab === 'notInCore' ? ['name-asc', 'name-desc', 'department', 'position'] : ['name-asc', 'name-desc', 'department', 'position', 'role']);

export interface RegistryQuery {
  tab: RegistryTab;
  search: string;
  department: string;
  role: string;
  position: string;
  sort: RegistrySort;
}
export const EMPTY_FILTERS = { department: '', role: '', position: '' } as const;
export const DEFAULT_QUERY: RegistryQuery = { tab: 'core', search: '', ...EMPTY_FILTERS, sort: 'name-asc' };

/** Case-insensitive, ё≡е, whitespace-insensitive. */
const norm = (value: string): string => value.toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

/** Every whitespace-separated token must occur in name, e-mail, position or any department (substring, not exact). */
export function matchesSearch(row: AdminUserRow, text: string): boolean {
  const tokens = norm(text).split(' ').filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = norm([row.displayName, row.email ?? '', row.position ?? '', ...row.departments].join(' \n '));
  return tokens.every((t) => haystack.includes(t));
}

export const roleFilterValue = (row: AdminUserRow): string => row.core?.roleLabel ?? '';

export interface RegistryOptions { departments: string[]; roles: string[]; positions: string[] }
/** Filter values come from the rows of the selected tab, never from a hard-coded list. */
export function registryOptions(rows: readonly AdminUserRow[], tab: RegistryTab): RegistryOptions {
  const inTab = rows.filter((r) => rowInTab(r, tab));
  const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
  return {
    departments: uniq(inTab.flatMap((r) => r.departments)),
    roles: tab === 'notInCore' ? [] : uniq(inTab.map(roleFilterValue)),
    positions: uniq(inTab.map((r) => r.position ?? '')),
  };
}

const cmp = (a: string, b: string) => a.localeCompare(b, 'ru');
/** Empty values sort last; ties fall back to the name, then the Bitrix id, so order is stable. */
const byField = (value: (r: AdminUserRow) => string) => (a: AdminUserRow, b: AdminUserRow) => {
  const x = value(a), y = value(b);
  if (!x !== !y) return x ? -1 : 1;
  return cmp(x, y) || cmp(a.displayName, b.displayName) || cmp(a.bitrixUserId, b.bitrixUserId);
};

export function applyRegistry(rows: readonly AdminUserRow[], q: RegistryQuery): AdminUserRow[] {
  const out = rows.filter((r) =>
    rowInTab(r, q.tab) &&
    matchesSearch(r, q.search) &&
    (!q.department || r.departments.includes(q.department)) &&
    (!q.position || r.position === q.position) &&
    (!q.role || roleFilterValue(r) === q.role));
  const sorters: Record<RegistrySort, (a: AdminUserRow, b: AdminUserRow) => number> = {
    'name-asc': (a, b) => cmp(a.displayName, b.displayName) || cmp(a.bitrixUserId, b.bitrixUserId),
    'name-desc': (a, b) => cmp(b.displayName, a.displayName) || cmp(a.bitrixUserId, b.bitrixUserId),
    department: byField((r) => r.departments.join(', ')),
    position: byField((r) => r.position ?? ''),
    role: byField(roleFilterValue),
  };
  return [...out].sort(sorters[q.sort]);
}

export const filtersActive = (q: RegistryQuery): boolean => !!(q.department || q.role || q.position);

export const BITRIX_STATE_LABEL = { active: 'Активен в Bitrix24', inactive: 'Неактивен в Bitrix24', unknown: 'Нет данных Bitrix24' } as const;
export const bitrixStateOf = (row: AdminUserRow): keyof typeof BITRIX_STATE_LABEL => (row.bitrixInactive ? 'inactive' : row.missingInDirectory ? 'unknown' : 'active');

export const EMPTY_TEXT: Record<RegistryTab, string> = {
  core: 'В Core пока нет пользователей',
  notInCore: 'Все активные сотрудники Bitrix24 уже добавлены в Core',
  inactive: 'Неактивных пользователей Bitrix24 нет',
};
export const NO_RESULTS_TEXT = 'Сотрудники не найдены';
