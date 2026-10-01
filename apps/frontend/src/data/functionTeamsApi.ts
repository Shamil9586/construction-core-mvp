import { parseResponse } from '../http';
import { readSessionToken } from '../auth/sessionToken';

/**
 * PBX-3A — the PTO object-team foundation's data source (`/function-teams/pto/*`,
 * `/objects/:id/function-team/pto`, `/function-handovers/*`). Every rule (who may
 * manage which object, atomic redistribution, handover completion) is enforced by
 * the backend; this module only types and calls it.
 */
export interface TeamPerson {
  userId: string;
  name: string;
  isActive: boolean;
}
export interface ObjectLead extends TeamPerson {
  assignmentId: string;
  startedAt: string;
  version: number;
}
export interface ObjectMember extends TeamPerson {
  assignmentId: string;
  startedAt: string;
  version: number;
  orgManagerUserId: string | null;
  orgManagerName: string | null;
  /** Informational only: the member's organizational manager differs from the current object lead. */
  inherited: boolean;
}
export interface ObjectTeamSummary {
  objectId: string;
  name: string;
  lead: ObjectLead | null;
  members: ObjectMember[];
}
export interface OrgMember extends TeamPerson {
  assignmentId: string;
  startedAt: string;
  version: number;
}
export interface HeadSummary extends TeamPerson {
  role: string | null;
  orgMembers: OrgMember[];
  ledObjects: { objectId: string; name: string }[];
}
export interface EngineerSummary extends TeamPerson {
  orgManagerUserId: string | null;
}
export type UnresolvedKind = 'ORG_MANAGER_UNAVAILABLE' | 'ORG_MEMBER_UNAVAILABLE' | 'OBJECT_LEAD_UNAVAILABLE' | 'OBJECT_MEMBER_UNAVAILABLE';
export interface UnresolvedAssignment {
  kind: UnresolvedKind;
  assignmentId: string;
  userId: string;
  userName: string;
  objectId?: string;
  objectName?: string;
  managerUserId?: string;
  managerName?: string;
}
export type HandoverStatus = 'OPEN' | 'ACKNOWLEDGED' | 'ADMIN_COMPLETED';
export interface Handover {
  id: string;
  objectId: string;
  objectName: string | null;
  outgoingUserId: string;
  outgoingName: string | null;
  incomingUserId: string;
  incomingName: string | null;
  reason: string;
  note: string | null;
  status: HandoverStatus;
  administrativeCompletionReason: string | null;
  createdAt: string;
  version: number;
}
export interface TeamsOverview {
  heads: HeadSummary[];
  engineers: EngineerSummary[];
  objects: ObjectTeamSummary[];
  unresolved: UnresolvedAssignment[];
  handovers: Handover[];
}
export interface MyTeam {
  role: string;
  orgTeam: (TeamPerson & { assignmentId: string; startedAt: string; onObjectIds: string[] })[];
  orgManager: { userId: string; name: string } | null;
  objects: ObjectTeamSummary[];
  handovers: Handover[];
}
export interface AssignmentHistoryEntry {
  assignmentId: string;
  userId: string;
  name: string;
  startedAt: string;
  endedAt: string;
  endedByName: string | null;
  endReason: string | null;
}
export interface ObjectPtoTeam {
  objectId: string;
  objectName: string;
  current: { lead: ObjectLead | null; members: ObjectMember[] };
  history: { leads: AssignmentHistoryEntry[]; members: AssignmentHistoryEntry[] };
  handovers: Handover[];
}
export interface RedistributeCommand {
  reason: string;
  /** ORG-1: a transfer/end of an EXISTING membership names the exact row read (id + version). */
  orgTransfers: { memberUserId: string; toManagerUserId: string; expectedAssignmentId?: string; expectedVersion?: number }[];
  orgEnds: { memberUserId: string; expectedAssignmentId?: string; expectedVersion?: number }[];
  leadChanges: { objectId: string; leadUserId: string }[];
  memberEnds: { objectId: string; memberUserId: string }[];
  memberAdds: { objectId: string; memberUserId: string }[];
  handovers: { objectId: string; outgoingUserId: string; incomingUserId: string; note?: string }[];
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = readSessionToken();
  const response = await fetch(`/api/${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return parseResponse(response) as Promise<T>;
}

const enc = encodeURIComponent;
export const getTeamsOverview = () => request<TeamsOverview>('GET', 'function-teams/pto/overview');
export const getMyTeam = () => request<MyTeam>('GET', 'function-teams/pto/my-team');
export const getObjectPtoTeam = (objectId: string) => request<ObjectPtoTeam>('GET', `objects/${enc(objectId)}/function-team/pto`);
export const redistributePto = (command: RedistributeCommand) => request<unknown>('POST', 'function-teams/pto/redistribute', command);
export const addObjectPtoMember = (objectId: string, memberUserId: string) =>
  request<unknown>('POST', `objects/${enc(objectId)}/function-team/pto/members`, { memberUserId });
export const endObjectPtoMember = (objectId: string, memberUserId: string, reason?: string) =>
  request<unknown>('POST', `objects/${enc(objectId)}/function-team/pto/members/${enc(memberUserId)}/end`, reason ? { reason } : {});
export const acknowledgeHandover = (id: string, version: number) => request<Handover>('POST', `function-handovers/${enc(id)}/acknowledge`, { version });
export const adminCompleteHandover = (id: string, version: number, reason: string) =>
  request<Handover>('POST', `function-handovers/${enc(id)}/admin-complete`, { version, reason });
