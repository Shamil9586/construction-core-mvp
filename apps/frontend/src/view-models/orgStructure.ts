import type { OrgFunctionCode, OrgFunctionGroup, OrgHistoryEntry, OrgManager, OrgObjectSummary } from '../data/orgStructureApi';
import { formatDate } from '../formatters';
import { INTERNAL_ROLE_LABELS, isInternalCoreRole } from '../auth/internalRoles';

/**
 * ORG-1 view-model helpers for «Структура компании»: Russian labels only (no storage names such as
 * function_code / manager_user_id / enum strings reach the screen) and the small pure rules the screen uses.
 */
export const FUNCTION_TITLE: Record<OrgFunctionCode, string> = {
  PTO: 'ПТО',
  CONSTRUCTION_CONTROL: 'Строительный контроль',
  SDO: 'СДО',
  PROJECT_MANAGEMENT: 'Руководители проектов',
};
/** Order of the groups on the screen: Руководство is rendered first by the screen itself. */
export const FUNCTION_ORDER: readonly OrgFunctionCode[] = ['PTO', 'CONSTRUCTION_CONTROL', 'SDO', 'PROJECT_MANAGEMENT'];

export const roleLabel = (role: string | null): string => (role && isInternalCoreRole(role) ? INTERNAL_ROLE_LABELS[role] : 'Роль не определена');

export const NO_MANAGER_LABEL = 'Без руководителя';

export function objectRelationText(o: OrgObjectSummary): string {
  if (o.relation === 'LEAD') return 'ведёт объект';
  if (o.relation === 'PROJECT_MANAGER') return 'руководитель проекта объекта';
  return o.objectLeadName ? `начальник объекта: ${o.objectLeadName}` : 'начальник объекта не назначен';
}
/** Informational label for a valid state — org manager differs from the object lead; never an error. */
export const DIFFERENT_TEAM_LABEL = 'Другая организационная команда';

export function reasonIsValid(reason: string): boolean {
  return reason.trim().length > 0;
}

/** Managers that may be offered as a NEW target: active, with the exact role, and not the employee's current one. */
export function targetManagers(group: Pick<OrgFunctionGroup, 'managers'>, currentManagerUserId: string | null): { value: string; label: string }[] {
  return group.managers.filter((m) => m.isActive && m.roleMatches && m.userId !== currentManagerUserId).map((m) => ({ value: m.userId, label: m.name }));
}

export const managerCountLabel = (m: Pick<OrgManager, 'orgMembers' | 'objectCount'>, fn: OrgFunctionCode): string =>
  `Сотрудников: ${m.orgMembers.length} · Объектов: ${m.objectCount}${fn === 'PROJECT_MANAGEMENT' ? ' (у руководителей проектов)' : ''}`;

export function historyLine(h: OrgHistoryEntry): string {
  const from = h.previousManagerName ? `из команды «${h.previousManagerName}»` : 'первое назначение';
  const to = h.nextManagerName ? `, далее «${h.nextManagerName}»` : '';
  const period = h.endedAt ? `${formatDate(h.startedAt)} — ${formatDate(h.endedAt)}` : `с ${formatDate(h.startedAt)}`;
  return `${h.managerName} · ${period} · ${from}${to}`;
}
