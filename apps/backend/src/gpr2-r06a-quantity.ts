import { ForbiddenException, NotFoundException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { one } from './db';
import { loadWorkFacts } from './fact-resolver';
import { Actor, objectAccess, workAccess } from './security';
import { runSnapshotRead } from './tx-context';
import { Permission, hasPermission } from '../../../packages/domain';
import { QuantityRead, shapeQuantityRead } from '../../../packages/domain/gpr2/r06a-quantity';

/** Called after a newly created Work INSERT on the same coordinated command connection. Never run for historical rows. */
export async function recordInitialWorkQuantity(c: any, work: { id: string; tenantId: string; objectId: string }, actorId: string,
    source: { kind: 'MANUAL_CREATE' | 'FINISH_GENERATION'; ref?: string; version?: string }): Promise<void> {
    const workRow = await one(c, 'SELECT unit,planned_quantity::text AS quantity FROM works WHERE tenant_id=$1 AND object_id=$2 AND id=$3',
        [work.tenantId, work.objectId, work.id]);
    if (!workRow) throw new Error('R06a: created Work disappeared within its command');
    const quantity = new Decimal(workRow.quantity).toFixed(4);
    const origin = await one(c, `INSERT INTO work_quantity_origins(tenant_id,object_id,work_id,source_kind,source_ref,source_version,provenance_status,original_quantity,unit,created_by)
        VALUES($1,$2,$3,$4,$5,$6,'PROVEN_CREATION',$7,$8,$9) RETURNING id`,
        [work.tenantId, work.objectId, work.id, source.kind, source.ref ?? null, source.version ?? null, quantity, workRow.unit, actorId]);
    if (!origin) throw new Error('R06a: origin insert failed');
    const version = await one(c, `INSERT INTO work_quantity_versions(tenant_id,object_id,work_id,sequence,quantity,unit,source_kind,created_by)
        VALUES($1,$2,$3,1,$4,$5,'INITIAL_CREATION',$6) RETURNING id`,
        [work.tenantId, work.objectId, work.id, quantity, workRow.unit, actorId]);
    await c.query(`INSERT INTO work_current_quantity(tenant_id,object_id,work_id,approved_version_id,created_by) VALUES($1,$2,$3,$4,$5)`,
        [work.tenantId, work.objectId, work.id, version.id, actorId]);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Object-scoped single-snapshot read. The legacy path is observed current, never asserted original provenance. */
export async function readWorkQuantity(actor: Actor, objectIdInput: string, workIdInput: string): Promise<QuantityRead> {
    if (!hasPermission(actor.role, Permission.WORK_VIEW)) throw new ForbiddenException('Недостаточно прав');
    const objectId = objectIdInput.toLowerCase(), workId = workIdInput.toLowerCase();
    if (!UUID.test(objectId) || !UUID.test(workId)) throw new NotFoundException('Запись не найдена');
    return runSnapshotRead(async ({ c }) => {
        const current = await one(c, 'SELECT id,tenant_id,role,is_active,contractor_id FROM users WHERE tenant_id=$1 AND id=$2', [actor.tenantId, actor.id]);
        if (!current || !current.isActive || !hasPermission(current.role, Permission.WORK_VIEW)) throw new ForbiddenException('Недостаточно прав');
        try { await objectAccess(c, current, objectId); }
        catch (e) { if (e instanceof ForbiddenException || e instanceof NotFoundException) throw new NotFoundException('Запись не найдена'); throw e; }
        const work = await one(c, `SELECT id,tenant_id,object_id,unit,planned_quantity::text AS observed_quantity FROM works
            WHERE tenant_id=$1 AND object_id=$2 AND id=$3`, [actor.tenantId, objectId, workId]);
        if (!work) throw new NotFoundException('Запись не найдена');
        try { await workAccess(c, current, work); }
        catch (e) { if (e instanceof ForbiddenException || e instanceof NotFoundException) throw new NotFoundException('Запись не найдена'); throw e; }
        if (current.role === 'CONTRACTOR_VIEWER') {
            const own = await one(c, 'SELECT id FROM works WHERE tenant_id=$1 AND object_id=$2 AND id=$3 AND contractor_id=$4',
                [actor.tenantId, objectId, workId, current.contractorId ?? null]);
            if (!own) throw new NotFoundException('Запись не найдена');
        }
        const origin = await one(c, `SELECT provenance_status,source_kind,source_ref,source_version,original_quantity::text AS original_quantity,unit
            FROM work_quantity_origins WHERE tenant_id=$1 AND object_id=$2 AND work_id=$3`, [actor.tenantId, objectId, workId]);
        const pointer = await one(c, `SELECT v.id,v.sequence,v.quantity::text AS quantity,v.unit,v.source_kind FROM work_current_quantity p
            JOIN work_quantity_versions v ON (v.tenant_id=p.tenant_id AND v.object_id=p.object_id AND v.work_id=p.work_id AND v.id=p.approved_version_id)
            WHERE p.tenant_id=$1 AND p.object_id=$2 AND p.work_id=$3`, [actor.tenantId, objectId, workId]);
        const fact = (await loadWorkFacts(c, actor.tenantId, [workId])).get(workId);
        return shapeQuantityRead({ workId, objectId, origin, pointer, observedQuantity: work.observedQuantity, observedUnit: work.unit,
            factQuantity: fact?.quantity ?? null, factState: fact?.state ?? 'UNKNOWN', factSourceMode: fact?.mode ?? 'UNKNOWN' });
    });
}
