import './helpers/gpr2-isolation';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { gpr2Harness, pilotScenario, uuid, type Gpr2Harness } from './helpers/gpr2-fixtures';
import { contentHash } from '../packages/domain/gpr2';

let g: Gpr2Harness, p: Awaited<ReturnType<typeof pilotScenario>>, db: any, pm: string, deputy: string;
before(async () => {
    g = await gpr2Harness('gpr2-r07'); p = await pilotScenario(g.h);
    db = await import('../apps/backend/src/db'); pm = await g.tokenFor(p.pm); deputy = await g.roleToken('DEPUTY_DIRECTOR');
});
after(async () => { await g?.h.close(); });
const path = () => `/v2/objects/${p.object.id}/quantity-change-requests`;
const call = (token:string,method:string,suffix:string,body:any) => g.call(token,method,path()+suffix,{body,headers:{'Idempotency-Key':uuid()}});
const row = async (sql:string,args:any[]=[]) => (await db.pool.query(sql,args)).rows[0];

test('request submission is immutable; Deputy approves exact current source, quantity and event atomically',async()=>{
    const work = p.plasterWork.work.id;
    const before = await row('SELECT p.approved_version_id,v.quantity FROM work_current_quantity p JOIN work_quantity_versions v ON v.id=p.approved_version_id WHERE p.work_id=$1',[work]);
    const scope = await row('SELECT scope_version FROM work_scope_state WHERE tenant_id=$1 AND object_id=$2',[p.pm.tenantId,p.object.id]);
    const create = await call(pm,'POST','',{expectedScopeVersion:String(scope.scope_version),payload:{workId:work,newQuantity:'700',reason:'Исключение свободного объёма',inputFingerprint:'a'.repeat(64),expectedSourceVersions:{quantity:before.approved_version_id},
        allocation:{expectedVersionId:null,units:[
            {executionUnitId:p.floor1.unit.id,quantity:'400',portions:[{portionId:p.floor1.portion.id,quantity:'400'}]},
            {executionUnitId:p.floor2.unit.id,quantity:'300',portions:[{portionId:p.floor2.portion.id,quantity:'300'}]}
        ]}}});
    assert.equal(create.status,200,JSON.stringify(create.body));
    const id = create.body.resultIds[0];
    const submit = await call(pm,'POST',`/${id}/submit`,{expectedVersion:'1',expectedScopeVersion:String(scope.scope_version),payload:{inputFingerprint:'a'.repeat(64),expectedSourceVersions:{quantity:before.approved_version_id}}});
    assert.equal(submit.status,200,JSON.stringify(submit.body));
    const snapshot = await row('SELECT payload FROM gpr2_quantity_submissions WHERE request_id=$1',[id]);
    const self = await call(pm,'POST',`/${id}/approve`,{expectedVersion:'2',expectedScopeVersion:String(scope.scope_version),payload:{inputFingerprint:contentHash(snapshot.payload),expectedSourceVersions:{quantity:before.approved_version_id}}});
    assert.equal(self.status,403);
    const approved = await call(deputy,'POST',`/${id}/approve`,{expectedVersion:'2',expectedScopeVersion:String(scope.scope_version),payload:{inputFingerprint:contentHash(snapshot.payload),expectedSourceVersions:{quantity:before.approved_version_id}}});
    assert.equal(approved.status,200,JSON.stringify(approved.body));
    const now = await row('SELECT p.approved_version_id,v.quantity,v.approved_request_id FROM work_current_quantity p JOIN work_quantity_versions v ON v.id=p.approved_version_id WHERE p.work_id=$1',[work]);
    assert.equal(now.quantity,'700.0000'); assert.equal(now.approved_request_id,id);
    assert.equal((await row('SELECT count(*)::int AS n FROM work_allocation_versions WHERE work_id=$1',[work])).n,1);
    assert.equal((await row('SELECT count(*)::int AS n FROM gpr2_quantity_submissions WHERE request_id=$1',[id])).n,1);
    assert.equal((await row('SELECT count(*)::int AS n FROM gpr2_schedule_basis_invalidations WHERE request_id=$1',[id])).n,1);
    await assert.rejects(db.pool.query('UPDATE gpr2_quantity_submissions SET payload=$2 WHERE request_id=$1',[id,'{}']),/immutable/);
});

test('protected 850 refuses 800, protected 800 permits 800; direct SQL cannot advance pointer below floor',async()=>{
    await g.h.as(p.pm);
    const w = await g.h.req('works',{objectId:p.object.id,workTypeId:p.plaster.id,contractorId:p.contractors[0].id,
        responsibleUserId:p.pm.id,name:'R07 floor',unit:'м²',plannedQuantity:1000,plannedStartDate:'2026-03-01',plannedFinishDate:'2026-04-30',estimatedCost:'100000'});
    const prior = await row('SELECT approved_version_id FROM work_current_quantity WHERE work_id=$1',[w.id]);
    const scope = await row('SELECT scope_version FROM work_scope_state WHERE tenant_id=$1 AND object_id=$2',[p.pm.tenantId,p.object.id]);
    const c = await call(pm,'POST','',{expectedScopeVersion:String(scope.scope_version),payload:{workId:w.id,newQuantity:'800',reason:'Исключение 200',inputFingerprint:'a'.repeat(64),expectedSourceVersions:{quantity:prior.approved_version_id}}});
    assert.equal(c.status,200,JSON.stringify(c.body)); const id=c.body.resultIds[0];
    const sub=await call(pm,'POST',`/${id}/submit`,{expectedVersion:'1',expectedScopeVersion:String(scope.scope_version),payload:{inputFingerprint:'a'.repeat(64),expectedSourceVersions:{quantity:prior.approved_version_id}}});
    assert.equal(sub.status,200,JSON.stringify(sub.body));
    const saved=await row('SELECT payload FROM gpr2_quantity_submissions WHERE request_id=$1',[id]);
    const body={expectedVersion:'2',expectedScopeVersion:String(scope.scope_version),payload:{inputFingerprint:contentHash(saved.payload),expectedSourceVersions:{quantity:prior.approved_version_id}}};
    await db.pool.query('UPDATE works SET actual_quantity=850 WHERE id=$1',[w.id]);
    const reject=await call(deputy,'POST',`/${id}/approve`,body);
    assert.equal(reject.status,422,JSON.stringify(reject.body)); assert.equal(reject.body.code,'BELOW_PROTECTED_QUANTITY');
    assert.equal((await row('SELECT approved_version_id FROM work_current_quantity WHERE work_id=$1',[w.id])).approved_version_id,prior.approved_version_id);
    await db.pool.query('UPDATE works SET actual_quantity=800 WHERE id=$1',[w.id]);
    const allowed=await call(deputy,'POST',`/${id}/approve`,body);
    assert.equal(allowed.status,200,JSON.stringify(allowed.body));
    const current=await row('SELECT approved_version_id FROM work_current_quantity WHERE work_id=$1',[w.id]);
    const client=await db.pool.connect();
    try {
        await client.query('BEGIN');
        const forged=(await client.query(`INSERT INTO gpr2_quantity_requests(tenant_id,object_id,work_id,state,proposed_quantity,quantity_version_id,reason,author_id)
            VALUES($1,$2,$3,'APPROVED',700,$4,'direct SQL negative',$5) RETURNING id`,
            [p.pm.tenantId,p.object.id,w.id,current.approved_version_id,p.pm.id])).rows[0].id;
        const v=(await client.query(`INSERT INTO work_quantity_versions(tenant_id,object_id,work_id,sequence,quantity,unit,source_kind,approved_request_id,previous_id,created_by)
            VALUES($1,$2,$3,3,700,$4,'APPROVED_REQUEST',$5,$6,$7) RETURNING id`,
            [p.pm.tenantId,p.object.id,w.id,w.unit,forged,current.approved_version_id,p.pm.id])).rows[0].id;
        await client.query('UPDATE work_current_quantity SET approved_version_id=$1 WHERE work_id=$2',[v,w.id]);
        await assert.rejects(client.query('COMMIT'),/BELOW_PROTECTED_QUANTITY/);
    } finally { await client.query('ROLLBACK').catch(()=>undefined); client.release(); }
    assert.equal((await row('SELECT approved_version_id FROM work_current_quantity WHERE work_id=$1',[w.id])).approved_version_id,current.approved_version_id);
});

test('reduction below persisted WEU plans requires an explicit allocation; forged surface old quantity is stale',async()=>{
    await g.h.as(p.pm);
    const w = await g.h.req('works',{objectId:p.object.id,workTypeId:p.plaster.id,contractorId:p.contractors[0].id,
        responsibleUserId:p.pm.id,name:'R07 planned WEU',unit:'м²',plannedQuantity:1000,plannedStartDate:'2026-03-01',plannedFinishDate:'2026-04-30',estimatedCost:'100000'});
    await g.h.req('execution-units',{objectWorkId:w.id,workTypeId:p.plaster.id,contractorId:p.contractors[0].id,unit:'м²',plannedQuantity:900,location:'R07 zone'});
    const prior=await row('SELECT approved_version_id FROM work_current_quantity WHERE work_id=$1',[w.id]);
    const scope=await row('SELECT scope_version FROM work_scope_state WHERE tenant_id=$1 AND object_id=$2',[p.pm.tenantId,p.object.id]);
    const draft=await call(pm,'POST','',{expectedScopeVersion:String(scope.scope_version),payload:{workId:w.id,newQuantity:'800',reason:'Уменьшение без распределения',
        inputFingerprint:'a'.repeat(64),expectedSourceVersions:{quantity:prior.approved_version_id}}});
    assert.equal(draft.status,200,JSON.stringify(draft.body)); const id=draft.body.resultIds[0];
    assert.equal((await call(pm,'POST',`/${id}/submit`,{expectedVersion:'1',expectedScopeVersion:String(scope.scope_version),payload:{inputFingerprint:'a'.repeat(64),expectedSourceVersions:{quantity:prior.approved_version_id}}})).status,200);
    const saved=await row('SELECT payload FROM gpr2_quantity_submissions WHERE request_id=$1',[id]);
    const approve={expectedVersion:'2',expectedScopeVersion:String(scope.scope_version),payload:{inputFingerprint:contentHash(saved.payload),expectedSourceVersions:{quantity:prior.approved_version_id}}};
    const reject=await call(deputy,'POST',`/${id}/approve`,approve);
    assert.equal(reject.status,422,JSON.stringify(reject.body)); assert.equal(reject.body.code,'BELOW_PROTECTED_QUANTITY');
    assert.equal((await row('SELECT approved_version_id FROM work_current_quantity WHERE work_id=$1',[w.id])).approved_version_id,prior.approved_version_id);
    // The same check is enforced at commit even when someone writes a new version through SQL.
    const client=await db.pool.connect();
    try {
        await client.query('BEGIN');
        await client.query("UPDATE gpr2_quantity_requests SET state='APPROVED' WHERE id=$1",[id]);
        const v=(await client.query(`INSERT INTO work_quantity_versions(tenant_id,object_id,work_id,sequence,quantity,unit,source_kind,approved_request_id,previous_id,created_by)
            VALUES($1,$2,$3,2,800,$4,'APPROVED_REQUEST',$5,$6,$7) RETURNING id`,[p.pm.tenantId,p.object.id,w.id,w.unit,id,prior.approved_version_id,p.pm.id])).rows[0].id;
        await client.query('UPDATE work_current_quantity SET approved_version_id=$1 WHERE work_id=$2',[v,w.id]);
        await assert.rejects(client.query('COMMIT'),/coherent allocation snapshot/);
    } finally { await client.query('ROLLBACK').catch(()=>undefined); client.release(); }
    const stale=await call(pm,'POST','',{expectedScopeVersion:String(scope.scope_version),payload:{workId:w.id,newQuantity:'800',reason:'Ложный исходный объём',
        inputFingerprint:'b'.repeat(64),expectedSourceVersions:{quantity:prior.approved_version_id},
        surface:{areaScopeId:uuid(),previousQuantity:'900',newQuantity:'800',stageEffects:[{stageOccurrenceId:uuid(),workId:w.id,oldQuantity:'900',newQuantity:'800'}]}}});
    assert.equal(stale.status,200,JSON.stringify(stale.body)); const sid=stale.body.resultIds[0];
    assert.equal((await call(pm,'POST',`/${sid}/submit`,{expectedVersion:'1',expectedScopeVersion:String(scope.scope_version),payload:{inputFingerprint:'b'.repeat(64),expectedSourceVersions:{quantity:prior.approved_version_id}}})).status,200);
    const ss=await row('SELECT payload FROM gpr2_quantity_submissions WHERE request_id=$1',[sid]);
    const bad=await call(deputy,'POST',`/${sid}/approve`,{expectedVersion:'2',expectedScopeVersion:String(scope.scope_version),
        payload:{inputFingerprint:contentHash(ss.payload),expectedSourceVersions:{quantity:prior.approved_version_id}}});
    assert.equal(bad.status,409,JSON.stringify(bad.body)); assert.equal(bad.body.code,'STALE_SOURCE_VERSION');
    assert.equal((await row('SELECT approved_version_id FROM work_current_quantity WHERE work_id=$1',[w.id])).approved_version_id,prior.approved_version_id);
});

test('Deputy return retains submission and reason; PM revision opens a new immutable submission',async()=>{
    await g.h.as(p.pm);
    const w=await g.h.req('works',{objectId:p.object.id,workTypeId:p.plaster.id,contractorId:p.contractors[0].id,
        responsibleUserId:p.pm.id,name:'R07 return lifecycle',unit:'м²',plannedQuantity:100,plannedStartDate:'2026-03-01',plannedFinishDate:'2026-04-30',estimatedCost:'100000'});
    const q=await row('SELECT approved_version_id FROM work_current_quantity WHERE work_id=$1',[w.id]);
    const s=await row('SELECT scope_version FROM work_scope_state WHERE tenant_id=$1 AND object_id=$2',[p.pm.tenantId,p.object.id]);
    const c=await call(pm,'POST','',{expectedScopeVersion:String(s.scope_version),payload:{workId:w.id,newQuantity:'90',reason:'Первый вариант'}});
    assert.equal(c.status,200); const id=c.body.resultIds[0];
    assert.equal((await call(pm,'POST',`/${id}/submit`,{expectedVersion:'1',expectedScopeVersion:String(s.scope_version),payload:{inputFingerprint:'c'.repeat(64),expectedSourceVersions:{quantity:q.approved_version_id}}})).status,200);
    const returned=await call(deputy,'POST',`/${id}/return`,{expectedVersion:'2',payload:{reason:'Уточните поверхность'}});
    assert.equal(returned.status,200,JSON.stringify(returned.body));
    const patch=await call(pm,'PATCH',`/${id}`,{expectedVersion:'3',payload:{newQuantity:'85',reason:'Уточнённый вариант'}});
    assert.equal(patch.status,200,JSON.stringify(patch.body));
    assert.equal((await call(pm,'POST',`/${id}/submit`,{expectedVersion:'4',expectedScopeVersion:String(s.scope_version),payload:{inputFingerprint:'d'.repeat(64),expectedSourceVersions:{quantity:q.approved_version_id}}})).status,200);
    const versions=(await db.pool.query('SELECT number,payload FROM gpr2_quantity_submissions WHERE request_id=$1 ORDER BY number',[id])).rows;
    assert.deepEqual(versions.map((x:any)=>x.number),[1,2]);
    assert.equal(versions[0].payload.newQuantity,'90.0000'); assert.equal(versions[1].payload.newQuantity,'85.0000');
    const events=(await db.pool.query('SELECT action,reason FROM gpr2_quantity_events WHERE request_id=$1 ORDER BY created_at,id',[id])).rows;
    assert.ok(events.some((x:any)=>x.action==='RETURN' && x.reason==='Уточните поверхность'));
});

test('surface group rolls back primary version and all effects when sibling protected floor rejects',async()=>{
    // Use the R05 guarded catalogue/generation routes to create two real MAIN producer bindings.
    const mkArea=async (body:any) => {
        const r=await g.call(pm,'POST',`/v2/objects/${p.object.id}/area-scopes`,{body:{payload:body},headers:{'Idempotency-Key':uuid()}});
        assert.equal(r.status,200,JSON.stringify(r.body)); return r.body.resultIds[0] as string;
    };
    const building=await mkArea({kind:'BUILDING',code:'R07-B',name:'Корпус R07'});
    const floor=await mkArea({parentId:building,kind:'FLOOR',code:'R07-F',name:'Этаж R07',measureQuantity:'1000',measureUnit:'м²'});
    const sys=await g.call(pm,'POST',`/v2/objects/${p.object.id}/finish-systems`,{body:{payload:{finishType:{code:'R07-FIN',name:'Отделка R07'},stages:[
        {occurrenceKey:'R07-A',position:1,workTypeId:p.plaster.id,required:true,measureScope:'MAIN',measureUnit:'м²'},
        {occurrenceKey:'R07-B',position:2,workTypeId:p.plaster.id,required:true,measureScope:'MAIN',measureUnit:'м²'}
    ]}},headers:{'Idempotency-Key':uuid()}});
    assert.equal(sys.status,200,JSON.stringify(sys.body)); const [finishTypeId,systemVersionId]=sys.body.resultIds;
    const preview=await g.call(pm,'POST',`/v2/objects/${p.object.id}/finish-systems/${finishTypeId}/preview`,
        {body:{expectedVersion:'1',payload:{systemVersionId,areaScopeIds:[floor]}}});
    assert.equal(preview.status,200,JSON.stringify(preview.body)); assert.equal(preview.body.preview.canConfirm,true,JSON.stringify(preview.body.preview));
    const pv=preview.body.preview;
    const confirm=await g.call(pm,'POST',`/v2/objects/${p.object.id}/finish-systems/${finishTypeId}/confirm`,{
        body:{expectedVersion:'1',expectedScopeVersion:pv.scopeVersion,payload:{systemVersionId,areaScopeIds:[floor],previewFingerprint:pv.previewFingerprint,
            expectedSourceVersions:{systemVersion:systemVersionId}}},headers:{'Idempotency-Key':uuid()}});
    assert.equal(confirm.status,200,JSON.stringify(confirm.body));
    const bindings=(await db.pool.query('SELECT occurrence_id,work_id FROM work_scope_bindings WHERE area_scope_id=$1 ORDER BY occurrence_id',[floor])).rows;
    assert.equal(bindings.length,2); const [primary,sibling]=bindings;
    const initial=await row('SELECT approved_version_id FROM work_current_quantity WHERE work_id=$1',[primary.work_id]);
    const scope=await row('SELECT scope_version FROM work_scope_state WHERE tenant_id=$1 AND object_id=$2',[p.pm.tenantId,p.object.id]);
    const effects=bindings.map((x:any)=>({stageOccurrenceId:x.occurrence_id,workId:x.work_id,oldQuantity:'1000',newQuantity:'800'}));
    const draft=await call(pm,'POST','',{expectedScopeVersion:String(scope.scope_version),payload:{workId:primary.work_id,newQuantity:'800',reason:'Групповая поверхность',
        surface:{areaScopeId:floor,previousQuantity:'1000',newQuantity:'800',stageEffects:effects}}});
    assert.equal(draft.status,200,JSON.stringify(draft.body)); const id=draft.body.resultIds[0];
    assert.equal((await call(pm,'POST',`/${id}/submit`,{expectedVersion:'1',expectedScopeVersion:String(scope.scope_version),payload:{inputFingerprint:'e'.repeat(64),expectedSourceVersions:{quantity:initial.approved_version_id}}})).status,200);
    const saved=await row('SELECT payload FROM gpr2_quantity_submissions WHERE request_id=$1',[id]);
    await db.pool.query('UPDATE works SET actual_quantity=850 WHERE id=$1',[sibling.work_id]);
    const refused=await call(deputy,'POST',`/${id}/approve`,{expectedVersion:'2',expectedScopeVersion:String(scope.scope_version),
        payload:{inputFingerprint:contentHash(saved.payload),expectedSourceVersions:{quantity:initial.approved_version_id}}});
    assert.equal(refused.status,422,JSON.stringify(refused.body)); assert.equal(refused.body.code,'BELOW_PROTECTED_QUANTITY');
    for(const b of bindings) assert.equal((await row('SELECT approved_version_id FROM work_current_quantity WHERE work_id=$1',[b.work_id])).approved_version_id,
        (await row('SELECT id FROM work_quantity_versions WHERE work_id=$1 AND sequence=1',[b.work_id])).id);
    assert.equal((await row('SELECT count(*)::int AS n FROM gpr2_surface_changes WHERE request_id=$1',[id])).n,0);
    assert.equal((await row('SELECT count(*)::int AS n FROM gpr2_schedule_basis_invalidations WHERE request_id=$1',[id])).n,0);
    await db.pool.query('UPDATE works SET actual_quantity=800 WHERE id=$1',[sibling.work_id]);
    const applied=await call(deputy,'POST',`/${id}/approve`,{expectedVersion:'2',expectedScopeVersion:String(scope.scope_version),
        payload:{inputFingerprint:contentHash(saved.payload),expectedSourceVersions:{quantity:initial.approved_version_id}}});
    assert.equal(applied.status,200,JSON.stringify(applied.body));
    for(const b of bindings) assert.equal((await row('SELECT v.quantity FROM work_current_quantity p JOIN work_quantity_versions v ON v.id=p.approved_version_id WHERE p.work_id=$1',[b.work_id])).quantity,'800.0000');
    assert.equal((await row('SELECT count(*)::int AS n FROM gpr2_surface_changes WHERE request_id=$1',[id])).n,1);
    assert.equal((await row('SELECT count(*)::int AS n FROM gpr2_surface_effects e JOIN gpr2_surface_changes s ON s.id=e.surface_change_id WHERE s.request_id=$1',[id])).n,2);
    assert.equal((await row('SELECT count(*)::int AS n FROM gpr2_schedule_basis_invalidations WHERE request_id=$1',[id])).n,2);
});
