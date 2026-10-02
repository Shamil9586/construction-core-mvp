import { ForbiddenException, Injectable } from '@nestjs/common';
import { pool, transaction, one, rows, insert } from './db';
import { Actor, requirePermission, scoped, objectAccess, workAccess, effectivePtoWorkAssignment, audit, ensure } from './security';
import { Permission as P, canAccessDocumentation } from '../../../packages/domain';
import { lockTeamScope } from './team-service';

/**
 * PILOT-W01 UI03 — PTO work handoff («Передать в работу»).
 *
 * Authoritative eligibility: object → current PTO_HEAD of that object → that head's CURRENT organizational PTO team
 * (functional_team_memberships) → active PTO engineers. Nothing else: no prior object membership is required (the handoff
 * itself is the work-level assignment and, while active, the assignee's work-scoped PTO access — see
 * hasActivePtoWorkAssignmentOnObject in security.ts). No head => empty (never a tenant-wide fallback).
 */
export async function resolvePtoWorkEligibility(c: any, tenantId: string, objectId: string): Promise<{ head: { id: string; name: string } | null; engineers: { id: string; name: string }[] }> {
    const head = await one(c, `SELECT u.id,u.name FROM object_function_lead_assignments l JOIN users u ON u.tenant_id=l.tenant_id AND u.id=l.lead_user_id WHERE l.tenant_id=$1 AND l.object_id=$2 AND l.function_code='PTO' AND l.ended_at IS NULL AND u.is_active=true AND u.role='PTO_HEAD'`, [tenantId, objectId]);
    if (!head)
        return { head: null, engineers: [] };
    const engineers = await rows(c, `SELECT u.id,u.name FROM functional_team_memberships t JOIN users u ON u.tenant_id=t.tenant_id AND u.id=t.member_user_id WHERE t.tenant_id=$1 AND t.function_code='PTO' AND t.manager_user_id=$2 AND t.ended_at IS NULL AND u.is_active=true AND u.role='PTO' ORDER BY u.name,u.id`, [tenantId, head.id]);
    return { head: { id: head.id, name: head.name }, engineers: engineers.map((e: any) => ({ id: e.id, name: e.name })) };
}
export async function activePtoWorkAssignment(c: any, tenantId: string, workId: string, lock = false) {
    return one(c, `SELECT * FROM pto_work_assignments WHERE tenant_id=$1 AND object_work_id=$2 AND ended_at IS NULL ${lock ? 'FOR UPDATE' : ''}`, [tenantId, workId]);
}

@Injectable()
export class PtoWorkAssignmentService {
    /** Who may hand the work off: the object's CURRENT PTO_HEAD, or ADMIN (existing system override, eligibility still applies). */
    private canAssign(a: Actor, headId: string | null) {
        return a.role === 'ADMIN' || (a.role === 'PTO_HEAD' && headId === a.id);
    }

    /** Read model for W01: head, eligible engineers (only for who may assign), current assignment, and server-decided action flags. */
    async view(a: Actor, workId: string) {
        if (!canAccessDocumentation(a.role))
            throw new ForbiddenException('Недостаточно прав: доступ к исполнительной документации');
        const w = await scoped(pool, 'works', workId, a);
        await workAccess(pool, a, w); // PTO engineer: object member or EFFECTIVE assignee of this exact work
        const elig = await resolvePtoWorkEligibility(pool, a.tenantId, w.objectId);
        // Only an EFFECTIVE assignment is reported (stale rows — assignee left the head's team, deactivated, head changed — are not);
        // assign() (not this read) decides whether a stale row can be superseded.
        const current = await effectivePtoWorkAssignment(pool, a.tenantId, workId);
        const user = current ? await one(pool, 'SELECT name FROM users WHERE tenant_id=$1 AND id=$2', [a.tenantId, current.assigneeUserId]) : null;
        const by = current ? await one(pool, 'SELECT name FROM users WHERE tenant_id=$1 AND id=$2', [a.tenantId, current.assignedBy]) : null;
        const pkgs = await one(pool, 'SELECT count(*)::int AS n FROM documentation_packages WHERE tenant_id=$1 AND object_work_id=$2', [a.tenantId, workId]);
        const canAssign = this.canAssign(a, elig.head?.id ?? null);
        const packageCount: number = pkgs.n;
        return {
            objectWorkId: workId,
            objectId: w.objectId,
            head: elig.head,
            assignment: current ? { id: current.id, assigneeUserId: current.assigneeUserId, assigneeName: user?.name ?? '', assignedByName: by?.name ?? '', assignedAt: current.startedAt, version: current.version } : null,
            eligible: canAssign ? elig.engineers : [],
            packageCount,
            canAssign,
            // Reassignment is only offered before any package exists (see assign()).
            canReassign: canAssign && !!current && packageCount === 0,
            canCreatePackage: !!current && (a.role === 'ADMIN' || (a.role === 'PTO' && current.assigneeUserId === a.id)),
        };
    }

    async assign(a: Actor, workId: string, d: { assigneeUserId: string }) {
        requirePermission(a, P.PTO_OBJECT_TEAM_MANAGE);
        return transaction(async (c) => {
            const w = await scoped(c, 'works', workId, a, true);
            await objectAccess(c, a, w.objectId, true); // PTO_HEAD: must be the object's CURRENT lead (ensurePtoObjectScope)
            await lockTeamScope(c, a, [w.objectId], [d.assigneeUserId, a.id]);
            const elig = await resolvePtoWorkEligibility(c, a.tenantId, w.objectId);
            ensure(!!elig.head, 'На объекте не назначен начальник ПТО');
            if (!this.canAssign(a, elig.head!.id))
                throw new ForbiddenException('Передать работу в ПТО может только текущий начальник ПТО этого объекта');
            ensure(elig.engineers.some((e) => e.id === d.assigneeUserId), 'Сотрудник не входит в команду ПТО этого объекта');
            const current = await activePtoWorkAssignment(c, a.tenantId, workId, true);
            if (current && current.assigneeUserId === d.assigneeUserId)
                return current; // idempotent: same engineer, nothing changes
            if (current) {
                const pkg = await one(c, 'SELECT 1 AS x FROM documentation_packages WHERE tenant_id=$1 AND object_work_id=$2 LIMIT 1', [a.tenantId, workId]);
                ensure(!pkg, 'Пакет ИД уже создан: смена ответственного ПТО здесь не поддерживается');
                await c.query("UPDATE pto_work_assignments SET ended_at=clock_timestamp(),ended_by=$3,end_reason='REASSIGNED',version=version+1 WHERE tenant_id=$1 AND id=$2 AND ended_at IS NULL", [a.tenantId, current.id, a.id]);
            }
            const created = await insert(c, 'pto_work_assignments', a.tenantId, { objectId: w.objectId, objectWorkId: workId, assigneeUserId: d.assigneeUserId, assignedBy: a.id });
            await audit(c, a, 'PtoWorkAssignment', created.id, current ? 'REASSIGN' : 'ASSIGN', current ?? null, created);
            return created;
        });
    }
}
