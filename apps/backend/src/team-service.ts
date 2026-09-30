import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { pool, one, rows, insert, transaction } from './db';
import { Actor, requirePermission, checkVersion, scoped, audit, ensure, ensurePtoObjectScope, isCurrentPtoLead } from './security';
import { Permission as P } from '../../../packages/domain';

/**
 * PBX-3A — Object Responsibility, Team Redistribution & Handover Foundation (PTO vertical).
 *
 * Three independent axes (PBX3-D02), three generic tables:
 *   functional_team_memberships        organizational: member -> current manager
 *   object_function_lead_assignments   object functional lead
 *   object_function_member_assignments object functional membership
 * plus object_function_handovers (formal handover record, PBX3-D10).
 *
 * Invariants this service relies on / keeps:
 *  - Lead replacement NEVER touches member assignments (PBX3-D01). Nothing here
 *    cascades from a lead row to a member row; member rows change only through an
 *    explicit member command.
 *  - History is never deleted or rewritten: an assignment is ENDED (close-old +
 *    create-new). infra/016's own triggers forbid DELETE and identity rewrites.
 *  - Every mutating command takes the same deterministic set of advisory locks
 *    (objects and users it touches, sorted) so overlapping commands serialise
 *    instead of deadlocking; the partial unique indexes stay the native backstop
 *    for anything the application pre-checks could still miss.
 *  - Roles are matched EXACTLY (organizational manager / object lead = PTO_HEAD,
 *    engineer / member = PTO); nothing is inferred from Bitrix descriptive fields.
 *  - Active-user validation applies to NEW active assignments only; ended rows and
 *    endings may involve users that were deactivated since.
 */
export const FN = 'PTO';
const T_ORG = 'functional_team_memberships', T_LEAD = 'object_function_lead_assignments', T_MEM = 'object_function_member_assignments', T_HO = 'object_function_handovers';
const OVERSIGHT_ROLES = ['DEPUTY_DIRECTOR', 'GENERAL_DIRECTOR', 'ADMIN'];
const ENTITY = { [T_ORG]: 'FunctionalTeamMembership', [T_LEAD]: 'ObjectFunctionLead', [T_MEM]: 'ObjectFunctionMember', [T_HO]: 'ObjectFunctionHandover' } as Record<string, string>;

export type RedistributeCommand = {
    reason: string;
    orgTransfers: { memberUserId: string; toManagerUserId: string }[];
    orgEnds: { memberUserId: string }[];
    leadChanges: { objectId: string; leadUserId: string }[];
    memberEnds: { objectId: string; memberUserId: string }[];
    memberAdds: { objectId: string; memberUserId: string }[];
    handovers: { objectId: string; outgoingUserId: string; incomingUserId: string; note?: string }[];
};

async function lockTeamScope(c: any, a: Actor, objectIds: string[], userIds: string[]) {
    const keys = [...new Set([...objectIds.map(id => `object:${id}`), ...userIds.map(id => `user:${id}`)])].sort();
    for (const k of keys)
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`pbx3:${a.tenantId}:${FN}:${k}`]);
    const ids = [...new Set(userIds)].sort();
    // Users are read FOR SHARE in a fixed order so a concurrent deactivation/role change
    // cannot slip between validation and the assignment insert.
    const list = ids.length ? await rows(c, 'SELECT id,name,role,is_active FROM users WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE', [a.tenantId, ids]) : [];
    return new Map<string, any>(list.map((u: any) => [u.id, u]));
}
function dup(list: string[], message: string) { ensure(new Set(list).size === list.length, message); }
function requireUser(users: Map<string, any>, id: string) { const u = users.get(id); if (!u) throw new NotFoundException('Пользователь не найден'); return u; }
function requireActiveRole(users: Map<string, any>, id: string, role: 'PTO' | 'PTO_HEAD') {
    const u = requireUser(users, id);
    ensure(u.role === role && u.isActive, role === 'PTO_HEAD' ? `Назначьте активного начальника ПТО (${u.name})` : `Назначьте активного сотрудника ПТО (${u.name})`);
    return u;
}
async function endRow(c: any, a: Actor, table: string, id: string, reason: string | null | undefined) {
    const n = await one(c, `UPDATE ${table} SET ended_at=clock_timestamp(),ended_by=$3,end_reason=$4,version=version+1 WHERE tenant_id=$1 AND id=$2 AND ended_at IS NULL RETURNING *`, [a.tenantId, id, a.id, reason ?? null]);
    ensure(!!n, 'Назначение уже завершено');
    return n;
}

@Injectable()
export class ObjectTeamService {
    // -----------------------------------------------------------------------
    // Atomic building blocks (all called inside a caller-owned transaction, after locks).
    // -----------------------------------------------------------------------
    private async orgTransfer(c: any, a: Actor, users: Map<string, any>, memberUserId: string, managerUserId: string, reason: string | null, expectedVersion?: number) {
        ensure(memberUserId !== managerUserId, 'Сотрудник не может быть руководителем самому себе');
        requireActiveRole(users, managerUserId, 'PTO_HEAD');
        requireActiveRole(users, memberUserId, 'PTO');
        const current = await one(c, `SELECT * FROM ${T_ORG} WHERE tenant_id=$1 AND function_code=$2 AND member_user_id=$3 AND ended_at IS NULL FOR UPDATE`, [a.tenantId, FN, memberUserId]);
        if (current) {
            if (expectedVersion !== undefined)
                checkVersion(current, expectedVersion);
            ensure(current.managerUserId !== managerUserId, 'Сотрудник уже входит в команду этого начальника');
            const ended = await endRow(c, a, T_ORG, current.id, reason ?? 'TRANSFER');
            await audit(c, a, ENTITY[T_ORG], current.id, 'END', current, ended);
        }
        const row = await insert(c, T_ORG, a.tenantId, { functionCode: FN, managerUserId, memberUserId, assignedBy: a.id });
        await audit(c, a, ENTITY[T_ORG], row.id, current ? 'TRANSFER' : 'ASSIGN', current ?? null, row);
        return row;
    }
    private async orgEnd(c: any, a: Actor, memberUserId: string, reason: string | null) {
        const current = await one(c, `SELECT * FROM ${T_ORG} WHERE tenant_id=$1 AND function_code=$2 AND member_user_id=$3 AND ended_at IS NULL FOR UPDATE`, [a.tenantId, FN, memberUserId]);
        ensure(!!current, 'Сотрудник не входит ни в одну команду ПТО');
        const ended = await endRow(c, a, T_ORG, current.id, reason ?? 'ORG_END');
        await audit(c, a, ENTITY[T_ORG], current.id, 'END', current, ended);
        return ended;
    }
    private async leadChange(c: any, a: Actor, users: Map<string, any>, objectId: string, leadUserId: string, reason: string | null, expectedVersion?: number) {
        requireActiveRole(users, leadUserId, 'PTO_HEAD');
        const current = await one(c, `SELECT * FROM ${T_LEAD} WHERE tenant_id=$1 AND object_id=$2 AND function_code=$3 AND ended_at IS NULL FOR UPDATE`, [a.tenantId, objectId, FN]);
        if (current) {
            if (expectedVersion !== undefined)
                checkVersion(current, expectedVersion);
            ensure(current.leadUserId !== leadUserId, 'Этот начальник ПТО уже назначен на объект');
            const ended = await endRow(c, a, T_LEAD, current.id, reason ?? 'REPLACED');
            await audit(c, a, ENTITY[T_LEAD], current.id, 'END', current, ended);
        }
        // Deliberately NO statement touching object_function_member_assignments here (PBX3-D01).
        const row = await insert(c, T_LEAD, a.tenantId, { objectId, functionCode: FN, leadUserId, assignedBy: a.id });
        await audit(c, a, ENTITY[T_LEAD], row.id, current ? 'REPLACE' : 'ASSIGN', current ?? null, row);
        return { previous: current ?? null, current: row };
    }
    private async memberAdd(c: any, a: Actor, users: Map<string, any>, objectId: string, memberUserId: string) {
        requireActiveRole(users, memberUserId, 'PTO');
        ensure(!await one(c, `SELECT 1 FROM ${T_MEM} WHERE tenant_id=$1 AND object_id=$2 AND function_code=$3 AND member_user_id=$4 AND ended_at IS NULL`, [a.tenantId, objectId, FN, memberUserId]), 'Сотрудник уже в команде ПТО объекта');
        const row = await insert(c, T_MEM, a.tenantId, { objectId, functionCode: FN, memberUserId, assignedBy: a.id });
        await audit(c, a, ENTITY[T_MEM], row.id, 'ASSIGN', null, row);
        return row;
    }
    private async memberEnd(c: any, a: Actor, objectId: string, memberUserId: string, reason: string | null, expectedVersion?: number) {
        const current = await one(c, `SELECT * FROM ${T_MEM} WHERE tenant_id=$1 AND object_id=$2 AND function_code=$3 AND member_user_id=$4 AND ended_at IS NULL FOR UPDATE`, [a.tenantId, objectId, FN, memberUserId]);
        ensure(!!current, 'Сотрудник не входит в текущую команду ПТО объекта');
        if (expectedVersion !== undefined)
            checkVersion(current, expectedVersion);
        const ended = await endRow(c, a, T_MEM, current.id, reason ?? 'REMOVED');
        await audit(c, a, ENTITY[T_MEM], current.id, 'END', current, ended);
        return ended;
    }
    private async createHandover(c: any, a: Actor, objectId: string, outgoingUserId: string, incomingUserId: string, reason: string, note?: string | null) {
        ensure(outgoingUserId !== incomingUserId, 'Передача дел самому себе не имеет смысла');
        const row = await insert(c, T_HO, a.tenantId, { objectId, functionCode: FN, outgoingUserId, incomingUserId, initiatedBy: a.id, reason, note: note ?? null });
        await audit(c, a, ENTITY[T_HO], row.id, 'CREATE', null, row);
        return row;
    }
    private async isCurrentOnObject(c: any, tenantId: string, objectId: string, userId: string) {
        return !!(await one(c, `SELECT 1 FROM ${T_LEAD} WHERE tenant_id=$1 AND object_id=$2 AND function_code=$3 AND lead_user_id=$4 AND ended_at IS NULL UNION ALL SELECT 1 FROM ${T_MEM} WHERE tenant_id=$1 AND object_id=$2 AND function_code=$3 AND member_user_id=$4 AND ended_at IS NULL`, [tenantId, objectId, FN, userId]));
    }
    private async everOnObject(c: any, tenantId: string, objectId: string, userId: string) {
        return !!(await one(c, `SELECT 1 FROM ${T_LEAD} WHERE tenant_id=$1 AND object_id=$2 AND function_code=$3 AND lead_user_id=$4 UNION ALL SELECT 1 FROM ${T_MEM} WHERE tenant_id=$1 AND object_id=$2 AND function_code=$3 AND member_user_id=$4`, [tenantId, objectId, FN, userId]));
    }

    // -----------------------------------------------------------------------
    // Deputy/Admin commands.
    // -----------------------------------------------------------------------
    /** Assign or transfer a PTO engineer into an organizational PTO_HEAD team (close-old + create-new). */
    async assignOrgMember(a: Actor, d: { memberUserId: string; managerUserId: string; reason?: string; expectedVersion?: number }) {
        requirePermission(a, P.FUNCTION_TEAM_MANAGE);
        return transaction(async (c) => {
            const users = await lockTeamScope(c, a, [], [d.memberUserId, d.managerUserId]);
            return this.orgTransfer(c, a, users, d.memberUserId, d.managerUserId, d.reason ?? null, d.expectedVersion);
        });
    }
    /** Assign/replace the current PTO_HEAD of one object. Existing object members stay untouched. */
    async assignObjectLead(a: Actor, objectId: string, d: { leadUserId: string; reason?: string; note?: string; expectedVersion?: number }) {
        requirePermission(a, P.OBJECT_FUNCTION_LEAD_ASSIGN);
        return transaction(async (c) => {
            await scoped(c, 'objects', objectId, a);
            const users = await lockTeamScope(c, a, [objectId], [d.leadUserId]);
            const r = await this.leadChange(c, a, users, objectId, d.leadUserId, d.reason ?? null, d.expectedVersion);
            let handover = null;
            if (r.previous)
                handover = await this.createHandover(c, a, objectId, r.previous.leadUserId, d.leadUserId, d.reason ?? 'Замена начальника ПТО на объекте', d.note);
            return { lead: r.current, previousLead: r.previous, handover };
        });
    }

    /**
     * One atomic Deputy/Admin redistribution: organizational transfers, lead replacements,
     * member ends/adds and handover creation in ONE transaction — all or nothing.
     */
    async redistribute(a: Actor, cmd: RedistributeCommand) {
        requirePermission(a, P.FUNCTION_TEAM_MANAGE);
        requirePermission(a, P.OBJECT_FUNCTION_LEAD_ASSIGN);
        dup(cmd.orgTransfers.map(x => x.memberUserId).concat(cmd.orgEnds.map(x => x.memberUserId)), 'Сотрудник указан в оргкоманде более одного раза');
        dup(cmd.leadChanges.map(x => x.objectId), 'Объект указан в назначении начальника более одного раза');
        dup(cmd.memberEnds.map(x => `${x.objectId}:${x.memberUserId}`), 'Дублирующееся снятие сотрудника с объекта');
        dup(cmd.memberAdds.map(x => `${x.objectId}:${x.memberUserId}`), 'Дублирующееся назначение сотрудника на объект');
        const total = cmd.orgTransfers.length + cmd.orgEnds.length + cmd.leadChanges.length + cmd.memberEnds.length + cmd.memberAdds.length + cmd.handovers.length;
        ensure(total > 0, 'Команда перераспределения пуста');
        // PBX3A-R02: replacing engineers on an object (ends AND adds for the same object) requires explicit
        // handover coverage in the same command — checked on the payload alone, before any mutation.
        for (const objectId of new Set(cmd.memberEnds.map(x => x.objectId))) {
            const ends = cmd.memberEnds.filter(x => x.objectId === objectId).map(x => x.memberUserId);
            const adds = cmd.memberAdds.filter(x => x.objectId === objectId).map(x => x.memberUserId);
            if (!adds.length)
                continue;
            const hs = cmd.handovers.filter(h => h.objectId === objectId);
            ensure(ends.every(u => hs.some(h => h.outgoingUserId === u && adds.includes(h.incomingUserId))) && adds.every(u => hs.some(h => h.incomingUserId === u && ends.includes(h.outgoingUserId))), 'Замена инженеров на объекте требует передачи дел: укажите передачу для каждого снятого и каждого добавленного инженера');
        }
        return transaction(async (c) => {
            const objectIds = [...cmd.leadChanges.map(x => x.objectId), ...cmd.memberEnds.map(x => x.objectId), ...cmd.memberAdds.map(x => x.objectId), ...cmd.handovers.map(x => x.objectId)];
            const userIds = [...cmd.orgTransfers.flatMap(x => [x.memberUserId, x.toManagerUserId]), ...cmd.orgEnds.map(x => x.memberUserId), ...cmd.leadChanges.map(x => x.leadUserId), ...cmd.memberEnds.map(x => x.memberUserId), ...cmd.memberAdds.map(x => x.memberUserId), ...cmd.handovers.flatMap(x => [x.outgoingUserId, x.incomingUserId])];
            // Every referenced object must exist in this tenant (cross-tenant ids -> 404).
            for (const id of [...new Set(objectIds)].sort())
                await scoped(c, 'objects', id, a);
            const users = await lockTeamScope(c, a, objectIds, userIds);
            const reason = cmd.reason;
            const result: any = { orgTransfers: [], orgEnds: [], leadChanges: [], memberEnds: [], memberAdds: [], handovers: [] };
            // Deterministic processing order (sorted) keeps overlapping commands from deadlocking on unique-index waits.
            const byKey = <T>(list: T[], key: (x: T) => string) => [...list].sort((x, y) => key(x).localeCompare(key(y)));
            for (const x of byKey(cmd.orgEnds, x => x.memberUserId))
                result.orgEnds.push(await this.orgEnd(c, a, x.memberUserId, reason));
            for (const x of byKey(cmd.orgTransfers, x => x.memberUserId))
                result.orgTransfers.push(await this.orgTransfer(c, a, users, x.memberUserId, x.toManagerUserId, reason));
            for (const x of byKey(cmd.leadChanges, x => x.objectId))
                result.leadChanges.push(await this.leadChange(c, a, users, x.objectId, x.leadUserId, reason));
            for (const x of byKey(cmd.memberEnds, x => `${x.objectId}:${x.memberUserId}`))
                result.memberEnds.push(await this.memberEnd(c, a, x.objectId, x.memberUserId, reason));
            for (const x of byKey(cmd.memberAdds, x => `${x.objectId}:${x.memberUserId}`))
                result.memberAdds.push(await this.memberAdd(c, a, users, x.objectId, x.memberUserId));
            // Handovers: explicit ones + one automatic per lead replacement (outgoing lead -> incoming lead).
            const explicit = new Set(cmd.handovers.map(h => `${h.objectId}:${h.outgoingUserId}:${h.incomingUserId}`));
            for (const h of cmd.handovers) {
                requireUser(users, h.outgoingUserId);
                ensure(await this.isCurrentOnObject(c, a.tenantId, h.objectId, h.incomingUserId), 'Принимающий сотрудник должен входить в текущую команду ПТО объекта');
                ensure(await this.everOnObject(c, a.tenantId, h.objectId, h.outgoingUserId), 'Передающий сотрудник никогда не был назначен на этот объект');
                result.handovers.push(await this.createHandover(c, a, h.objectId, h.outgoingUserId, h.incomingUserId, reason, h.note));
            }
            for (const l of result.leadChanges)
                if (l.previous && !explicit.has(`${l.current.objectId}:${l.previous.leadUserId}:${l.current.leadUserId}`))
                    result.handovers.push(await this.createHandover(c, a, l.current.objectId, l.previous.leadUserId, l.current.leadUserId, reason));
            return result;
        });
    }

    // -----------------------------------------------------------------------
    // Object PTO_HEAD commands (ADMIN override skips the "current lead" / "own team" rules).
    // -----------------------------------------------------------------------
    private async requireLeadOrAdmin(c: any, a: Actor, objectId: string) {
        if (a.role === 'ADMIN')
            return;
        if (!(await isCurrentPtoLead(c, a.tenantId, objectId, a.id)))
            throw new ForbiddenException('Управлять командой ПТО объекта может только его текущий начальник ПТО');
    }
    /** The current PTO_HEAD adds an engineer from THEIR OWN organizational team to the object. */
    async addObjectMember(a: Actor, objectId: string, d: { memberUserId: string }) {
        requirePermission(a, P.PTO_OBJECT_TEAM_MANAGE);
        return transaction(async (c) => {
            await scoped(c, 'objects', objectId, a);
            const users = await lockTeamScope(c, a, [objectId], [d.memberUserId, a.id]);
            await this.requireLeadOrAdmin(c, a, objectId);
            if (a.role !== 'ADMIN') {
                const own = await one(c, `SELECT 1 FROM ${T_ORG} WHERE tenant_id=$1 AND function_code=$2 AND manager_user_id=$3 AND member_user_id=$4 AND ended_at IS NULL`, [a.tenantId, FN, a.id, d.memberUserId]);
                if (!own)
                    throw new ForbiddenException('Начальник ПТО может добавить на объект только сотрудника из своей команды');
            }
            return this.memberAdd(c, a, users, objectId, d.memberUserId);
        });
    }
    /** The current PTO_HEAD removes ANY current PTO engineer from the object (inherited members included). */
    async endObjectMember(a: Actor, objectId: string, memberUserId: string, d: { reason?: string; expectedVersion?: number }) {
        requirePermission(a, P.PTO_OBJECT_TEAM_MANAGE);
        return transaction(async (c) => {
            await scoped(c, 'objects', objectId, a);
            await lockTeamScope(c, a, [objectId], [memberUserId]);
            await this.requireLeadOrAdmin(c, a, objectId);
            return this.memberEnd(c, a, objectId, memberUserId, d.reason ?? null, d.expectedVersion);
        });
    }

    // -----------------------------------------------------------------------
    // Handover acknowledgement.
    // -----------------------------------------------------------------------
    async acknowledgeHandover(a: Actor, id: string, d: { version: number }) {
        requirePermission(a, P.PTO_TEAM_READ);
        return transaction(async (c) => {
            const h = await scoped(c, T_HO, id, a, true);
            checkVersion(h, d.version);
            if (h.incomingUserId !== a.id)
                throw new ForbiddenException('Подтвердить передачу может только принимающий сотрудник');
            ensure(h.status === 'OPEN', 'Передача уже завершена');
            const n = await one(c, "UPDATE object_function_handovers SET status='ACKNOWLEDGED',acknowledged_by=$3,acknowledged_at=now(),updated_at=now(),version=version+1 WHERE tenant_id=$1 AND id=$2 RETURNING *", [a.tenantId, id, a.id]);
            await audit(c, a, ENTITY[T_HO], id, 'ACKNOWLEDGE', h, n);
            return n;
        });
    }
    /** Deputy/Admin completes a handover administratively (outgoing user unavailable); a reason is mandatory. */
    async adminCompleteHandover(a: Actor, id: string, d: { version: number; reason: string }) {
        requirePermission(a, P.FUNCTION_TEAM_MANAGE);
        ensure(d.reason.trim().length > 0, 'Укажите причину административного завершения');
        return transaction(async (c) => {
            const h = await scoped(c, T_HO, id, a, true);
            checkVersion(h, d.version);
            ensure(h.status === 'OPEN', 'Передача уже завершена');
            const n = await one(c, "UPDATE object_function_handovers SET status='ADMIN_COMPLETED',administrative_completed_by=$3,administrative_completed_at=now(),administrative_completion_reason=$4,updated_at=now(),version=version+1 WHERE tenant_id=$1 AND id=$2 RETURNING *", [a.tenantId, id, a.id, d.reason.trim()]);
            await audit(c, a, ENTITY[T_HO], id, 'ADMIN_COMPLETE', h, n);
            return n;
        });
    }

    // -----------------------------------------------------------------------
    // Reads.
    // -----------------------------------------------------------------------
    private async currentObjectRows(c: any, tenantId: string, objectIds: string[] | null) {
        const args = objectIds ? [tenantId, FN, objectIds] : [tenantId, FN];
        const leads = await rows(c, `SELECT l.*,u.name AS lead_name,u.is_active AS lead_is_active,u.role AS lead_role FROM ${T_LEAD} l JOIN users u ON u.tenant_id=l.tenant_id AND u.id=l.lead_user_id WHERE l.tenant_id=$1 AND l.function_code=$2 AND l.ended_at IS NULL${objectIds ? ' AND l.object_id=ANY($3::uuid[])' : ''}`, args);
        const members = await rows(c, `SELECT m.*,u.name AS member_name,u.is_active AS member_is_active,u.role AS member_role,o.manager_user_id AS org_manager_user_id,mu.name AS org_manager_name FROM ${T_MEM} m JOIN users u ON u.tenant_id=m.tenant_id AND u.id=m.member_user_id LEFT JOIN ${T_ORG} o ON o.tenant_id=m.tenant_id AND o.function_code=m.function_code AND o.member_user_id=m.member_user_id AND o.ended_at IS NULL LEFT JOIN users mu ON mu.tenant_id=o.tenant_id AND mu.id=o.manager_user_id WHERE m.tenant_id=$1 AND m.function_code=$2 AND m.ended_at IS NULL${objectIds ? ' AND m.object_id=ANY($3::uuid[])' : ''} ORDER BY u.name,m.id`, args);
        return { leads, members };
    }
    private leadView(l: any) { return l && { assignmentId: l.id, userId: l.leadUserId, name: l.leadName, isActive: l.leadIsActive, startedAt: l.startedAt, version: l.version }; }
    private memberView(m: any, leadUserId: string | null) { return { assignmentId: m.id, userId: m.memberUserId, name: m.memberName, isActive: m.memberIsActive, startedAt: m.startedAt, version: m.version, orgManagerUserId: m.orgManagerUserId ?? null, orgManagerName: m.orgManagerName ?? null, inherited: !!leadUserId && (m.orgManagerUserId ?? null) !== leadUserId }; }
    private handoverView(h: any) { return { id: h.id, objectId: h.objectId, objectName: h.objectName ?? null, functionCode: h.functionCode, outgoingUserId: h.outgoingUserId, outgoingName: h.outgoingName ?? null, incomingUserId: h.incomingUserId, incomingName: h.incomingName ?? null, initiatedBy: h.initiatedBy, reason: h.reason, note: h.note, status: h.status, acknowledgedAt: h.acknowledgedAt, administrativeCompletedAt: h.administrativeCompletedAt, administrativeCompletionReason: h.administrativeCompletionReason, createdAt: h.createdAt, version: h.version }; }
    private async handovers(c: any, a: Actor, onlyMine: boolean, objectId?: string) {
        const args: any[] = [a.tenantId, FN]; let where = '';
        if (onlyMine) { args.push(a.id); where += ` AND (h.outgoing_user_id=$${args.length} OR h.incoming_user_id=$${args.length})`; }
        if (objectId) { args.push(objectId); where += ` AND h.object_id=$${args.length}`; }
        return (await rows(c, `SELECT h.*,o.name AS object_name,ou.name AS outgoing_name,iu.name AS incoming_name FROM ${T_HO} h JOIN objects o ON o.tenant_id=h.tenant_id AND o.id=h.object_id JOIN users ou ON ou.tenant_id=h.tenant_id AND ou.id=h.outgoing_user_id JOIN users iu ON iu.tenant_id=h.tenant_id AND iu.id=h.incoming_user_id WHERE h.tenant_id=$1 AND h.function_code=$2${where} ORDER BY h.created_at DESC,h.id LIMIT 200`, args)).map(h => this.handoverView(h));
    }

    /** Deputy/Admin/General-Director management surface: heads, teams, objects, unresolved assignments, handovers. */
    async overview(a: Actor) {
        requirePermission(a, P.PTO_TEAM_READ);
        if (!OVERSIGHT_ROLES.includes(a.role))
            throw new ForbiddenException('Обзор команд доступен руководству');
        const t = a.tenantId;
        const users = await rows(pool, "SELECT id,name,role,is_active FROM users WHERE tenant_id=$1 AND role IN ('PTO','PTO_HEAD') ORDER BY name,id", [t]);
        const orgRows = await rows(pool, `SELECT * FROM ${T_ORG} WHERE tenant_id=$1 AND function_code=$2 AND ended_at IS NULL`, [t, FN]);
        const objects = await rows(pool, 'SELECT id,name FROM objects WHERE tenant_id=$1 ORDER BY name,id', [t]);
        const { leads, members } = await this.currentObjectRows(pool, t, null);
        const byId = new Map<string, any>(users.map((u: any) => [u.id, u]));
        const objectViews = objects.map((o: any) => {
            const lead = leads.find((l: any) => l.objectId === o.id) ?? null;
            return { objectId: o.id, name: o.name, lead: this.leadView(lead), members: members.filter((m: any) => m.objectId === o.id).map((m: any) => this.memberView(m, lead?.leadUserId ?? null)) };
        });
        const headIds = new Set<string>([...users.filter((u: any) => u.role === 'PTO_HEAD' && u.isActive).map((u: any) => u.id), ...orgRows.map((r: any) => r.managerUserId), ...leads.map((l: any) => l.leadUserId)]);
        const heads = [...headIds].map(id => {
            const u = byId.get(id) ?? { id, name: '—', role: null, isActive: false };
            return {
                userId: id, name: u.name, isActive: u.isActive, role: u.role,
                orgMembers: orgRows.filter((r: any) => r.managerUserId === id).map((r: any) => { const m = byId.get(r.memberUserId); return { assignmentId: r.id, userId: r.memberUserId, name: m?.name ?? '—', isActive: m?.isActive ?? false, startedAt: r.startedAt, version: r.version }; }),
                ledObjects: objectViews.filter(o => o.lead?.userId === id).map(o => ({ objectId: o.objectId, name: o.name })),
            };
        }).sort((x, y) => Number(y.isActive) - Number(x.isActive) || x.name.localeCompare(y.name, 'ru'));
        const engineers = users.filter((u: any) => u.role === 'PTO').map((u: any) => { const r = orgRows.find((x: any) => x.memberUserId === u.id); return { userId: u.id, name: u.name, isActive: u.isActive, orgManagerUserId: r?.managerUserId ?? null, orgAssignmentVersion: r?.version ?? null }; });
        const unresolved: any[] = [];
        for (const r of orgRows) {
            const mgr = byId.get(r.managerUserId), mem = byId.get(r.memberUserId);
            if (!mgr || !mgr.isActive || mgr.role !== 'PTO_HEAD') unresolved.push({ kind: 'ORG_MANAGER_UNAVAILABLE', assignmentId: r.id, userId: r.memberUserId, userName: mem?.name ?? '—', managerUserId: r.managerUserId, managerName: mgr?.name ?? '—' });
            if (!mem || !mem.isActive || mem.role !== 'PTO') unresolved.push({ kind: 'ORG_MEMBER_UNAVAILABLE', assignmentId: r.id, userId: r.memberUserId, userName: mem?.name ?? '—', managerUserId: r.managerUserId, managerName: mgr?.name ?? '—' });
        }
        for (const o of objectViews) {
            if (o.lead) { const u = byId.get(o.lead.userId); if (!u || !u.isActive || u.role !== 'PTO_HEAD') unresolved.push({ kind: 'OBJECT_LEAD_UNAVAILABLE', assignmentId: o.lead.assignmentId, objectId: o.objectId, objectName: o.name, userId: o.lead.userId, userName: o.lead.name }); }
            for (const m of o.members) { const u = byId.get(m.userId); if (!u || !u.isActive || u.role !== 'PTO') unresolved.push({ kind: 'OBJECT_MEMBER_UNAVAILABLE', assignmentId: m.assignmentId, objectId: o.objectId, objectName: o.name, userId: m.userId, userName: m.name }); }
        }
        const handovers = await this.handovers(pool, a, false);
        return { functionCode: FN, heads, engineers, objects: objectViews, unresolved, handovers };
    }

    /** PTO_HEAD: «Моя команда ПТО» + «Команда объекта». PTO: own objects and their teams. */
    async myTeam(a: Actor) {
        requirePermission(a, P.PTO_TEAM_READ);
        ensure(a.role === 'PTO_HEAD' || a.role === 'PTO', 'Раздел доступен сотрудникам ПТО');
        const t = a.tenantId;
        const objectIds = a.role === 'PTO_HEAD'
            ? (await rows(pool, `SELECT object_id FROM ${T_LEAD} WHERE tenant_id=$1 AND function_code=$2 AND lead_user_id=$3 AND ended_at IS NULL`, [t, FN, a.id])).map((r: any) => r.objectId)
            : (await rows(pool, `SELECT object_id FROM ${T_MEM} WHERE tenant_id=$1 AND function_code=$2 AND member_user_id=$3 AND ended_at IS NULL`, [t, FN, a.id])).map((r: any) => r.objectId);
        const objects = objectIds.length ? await rows(pool, 'SELECT id,name FROM objects WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY name,id', [t, objectIds]) : [];
        const { leads, members } = await this.currentObjectRows(pool, t, objectIds);
        const objectViews = objects.map((o: any) => { const lead = leads.find((l: any) => l.objectId === o.id) ?? null; return { objectId: o.id, name: o.name, lead: this.leadView(lead), members: members.filter((m: any) => m.objectId === o.id).map((m: any) => this.memberView(m, lead?.leadUserId ?? null)) }; });
        const orgTeam = a.role === 'PTO_HEAD' ? (await rows(pool, `SELECT o.*,u.name AS member_name,u.is_active AS member_is_active FROM ${T_ORG} o JOIN users u ON u.tenant_id=o.tenant_id AND u.id=o.member_user_id WHERE o.tenant_id=$1 AND o.function_code=$2 AND o.manager_user_id=$3 AND o.ended_at IS NULL ORDER BY u.name,o.id`, [t, FN, a.id])).map((r: any) => ({ assignmentId: r.id, userId: r.memberUserId, name: r.memberName, isActive: r.memberIsActive, startedAt: r.startedAt, onObjectIds: objectViews.filter(o => o.members.some((m: any) => m.userId === r.memberUserId)).map(o => o.objectId) })) : [];
        const orgManager = a.role === 'PTO' ? await one(pool, `SELECT o.manager_user_id AS user_id,u.name FROM ${T_ORG} o JOIN users u ON u.tenant_id=o.tenant_id AND u.id=o.manager_user_id WHERE o.tenant_id=$1 AND o.function_code=$2 AND o.member_user_id=$3 AND o.ended_at IS NULL`, [t, FN, a.id]) : null;
        return { functionCode: FN, role: a.role, orgTeam, orgManager: orgManager ?? null, objects: objectViews, handovers: await this.handovers(pool, a, true) };
    }

    /** Object screen PTO block: current lead/members and, separately, the assignment history. */
    async objectTeam(a: Actor, objectId: string) {
        requirePermission(a, P.PTO_TEAM_READ);
        const t = a.tenantId;
        const o = await scoped(pool, 'objects', objectId, a);
        await ensurePtoObjectScope(pool, a, objectId);
        const { leads, members } = await this.currentObjectRows(pool, t, [objectId]);
        const lead = leads[0] ?? null;
        const histLeads = await rows(pool, `SELECT l.*,u.name AS lead_name,u.is_active AS lead_is_active,eb.name AS ended_by_name FROM ${T_LEAD} l JOIN users u ON u.tenant_id=l.tenant_id AND u.id=l.lead_user_id LEFT JOIN users eb ON eb.tenant_id=l.tenant_id AND eb.id=l.ended_by WHERE l.tenant_id=$1 AND l.object_id=$2 AND l.function_code=$3 AND l.ended_at IS NOT NULL ORDER BY l.ended_at DESC,l.id`, [t, objectId, FN]);
        const histMembers = await rows(pool, `SELECT m.*,u.name AS member_name,u.is_active AS member_is_active,eb.name AS ended_by_name FROM ${T_MEM} m JOIN users u ON u.tenant_id=m.tenant_id AND u.id=m.member_user_id LEFT JOIN users eb ON eb.tenant_id=m.tenant_id AND eb.id=m.ended_by WHERE m.tenant_id=$1 AND m.object_id=$2 AND m.function_code=$3 AND m.ended_at IS NOT NULL ORDER BY m.ended_at DESC,m.id`, [t, objectId, FN]);
        return {
            functionCode: FN, objectId, objectName: o.name,
            current: { lead: this.leadView(lead), members: members.map((m: any) => this.memberView(m, lead?.leadUserId ?? null)) },
            history: {
                leads: histLeads.map((l: any) => ({ assignmentId: l.id, userId: l.leadUserId, name: l.leadName, startedAt: l.startedAt, endedAt: l.endedAt, endedByName: l.endedByName, endReason: l.endReason })),
                members: histMembers.map((m: any) => ({ assignmentId: m.id, userId: m.memberUserId, name: m.memberName, startedAt: m.startedAt, endedAt: m.endedAt, endedByName: m.endedByName, endReason: m.endReason })),
            },
            handovers: await this.handovers(pool, a, false, objectId),
        };
    }

    async listHandovers(a: Actor) {
        requirePermission(a, P.PTO_TEAM_READ);
        return this.handovers(pool, a, !OVERSIGHT_ROLES.includes(a.role));
    }
}
