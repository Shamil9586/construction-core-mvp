import { Gpr2Error } from '../../../packages/domain/gpr2';
import { Gpr2HttpException } from './gpr2-command-guard';
import Decimal from 'decimal.js';
import { one, insert } from './db';
import { Actor, requirePermission, scoped, objectAccess, ensure, checkVersion, audit } from './security';
import { Permission as P } from '../../../packages/domain';
import { commandFingerprint } from '../../../packages/domain/gpr2';
import { runLedgered } from './command-ledger';

export const PLANNING_FIELDS = ['contractorId', 'responsibleUserId', 'estimatedCost', 'plannedStartDate', 'plannedFinishDate'] as const;

async function validatePlanning(c: any, a: Actor, objectId: string, values: any) {
    if (values.responsibleUserId) {
        const u = await one(c, 'SELECT * FROM users WHERE tenant_id=$1 AND id=$2 FOR SHARE', [a.tenantId, values.responsibleUserId]);
        ensure(!!u, 'Ответственный не найден');
        ensure(u.isActive, 'Ответственный неактивен');
    }
    if (values.contractorId) ensure(!!await one(c, 'SELECT id FROM object_contractors_active WHERE tenant_id=$1 AND object_id=$2 AND contractor_id=$3 FOR UPDATE', [a.tenantId, objectId, values.contractorId]), 'Субподрядчик не назначен на объект');
    ensure(!values.plannedStartDate || !values.plannedFinishDate || values.plannedFinishDate >= values.plannedStartDate, 'Некорректные сроки');
}

/** Called only inside the registered coordinated transaction; no independent pool access. */
export async function writeEarlyWork(c: any, a: Actor, input: any, workId?: string) {
    const previous = workId ? await scoped(c, 'works', workId, a) : null;
    const objectId = previous?.objectId ?? input.objectId;
    const { idempotencyKey, version, ...data } = input;
    if (!workId) {
        for (const f of PLANNING_FIELDS) data[f] = data[f] ?? null;
        data.plannedQuantity = new Decimal(data.plannedQuantity).toFixed(4);
    }
    if (data.estimatedCost != null) data.estimatedCost = new Decimal(data.estimatedCost).toFixed(2);
    ensure(!!workId || PLANNING_FIELDS.every(f => data[f] != null) || !!idempotencyKey, 'Для ранней работы необходим idempotencyKey');
    const commandKind = workId ? 'work.planning.complete' : 'work.create';
    const outcome = await runLedgered(c, {
        tenantId: a.tenantId, actorId: a.id, commandKind, scopeId: workId ?? objectId, idempotencyKey: idempotencyKey ?? null,
        fingerprint: commandFingerprint({ commandKind, payload: { ...data, version: version ?? null }, expectedVersion: null, expectedScopeVersion: null, sourceVersions: {} })
    }, {
        authorize: async () => {
            const current = await one(c, 'SELECT * FROM users WHERE tenant_id=$1 AND id=$2 FOR SHARE', [a.tenantId, a.id]);
            ensure(!!current, 'Пользователь не найден');
            ensure(current.isActive, 'Пользователь неактивен');
            requirePermission(current, P.WORK_CREATE);
            await objectAccess(c, current, objectId, true);
        },
        execute: async () => {
            let work: any;
            if (workId) {
                const old = await scoped(c, 'works', workId, a, true);
                checkVersion(old, version);
                for (const f of PLANNING_FIELDS) if (f in data) ensure(old[f] == null, 'Известный реквизит нельзя перезаписать: ' + f);
                await validatePlanning(c, a, objectId, { ...old, ...data });
                const names: Record<string, string> = { contractorId: 'contractor_id', responsibleUserId: 'responsible_user_id', estimatedCost: 'estimated_cost', plannedStartDate: 'planned_start_date', plannedFinishDate: 'planned_finish_date' };
                const fields = PLANNING_FIELDS.filter(f => f in data);
                work = await one(c, `UPDATE works SET ${fields.map((f, i) => names[f] + '=$' + (i + 3)).join(',')},version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`, [a.tenantId, workId, ...fields.map(f => data[f])]);
                await audit(c, a, 'Work', workId, 'COMPLETE_PLANNING', old, work);
            } else {
                await scoped(c, 'work_types', data.workTypeId, a);
                await validatePlanning(c, a, objectId, data);
                work = await insert(c, 'works', a.tenantId, data);
                await audit(c, a, 'Work', work.id, 'CREATE', null, work);
            }
            return { resultIds: [work.id], appliedVersions: { aggregate: String(work.version), scope: null }, warnings: [] };
        }
    }).catch(e => { throw e instanceof Gpr2Error ? new Gpr2HttpException(e) : e; });
    return scoped(c, 'works', outcome.result.resultIds[0], a);
}
