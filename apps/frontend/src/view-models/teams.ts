import type { HandoverStatus, UnresolvedKind, RedistributeCommand, TeamsOverview } from '../data/functionTeamsApi';

/**
 * PBX-3A view-model helpers for «Команды и объекты» / «Моя команда ПТО»: Russian labels and the
 * one place that turns the Deputy's pending list into the single atomic redistribution command.
 */
export const HANDOVER_STATUS_LABEL: Record<HandoverStatus, string> = {
  OPEN: 'Ожидает подтверждения',
  ACKNOWLEDGED: 'Подтверждена',
  ADMIN_COMPLETED: 'Завершена администратором',
};

export const UNRESOLVED_LABEL: Record<UnresolvedKind, string> = {
  ORG_MANAGER_UNAVAILABLE: 'Начальник недоступен — сотрудник ждёт перераспределения',
  ORG_MEMBER_UNAVAILABLE: 'Сотрудник недоступен — закройте его назначение',
  OBJECT_LEAD_UNAVAILABLE: 'Начальник объекта недоступен — назначьте нового',
  OBJECT_MEMBER_UNAVAILABLE: 'Сотрудник на объекте недоступен — снимите его с объекта',
};

export type RedistributeOp =
  | { kind: 'orgTransfer'; memberUserId: string; toManagerUserId: string }
  | { kind: 'orgEnd'; memberUserId: string }
  | { kind: 'lead'; objectId: string; leadUserId: string }
  | { kind: 'memberEnd'; objectId: string; memberUserId: string }
  | { kind: 'memberAdd'; objectId: string; memberUserId: string }
  | { kind: 'handover'; objectId: string; outgoingUserId: string; incomingUserId: string };

/** The (assignment id, version) the screen read for an employee's CURRENT organizational membership, if any. */
export type OrgExpectationLookup = (memberUserId: string) => { assignmentId: string; version: number } | null | undefined;

/** Reads every current org membership off the overview the Deputy is looking at (ORG-1: transfer/end must name the row they saw). */
export function orgExpectationLookup(overview: Pick<TeamsOverview, 'heads'>): OrgExpectationLookup {
  const byMember = new Map<string, { assignmentId: string; version: number }>();
  for (const head of overview.heads) for (const m of head.orgMembers) byMember.set(m.userId, { assignmentId: m.assignmentId, version: m.version });
  return (id) => byMember.get(id) ?? null;
}

/** Every operation the Deputy queued goes into ONE command — the backend applies it all-or-nothing. */
export function buildRedistributeCommand(reason: string, ops: readonly RedistributeOp[], expectation: OrgExpectationLookup = () => null): RedistributeCommand {
  const command: RedistributeCommand = { reason: reason.trim(), orgTransfers: [], orgEnds: [], leadChanges: [], memberEnds: [], memberAdds: [], handovers: [] };
  for (const op of ops) {
    if (op.kind === 'orgTransfer') {
      const e = expectation(op.memberUserId);
      command.orgTransfers.push({ memberUserId: op.memberUserId, toManagerUserId: op.toManagerUserId, ...(e ? { expectedAssignmentId: e.assignmentId, expectedVersion: e.version } : {}) });
    } else if (op.kind === 'orgEnd') {
      const e = expectation(op.memberUserId);
      command.orgEnds.push({ memberUserId: op.memberUserId, ...(e ? { expectedAssignmentId: e.assignmentId, expectedVersion: e.version } : {}) });
    }
    else if (op.kind === 'lead') command.leadChanges.push({ objectId: op.objectId, leadUserId: op.leadUserId });
    else if (op.kind === 'memberEnd') command.memberEnds.push({ objectId: op.objectId, memberUserId: op.memberUserId });
    else if (op.kind === 'memberAdd') command.memberAdds.push({ objectId: op.objectId, memberUserId: op.memberUserId });
    else command.handovers.push({ objectId: op.objectId, outgoingUserId: op.outgoingUserId, incomingUserId: op.incomingUserId });
  }
  return command;
}

/**
 * PBX3A-R02 — objects where the queued steps replace engineers (both a removal and an addition) but the
 * handover steps do not cover every removed and every added engineer. Mirrors the backend rule so the
 * Deputy is blocked before submitting; the backend remains the enforcer.
 */
export function replacementHandoverGaps(ops: readonly RedistributeOp[]): string[] {
  const gaps: string[] = [];
  const objectIds = new Set(ops.filter((o) => o.kind === 'memberEnd').map((o) => (o as { objectId: string }).objectId));
  for (const objectId of objectIds) {
    const ends = ops.flatMap((o) => (o.kind === 'memberEnd' && o.objectId === objectId ? [o.memberUserId] : []));
    const adds = ops.flatMap((o) => (o.kind === 'memberAdd' && o.objectId === objectId ? [o.memberUserId] : []));
    if (adds.length === 0) continue;
    const hs = ops.flatMap((o) => (o.kind === 'handover' && o.objectId === objectId ? [o] : []));
    const covered = ends.every((u) => hs.some((h) => h.outgoingUserId === u && adds.includes(h.incomingUserId))) && adds.every((u) => hs.some((h) => h.incomingUserId === u && ends.includes(h.outgoingUserId)));
    if (!covered) gaps.push(objectId);
  }
  return gaps;
}

export function canSubmitRedistribution(reason: string, ops: readonly RedistributeOp[]): boolean {
  return reason.trim().length > 0 && ops.length > 0 && replacementHandoverGaps(ops).length === 0;
}

/** Human description of one queued operation; `name`/`objectName` resolve ids the caller already holds. */
export function describeOp(op: RedistributeOp, name: (userId: string) => string, objectName: (objectId: string) => string): string {
  switch (op.kind) {
    case 'orgTransfer': return `${name(op.memberUserId)} → в команду начальника ${name(op.toManagerUserId)}`;
    case 'orgEnd': return `${name(op.memberUserId)} — закрыть членство в команде`;
    case 'lead': return `«${objectName(op.objectId)}»: начальник ПТО → ${name(op.leadUserId)}`;
    case 'memberEnd': return `«${objectName(op.objectId)}»: снять ${name(op.memberUserId)}`;
    case 'memberAdd': return `«${objectName(op.objectId)}»: добавить ${name(op.memberUserId)}`;
    case 'handover': return `«${objectName(op.objectId)}»: передача дел ${name(op.outgoingUserId)} → ${name(op.incomingUserId)}`;
  }
}

export interface PickerOption { value: string; label: string }

/**
 * Engineer picker for the object-scoped steps «Снять инженера с объекта» (memberEnd) and
 * «Добавить инженера на объект» (memberAdd), derived from the SELECTED object's PERSISTED
 * current PTO members and the steps already queued for that same object. The backend runs
 * memberEnds BEFORE memberAdds, so a queued add can never be removed in the same command.
 *  - memberEnd: persisted members minus queued memberEnds (a current member stays selectable
 *    even when inactive, labelled «(недоступен)»). Queued memberAdds are never offered.
 *  - memberAdd: active PTO engineers who are not persisted members, not already queued for
 *    addition, and not queued for removal (remove→re-add in one command is forbidden).
 * No object selected → empty list (never the whole tenant). The backend stays authoritative.
 */
export function objectMemberOptions(
  overview: Pick<TeamsOverview, 'engineers' | 'objects'>,
  kind: 'memberEnd' | 'memberAdd',
  objectId: string,
  queued: readonly RedistributeOp[] = [],
): PickerOption[] {
  const object = objectId ? overview.objects.find((o) => o.objectId === objectId) : undefined;
  if (!object) return [];
  const forObject = queued.filter((op) => (op.kind === 'memberEnd' || op.kind === 'memberAdd') && op.objectId === objectId);
  const queuedEnds = new Set(forObject.filter((op) => op.kind === 'memberEnd').map((op) => (op as { memberUserId: string }).memberUserId));
  const queuedAdds = new Set(forObject.filter((op) => op.kind === 'memberAdd').map((op) => (op as { memberUserId: string }).memberUserId));
  if (kind === 'memberEnd') {
    return object.members.filter((m) => !queuedEnds.has(m.userId)).map((m) => ({ value: m.userId, label: m.isActive ? m.name : `${m.name} (недоступен)` }));
  }
  const persisted = new Set(object.members.map((m) => m.userId));
  return overview.engineers
    .filter((e) => e.isActive && !persisted.has(e.userId) && !queuedAdds.has(e.userId) && !queuedEnds.has(e.userId))
    .map((e) => ({ value: e.userId, label: e.name }));
}
