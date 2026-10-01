import type { OrgEmployee, OrgFunctionCode, OrgFunctionGroup, OrgHistoryEntry, OrgManager, OrgUnresolved } from '../data/orgStructureApi';
import { formatDate } from '../formatters';
import { INTERNAL_ROLE_LABELS, isInternalCoreRole } from '../auth/internalRoles';

/**
 * ORG-1 view-model helpers for «Структура компании»: organizational structure ONLY (who, which unit, whose
 * immediate manager). No object information exists here by design. Russian position titles only — no enum names,
 * no «Роль:» prefixes, no storage vocabulary.
 */
export const FUNCTION_TITLE: Record<OrgFunctionCode, string> = {
  PTO: 'ПТО',
  CONSTRUCTION_CONTROL: 'Строительный контроль',
  SDO: 'СДО',
  PROJECT_MANAGEMENT: 'Руководители проектов',
};
/** Order of the groups inside «Производственный блок». */
export const FUNCTION_ORDER: readonly OrgFunctionCode[] = ['PTO', 'CONSTRUCTION_CONTROL', 'SDO', 'PROJECT_MANAGEMENT'];

/** Position titles; shared role labels are reused except where they name a department rather than a position. */
const POSITION_OVERRIDE: Record<string, string> = { CONSTRUCTION_CONTROL: 'Инженер строительного контроля' };
export const positionTitle = (role: string | null): string =>
  role && POSITION_OVERRIDE[role] ? POSITION_OVERRIDE[role]! : role && isInternalCoreRole(role) ? INTERNAL_ROLE_LABELS[role] : 'Должность не определена';

export const NO_HEAD_LABEL = 'Руководитель подразделения не назначен';
export const UNASSIGNED_GROUP_LABEL = 'Сотрудники без руководителя';

/** Project Managers have no functional head: Deputy Director is company leadership, never a local head card. */
export const hasLocalHead = (fn: OrgFunctionCode): boolean => fn !== 'PROJECT_MANAGEMENT';

export const reasonIsValid = (reason: string): boolean => reason.trim().length > 0;

/** Real heads to render as head cards: active heads, plus any head still carrying subordinates (inactive/changed role). */
export const departmentHeads = (group: Pick<OrgFunctionGroup, 'managers'>): OrgManager[] => group.managers.filter((m) => m.isActive || m.orgMembers.length > 0);
export const hasActiveHead = (group: Pick<OrgFunctionGroup, 'managers'>): boolean => group.managers.some((m) => m.isActive && m.roleMatches);

/** Employees that genuinely have no organizational manager (empty array => no exception group is rendered at all). */
export const unassignedEmployees = (group: Pick<OrgFunctionGroup, 'unassigned'>): OrgEmployee[] => group.unassigned;

/** Project Managers as one flat list — the stored relation to a Deputy is not rendered as a local head. */
export function projectManagers(group: Pick<OrgFunctionGroup, 'managers' | 'unassigned'>): OrgEmployee[] {
  return [...group.managers.flatMap((m) => m.orgMembers), ...group.unassigned].sort((x, y) => x.name.localeCompare(y.name, 'ru'));
}

/** Banner items for a group; for Project Managers the (Deputy) manager side is never surfaced as a local head problem. */
export const visibleUnresolved = (group: Pick<OrgFunctionGroup, 'functionCode' | 'unresolved'>): OrgUnresolved[] =>
  hasLocalHead(group.functionCode) ? group.unresolved : group.unresolved.filter((u) => u.kind === 'MEMBER_UNAVAILABLE');

/** Managers that may be offered as a NEW target: active, exact role, and not the employee's current one. */
export function targetManagers(group: Pick<OrgFunctionGroup, 'managers'>, currentManagerUserId: string | null): { value: string; label: string }[] {
  return group.managers.filter((m) => m.isActive && m.roleMatches && m.userId !== currentManagerUserId).map((m) => ({ value: m.userId, label: m.name }));
}

export type EmployeeAction = 'assign' | 'change-manager' | 'history';
/**
 * Business-language actions an employee's ⋯ menu may contain. Derived from the backend capability (`canManage`, the
 * assignment reference it only hands to a caller allowed to mutate) — never from a role label. Project Managers get
 * no organizational mutation (no local head). «Перевести в другое подразделение» and ending a membership are not
 * offered: no safe cross-function / dismissal workflow exists.
 */
export function employeeActions(args: { fn: OrgFunctionCode; canManage: boolean; employee: Pick<OrgEmployee, 'assignment' | 'orgManagerUserId'>; hasTargets: boolean }): EmployeeAction[] {
  const out: EmployeeAction[] = [];
  if (args.canManage && hasLocalHead(args.fn) && args.hasTargets) {
    if (args.employee.orgManagerUserId === null) out.push('assign');
    else if (args.employee.assignment) out.push('change-manager');
  }
  if (args.employee.orgManagerUserId !== null) out.push('history');
  return out;
}
export const ACTION_LABEL: Record<EmployeeAction, string> = { assign: 'Назначить руководителя', 'change-manager': 'Сменить руководителя', history: 'История изменений' };

export function historyLine(h: OrgHistoryEntry): string {
  const from = h.previousManagerName ? `ранее: ${h.previousManagerName}` : 'первое назначение';
  const period = h.endedAt ? `${formatDate(h.startedAt)} — ${formatDate(h.endedAt)}` : `с ${formatDate(h.startedAt)}`;
  return `${h.managerName} · ${period} · ${from}`;
}
