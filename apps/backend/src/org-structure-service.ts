import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { pool, rows, transaction } from './db';
import { Actor, requirePermission } from './security';
import { Permission as P } from '../../../packages/domain';
import { ORG_FUNCTIONS, ORG_FUNCTION_CODES, type OrgFunctionCode, lockTeamScope, orgAssignCore, orgTransferCore, orgEndCore } from './team-service';

/**
 * ORG-1 — «Структура компании»: tenant-scoped organizational read model + bounded mutations.
 *
 * Three independent axes (DR-ORG01): this service reads/writes ONLY the organizational axis
 * (functional_team_memberships). Object assignments (object_function_*) and the object РП
 * (objects.project_manager_id) are READ for display and are never written here — no cascade,
 * no handover, no role change. Bitrix descriptive fields are not consulted at all.
 *
 * Visibility (enforced here, independent of any frontend predicate):
 *  - GENERAL_DIRECTOR / DEPUTY_DIRECTOR / ADMIN: whole company;
 *  - PTO_HEAD / CONSTRUCTION_CONTROL_HEAD / SDO_HEAD: only their own function and only their own team;
 *  - everyone else: 403.
 * Mutations: FUNCTION_TEAM_MANAGE (DEPUTY_DIRECTOR, ADMIN). GENERAL_DIRECTOR is read-only.
 */
const FULL_READ_ROLES = ['GENERAL_DIRECTOR', 'DEPUTY_DIRECTOR', 'ADMIN'];
const HEAD_FUNCTION: Record<string, OrgFunctionCode> = { PTO_HEAD: 'PTO', CONSTRUCTION_CONTROL_HEAD: 'CONSTRUCTION_CONTROL', SDO_HEAD: 'SDO' };
const OBJECT_TEAM_FUNCTIONS: OrgFunctionCode[] = ['PTO', 'CONSTRUCTION_CONTROL', 'SDO'];
const T_ORG = 'functional_team_memberships', T_LEAD = 'object_function_lead_assignments', T_MEM = 'object_function_member_assignments';

type Scope = { kind: 'FULL' } | { kind: 'OWN_TEAM'; fn: OrgFunctionCode };

@Injectable()
export class OrgStructureService {
    private scope(a: Actor): Scope {
        if (FULL_READ_ROLES.includes(a.role)) {
            requirePermission(a, P.ORG_STRUCTURE_READ);
            return { kind: 'FULL' };
        }
        // Functional heads hold no company-wide permission: the exact role maps to exactly one function and one team.
        const fn = HEAD_FUNCTION[a.role];
        if (fn)
            return { kind: 'OWN_TEAM', fn };
        throw new ForbiddenException('Структура компании недоступна для вашей роли');
    }
    private canManage(a: Actor) { try { requirePermission(a, P.FUNCTION_TEAM_MANAGE); return true; } catch { return false; } }

    // -----------------------------------------------------------------------
    // Mutations — fixed tenant/assignedBy from the session, function from the route, exact role pair.
    // -----------------------------------------------------------------------
    async assign(a: Actor, fn: OrgFunctionCode, d: { memberUserId: string; managerUserId: string }) {
        requirePermission(a, P.FUNCTION_TEAM_MANAGE);
        return transaction(async (c) => {
            const users = await lockTeamScope(c, a, [], [d.memberUserId, d.managerUserId], fn);
            return orgAssignCore(c, a, fn, users, d.memberUserId, d.managerUserId);
        });
    }
    async transfer(a: Actor, fn: OrgFunctionCode, d: { memberUserId: string; managerUserId: string; reason: string; expectedAssignmentId: string; expectedVersion: number }) {
        requirePermission(a, P.FUNCTION_TEAM_MANAGE);
        return transaction(async (c) => {
            const users = await lockTeamScope(c, a, [], [d.memberUserId, d.managerUserId], fn);
            return orgTransferCore(c, a, fn, users, d.memberUserId, d.managerUserId, d.reason, { assignmentId: d.expectedAssignmentId, version: d.expectedVersion });
        });
    }
    async end(a: Actor, fn: OrgFunctionCode, d: { memberUserId: string; reason: string; expectedAssignmentId: string; expectedVersion: number }) {
        requirePermission(a, P.FUNCTION_TEAM_MANAGE);
        return transaction(async (c) => {
            const users = await lockTeamScope(c, a, [], [d.memberUserId], fn);
            // Tenant-scoped lookup: another tenant's (or an unknown) employee is 404, never a vague conflict. The employee
            // may be inactive / have a changed role — cleanup of an unavailable relationship must stay possible.
            if (!users.get(d.memberUserId))
                throw new NotFoundException('Пользователь не найден');
            return orgEndCore(c, a, fn, d.memberUserId, d.reason, { assignmentId: d.expectedAssignmentId, version: d.expectedVersion });
        });
    }

    // -----------------------------------------------------------------------
    // Read model.
    // -----------------------------------------------------------------------
    async overview(a: Actor) {
        const scope = this.scope(a);
        const canManage = this.canManage(a);
        const t = a.tenantId;
        const users = await rows(pool, 'SELECT id,name,role,is_active FROM users WHERE tenant_id=$1 ORDER BY name,id', [t]);
        const byId = new Map<string, any>(users.map((u: any) => [u.id, u]));
        const memberships = await rows(pool, `SELECT * FROM ${T_ORG} WHERE tenant_id=$1 AND ended_at IS NULL`, [t]);
        const leads = await rows(pool, `SELECT l.object_id,l.function_code,l.lead_user_id,o.name AS object_name FROM ${T_LEAD} l JOIN objects o ON o.tenant_id=l.tenant_id AND o.id=l.object_id WHERE l.tenant_id=$1 AND l.ended_at IS NULL`, [t]);
        const objMembers = await rows(pool, `SELECT m.object_id,m.function_code,m.member_user_id,o.name AS object_name FROM ${T_MEM} m JOIN objects o ON o.tenant_id=m.tenant_id AND o.id=m.object_id WHERE m.tenant_id=$1 AND m.ended_at IS NULL`, [t]);
        const pmObjects = await rows(pool, 'SELECT id,name,project_manager_id FROM objects WHERE tenant_id=$1 ORDER BY name,id', [t]);

        const functions = ORG_FUNCTION_CODES.filter(fn => scope.kind === 'FULL' || scope.fn === fn).map((fn) => {
            const def = ORG_FUNCTIONS[fn];
            const current = memberships.filter((m: any) => m.functionCode === fn);
            const orgManagerOf = new Map<string, string>(current.map((m: any) => [m.memberUserId, m.managerUserId]));
            const leadByObject = new Map<string, any>(leads.filter((l: any) => l.functionCode === fn).map((l: any) => [l.objectId, l]));

            const objectsOf = (userId: string) => {
                if (fn === 'PROJECT_MANAGEMENT')
                    // The authoritative РП source stays objects.project_manager_id; shown, never copied.
                    return pmObjects.filter((o: any) => o.projectManagerId === userId).map((o: any) => ({ objectId: o.id, name: o.name, relation: 'PROJECT_MANAGER', objectLeadUserId: null, objectLeadName: null, differentOrgTeam: false }));
                const asLead = leads.filter((l: any) => l.functionCode === fn && l.leadUserId === userId).map((l: any) => ({ objectId: l.objectId, name: l.objectName, relation: 'LEAD', objectLeadUserId: userId, objectLeadName: byId.get(userId)?.name ?? null, differentOrgTeam: false }));
                const asMember = objMembers.filter((m: any) => m.functionCode === fn && m.memberUserId === userId).map((m: any) => {
                    const lead = leadByObject.get(m.objectId) ?? null, orgManager = orgManagerOf.get(userId) ?? null;
                    // Valid state, not an error: org manager differs from the current object lead (inherited team).
                    return { objectId: m.objectId, name: m.objectName, relation: 'MEMBER', objectLeadUserId: lead?.leadUserId ?? null, objectLeadName: lead ? byId.get(lead.leadUserId)?.name ?? null : null, differentOrgTeam: !!lead && !!orgManager && orgManager !== lead.leadUserId };
                });
                return [...asLead, ...asMember].sort((x, y) => x.name.localeCompare(y.name, 'ru'));
            };
            const employee = (userId: string, m: any | null) => {
                const u = byId.get(userId);
                return {
                    userId, name: u?.name ?? '—', isActive: !!u?.isActive, role: u?.role ?? null, roleMatches: u?.role === def.memberRole,
                    orgManagerUserId: m?.managerUserId ?? null, startedAt: m?.startedAt ?? null,
                    // id + version are handed out only to a caller allowed to mutate.
                    assignment: m && canManage ? { assignmentId: m.id, version: m.version } : null,
                    objects: objectsOf(userId),
                };
            };

            let managerIds = new Set<string>([...users.filter((u: any) => u.role === def.managerRole && u.isActive).map((u: any) => u.id), ...current.map((m: any) => m.managerUserId)]);
            if (scope.kind === 'OWN_TEAM')
                managerIds = new Set([a.id]);
            const managers = [...managerIds].map((id) => {
                const u = byId.get(id);
                const team = current.filter((m: any) => m.managerUserId === id).map((m: any) => employee(m.memberUserId, m)).sort((x: any, y: any) => x.name.localeCompare(y.name, 'ru'));
                const ledObjects = OBJECT_TEAM_FUNCTIONS.includes(fn) ? objectsOf(id).filter((o: any) => o.relation === 'LEAD') : [];
                const objectIds = new Set<string>(fn === 'PROJECT_MANAGEMENT' ? team.flatMap((e: any) => e.objects.map((o: any) => o.objectId)) : ledObjects.map((o: any) => o.objectId));
                return { userId: id, name: u?.name ?? '—', isActive: !!u?.isActive, role: u?.role ?? null, roleMatches: u?.role === def.managerRole, orgMembers: team, ledObjects, objectCount: objectIds.size };
            }).sort((x, y) => Number(y.isActive) - Number(x.isActive) || x.name.localeCompare(y.name, 'ru'));

            const assigned = new Set(current.map((m: any) => m.memberUserId));
            const unassigned = scope.kind === 'FULL'
                ? users.filter((u: any) => u.role === def.memberRole && u.isActive && !assigned.has(u.id)).map((u: any) => employee(u.id, null))
                : [];

            const unresolved: any[] = [];
            for (const m of current) {
                if (scope.kind === 'OWN_TEAM' && m.managerUserId !== a.id)
                    continue;
                const mgr = byId.get(m.managerUserId), mem = byId.get(m.memberUserId);
                const base = { assignment: canManage ? { assignmentId: m.id, version: m.version } : null, memberUserId: m.memberUserId, memberName: mem?.name ?? '—', managerUserId: m.managerUserId, managerName: mgr?.name ?? '—' };
                if (!mgr || !mgr.isActive || mgr.role !== def.managerRole)
                    unresolved.push({ kind: 'MANAGER_UNAVAILABLE', ...base });
                if (!mem || !mem.isActive || mem.role !== def.memberRole)
                    unresolved.push({ kind: 'MEMBER_UNAVAILABLE', ...base });
            }
            return { functionCode: fn, managerRole: def.managerRole, memberRole: def.memberRole, managers, unassigned, unresolved };
        });

        const pmTeams = memberships.filter((m: any) => m.functionCode === 'PROJECT_MANAGEMENT');
        const deputyIds = new Set<string>([...users.filter((u: any) => u.role === ORG_FUNCTIONS.PROJECT_MANAGEMENT.managerRole && u.isActive).map((u: any) => u.id), ...pmTeams.map((m: any) => m.managerUserId)]);
        const management = scope.kind === 'FULL'
            ? { deputies: [...deputyIds].map((id) => ({ userId: id, name: byId.get(id)?.name ?? '—', isActive: !!byId.get(id)?.isActive, projectManagerCount: pmTeams.filter((m: any) => m.managerUserId === id).length })).sort((x, y) => Number(y.isActive) - Number(x.isActive) || x.name.localeCompare(y.name, 'ru')) }
            : null;
        return { scope: scope.kind, canManage, management, functions };
    }

    /**
     * Append-only organizational history, one entry per membership row. previousManager/nextManager come from the
     * adjacent rows of the same employee+function. Historical entries are never modified by anything here.
     */
    async history(a: Actor, q: { functionCode?: OrgFunctionCode; memberUserId?: string }) {
        const scope = this.scope(a);
        if (scope.kind === 'OWN_TEAM' && q.functionCode && q.functionCode !== scope.fn)
            throw new ForbiddenException('История доступна только по вашей функции');
        const fns = scope.kind === 'OWN_TEAM' ? [scope.fn] : q.functionCode ? [q.functionCode] : ORG_FUNCTION_CODES;
        const args: any[] = [a.tenantId, fns];
        let where = '';
        if (q.memberUserId) { args.push(q.memberUserId); where = ` AND m.member_user_id=$${args.length}`; }
        const list = await rows(pool, `SELECT m.*,mu.name AS member_name,gu.name AS manager_name,ab.name AS assigned_by_name,eb.name AS ended_by_name FROM ${T_ORG} m JOIN users mu ON mu.tenant_id=m.tenant_id AND mu.id=m.member_user_id JOIN users gu ON gu.tenant_id=m.tenant_id AND gu.id=m.manager_user_id JOIN users ab ON ab.tenant_id=m.tenant_id AND ab.id=m.assigned_by LEFT JOIN users eb ON eb.tenant_id=m.tenant_id AND eb.id=m.ended_by WHERE m.tenant_id=$1 AND m.function_code=ANY($2::text[])${where} ORDER BY m.function_code,m.member_user_id,m.started_at,m.id`, args);
        const out: any[] = [];
        list.forEach((m: any, i: number) => {
            const prev = list[i - 1], next = list[i + 1];
            const p = prev && prev.memberUserId === m.memberUserId && prev.functionCode === m.functionCode ? prev : null;
            const n = next && next.memberUserId === m.memberUserId && next.functionCode === m.functionCode ? next : null;
            if (scope.kind === 'OWN_TEAM' && ![m.managerUserId, p?.managerUserId, n?.managerUserId].includes(a.id))
                return;
            out.push({
                assignmentId: m.id, functionCode: m.functionCode, memberUserId: m.memberUserId, memberName: m.memberName,
                managerUserId: m.managerUserId, managerName: m.managerName,
                previousManagerUserId: p?.managerUserId ?? null, previousManagerName: p?.managerName ?? null,
                nextManagerUserId: n?.managerUserId ?? null, nextManagerName: n?.managerName ?? null,
                startedAt: m.startedAt, startedByName: m.assignedByName,
                endedAt: m.endedAt, endedByName: m.endedByName ?? null, reason: m.endReason ?? null, active: m.endedAt === null,
            });
        });
        return out.sort((x, y) => new Date(y.startedAt).getTime() - new Date(x.startedAt).getTime() || x.assignmentId.localeCompare(y.assignmentId)).slice(0, 500);
    }
}
