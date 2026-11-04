import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { one, rows, transaction } from './db';
import { Actor, objectAccess, requirePermission, workAccess, audit } from './security';
import { Permission } from '../../../packages/domain';
import { coordinate } from './coordination-lock';
import { loadPortionFigures, loadWorkFacts } from './fact-resolver';

type Input = { expectedVersionId: string | null; units: { executionUnitId: string; quantity: string | number;
    portions: { portionId: string; quantity: string | number }[] }[] };
const dec = (value: string | number) => new Decimal(value);
const fixed = (value: Decimal) => value.toFixed(4);

/** Explicit complete snapshot; all reads and writes share one Work lock and transaction. */
export async function replaceWorkAllocation(a: Actor, objectId: string, workId: string, d: Input, tokenHash: string) {
    requirePermission(a, Permission.EXECUTION_UNIT_MANAGE);
    return transaction(async c => {
        await coordinate(c, 'gpr2-r06b-allocation.ts#replaceWorkAllocation', a.tenantId, { work: workId });
        const work = await one(c, 'SELECT * FROM works WHERE tenant_id=$1 AND object_id=$2 AND id=$3 FOR UPDATE', [a.tenantId, objectId, workId]);
        if (!work) throw new NotFoundException('Работа не найдена');
        // The actor captured by authenticate() is not a durable authorization decision.
        // Lock both session and user after Work coordination so a concurrent revocation
        // either commits first (this fails) or waits until this transaction ends.
        const currentActor = await one(c, `SELECT u.* FROM sessions s JOIN users u ON u.tenant_id=s.tenant_id AND u.id=s.user_id
            WHERE s.token_hash=$1 AND s.tenant_id=$2 AND s.user_id=$3 AND s.expires_at>now()
              AND u.is_active=true FOR SHARE OF s,u`, [tokenHash,a.tenantId,a.id]);
        if (!currentActor) throw new ConflictException('Сессия или роль изменена');
        requirePermission(currentActor, Permission.EXECUTION_UNIT_MANAGE);
        const lockedObject = await one(c,'SELECT id FROM objects WHERE tenant_id=$1 AND id=$2 FOR SHARE',
            [a.tenantId,objectId]);
        if (!lockedObject) throw new NotFoundException('Объект не найден');
        await objectAccess(c, currentActor, objectId, true);
        await workAccess(c, currentActor, work, true);
        const current = await one(c, `SELECT p.approved_version_id,v.quantity::text AS quantity,v.unit FROM work_current_quantity p
            JOIN work_quantity_versions v ON v.tenant_id=p.tenant_id AND v.object_id=p.object_id AND v.work_id=p.work_id AND v.id=p.approved_version_id
            WHERE p.tenant_id=$1 AND p.object_id=$2 AND p.work_id=$3 FOR UPDATE OF p`, [a.tenantId, objectId, workId]);
        if (!current) throw new ConflictException('Для работы нет подтверждённой текущей версии объёма; исторический источник не установлен');
        const previous = await one(c, `SELECT p.version_id,v.sequence FROM work_current_allocation p JOIN work_allocation_versions v
            ON v.tenant_id=p.tenant_id AND v.object_id=p.object_id AND v.work_id=p.work_id AND v.id=p.version_id
            WHERE p.tenant_id=$1 AND p.object_id=$2 AND p.work_id=$3 FOR UPDATE OF p`, [a.tenantId, objectId, workId]);
        if ((previous?.versionId ?? null) !== d.expectedVersionId) throw new ConflictException('Версия распределения изменилась');
        // R06b does not implement the R07 fact/reduction race. An allocation
        // snapshot is frozen once any protected evidence exists; direct SQL has
        // the same rule in the pointer trigger. Later scoped adjustments are R07.
        const evidence = await one(c, `SELECT 1 AS present FROM works w WHERE w.tenant_id=$1 AND w.object_id=$2 AND w.id=$3 AND (
            w.actual_quantity>0 OR EXISTS(SELECT 1 FROM work_progress p WHERE p.tenant_id=w.tenant_id AND p.object_work_id=w.id)
            OR EXISTS(SELECT 1 FROM work_execution_units u JOIN quantity_portions p ON p.tenant_id=u.tenant_id AND p.execution_unit_id=u.id
                JOIN portion_quantity_confirmations f ON f.tenant_id=p.tenant_id AND f.portion_id=p.id
                WHERE u.tenant_id=w.tenant_id AND u.object_work_id=w.id)
            OR EXISTS(SELECT 1 FROM work_execution_units u JOIN quantity_portions p ON p.tenant_id=u.tenant_id AND p.execution_unit_id=u.id
                JOIN documentation_customer_accepted_quantities f ON f.tenant_id=p.tenant_id AND f.quantity_portion_id=p.id
                WHERE u.tenant_id=w.tenant_id AND u.object_work_id=w.id))`, [a.tenantId,objectId,workId]);
        if (evidence) throw new ConflictException('Распределение защищено подтверждённым фактом; корректировка относится к R07');
        if (new Set(d.units.map(x => x.executionUnitId)).size !== d.units.length) throw new BadRequestException('Единица исполнения повторяется');
        const fact = (await loadWorkFacts(c, a.tenantId, [workId])).get(workId);
        if (!fact || (fact.state !== 'KNOWN' && fact.state !== 'NONE_REPORTED') ||
            (fact.quantity !== null && dec(fact.quantity).gt(0) &&
                (fact.mode !== 'PORTION' || fact.modeProvenance !== 'PERSISTED')))
            throw new ConflictException('Источник или область факта неоднозначны для распределения');
        let workTotal = new Decimal(0);
        const validated: { executionUnitId: string; quantity: string; portions: { portionId: string; quantity: string }[] }[] = [];
        for (const entry of d.units) {
            const unit = await one(c, `SELECT id,unit,planned_quantity::text AS planned_quantity FROM work_execution_units
                WHERE tenant_id=$1 AND object_work_id=$2 AND id=$3`, [a.tenantId, workId, entry.executionUnitId]);
            if (!unit || unit.unit !== current.unit) throw new BadRequestException('Единица исполнения не принадлежит работе или единица измерения не совпадает');
            const q = dec(entry.quantity);
            if (q.gt(unit.plannedQuantity)) throw new BadRequestException('Распределение превышает плановый объём единицы исполнения');
            workTotal = workTotal.plus(q);
            if (new Set(entry.portions.map(x => x.portionId)).size !== entry.portions.length) throw new BadRequestException('Участок повторяется');
            let portionTotal = new Decimal(0);
            const portionIds = entry.portions.map(x => x.portionId);
            const figures = await loadPortionFigures(c, a.tenantId, portionIds);
            const portions = [];
            for (const p of entry.portions) {
                const row = await one(c, 'SELECT id,planned_quantity::text AS planned_quantity FROM quantity_portions WHERE tenant_id=$1 AND execution_unit_id=$2 AND id=$3',
                    [a.tenantId, entry.executionUnitId, p.portionId]);
                if (!row) throw new BadRequestException('Участок не принадлежит единице исполнения');
                const pq = dec(p.quantity);
                if (pq.gt(row.plannedQuantity)) throw new BadRequestException('Распределение превышает плановый объём участка');
                const figure = figures.get(p.portionId);
                if (!figure || figure.rp.state === 'UNKNOWN_TIE' || figure.internal.state === 'UNKNOWN_TIE' ||
                    (figure.customer.groupSize > 0 && figure.customer.quantity === null))
                    throw new ConflictException('Неоднозначное подтверждение объёма участка');
                const floor = [figure.rpFact,figure.internalSc,figure.customerAccepted].filter((v): v is string => v !== null).reduce((m,v) => Decimal.max(m,v),new Decimal(0));
                if (pq.lt(floor)) throw new ConflictException('Распределение ниже защищённого подтверждённого факта участка');
                portionTotal = portionTotal.plus(pq);
                portions.push({ portionId: p.portionId, quantity: fixed(pq) });
            }
            if (portionTotal.gt(q)) throw new BadRequestException('Сумма участков превышает распределение единицы исполнения');
            validated.push({ executionUnitId: entry.executionUnitId, quantity: fixed(q), portions });
        }
        if (workTotal.gt(current.quantity)) throw new BadRequestException('Распределение превышает текущий объём работы');
        // A complete replacement cannot omit a confirmed scope. Resolve each portion through R02,
        // and conservatively retain all customer-accepted quantities recorded for that scope.
        const allPortions = await rows(c, `SELECT p.id FROM quantity_portions p JOIN work_execution_units u
            ON u.tenant_id=p.tenant_id AND u.id=p.execution_unit_id
            WHERE u.tenant_id=$1 AND u.object_work_id=$2`, [a.tenantId,workId]);
        const provided = new Map(validated.flatMap(u => u.portions.map(p => [p.portionId,p.quantity] as const)));
        const allFigures = await loadPortionFigures(c,a.tenantId,allPortions.map((p:any) => p.id));
        for (const portion of allPortions) {
            const f = allFigures.get(portion.id)!;
            if (f.rp.state === 'UNKNOWN_TIE' || f.internal.state === 'UNKNOWN_TIE' ||
                (f.customer.groupSize > 0 && f.customer.quantity === null))
                throw new ConflictException('Неоднозначное подтверждение объёма участка');
            const accepted = await one(c, `SELECT max(quantity)::text AS quantity FROM documentation_customer_accepted_quantities
                WHERE tenant_id=$1 AND quantity_portion_id=$2`,[a.tenantId,portion.id]);
            const floor = [f.rpFact,f.internalSc,f.customerAccepted,accepted?.quantity ?? null]
                .filter((v): v is string => v !== null).reduce((m,v) => Decimal.max(m,v),new Decimal(0));
            if (dec(provided.get(portion.id) ?? '0').lt(floor))
                throw new ConflictException('Распределение ниже защищённого подтверждённого факта участка');
        }
        const version = await one(c, `INSERT INTO work_allocation_versions(tenant_id,object_id,work_id,sequence,previous_id,quantity_version_id,unit,created_by)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,sequence`,
            [a.tenantId, objectId, workId, Number(previous?.sequence ?? 0)+1, previous?.versionId ?? null, current.approvedVersionId, current.unit, a.id]);
        for (const entry of validated) {
            await c.query(`INSERT INTO work_allocation_lines(tenant_id,object_id,work_id,version_id,execution_unit_id,quantity,unit)
                VALUES($1,$2,$3,$4,$5,$6,$7)`, [a.tenantId,objectId,workId,version.id,entry.executionUnitId,entry.quantity,current.unit]);
            for (const p of entry.portions)
                await c.query(`INSERT INTO work_allocation_lines(tenant_id,object_id,work_id,version_id,execution_unit_id,portion_id,quantity,unit)
                    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [a.tenantId,objectId,workId,version.id,entry.executionUnitId,p.portionId,p.quantity,current.unit]);
        }
        if (previous) await c.query(`UPDATE work_current_allocation SET version_id=$4,updated_at=now()
            WHERE tenant_id=$1 AND object_id=$2 AND work_id=$3`, [a.tenantId,objectId,workId,version.id]);
        else await c.query(`INSERT INTO work_current_allocation(tenant_id,object_id,work_id,version_id) VALUES($1,$2,$3,$4)`,
            [a.tenantId,objectId,workId,version.id]);
        await audit(c,currentActor,'WorkAllocation',version.id,'REPLACE',previous ?? null,
            { workId,objectId,versionId:version.id,sequence:version.sequence,allocatedQuantity:fixed(workTotal) });
        return { versionId: version.id, sequence: Number(version.sequence), allocatedQuantity: fixed(workTotal),
            unallocatedQuantity: fixed(dec(current.quantity).minus(workTotal)), unit: current.unit };
    });
}

export async function readAllocation(c: any, tenantId: string, objectId: string, workId: string, currentQuantity: string | null) {
    const pointer = await one(c, `SELECT p.version_id,v.sequence FROM work_current_allocation p JOIN work_allocation_versions v
        ON v.tenant_id=p.tenant_id AND v.object_id=p.object_id AND v.work_id=p.work_id AND v.id=p.version_id
        WHERE p.tenant_id=$1 AND p.object_id=$2 AND p.work_id=$3`, [tenantId,objectId,workId]);
    if (!pointer) return { allocationVersionId: null, allocationSequence: null, allocatedQuantity: null,
        unallocatedQuantity: null, allocationCoverage: currentQuantity === null ? 'UNKNOWN_CURRENT' : 'NOT_CAPTURED', allocations: [] };
    const lines = await rows(c, `SELECT execution_unit_id,portion_id,quantity::text AS quantity,unit FROM work_allocation_lines
        WHERE tenant_id=$1 AND object_id=$2 AND work_id=$3 AND version_id=$4 ORDER BY execution_unit_id,portion_id NULLS FIRST`,
        [tenantId,objectId,workId,pointer.versionId]);
    const allocated = lines.filter((l:any) => l.portionId === null).reduce((s:Decimal,l:any) => s.plus(l.quantity),new Decimal(0));
    const remaining = currentQuantity === null ? null : dec(currentQuantity).minus(allocated);
    return { allocationVersionId: pointer.versionId, allocationSequence: Number(pointer.sequence),
        allocatedQuantity: fixed(allocated), unallocatedQuantity: remaining === null ? null : fixed(remaining),
        allocationCoverage: remaining === null ? 'UNKNOWN_CURRENT' : remaining.isZero() ? 'FULL' : 'PARTIAL',
        allocations: lines.map((l:any) => ({ executionUnitId: l.executionUnitId, portionId: l.portionId, quantity: fixed(dec(l.quantity)), unit: l.unit })) };
}
