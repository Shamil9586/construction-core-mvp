import type { HandoverStatus, UnresolvedKind, RedistributeCommand } from '../data/functionTeamsApi';

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

/** Every operation the Deputy queued goes into ONE command — the backend applies it all-or-nothing. */
export function buildRedistributeCommand(reason: string, ops: readonly RedistributeOp[]): RedistributeCommand {
  const command: RedistributeCommand = { reason: reason.trim(), orgTransfers: [], orgEnds: [], leadChanges: [], memberEnds: [], memberAdds: [], handovers: [] };
  for (const op of ops) {
    if (op.kind === 'orgTransfer') command.orgTransfers.push({ memberUserId: op.memberUserId, toManagerUserId: op.toManagerUserId });
    else if (op.kind === 'orgEnd') command.orgEnds.push({ memberUserId: op.memberUserId });
    else if (op.kind === 'lead') command.leadChanges.push({ objectId: op.objectId, leadUserId: op.leadUserId });
    else if (op.kind === 'memberEnd') command.memberEnds.push({ objectId: op.objectId, memberUserId: op.memberUserId });
    else if (op.kind === 'memberAdd') command.memberAdds.push({ objectId: op.objectId, memberUserId: op.memberUserId });
    else command.handovers.push({ objectId: op.objectId, outgoingUserId: op.outgoingUserId, incomingUserId: op.incomingUserId });
  }
  return command;
}

export function canSubmitRedistribution(reason: string, ops: readonly RedistributeOp[]): boolean {
  return reason.trim().length > 0 && ops.length > 0;
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
