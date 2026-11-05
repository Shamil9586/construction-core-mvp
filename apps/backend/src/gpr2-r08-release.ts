import Decimal from 'decimal.js';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { one, rows, transaction } from './db';
import { Actor, objectAccess, requirePermission, workAccess, audit } from './security';
import { Permission } from '../../../packages/domain';
import { loadPortionFigures } from './fact-resolver';
import { evaluateZonalRelease, type ReleaseEvidence, type ReleaseIssue, type ReleaseRequirement } from '../../../packages/domain/gpr2/r08-release';
import { coordinate } from './coordination-lock';

type Setup = { workId:string; executionUnitId:string; areaScopeId:string; basis:string;
    policy:'REQUIRED'|'NOT_REQUIRED'; requirements:{sourceWorkId:string;sourceExecutionUnitId:string;
        sourceAreaScopeId:string;requiresInternalSc:boolean;cureDays:number}[] };

/** First-time explicit mapping on an unfactored target. No inference/backfill of legacy location. */
export async function configureZonalRelease(actor:Actor, objectId:string, d:Setup, tokenHash:string) {
    requirePermission(actor,Permission.OBJECT_EDIT);
    if (!['PROJECT_MANAGER','ADMIN'].includes(actor.role)) throw new ForbiddenException('Настройка зонального допуска доступна РП');
    return transaction(async c=>{
        await coordinate(c,'gpr2-r08-release.ts#configureZonalRelease',actor.tenantId,{work:d.workId});
        const target=await one(c,'SELECT * FROM works WHERE tenant_id=$1 AND object_id=$2 AND id=$3 FOR UPDATE',
            [actor.tenantId,objectId,d.workId]);
        if(!target) throw new NotFoundException('Работа не найдена');
        const currentActor=await one(c,`SELECT u.* FROM sessions s JOIN users u ON u.tenant_id=s.tenant_id AND u.id=s.user_id
            WHERE s.token_hash=$1 AND s.tenant_id=$2 AND s.user_id=$3 AND s.expires_at>now()
            AND u.is_active=true FOR SHARE OF s,u`,[tokenHash,actor.tenantId,actor.id]);
        if(!currentActor || !['PROJECT_MANAGER','ADMIN'].includes(currentActor.role)) throw new ConflictException('Сессия или роль изменилась');
        requirePermission(currentActor,Permission.OBJECT_EDIT);
        await one(c,'SELECT id FROM objects WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[actor.tenantId,objectId]);
        await objectAccess(c,currentActor,objectId,true);
        if(target.actualQuantity>0 || await one(c,'SELECT 1 FROM work_progress WHERE tenant_id=$1 AND object_work_id=$2 LIMIT 1',[actor.tenantId,d.workId]) ||
            await one(c,'SELECT 1 FROM inspections WHERE tenant_id=$1 AND object_work_id=$2 LIMIT 1',[actor.tenantId,d.workId]) ||
            await one(c,`SELECT 1 FROM portion_quantity_confirmations f JOIN quantity_portions p ON p.tenant_id=f.tenant_id AND p.id=f.portion_id
                JOIN work_execution_units u ON u.tenant_id=p.tenant_id AND u.id=p.execution_unit_id
                WHERE f.tenant_id=$1 AND u.object_work_id=$2 LIMIT 1`,[actor.tenantId,d.workId]))
            throw new ConflictException('Существующий факт требует отдельной I-LIVE сверки');
        if(await one(c,'SELECT 1 FROM gpr2_execution_unit_area_scopes WHERE tenant_id=$1 AND object_id=$2 AND execution_unit_id=$3',
            [actor.tenantId,objectId,d.executionUnitId])) throw new ConflictException('Зона уже закреплена');
        const policy=await one(c,`SELECT v.policy,v.version FROM gpr2_current_internal_sc_policy p JOIN gpr2_internal_sc_policy_versions v
            ON v.tenant_id=p.tenant_id AND v.object_id=p.object_id AND v.id=p.version_id WHERE p.tenant_id=$1 AND p.object_id=$2`,[actor.tenantId,objectId]);
        if(policy && policy.policy!==d.policy) throw new ConflictException('Политика объекта отличается');
        if(!policy){
            const v=await one(c,`INSERT INTO gpr2_internal_sc_policy_versions(tenant_id,object_id,version,policy,basis,actor_id)
                VALUES($1,$2,1,$3,$4,$5) RETURNING id`,[actor.tenantId,objectId,d.policy,d.basis,currentActor.id]);
            await c.query('INSERT INTO gpr2_current_internal_sc_policy(tenant_id,object_id,version_id) VALUES($1,$2,$3)',[actor.tenantId,objectId,v.id]);
        }
        await c.query(`INSERT INTO gpr2_execution_unit_area_scopes(tenant_id,object_id,work_id,execution_unit_id,area_scope_id,created_by)
            VALUES($1,$2,$3,$4,$5,$6)`,[actor.tenantId,objectId,d.workId,d.executionUnitId,d.areaScopeId,currentActor.id]);
        for(const r of d.requirements){
            const sourceMap=await one(c,`SELECT work_id,area_scope_id FROM gpr2_execution_unit_area_scopes
                WHERE tenant_id=$1 AND object_id=$2 AND execution_unit_id=$3`,[actor.tenantId,objectId,r.sourceExecutionUnitId]);
            if(sourceMap && (sourceMap.workId!==r.sourceWorkId || sourceMap.areaScopeId!==r.sourceAreaScopeId))
                throw new ConflictException('Источник имеет другое доказанное пространственное соответствие');
            if(!sourceMap) await c.query(`INSERT INTO gpr2_execution_unit_area_scopes(tenant_id,object_id,work_id,execution_unit_id,area_scope_id,created_by)
                VALUES($1,$2,$3,$4,$5,$6)`,[actor.tenantId,objectId,r.sourceWorkId,r.sourceExecutionUnitId,r.sourceAreaScopeId,currentActor.id]);
            await c.query(`INSERT INTO technical_release_requirements(tenant_id,object_id,target_work_id,target_execution_unit_id,target_area_scope_id,
                source_work_id,source_execution_unit_id,source_area_scope_id,requires_internal_sc,cure_days,created_by)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[actor.tenantId,objectId,d.workId,d.executionUnitId,d.areaScopeId,
                r.sourceWorkId,r.sourceExecutionUnitId,r.sourceAreaScopeId,r.requiresInternalSc,r.cureDays,currentActor.id]);
        }
        await c.query(`INSERT INTO gpr2_release_scope_completeness(tenant_id,object_id,work_id,execution_unit_id,area_scope_id,basis,declared_by)
            VALUES($1,$2,$3,$4,$5,$6,$7)`,[actor.tenantId,objectId,d.workId,d.executionUnitId,d.areaScopeId,d.basis,currentActor.id]);
        await audit(c,currentActor,'Work',d.workId,'R08_RELEASE_SETUP',null,{areaScopeId:d.areaScopeId,unitId:d.executionUnitId,policy:d.policy,requirements:d.requirements});
        return {workId:d.workId,executionUnitId:d.executionUnitId,areaScopeId:d.areaScopeId,policy:d.policy,requirements:d.requirements.length};
    });
}

/** Read-only R08 preview; absence of explicit mapping/completeness/policy always blocks. */
export async function readZonalRelease(c: any, actor: Actor, objectId: string, workId: string, unitId: string) {
    requirePermission(actor, Permission.WORK_VIEW);
    await objectAccess(c, actor, objectId);
    const work = await one(c,'SELECT * FROM works WHERE tenant_id=$1 AND object_id=$2 AND id=$3', [actor.tenantId,objectId,workId]);
    if (!work) throw new NotFoundException('Работа не найдена');
    await workAccess(c,actor,work);
    const unit = await one(c,'SELECT * FROM work_execution_units WHERE tenant_id=$1 AND object_work_id=$2 AND id=$3', [actor.tenantId,workId,unitId]);
    if (!unit) throw new NotFoundException('Единица исполнения не найдена');
    const mapped = await one(c,`SELECT m.area_scope_id, a.lifecycle FROM gpr2_execution_unit_area_scopes m
        JOIN object_area_scopes a ON a.tenant_id=m.tenant_id AND a.object_id=m.object_id AND a.id=m.area_scope_id
        WHERE m.tenant_id=$1 AND m.object_id=$2 AND m.work_id=$3 AND m.execution_unit_id=$4`,[actor.tenantId,objectId,workId,unitId]);
    const policy = await one(c,`SELECT v.policy,v.version FROM gpr2_current_internal_sc_policy p JOIN gpr2_internal_sc_policy_versions v
        ON v.tenant_id=p.tenant_id AND v.object_id=p.object_id AND v.id=p.version_id
        WHERE p.tenant_id=$1 AND p.object_id=$2`,[actor.tenantId,objectId]);
    const complete = mapped && await one(c,`SELECT id FROM (SELECT execution_unit_id AS id FROM gpr2_release_scope_completeness
        WHERE tenant_id=$1 AND object_id=$2 AND work_id=$3 AND execution_unit_id=$4 AND area_scope_id=$5) x`,
        [actor.tenantId,objectId,workId,unitId,mapped.areaScopeId]);
    const raw = mapped ? await rows(c,`SELECT * FROM technical_release_requirements WHERE tenant_id=$1 AND object_id=$2
        AND target_work_id=$3 AND target_execution_unit_id=$4 AND target_area_scope_id=$5`,
        [actor.tenantId,objectId,workId,unitId,mapped.areaScopeId]) : [];
    const requirements: ReleaseRequirement[] = raw.map((r:any)=>({id:r.id,targetAreaId:r.targetAreaScopeId,
        targetExecutionUnitId:r.targetExecutionUnitId,sourceAreaId:r.sourceAreaScopeId,sourceExecutionUnitId:r.sourceExecutionUnitId,
        requiresInternalSc:r.requiresInternalSc,cureThroughLocalDate:null}));
    const evidence: ReleaseEvidence[] = [];
    for (const r of raw) {
        const source = await one(c,'SELECT planned_quantity FROM work_execution_units WHERE tenant_id=$1 AND object_work_id=$2 AND id=$3',
            [actor.tenantId,r.sourceWorkId,r.sourceExecutionUnitId]);
        const portions = source ? await rows(c,'SELECT id FROM quantity_portions WHERE tenant_id=$1 AND execution_unit_id=$2',
            [actor.tenantId,r.sourceExecutionUnitId]) : [];
        const sourceArea=await one(c,'SELECT lifecycle FROM object_area_scopes WHERE tenant_id=$1 AND object_id=$2 AND id=$3',
            [actor.tenantId,objectId,r.sourceAreaScopeId]);
        const figures = await loadPortionFigures(c,actor.tenantId,portions.map((p:any)=>p.id));
        const rp = portions.reduce((sum:Decimal,p:any)=>sum.plus(figures.get(p.id)?.rpFact ?? 0),new Decimal(0));
        const sc = portions.reduce((sum:Decimal,p:any)=>sum.plus(figures.get(p.id)?.internalSc ?? 0),new Decimal(0));
        const known = !!source && sourceArea?.lifecycle==='ACTIVE' && portions.length>0 && portions.every((p:any)=>figures.get(p.id)?.rp.state==='RESOLVED');
        if (r.cureDays>0) {
            const latest = portions.map((p:any)=>figures.get(p.id)?.rp).filter((f:any)=>f?.state==='RESOLVED')
                .map((f:any)=>f.recordedAt).sort().at(-1);
            if (latest) {
                const date = await one(c,`SELECT (($1::timestamptz AT TIME ZONE 'Europe/Moscow')::date + $2::int)::text AS day`,[latest,r.cureDays]);
                requirements.find(q=>q.id===r.id)!.cureThroughLocalDate=date.day;
            }
        }
        evidence.push({requirementId:r.id,sourceAreaId:r.sourceAreaScopeId,sourceExecutionUnitId:r.sourceExecutionUnitId,
            rpConfirmed:known && rp.gte(source.plannedQuantity),internalScConfirmed:known &&
                portions.every((p:any)=>figures.get(p.id)?.internal.state==='RESOLVED') && sc.gte(source.plannedQuantity),evidenceKnown:known});
    }
    const missingLegacy = await one(c,`SELECT 1 AS missing FROM work_dependencies d WHERE d.tenant_id=$1 AND d.successor_work_id=$2
      AND NOT EXISTS(SELECT 1 FROM technical_release_requirements r WHERE r.tenant_id=d.tenant_id AND r.object_id=$3
        AND r.target_execution_unit_id=$4 AND r.target_area_scope_id=$5 AND r.source_work_id=d.predecessor_work_id) LIMIT 1`,
        [actor.tenantId,workId,objectId,unitId,mapped?.areaScopeId ?? null]);
    const issues: ReleaseIssue[] = (await rows(c,`SELECT s.area_scope_id,s.execution_unit_id FROM issues i
        JOIN inspections x ON x.tenant_id=i.tenant_id AND x.id=i.inspection_id
        LEFT JOIN gpr2_critical_issue_scopes s ON s.tenant_id=i.tenant_id AND s.issue_id=i.id
        WHERE i.tenant_id=$1 AND x.object_id=$2 AND i.severity='CRITICAL' AND i.status<>'CLOSED'`,
        [actor.tenantId,objectId])).map((i:any)=>({areaId:i.areaScopeId??null,executionUnitId:i.executionUnitId??null,critical:true,open:true}));
    const localDate = (await one(c,'SELECT CURRENT_DATE::text AS day',[])).day;
    const activeAssignment = unit.contractorId && await one(c,`SELECT 1 AS present FROM object_contractors_active
        WHERE tenant_id=$1 AND object_id=$2 AND contractor_id=$3`,[actor.tenantId,objectId,unit.contractorId]);
    const allocation = await one(c,`SELECT COALESCE(SUM(l.quantity),0)::text AS quantity FROM work_current_allocation p
        JOIN work_allocation_lines l ON l.tenant_id=p.tenant_id AND l.object_id=p.object_id
            AND l.work_id=p.work_id AND l.version_id=p.version_id
        WHERE p.tenant_id=$1 AND p.object_id=$2 AND p.work_id=$3 AND l.execution_unit_id=$4 AND l.portion_id IS NULL`,
        [actor.tenantId,objectId,workId,unitId]);
    const allocated = !!allocation && new Decimal(allocation.quantity).gt(0);
    const verdict = evaluateZonalRelease({targetAreaId:mapped?.areaScopeId ?? '',targetExecutionUnitId:unitId,
        assigned:!!activeAssignment && allocated,scopeKnown:!!mapped && mapped.lifecycle==='ACTIVE',policy:policy?.policy ?? null,
        requirements:complete && !missingLegacy ? requirements : null,evidence,issues,localDate});
    return {objectId,workId,executionUnitId:unitId,areaScopeId:mapped?.areaScopeId ?? null,policyVersion:policy?.version ?? null,...verdict};
}
