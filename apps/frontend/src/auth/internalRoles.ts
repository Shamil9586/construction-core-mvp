import type { Role } from '../types/api';

/**
 * F7 — which roles the internal Core application serves (Architecture
 * Decisions 3 and 4).
 *
 * Core is the company's internal application. `CONTRACTOR_VIEWER` is the
 * external-participant role (the legacy role picker labels it «Субподрядчик»),
 * and external/subcontractor access is a separate, later product phase — so it
 * is neither offered by Core's test sign-in nor treated as a Core user when an
 * existing session carrying it reaches Core.
 *
 * This is a product-scope guard, not a security boundary. What any session may
 * read is decided by the backend (`ReadService.snapshot()` already scopes
 * `CONTRACTOR_VIEWER` to its own contractor); nothing here grants or widens
 * access, it only declines to present the internal application to a role it
 * was not built for.
 *
 * The list is an explicit allowlist rather than "everything except
 * CONTRACTOR_VIEWER": a role this code does not know (a future role, or a value
 * the `Role` union does not list) is unrecognised, not internal — an unknown
 * reading never resolves to the permissive answer.
 */
export const INTERNAL_CORE_ROLES = [
  'GENERAL_DIRECTOR',
  'TECHNICAL_DIRECTOR',
  'PROJECT_MANAGER',
  'CONSTRUCTION_CONTROL',
  // PBX-2 corrective: current department-head roles.
  'CONSTRUCTION_CONTROL_HEAD',
  'PTO',
  'PTO_HEAD',
  'SDO',
  'SDO_HEAD',
  'ADMIN',
  // Legacy-compatible: an existing session may carry it; never a new choice.
  'DEPARTMENT_HEAD',
  // F12.3 (LOCKED DECISION 1): the canonical current managerial role.
  'DEPUTY_DIRECTOR',
] as const satisfies readonly Role[];

export type InternalCoreRole = (typeof INTERNAL_CORE_ROLES)[number];

/** The one external-participant role the backend defines today. */
export const EXTERNAL_PARTICIPANT_ROLE = 'CONTRACTOR_VIEWER' satisfies Role;

/**
 * F12.3 FINAL-R05: the roles Core's test sign-in offers for a NEW mock
 * session, distinct from `INTERNAL_CORE_ROLES` above.
 *
 * `INTERNAL_CORE_ROLES` answers two different questions at once: which roles
 * an EXISTING session may carry (it must keep legacy `TECHNICAL_DIRECTOR` for
 * that — sessions already authenticated with it must keep working), and
 * which roles a NEW sign-in should offer. `DEPUTY_DIRECTOR` is the canonical
 * CURRENT managerial role (LOCKED DECISION 1); `TECHNICAL_DIRECTOR` is
 * legacy-only and must not be presented as a normal current choice, so a new
 * mock sign-in needs the narrower list below instead. `CONTRACTOR_VIEWER` is
 * already excluded by construction — `INTERNAL_CORE_ROLES` is itself an
 * explicit allowlist that never contains it (see the test pinning this) — so
 * filtering out `TECHNICAL_DIRECTOR` alone is sufficient here.
 *
 * The backend's own `POST /users` draws the same distinction with
 * `CURRENT_ASSIGNABLE_ROLES` (packages/domain); this is that same current/
 * legacy split, kept for the one other place Core offers a role as a new
 * choice rather than reading one an existing user already has.
 */
export const LEGACY_ONLY_ROLES: readonly InternalCoreRole[] = ['TECHNICAL_DIRECTOR', 'DEPARTMENT_HEAD'];

export const CURRENT_MOCK_SIGN_IN_ROLES: readonly InternalCoreRole[] = INTERNAL_CORE_ROLES.filter(
  (role) => !LEGACY_ONLY_ROLES.includes(role),
);

/** The same Russian wording the legacy entry shows for these roles (main.tsx `roleNames`). */
export const INTERNAL_ROLE_LABELS: Record<InternalCoreRole, string> = {
  GENERAL_DIRECTOR: 'Генеральный директор',
  TECHNICAL_DIRECTOR: 'Технический директор',
  PROJECT_MANAGER: 'Руководитель проекта',
  CONSTRUCTION_CONTROL: 'Строительный контроль',
  CONSTRUCTION_CONTROL_HEAD: 'Начальник СК',
  // Role labels only — the ПТО / СДО departments and workspaces keep their names.
  PTO: 'Инженер ПТО',
  PTO_HEAD: 'Начальник ПТО',
  SDO: 'Инженер-сметчик',
  SDO_HEAD: 'Начальник СДО',
  ADMIN: 'Администратор',
  DEPARTMENT_HEAD: 'Руководитель направления',
  DEPUTY_DIRECTOR: 'Заместитель директора',
};

export type CoreRoleAccess =
  | { kind: 'Internal'; role: InternalCoreRole }
  | { kind: 'External' }
  | { kind: 'Unrecognized' };

export function isInternalCoreRole(role: string): role is InternalCoreRole {
  return (INTERNAL_CORE_ROLES as readonly string[]).includes(role);
}

export function classifyCoreRole(role: string): CoreRoleAccess {
  if (isInternalCoreRole(role)) return { kind: 'Internal', role };
  if (role === EXTERNAL_PARTICIPANT_ROLE) return { kind: 'External' };
  return { kind: 'Unrecognized' };
}

/**
 * F8.2.1 — mirrors the backend's own `canAccessDocumentation()`
 * (`packages/domain`): SDO has no F8.2/F8.2.1 access at all ("SDO: Нет
 * доступа"), and `CONTRACTOR_VIEWER` is the external-participant role Core
 * does not serve to begin with (`classifyCoreRole`, above). Used to hide the
 * "ПТО" sidebar item and to show an explicit access-denied state instead of
 * a P01 table, package detail screen or W01 documentation section that would
 * otherwise render as if nothing needed attention or no package existed yet
 * — a real, misleading claim, not merely an absent one, for a role whose
 * snapshot never carries this data at all.
 */
export function canAccessDocumentation(role: string): boolean {
  return !isSdoRole(role) && role !== 'CONTRACTOR_VIEWER';
}

/**
 * F8.2.1 Decision 3 — only PTO creates or manages a Documentation Package,
 * its documents, versions and status; every other role's own access is
 * view-only or none. ADMIN is included because it already holds every
 * backend permission including `DOCUMENTATION_MANAGE` (`packages/domain`'s
 * own `grants` table grants it `Object.values(Permission)`) — omitting it
 * here would leave an ADMIN session unable to use a feature the backend
 * already lets it use. One shared predicate (Decision 1) for P01, the
 * package detail screen and W01's own create/open actions; the backend
 * remains the sole enforcer regardless — this only decides which controls a
 * route renders.
 */
export function canManageDocumentation(role: string): boolean {
  return isPtoRole(role) || role === 'ADMIN';
}

/**
 * F8.3 — mirrors the backend's own `canAccessSdoWorkspace()`
 * (`packages/domain`): the `/sdo` operational workspace (upcoming packages
 * queue, active SDO Cases, case detail actions) is SDO/ADMIN only — a
 * mirror-image predicate from `canAccessDocumentation` above, not a reuse of
 * it (SDO is explicitly excluded there, explicitly included here). Every
 * other internal role still reads SDO Case state read-only elsewhere (W01,
 * Package Detail) via the snapshot's own `sdoClosingCases`/
 * `sdoPackageReadiness`, gated only by `canAccessDocumentation`/nothing at
 * all — never by this predicate.
 */
export function canAccessSdoWorkspace(role: string): boolean {
  return isSdoRole(role) || role === 'ADMIN';
}

/**
 * PBX-2 — the roles the «Пользователи и доступ» screen offers as a TARGET, in
 * display order. Mirrors the backend's `INTERNAL_ASSIGNABLE_ROLES`
 * (packages/domain; a test pins the two together). Deliberately excludes
 * legacy `TECHNICAL_DIRECTOR` and `DEPARTMENT_HEAD` (an existing user keeps them and they stay readable,
 * but they are never a choice) and `CONTRACTOR_VIEWER` (external participant,
 * outside the internal Bitrix Core contour).
 */
export const ADMIN_ASSIGNABLE_ROLES = [
  'GENERAL_DIRECTOR',
  'DEPUTY_DIRECTOR',
  'PROJECT_MANAGER',
  'CONSTRUCTION_CONTROL',
  'CONSTRUCTION_CONTROL_HEAD',
  'PTO',
  'PTO_HEAD',
  'SDO',
  'SDO_HEAD',
  'ADMIN',
] as const satisfies readonly InternalCoreRole[];

export type AdminAssignableRole = (typeof ADMIN_ASSIGNABLE_ROLES)[number];

/** Russian role label for the admin screen — never a raw enum name. */
export function adminRoleLabel(role: string): string {
  if (isInternalCoreRole(role)) return INTERNAL_ROLE_LABELS[role];
  if (role === EXTERNAL_PARTICIPANT_ROLE) return 'Внешний участник';
  return 'Неизвестная роль';
}

/**
 * The head roles carry the same operational bundle as their department's
 * engineer role until object-responsibility exists (mirrors the backend's
 * `isPtoRole` / `isSdoRole` in packages/domain).
 */
export const isPtoRole = (role: string): boolean => role === 'PTO' || role === 'PTO_HEAD';
export const isSdoRole = (role: string): boolean => role === 'SDO' || role === 'SDO_HEAD';

/** Only ADMIN administers users; the backend enforces ADMIN_USERS independently. */
export function canAdministerUsers(role: string): boolean {
  return role === 'ADMIN';
}

/**
 * PBX-3A — «Команды и объекты»: leadership sees the PTO teams (GENERAL_DIRECTOR
 * read-only); only DEPUTY_DIRECTOR and ADMIN may redistribute. The backend
 * (FUNCTION_TEAM_MANAGE / OBJECT_FUNCTION_LEAD_ASSIGN) enforces both independently.
 */
export const canViewTeamsOverview = (role: string): boolean => role === 'DEPUTY_DIRECTOR' || role === 'GENERAL_DIRECTOR' || role === 'ADMIN';
export const canRedistributeTeams = (role: string): boolean => role === 'DEPUTY_DIRECTOR' || role === 'ADMIN';
/** «Моя команда ПТО» — PTO_HEAD manages, PTO reads its own objects. */
export const canViewMyPtoTeam = (role: string): boolean => role === 'PTO_HEAD' || role === 'PTO';
/** May read the PTO block on an object screen (backend: PTO_TEAM_READ). */
export const canViewObjectPtoTeam = (role: string): boolean => canViewTeamsOverview(role) || canViewMyPtoTeam(role);

/**
 * OBJ-1 — «Добавить объект»: creating an object appoints its РП, a managerial act of the
 * Deputy Director (ADMIN = system override). PROJECT_MANAGER, GENERAL_DIRECTOR and legacy
 * TECHNICAL_DIRECTOR never get the control. Based on the confirmed Core role only — never
 * on Bitrix position/department. The backend (OBJECT_CREATE + role rule) enforces it independently.
 */
export const canCreateObject = (role: string): boolean => role === 'DEPUTY_DIRECTOR' || role === 'ADMIN';
