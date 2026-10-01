import { parseResponse } from '../http';
import { readSessionToken } from '../auth/sessionToken';

/**
 * ORG-1 — «Структура компании» data source (`/org-structure*`). Visibility (full vs. own team) and every
 * mutation rule are enforced by the backend; this module only types and calls it. tenantId / assignedBy /
 * functionCode in a body are never sent: the tenant and actor come from the session, the function from the route.
 */
export type OrgFunctionCode = 'PTO' | 'CONSTRUCTION_CONTROL' | 'SDO' | 'PROJECT_MANAGEMENT';

export interface OrgObjectSummary {
  objectId: string;
  name: string;
  relation: 'LEAD' | 'MEMBER' | 'PROJECT_MANAGER';
  objectLeadUserId: string | null;
  objectLeadName: string | null;
  /** Valid, informational state: the employee's organizational manager is not the object's current lead. */
  differentOrgTeam: boolean;
}
export interface OrgAssignmentRef { assignmentId: string; version: number }
export interface OrgEmployee {
  userId: string;
  name: string;
  isActive: boolean;
  role: string | null;
  roleMatches: boolean;
  orgManagerUserId: string | null;
  startedAt: string | null;
  /** Present only for a caller who may mutate (DEPUTY_DIRECTOR / ADMIN) and only for an assigned employee. */
  assignment: OrgAssignmentRef | null;
  objects: OrgObjectSummary[];
}
export interface OrgManager {
  userId: string;
  name: string;
  isActive: boolean;
  role: string | null;
  roleMatches: boolean;
  orgMembers: OrgEmployee[];
  ledObjects: OrgObjectSummary[];
  objectCount: number;
}
export interface OrgUnresolved {
  kind: 'MANAGER_UNAVAILABLE' | 'MEMBER_UNAVAILABLE';
  assignment: OrgAssignmentRef | null;
  memberUserId: string;
  memberName: string;
  managerUserId: string;
  managerName: string;
}
export interface OrgFunctionGroup {
  functionCode: OrgFunctionCode;
  managerRole: string;
  memberRole: string;
  managers: OrgManager[];
  unassigned: OrgEmployee[];
  unresolved: OrgUnresolved[];
}
export interface OrgDeputy { userId: string; name: string; isActive: boolean; projectManagerCount: number }
export interface OrgStructure {
  scope: 'FULL' | 'OWN_TEAM';
  canManage: boolean;
  management: { deputies: OrgDeputy[] } | null;
  functions: OrgFunctionGroup[];
}
export interface OrgHistoryEntry {
  assignmentId: string;
  functionCode: OrgFunctionCode;
  memberUserId: string;
  memberName: string;
  managerUserId: string;
  managerName: string;
  previousManagerName: string | null;
  nextManagerName: string | null;
  startedAt: string;
  startedByName: string;
  endedAt: string | null;
  endedByName: string | null;
  reason: string | null;
  active: boolean;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = readSessionToken();
  const response = await fetch(`/api/${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return parseResponse(response) as Promise<T>;
}

const enc = encodeURIComponent;
export const getOrgStructure = () => request<OrgStructure>('GET', 'org-structure');
export const getOrgHistory = (functionCode: OrgFunctionCode, memberUserId: string) =>
  request<OrgHistoryEntry[]>('GET', `org-structure/history?functionCode=${enc(functionCode)}&memberUserId=${enc(memberUserId)}`);
export const assignOrgMember = (fn: OrgFunctionCode, memberUserId: string, managerUserId: string) =>
  request<unknown>('POST', `org-structure/${fn}/assign`, { memberUserId, managerUserId });
export const transferOrgMember = (fn: OrgFunctionCode, memberUserId: string, managerUserId: string, reason: string, expected: OrgAssignmentRef) =>
  request<unknown>('POST', `org-structure/${fn}/transfer`, { memberUserId, managerUserId, reason: reason.trim(), expectedAssignmentId: expected.assignmentId, expectedVersion: expected.version });
export const endOrgMember = (fn: OrgFunctionCode, memberUserId: string, reason: string, expected: OrgAssignmentRef) =>
  request<unknown>('POST', `org-structure/${fn}/end`, { memberUserId, reason: reason.trim(), expectedAssignmentId: expected.assignmentId, expectedVersion: expected.version });
