import type { AdminCoreUser, BitrixEmployee } from '../data/adminUsersApi';
import { ADMIN_ASSIGNABLE_ROLES, LEGACY_ONLY_ROLES, adminRoleLabel } from '../auth/internalRoles';

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
    /** TECHNICAL_DIRECTOR / DEPARTMENT_HEAD: readable, never offered as a target. */
    legacyRole: boolean;
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
    legacyRole: (LEGACY_ONLY_ROLES as readonly string[]).includes(user.role),
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
