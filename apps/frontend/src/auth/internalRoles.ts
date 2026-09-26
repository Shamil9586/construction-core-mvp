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
  'PTO',
  'SDO',
  'ADMIN',
  'DEPARTMENT_HEAD',
] as const satisfies readonly Role[];

export type InternalCoreRole = (typeof INTERNAL_CORE_ROLES)[number];

/** The one external-participant role the backend defines today. */
export const EXTERNAL_PARTICIPANT_ROLE = 'CONTRACTOR_VIEWER' satisfies Role;

/** The same Russian wording the legacy entry shows for these roles (main.tsx `roleNames`). */
export const INTERNAL_ROLE_LABELS: Record<InternalCoreRole, string> = {
  GENERAL_DIRECTOR: 'Генеральный директор',
  TECHNICAL_DIRECTOR: 'Технический директор',
  PROJECT_MANAGER: 'Руководитель проекта',
  CONSTRUCTION_CONTROL: 'Строительный контроль',
  PTO: 'ПТО',
  SDO: 'СДО',
  ADMIN: 'Администратор',
  DEPARTMENT_HEAD: 'Руководитель направления',
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
  return role !== 'SDO' && role !== 'CONTRACTOR_VIEWER';
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
  return role === 'PTO' || role === 'ADMIN';
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
  return role === 'SDO' || role === 'ADMIN';
}
