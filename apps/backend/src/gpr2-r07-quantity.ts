import { z } from 'zod';
import Decimal from 'decimal.js';
import { one } from './db';
import { rows } from './db';
import { audit } from './security';
import { loadWorkFacts } from './fact-resolver';
import { runCommandTx } from './tx-context';
import { coordinate } from './coordination-lock';
import { ledgered, mapR05DbError } from './gpr2-r05-support';
import type { Gpr2CommandContext } from './gpr2-command-guard';
import { Gpr2Error, QUANTITY_CHANGE_REQUEST, assertAggregateVersion, transitionForEndpoint, validationFailed, contentHash } from '../../../packages/domain/gpr2';

const uuid = z.string().uuid();
const qty = z.string().regex(/^(?:0|[1-9]\d{0,19})(?:\.\d{1,4})?$/);
const reason = z.string().trim().min(1).max(2000);
const allocation = z.object({ expectedVersionId: uuid.nullable(), units: z.array(z.object({
    executionUnitId: uuid, quantity: qty, portions: z.array(z.object({ portionId: uuid, quantity: qty }).strict())
}).strict()) }).strict();
const surface = z.object({ areaScopeId: uuid, previousQuantity: qty, newQuantity: qty,
    stageEffects: z.array(z.object({ stageOccurrenceId: uuid, workId: uuid, oldQuantity: qty, newQuantity: qty }).strict()) }).strict();
const proposal = z.object({ workId: uuid, newQuantity: qty, reason, allocation: allocation.optional(), surface: surface.optional(),
    inputFingerprint: z.string().optional(), expectedSourceVersions: z.record(z.string(),z.string()).optional() }).strict();
const change = proposal.omit({ workId: true });
const note = z.object({ reason }).strict();
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
    const p = schema.safeParse(input);
    if (!p.success) throw validationFailed(p.error.issues.map(i => ({ path: i.path.join('.') || 'payload', rule: 'FIELD_TYPE' })));
    return p.data;
}
const ok = (ids: string[], version: number) => ({ resultIds: ids, appliedVersions: { aggregate: String(version), scope: null }, warnings: [] });
async function request(c: any, ctx: Gpr2CommandContext) {
    const r = await one(c, 'SELECT * FROM gpr2_quantity_requests WHERE tenant_id=$1 AND object_id=$2 AND id=$3 FOR UPDATE',
        [ctx.actor.tenantId, ctx.objectId, ctx.params.id]);
    if (!r) throw new Gpr2Error('RESOURCE_NOT_FOUND');
    assertAggregateVersion(ctx.command.expectedVersion as any, r.version);
    return r;
}
async function event(c: any, ctx: Gpr2CommandContext, id: string, number: number, action: string, reasonText?: string) {
    await c.query(`INSERT INTO gpr2_quantity_events(tenant_id,object_id,request_id,submission_number,action,actor_id,reason)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [ctx.actor.tenantId,ctx.objectId,id,number,action,ctx.actor.id,reasonText ?? null]);
}
/** Draft and lifecycle mutations are scoped, idempotent, and atomically audited. */
export async function r07Draft(ctx: Gpr2CommandContext) {
    const id = ctx.endpoint.id;
    const payload = id === 'quantity.request.create' ? parse(proposal, ctx.command.payload) :
        id === 'quantity.request.patch' ? parse(change, ctx.command.payload) :
        id === 'quantity.request.return' || id === 'quantity.request.review-note' ? parse(note, ctx.command.payload) : null;
    return runCommandTx(async tx => {
        const c = tx.c;
        await coordinate(c, 'gpr2-r07-quantity.ts#draft', ctx.actor.tenantId, { object: ctx.objectId! });
        return (await ledgered(c, ctx, async a => {
            if (id === 'quantity.request.create') {
                const d = payload as z.infer<typeof proposal>;
                const work = await one(c, `SELECT id,unit FROM works WHERE tenant_id=$1 AND object_id=$2 AND id=$3`, [a.tenantId,ctx.objectId,d.workId]);
                if (!work) throw new Gpr2Error('CROSS_SCOPE_REFERENCE');
                const current = await one(c, `SELECT v.id FROM work_current_quantity p JOIN work_quantity_versions v ON v.id=p.approved_version_id
                    WHERE p.tenant_id=$1 AND p.object_id=$2 AND p.work_id=$3`, [a.tenantId,ctx.objectId,d.workId]);
                if (!current) throw new Gpr2Error('MISSING_REQUIRED_DATA');
                const r = await one(c, `INSERT INTO gpr2_quantity_requests(tenant_id,object_id,work_id,proposed_quantity,quantity_version_id,reason,allocation,surface,author_id)
                    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9) RETURNING *`,
                    [a.tenantId,ctx.objectId,d.workId,d.newQuantity,current.id,d.reason,JSON.stringify(d.allocation ?? null),JSON.stringify(d.surface ?? null),a.id]);
                await event(c,ctx,r.id,0,'CREATE',d.reason);
                await audit(c,a,'QuantityChangeRequest',r.id,'CREATE',null,r);
                return ok([r.id],r.version);
            }
            const r = await request(c,ctx);
            if (id === 'quantity.request.review-note') {
                // Optional PTO grant is denied by default in the endpoint registry; a note cannot decide the request.
                if (r.state !== 'SUBMITTED') throw new Gpr2Error('INVALID_TRANSITION');
                await event(c,ctx,r.id,r.submissionNumber,'REVIEW_NOTE',(payload as any).reason);
                return ok([r.id],r.version);
            }
            transitionForEndpoint(QUANTITY_CHANGE_REQUEST,r.state,id);
            if (id === 'quantity.request.patch') {
                if (r.authorId !== a.id) throw new Gpr2Error('PERMISSION_DENIED');
                const d = payload as z.infer<typeof change>;
                const changed = await one(c, `UPDATE gpr2_quantity_requests SET state='DRAFT', proposed_quantity=$4,reason=$5,
                    allocation=$6::jsonb,surface=$7::jsonb,version=version+1,updated_at=now()
                    WHERE tenant_id=$1 AND object_id=$2 AND id=$3 RETURNING *`,
                    [a.tenantId,ctx.objectId,r.id,d.newQuantity,d.reason,JSON.stringify(d.allocation ?? null),JSON.stringify(d.surface ?? null)]);
                await event(c,ctx,r.id,r.submissionNumber,r.state === 'RETURNED' ? 'REVISE':'EDIT',d.reason);
                await audit(c,a,'QuantityChangeRequest',r.id,'PATCH',r,changed);
                return ok([r.id],changed.version);
            }
            if (id === 'quantity.request.submit') {
                if (r.authorId !== a.id) throw new Gpr2Error('PERMISSION_DENIED');
                const current = await one(c,'SELECT approved_version_id FROM work_current_quantity WHERE tenant_id=$1 AND object_id=$2 AND work_id=$3',
                    [a.tenantId,ctx.objectId,r.workId]);
                if (!current || current.approvedVersionId !== r.quantityVersionId) throw new Gpr2Error('STALE_SOURCE_VERSION');
                const n = r.submissionNumber+1;
                await c.query(`INSERT INTO gpr2_quantity_submissions(tenant_id,object_id,request_id,number,payload,submitted_by)
                    VALUES($1,$2,$3,$4,$5::jsonb,$6)`,[a.tenantId,ctx.objectId,r.id,n,JSON.stringify({workId:r.workId,newQuantity:r.proposedQuantity,quantityVersionId:r.quantityVersionId,reason:r.reason,allocation:r.allocation,surface:r.surface}),a.id]);
                const changed = await one(c,`UPDATE gpr2_quantity_requests SET state='SUBMITTED',submitter_id=$4,submission_number=$5,
                    version=version+1,updated_at=now() WHERE tenant_id=$1 AND object_id=$2 AND id=$3 RETURNING *`,[a.tenantId,ctx.objectId,r.id,a.id,n]);
                await event(c,ctx,r.id,n,'SUBMIT');
                await audit(c,a,'QuantityChangeRequest',r.id,'SUBMIT',r,changed);
                return ok([r.id],changed.version);
            }
            if (id === 'quantity.request.return') {
                const changed = await one(c,`UPDATE gpr2_quantity_requests SET state='RETURNED',decided_by=$4,version=version+1,updated_at=now()
                    WHERE tenant_id=$1 AND object_id=$2 AND id=$3 RETURNING *`,[a.tenantId,ctx.objectId,r.id,a.id]);
                await event(c,ctx,r.id,r.submissionNumber,'RETURN',(payload as any).reason);
                await audit(c,a,'QuantityChangeRequest',r.id,'RETURN',r,changed);
                return ok([r.id],changed.version);
            }
            throw new Gpr2Error('COMMAND_NOT_ENABLED');
        })).result;
    }).catch(mapR05DbError);
}

export async function r07Approve(ctx: Gpr2CommandContext) {
    return runCommandTx(async tx => {
        const c = tx.c;
        await coordinate(c,'gpr2-r07-quantity.ts#approve',ctx.actor.tenantId,{object:ctx.objectId!});
        return (await ledgered(c,ctx,async a => {
            const r = await request(c,ctx);
            transitionForEndpoint(QUANTITY_CHANGE_REQUEST,r.state,ctx.endpoint.id);
            if (r.authorId === a.id || r.submitterId === a.id) throw new Gpr2Error('SEPARATION_OF_DUTIES');
            const submitted = await one(c,`SELECT payload FROM gpr2_quantity_submissions WHERE tenant_id=$1 AND object_id=$2 AND request_id=$3 AND number=$4`,
                [a.tenantId,ctx.objectId,r.id,r.submissionNumber]);
            if (!submitted) throw new Gpr2Error('STALE_SOURCE_VERSION');
            if (ctx.command.payload.inputFingerprint !== contentHash(submitted.payload) ||
                ctx.command.payload.expectedSourceVersions.quantity !== r.quantityVersionId)
                throw new Gpr2Error('STALE_SOURCE_VERSION');
            const q = await one(c,`SELECT p.approved_version_id,v.sequence,v.quantity::text AS quantity,v.unit FROM work_current_quantity p
                JOIN work_quantity_versions v ON v.id=p.approved_version_id
                WHERE p.tenant_id=$1 AND p.object_id=$2 AND p.work_id=$3 FOR UPDATE OF p`,[a.tenantId,ctx.objectId,r.workId]);
            if (!q || q.approvedVersionId !== r.quantityVersionId) throw new Gpr2Error('STALE_SOURCE_VERSION');
            const work = await one(c,`SELECT * FROM works WHERE tenant_id=$1 AND object_id=$2 AND id=$3 FOR UPDATE`,[a.tenantId,ctx.objectId,r.workId]);
            const next = new Decimal(r.proposedQuantity);
            const s = r.surface ? parse(surface,r.surface) : null;
            if (s && (!new Decimal(s.previousQuantity).eq(q.quantity) || !new Decimal(s.newQuantity).eq(next) ||
                s.stageEffects.some(x=>!new Decimal(x.oldQuantity).eq(q.quantity) || !new Decimal(x.newQuantity).eq(s.newQuantity))))
                throw new Gpr2Error('STALE_SOURCE_VERSION');
            const fact = (await loadWorkFacts(c,a.tenantId,[r.workId])).get(r.workId);
            if (!fact || !['KNOWN','NONE_REPORTED'].includes(fact.state) ||
                (fact.quantity !== null && new Decimal(fact.quantity).gt(next))) throw new Gpr2Error('BELOW_PROTECTED_QUANTITY');
            // Independent evidence on atomic portions may overlap RP and SC; take max per portion, then sum disjoint portions.
            const protectedRows = await rows(c,`SELECT p.id AS portion_id,
                greatest(coalesce((SELECT max(f.quantity) FROM portion_quantity_confirmations f WHERE f.tenant_id=p.tenant_id AND f.portion_id=p.id AND f.source='RP_FACT'),0),
                  coalesce((SELECT max(f.quantity) FROM portion_quantity_confirmations f WHERE f.tenant_id=p.tenant_id AND f.portion_id=p.id AND f.source='INTERNAL_SC'),0),
                  coalesce((SELECT max(f.quantity) FROM documentation_customer_accepted_quantities f WHERE f.tenant_id=p.tenant_id AND f.quantity_portion_id=p.id),0))::text AS floor,
                EXISTS(SELECT 1 FROM sdo_closing_portion_allocations x WHERE x.tenant_id=p.tenant_id AND x.quantity_portion_id=p.id AND x.cancelled_at IS NULL) AS closing
                FROM quantity_portions p JOIN work_execution_units u ON u.tenant_id=p.tenant_id AND u.id=p.execution_unit_id
                WHERE p.tenant_id=$1 AND u.object_work_id=$2`,[a.tenantId,r.workId]);
            if (protectedRows.some((x:any)=>x.closing)) throw new Gpr2Error('BELOW_PROTECTED_QUANTITY');
            const floor = protectedRows.reduce((s:Decimal,x:any)=>s.plus(x.floor),new Decimal(0));
            if (next.lt(floor)) throw new Gpr2Error('BELOW_PROTECTED_QUANTITY');
            const prior = await one(c,`SELECT p.version_id,v.sequence FROM work_current_allocation p JOIN work_allocation_versions v ON v.id=p.version_id
                WHERE p.tenant_id=$1 AND p.object_id=$2 AND p.work_id=$3 FOR UPDATE OF p`,[a.tenantId,ctx.objectId,r.workId]);
            const d = r.allocation ? parse(allocation,r.allocation) : null;
            if ((prior?.versionId ?? null) !== (d?.expectedVersionId ?? null) || (!!prior && !d)) throw new Gpr2Error('STALE_SOURCE_VERSION');
            const unitSum = (d?.units ?? []).reduce((s,x)=>s.plus(x.quantity),new Decimal(0));
            if (unitSum.gt(next)) throw new Gpr2Error('BELOW_PROTECTED_QUANTITY');
            // A Work with existing WEU plans cannot be reduced below their sum without an explicit
            // replacement allocation snapshot. Otherwise it advertises a smaller Work cap while
            // retaining larger production obligations outside the quantity decision.
            const planned = await one(c,`SELECT coalesce(sum(planned_quantity),0)::text AS total FROM work_execution_units
                WHERE tenant_id=$1 AND object_work_id=$2`,[a.tenantId,r.workId]);
            if (new Decimal(planned.total).gt(next) && (!d || unitSum.isZero())) throw new Gpr2Error('BELOW_PROTECTED_QUANTITY');
            for (const x of protectedRows) if (new Decimal(x.floor).gt(0)) {
                const target = d?.units.flatMap(u=>u.portions).find(p=>p.portionId===x.portionId);
                if (!target || new Decimal(target.quantity).lt(x.floor)) throw new Gpr2Error('BELOW_PROTECTED_QUANTITY');
            }
            if (s) {
                const bindings = await rows(c,`SELECT occurrence_id,work_id FROM work_scope_bindings WHERE tenant_id=$1 AND object_id=$2
                    AND area_scope_id=$3 AND measure_scope='MAIN' AND binding_state='ACTIVE' ORDER BY work_id,occurrence_id`,
                    [a.tenantId,ctx.objectId,s.areaScopeId]);
                const expected = new Set<string>(bindings.map((x:any)=>x.occurrenceId+':'+x.workId));
                const proposed = new Set(s.stageEffects.map(x=>x.stageOccurrenceId+':'+x.workId));
                if (!expected.size || proposed.size!==s.stageEffects.length || proposed.size!==expected.size ||
                    [...expected].some(x=>!proposed.has(x)) || !s.stageEffects.some(x=>x.workId===r.workId))
                    throw new Gpr2Error('CROSS_SCOPE_REFERENCE');
            }
            const version = await one(c,`INSERT INTO work_quantity_versions(tenant_id,object_id,work_id,sequence,quantity,unit,source_kind,approved_request_id,previous_id,created_by)
                VALUES($1,$2,$3,$4,$5,$6,'APPROVED_REQUEST',$7,$8,$9) RETURNING id`,
                [a.tenantId,ctx.objectId,r.workId,q.sequence+1,next.toFixed(4),q.unit,r.id,q.approvedVersionId,a.id]);
            if (d) {
                const alloc = await one(c,`INSERT INTO work_allocation_versions(tenant_id,object_id,work_id,sequence,previous_id,quantity_version_id,unit,created_by,approved_request_id)
                    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
                    [a.tenantId,ctx.objectId,r.workId,prior ? prior.sequence+1:1,prior?.versionId ?? null,version.id,q.unit,a.id,r.id]);
                for (const u of d.units) {
                    await c.query(`INSERT INTO work_allocation_lines(tenant_id,object_id,work_id,version_id,execution_unit_id,quantity,unit)
                        VALUES($1,$2,$3,$4,$5,$6,$7)`,[a.tenantId,ctx.objectId,r.workId,alloc.id,u.executionUnitId,u.quantity,q.unit]);
                    for (const p of u.portions) await c.query(`INSERT INTO work_allocation_lines(tenant_id,object_id,work_id,version_id,execution_unit_id,portion_id,quantity,unit)
                        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[a.tenantId,ctx.objectId,r.workId,alloc.id,u.executionUnitId,p.portionId,p.quantity,q.unit]);
                }
                if (prior) await c.query(`UPDATE work_current_allocation SET version_id=$4,updated_at=now() WHERE tenant_id=$1 AND object_id=$2 AND work_id=$3`,
                    [a.tenantId,ctx.objectId,r.workId,alloc.id]);
                else await c.query(`INSERT INTO work_current_allocation(tenant_id,object_id,work_id,version_id) VALUES($1,$2,$3,$4)`,
                    [a.tenantId,ctx.objectId,r.workId,alloc.id]);
            }
            await c.query(`UPDATE work_current_quantity SET approved_version_id=$4,updated_at=now() WHERE tenant_id=$1 AND object_id=$2 AND work_id=$3`,
                [a.tenantId,ctx.objectId,r.workId,version.id]);
            await c.query(`INSERT INTO gpr2_schedule_basis_invalidations(tenant_id,object_id,work_id,quantity_version_id,request_id) VALUES($1,$2,$3,$4,$5)`,
                [a.tenantId,ctx.objectId,r.workId,version.id,r.id]);
            await c.query(`INSERT INTO gpr2_labor_coverage_recalculations(tenant_id,object_id,work_id,quantity_version_id,request_id) VALUES($1,$2,$3,$4,$5)`,
                [a.tenantId,ctx.objectId,r.workId,version.id,r.id]);
            if (s) {
                const header = await one(c,`INSERT INTO gpr2_surface_changes(tenant_id,object_id,request_id,area_scope_id,previous_quantity,new_quantity,delta,unit)
                    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,[a.tenantId,ctx.objectId,r.id,s.areaScopeId,s.previousQuantity,
                    s.newQuantity,new Decimal(s.newQuantity).minus(s.previousQuantity).toFixed(4),q.unit]);
                for (const effect of s.stageEffects) {
                    await c.query(`INSERT INTO gpr2_surface_effects(tenant_id,object_id,surface_change_id,stage_occurrence_id,work_id,old_quantity,new_quantity)
                        VALUES($1,$2,$3,$4,$5,$6,$7)`,[a.tenantId,ctx.objectId,header.id,effect.stageOccurrenceId,effect.workId,effect.oldQuantity,effect.newQuantity]);
                    if (effect.workId===r.workId) continue;
                    const other = await one(c,`SELECT p.approved_version_id,v.sequence,v.quantity::text AS quantity,v.unit FROM work_current_quantity p
                        JOIN work_quantity_versions v ON v.id=p.approved_version_id WHERE p.tenant_id=$1 AND p.object_id=$2 AND p.work_id=$3 FOR UPDATE OF p`,
                        [a.tenantId,ctx.objectId,effect.workId]);
                    if (!other || !new Decimal(other.quantity).eq(effect.oldQuantity) || other.unit!==q.unit) throw new Gpr2Error('STALE_SOURCE_VERSION');
                    const actor = (await loadWorkFacts(c,a.tenantId,[effect.workId])).get(effect.workId);
                    if (!actor || !['KNOWN','NONE_REPORTED'].includes(actor.state) ||
                        (actor.quantity!==null && new Decimal(actor.quantity).gt(effect.newQuantity))) throw new Gpr2Error('BELOW_PROTECTED_QUANTITY');
                    // A sibling with independently scoped allocation/evidence needs its own review; never silently rewrite it.
                    if (await one(c,`SELECT 1 FROM work_current_allocation WHERE tenant_id=$1 AND object_id=$2 AND work_id=$3`,
                        [a.tenantId,ctx.objectId,effect.workId])) throw new Gpr2Error('BELOW_PROTECTED_QUANTITY');
                    const v = await one(c,`INSERT INTO work_quantity_versions(tenant_id,object_id,work_id,sequence,quantity,unit,source_kind,approved_request_id,previous_id,created_by)
                        VALUES($1,$2,$3,$4,$5,$6,'APPROVED_REQUEST',$7,$8,$9) RETURNING id`,
                        [a.tenantId,ctx.objectId,effect.workId,other.sequence+1,effect.newQuantity,q.unit,r.id,other.approvedVersionId,a.id]);
                    await c.query(`UPDATE work_current_quantity SET approved_version_id=$4,updated_at=now() WHERE tenant_id=$1 AND object_id=$2 AND work_id=$3`,
                        [a.tenantId,ctx.objectId,effect.workId,v.id]);
                    for (const table of ['gpr2_schedule_basis_invalidations','gpr2_labor_coverage_recalculations'])
                        await c.query(`INSERT INTO ${table}(tenant_id,object_id,work_id,quantity_version_id,request_id) VALUES($1,$2,$3,$4,$5)`,
                            [a.tenantId,ctx.objectId,effect.workId,v.id,r.id]);
                }
            }
            const changed = await one(c,`UPDATE gpr2_quantity_requests SET state='APPROVED',decided_by=$4,version=version+1,updated_at=now()
                WHERE tenant_id=$1 AND object_id=$2 AND id=$3 RETURNING *`,[a.tenantId,ctx.objectId,r.id,a.id]);
            await event(c,ctx,r.id,r.submissionNumber,'APPROVE');
            await audit(c,a,'QuantityChangeRequest',r.id,'APPROVE',r,changed);
            return ok([r.id,version.id],changed.version);
        })).result;
    }).catch(mapR05DbError);
}
