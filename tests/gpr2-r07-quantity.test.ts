import './helpers/gpr2-isolation';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { gpr2Harness, pilotScenario, uuid, type Gpr2Harness } from './helpers/gpr2-fixtures';
import { reportFact } from './helpers/gpr-fixtures';
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
/**
 * R07-REV-03a (migration 038): a bare `state='APPROVED'` is no longer enough for the database, so a test that wants to show a DIFFERENT database guard
 * (the protected floor, the coherent allocation snapshot) must give the forged request a complete, consistent history first — the strongest forgery a writer
 * with the application role can make. Both helpers do exactly what the service does, row for row, minus the checks.
 */
const deciderId = async () => (await row("SELECT id FROM users WHERE tenant_id=$1 AND role='DEPUTY_DIRECTOR' AND is_active=true ORDER BY created_at LIMIT 1",[p.pm.tenantId])).id as string;
// The pool of the PGlite harness is one connection: the decider is looked up BEFORE a client transaction is opened, never inside it.
const approveBySql = async (client:any,requestId:string,d:string) => {
    const r=(await client.query('SELECT tenant_id,object_id,submission_number FROM gpr2_quantity_requests WHERE id=$1',[requestId])).rows[0];
    await client.query("UPDATE gpr2_quantity_requests SET state='APPROVED',decided_by=$2 WHERE id=$1",[requestId,d]);
    await client.query("INSERT INTO gpr2_quantity_events(tenant_id,object_id,request_id,submission_number,action,actor_id) VALUES($1,$2,$3,$4,'APPROVE',$5)",[r.tenant_id,r.object_id,requestId,r.submission_number,d]);
};
const fabricateApproved = async (client:any,workId:string,source:string,quantity:number,d:string) => {
    const id=(await client.query(`INSERT INTO gpr2_quantity_requests(tenant_id,object_id,work_id,proposed_quantity,quantity_version_id,reason,author_id)
        VALUES($1,$2,$3,$4,$5,'direct SQL negative',$6) RETURNING id`,[p.pm.tenantId,p.object.id,workId,quantity,source,p.pm.id])).rows[0].id as string;
    await client.query(`INSERT INTO gpr2_quantity_submissions(tenant_id,object_id,request_id,number,payload,submitted_by) VALUES($1,$2,$3,1,$4::jsonb,$5)`,
        [p.pm.tenantId,p.object.id,id,JSON.stringify({workId,newQuantity:String(quantity),quantityVersionId:source,reason:'direct SQL negative'}),p.pm.id]);
    await client.query("INSERT INTO gpr2_quantity_events(tenant_id,object_id,request_id,submission_number,action,actor_id) VALUES($1,$2,$3,1,'SUBMIT',$4)",[p.pm.tenantId,p.object.id,id,p.pm.id]);
    await client.query("UPDATE gpr2_quantity_requests SET state='SUBMITTED',submitter_id=$2,submission_number=1 WHERE id=$1",[id,p.pm.id]);
    await approveBySql(client,id,d);
    return id;
};

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
    const decider=await deciderId();
    const client=await db.pool.connect();
    try {
        await client.query('BEGIN');
        const forged=await fabricateApproved(client,w.id,current.approved_version_id,700,decider);
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
    const decider=await deciderId();
    const client=await db.pool.connect();
    try {
        await client.query('BEGIN');
        await approveBySql(client,id,decider);
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

// ---- R07-REV-02 (independent review of 2ae913c): the two roadmap R07 acceptance facts that no earlier test asserted ----------------------------------

/** A digest of every row of a table: equal before and after proves no row was added, changed or removed (an empty table has a stable digest too). */
const digest = async (sql:string) => row(`SELECT md5(coalesce(string_agg(t::text,'|' ORDER BY t::text),'')) AS d, count(*)::int AS n FROM (${sql}) t`);
/** Everything that records production fact activity. R07 must not write any of it: an exclusion is not a fact. */
const factState = async () => ({
    confirmations: await digest('SELECT row_to_json(c)::text FROM portion_quantity_confirmations c'),
    rpFacts: await digest("SELECT row_to_json(c)::text FROM portion_quantity_confirmations c WHERE c.source='RP_FACT'"),
    progress: await digest('SELECT row_to_json(w)::text FROM work_progress w'),
    actual: await digest('SELECT id::text||\':\'||actual_quantity::text FROM works')
});

test('R07-REV-02a LOCAL 150 stays 150: a refused and an applied MAIN surface group never touch it, and a LOCAL stage cannot be dragged into the MAIN group',async()=>{
    const mkArea=async (body:any) => {
        const r=await g.call(pm,'POST',`/v2/objects/${p.object.id}/area-scopes`,{body:{payload:body},headers:{'Idempotency-Key':uuid()}});
        assert.equal(r.status,200,JSON.stringify(r.body)); return r.body.resultIds[0] as string;
    };
    const building=await mkArea({kind:'BUILDING',code:'R07L-B',name:'Корпус R07 LOCAL'});
    const floor=await mkArea({parentId:building,kind:'FLOOR',code:'R07L-F',name:'Этаж R07 LOCAL',measureQuantity:'1000',measureUnit:'м²'});
    const sys=await g.call(pm,'POST',`/v2/objects/${p.object.id}/finish-systems`,{body:{payload:{finishType:{code:'R07L-FIN',name:'Отделка R07 LOCAL'},stages:[
        {occurrenceKey:'R07L-A',position:1,workTypeId:p.plaster.id,required:true,measureScope:'MAIN',measureUnit:'м²'},
        {occurrenceKey:'R07L-M',position:2,workTypeId:p.plaster.id,required:true,measureScope:'MAIN',measureUnit:'м²'},
        {occurrenceKey:'R07L-L',position:3,workTypeId:p.plaster.id,required:true,measureScope:'LOCAL',measureUnit:'м²'}
    ]}},headers:{'Idempotency-Key':uuid()}});
    assert.equal(sys.status,200,JSON.stringify(sys.body)); const [finishTypeId,systemVersionId]=sys.body.resultIds;
    const generation={systemVersionId,areaScopeIds:[floor],localQuantities:[{occurrenceKey:'R07L-L',areaScopeId:floor,quantity:'150'}]};
    const preview=await g.call(pm,'POST',`/v2/objects/${p.object.id}/finish-systems/${finishTypeId}/preview`,{body:{expectedVersion:'1',payload:generation}});
    assert.equal(preview.status,200,JSON.stringify(preview.body)); assert.equal(preview.body.preview.canConfirm,true,JSON.stringify(preview.body.preview));
    const pv=preview.body.preview;
    const confirm=await g.call(pm,'POST',`/v2/objects/${p.object.id}/finish-systems/${finishTypeId}/confirm`,{
        body:{expectedVersion:'1',expectedScopeVersion:pv.scopeVersion,payload:{...generation,previewFingerprint:pv.previewFingerprint,expectedSourceVersions:{systemVersion:systemVersionId}}},
        headers:{'Idempotency-Key':uuid()}});
    assert.equal(confirm.status,200,JSON.stringify(confirm.body));
    const all=(await db.pool.query('SELECT occurrence_id,work_id,measure_scope,basis_quantity::text AS basis FROM work_scope_bindings WHERE area_scope_id=$1 ORDER BY occurrence_id',[floor])).rows;
    assert.equal(all.length,3); const main=all.filter((b:any)=>b.measure_scope==='MAIN'), local=all.filter((b:any)=>b.measure_scope==='LOCAL');
    assert.equal(main.length,2); assert.equal(local.length,1); assert.equal(local[0].basis,'150.0000','the LOCAL obligation was generated for the stated local 150');
    const lw=local[0].work_id as string, [primary,sibling]=main;
    const localState=async()=>({
        current:await row('SELECT p.approved_version_id,v.quantity::text AS quantity,v.sequence FROM work_current_quantity p JOIN work_quantity_versions v ON v.id=p.approved_version_id WHERE p.work_id=$1',[lw]),
        versions:(await row('SELECT count(*)::int AS n FROM work_quantity_versions WHERE work_id=$1',[lw])).n,
        planned:(await row('SELECT planned_quantity::text AS q FROM works WHERE id=$1',[lw])).q,
        allocation:(await row('SELECT count(*)::int AS n FROM work_allocation_versions WHERE work_id=$1',[lw])).n,
        effects:(await row('SELECT count(*)::int AS n FROM gpr2_surface_effects WHERE work_id=$1',[lw])).n,
        invalidations:(await row('SELECT count(*)::int AS n FROM gpr2_schedule_basis_invalidations WHERE work_id=$1',[lw])).n,
        labor:(await row('SELECT count(*)::int AS n FROM gpr2_labor_coverage_recalculations WHERE work_id=$1',[lw])).n
    });
    const baseline=await localState();
    assert.equal(baseline.current.quantity,'150.0000'); assert.equal(baseline.versions,1); assert.equal(baseline.planned.startsWith('150'),true);
    assert.deepEqual([baseline.allocation,baseline.effects,baseline.invalidations,baseline.labor],[0,0,0,0]);
    const initial=await row('SELECT approved_version_id FROM work_current_quantity WHERE work_id=$1',[primary.work_id]);
    const scope=await row('SELECT scope_version FROM work_scope_state WHERE tenant_id=$1 AND object_id=$2',[p.pm.tenantId,p.object.id]);
    const effects=main.map((x:any)=>({stageOccurrenceId:x.occurrence_id,workId:x.work_id,oldQuantity:'1000',newQuantity:'800'}));
    const draft=await call(pm,'POST','',{expectedScopeVersion:String(scope.scope_version),payload:{workId:primary.work_id,newQuantity:'800',reason:'Поверхность с LOCAL 150',
        surface:{areaScopeId:floor,previousQuantity:'1000',newQuantity:'800',stageEffects:effects}}});
    assert.equal(draft.status,200,JSON.stringify(draft.body)); const id=draft.body.resultIds[0];
    assert.equal((await call(pm,'POST',`/${id}/submit`,{expectedVersion:'1',expectedScopeVersion:String(scope.scope_version),payload:{inputFingerprint:'f'.repeat(64),expectedSourceVersions:{quantity:initial.approved_version_id}}})).status,200);
    const saved=await row('SELECT payload FROM gpr2_quantity_submissions WHERE request_id=$1',[id]);
    const approveBody={expectedVersion:'2',expectedScopeVersion:String(scope.scope_version),payload:{inputFingerprint:contentHash(saved.payload),expectedSourceVersions:{quantity:initial.approved_version_id}}};
    // (1) refused: the MAIN sibling carries 850 of protected fact. The LOCAL Work is neither part of the group nor modified by the rollback.
    await db.pool.query('UPDATE works SET actual_quantity=850 WHERE id=$1',[sibling.work_id]);
    const refusedFacts=await factState();
    const refused=await call(deputy,'POST',`/${id}/approve`,approveBody);
    assert.equal(refused.status,422,JSON.stringify(refused.body)); assert.equal(refused.body.code,'BELOW_PROTECTED_QUANTITY');
    assert.deepEqual(await localState(),baseline,'LOCAL 150 is unchanged after a REFUSED MAIN surface approval');
    assert.deepEqual(await factState(),refusedFacts,'a refused approval writes no fact activity');
    // (2) applied: both MAIN Works move 1000 -> 800; the LOCAL Work stays at 150 with the very same version row.
    await db.pool.query('UPDATE works SET actual_quantity=800 WHERE id=$1',[sibling.work_id]);
    const appliedFacts=await factState();
    const applied=await call(deputy,'POST',`/${id}/approve`,approveBody);
    assert.equal(applied.status,200,JSON.stringify(applied.body));
    for(const b of main) assert.equal((await row('SELECT v.quantity::text AS quantity FROM work_current_quantity p JOIN work_quantity_versions v ON v.id=p.approved_version_id WHERE p.work_id=$1',[b.work_id])).quantity,'800.0000');
    assert.equal((await row('SELECT count(*)::int AS n FROM gpr2_surface_effects e JOIN gpr2_surface_changes s ON s.id=e.surface_change_id WHERE s.request_id=$1',[id])).n,2,'exactly the two MAIN effects were written');
    assert.deepEqual(await localState(),baseline,'LOCAL 150 is unchanged after an APPLIED MAIN surface approval (same version id, no effect, invalidation or recalculation row)');
    assert.deepEqual(await factState(),appliedFacts,'an applied approval writes no fact activity either');
    // (3) a client that tries to treat the LOCAL stage as part of the MAIN group is refused as a whole; nothing changes.
    const scope2=await row('SELECT scope_version FROM work_scope_state WHERE tenant_id=$1 AND object_id=$2',[p.pm.tenantId,p.object.id]);
    const current=await row('SELECT approved_version_id FROM work_current_quantity WHERE work_id=$1',[primary.work_id]);
    const dragged=all.map((x:any)=>({stageOccurrenceId:x.occurrence_id,workId:x.work_id,oldQuantity:'800',newQuantity:'700'}));
    const bad=await call(pm,'POST','',{expectedScopeVersion:String(scope2.scope_version),payload:{workId:primary.work_id,newQuantity:'700',reason:'LOCAL втянут в MAIN',
        surface:{areaScopeId:floor,previousQuantity:'800',newQuantity:'700',stageEffects:dragged}}});
    assert.equal(bad.status,200,JSON.stringify(bad.body)); const badId=bad.body.resultIds[0];
    assert.equal((await call(pm,'POST',`/${badId}/submit`,{expectedVersion:'1',expectedScopeVersion:String(scope2.scope_version),payload:{inputFingerprint:'9'.repeat(64),expectedSourceVersions:{quantity:current.approved_version_id}}})).status,200);
    const badSaved=await row('SELECT payload FROM gpr2_quantity_submissions WHERE request_id=$1',[badId]);
    const beforeBad={main:(await db.pool.query('SELECT work_id,approved_version_id FROM work_current_quantity WHERE work_id=ANY($1) ORDER BY work_id',[main.map((b:any)=>b.work_id)])).rows,facts:await factState()};
    const refusedLocal=await call(deputy,'POST',`/${badId}/approve`,{expectedVersion:'2',expectedScopeVersion:String(scope2.scope_version),
        payload:{inputFingerprint:contentHash(badSaved.payload),expectedSourceVersions:{quantity:current.approved_version_id}}});
    assert.equal(refusedLocal.status,422,JSON.stringify(refusedLocal.body)); assert.equal(refusedLocal.body.code,'CROSS_SCOPE_REFERENCE');
    assert.deepEqual(await localState(),baseline,'LOCAL 150 is unchanged after a refused attempt to move it with the MAIN surface');
    assert.deepEqual({main:(await db.pool.query('SELECT work_id,approved_version_id FROM work_current_quantity WHERE work_id=ANY($1) ORDER BY work_id',[main.map((b:any)=>b.work_id)])).rows,facts:await factState()},beforeBad,'the MAIN Works and the fact tables are untouched too');
    assert.equal((await row('SELECT count(*)::int AS n FROM gpr2_surface_changes WHERE request_id=$1',[badId])).n,0);
});

test('R07-REV-02b an exclusion never writes RP_FACT: a real reported fact stays byte-identical across a refused and an applied approval',async()=>{
    await g.h.as(p.pm);
    const w=await g.h.req('works',{objectId:p.object.id,workTypeId:p.plaster.id,contractorId:p.contractors[0].id,
        responsibleUserId:p.pm.id,name:'R07 exclusion without fact',unit:'м²',plannedQuantity:1000,plannedStartDate:'2026-03-01',plannedFinishDate:'2026-04-30',estimatedCost:'100000'});
    const unit=await g.h.req('execution-units',{objectWorkId:w.id,workTypeId:p.plaster.id,contractorId:p.contractors[0].id,unit:'м²',plannedQuantity:1000,location:'R07 fact zone'});
    const portion=await g.h.req(`execution-units/${unit.id}/portions`,{label:'R07 участок',plannedQuantity:1000});
    // The RP fact comes through the real route; it is the only RP_FACT row this Work will ever have.
    await reportFact(g.h,p.pm,portion.id,300);
    const rp=(await db.pool.query("SELECT id,quantity::text AS quantity FROM portion_quantity_confirmations WHERE portion_id=$1 AND source='RP_FACT' ORDER BY id",[portion.id])).rows;
    assert.ok(rp.length>=1,'the fixture really carries an RP_FACT row'); const rpTotal=rp.reduce((s:number,x:any)=>s+Number(x.quantity),0); assert.equal(rpTotal,300);
    const prior=await row('SELECT approved_version_id FROM work_current_quantity WHERE work_id=$1',[w.id]);
    const scope=await row('SELECT scope_version FROM work_scope_state WHERE tenant_id=$1 AND object_id=$2',[p.pm.tenantId,p.object.id]);
    const request=async(newQuantity:string,units:string,fp:string)=>{
        const c=await call(pm,'POST','',{expectedScopeVersion:String(scope.scope_version),payload:{workId:w.id,newQuantity,reason:'Исключение '+newQuantity,inputFingerprint:fp.repeat(64),expectedSourceVersions:{quantity:prior.approved_version_id},
            allocation:{expectedVersionId:null,units:[{executionUnitId:unit.id,quantity:units,portions:[{portionId:portion.id,quantity:units}]}]}}});
        assert.equal(c.status,200,JSON.stringify(c.body)); const id=c.body.resultIds[0];
        assert.equal((await call(pm,'POST',`/${id}/submit`,{expectedVersion:'1',expectedScopeVersion:String(scope.scope_version),payload:{inputFingerprint:fp.repeat(64),expectedSourceVersions:{quantity:prior.approved_version_id}}})).status,200);
        const saved=await row('SELECT payload FROM gpr2_quantity_submissions WHERE request_id=$1',[id]);
        return {id,body:{expectedVersion:'2',expectedScopeVersion:String(scope.scope_version),payload:{inputFingerprint:contentHash(saved.payload),expectedSourceVersions:{quantity:prior.approved_version_id}}}};
    };
    // (1) refused: 250 is below the 300 protected RP fact. No fact row appears, none changes.
    const low=await request('250','250','1');
    const beforeRefused=await factState();
    const refused=await call(deputy,'POST',`/${low.id}/approve`,low.body);
    assert.equal(refused.status,422,JSON.stringify(refused.body)); assert.equal(refused.body.code,'BELOW_PROTECTED_QUANTITY');
    assert.deepEqual(await factState(),beforeRefused,'a REFUSED exclusion leaves every fact table byte-identical');
    assert.equal((await row('SELECT approved_version_id FROM work_current_quantity WHERE work_id=$1',[w.id])).approved_version_id,prior.approved_version_id);
    // (2) applied: 1000 -> 800 with the fact at 300. The excluded 200 is a quantity decision, not a fact.
    const ok=await request('800','800','2');
    const beforeApplied=await factState();
    const applied=await call(deputy,'POST',`/${ok.id}/approve`,ok.body);
    assert.equal(applied.status,200,JSON.stringify(applied.body));
    assert.equal((await row('SELECT v.quantity::text AS quantity FROM work_current_quantity p JOIN work_quantity_versions v ON v.id=p.approved_version_id WHERE p.work_id=$1',[w.id])).quantity,'800.0000');
    assert.deepEqual(await factState(),beforeApplied,'an APPLIED exclusion leaves every fact table byte-identical');
    assert.deepEqual((await db.pool.query("SELECT id,quantity::text AS quantity FROM portion_quantity_confirmations WHERE portion_id=$1 AND source='RP_FACT' ORDER BY id",[portion.id])).rows,rp,'the RP_FACT rows are exactly the reported ones — no RP_FACT of 200, none of 800');
    assert.equal((await row("SELECT count(*)::int AS n FROM portion_quantity_confirmations WHERE portion_id=$1 AND source<>'RP_FACT'",[portion.id])).n,0,'and no other kind of confirmation either');
    // The check is not vacuous: the approval did write its own rows (quantity decision, event, invalidation) while the fact tables stayed still.
    assert.equal((await row("SELECT count(*)::int AS n FROM gpr2_quantity_events WHERE request_id=$1 AND action='APPROVE'",[ok.id])).n,1);
    assert.equal((await row('SELECT count(*)::int AS n FROM gpr2_schedule_basis_invalidations WHERE request_id=$1',[ok.id])).n,1);
});

test('R07-REV-03a structure: a request cannot skip its lifecycle, be approved by its author, be edited after submission, or carry a pointer without its events',async()=>{
    await g.h.as(p.pm);
    const w=await g.h.req('works',{objectId:p.object.id,workTypeId:p.plaster.id,contractorId:p.contractors[0].id,
        responsibleUserId:p.pm.id,name:'R07 lifecycle structure',unit:'м²',plannedQuantity:1000,plannedStartDate:'2026-03-01',plannedFinishDate:'2026-04-30',estimatedCost:'100000'});
    const source=(await row('SELECT approved_version_id FROM work_current_quantity WHERE work_id=$1',[w.id])).approved_version_id as string;
    const scope=await row('SELECT scope_version FROM work_scope_state WHERE tenant_id=$1 AND object_id=$2',[p.pm.tenantId,p.object.id]);
    const mk=async(quantity:string,fp:string)=>{
        const c=await call(pm,'POST','',{expectedScopeVersion:String(scope.scope_version),payload:{workId:w.id,newQuantity:quantity,reason:'структура '+quantity,inputFingerprint:fp.repeat(64),expectedSourceVersions:{quantity:source}}});
        assert.equal(c.status,200,JSON.stringify(c.body)); return c.body.resultIds[0] as string;
    };
    const submit=async(id:string,fp:string)=>assert.equal((await call(pm,'POST',`/${id}/submit`,{expectedVersion:'1',expectedScopeVersion:String(scope.scope_version),payload:{inputFingerprint:fp.repeat(64),expectedSourceVersions:{quantity:source}}})).status,200);
    const params=[p.pm.tenantId,p.object.id,w.id,900,source,p.pm.id];
    const insert=`INSERT INTO gpr2_quantity_requests(tenant_id,object_id,work_id,state,proposed_quantity,quantity_version_id,reason,author_id,submission_number,submitter_id,decided_by) VALUES($1,$2,$3,$7,$4,$5,'direct',$6,$8,$9,$10)`;
    // a request is born an undecided DRAFT, whatever else is true
    await assert.rejects(db.pool.query(insert,[...params,'APPROVED',0,null,null]),/starts as an undecided DRAFT/);
    await assert.rejects(db.pool.query(insert,[...params,'SUBMITTED',1,p.pm.id,null]),/starts as an undecided DRAFT/);
    await assert.rejects(db.pool.query(insert,[...params,'DRAFT',0,null,await deciderId()]),/starts as an undecided DRAFT/);
    // DRAFT -> SUBMITTED needs the author's snapshot of the next number
    const draft=await mk('900','1');
    await assert.rejects(db.pool.query("UPDATE gpr2_quantity_requests SET state='SUBMITTED',submitter_id=author_id,submission_number=1 WHERE id=$1",[draft]),/needs the author's submission snapshot/);
    await assert.rejects(db.pool.query("UPDATE gpr2_quantity_requests SET state='APPROVED',decided_by=$2 WHERE id=$1",[draft,await deciderId()]),/invalid quantity request transition DRAFT -> APPROVED/);
    // a snapshot is taken only by the author, in sequence, from a DRAFT
    await assert.rejects(db.pool.query(`INSERT INTO gpr2_quantity_submissions(tenant_id,object_id,request_id,number,payload,submitted_by) VALUES($1,$2,$3,2,'{}',$4)`,[p.pm.tenantId,p.object.id,draft,p.pm.id]),/only from the author's DRAFT, in sequence/);
    await assert.rejects(db.pool.query(`INSERT INTO gpr2_quantity_submissions(tenant_id,object_id,request_id,number,payload,submitted_by) VALUES($1,$2,$3,1,'{}',$4)`,[p.pm.tenantId,p.object.id,draft,await deciderId()]),/only from the author's DRAFT, in sequence/);
    await submit(draft,'1');
    // SUBMITTED: no edit, no skipped decision, no approval by the author or submitter, no step back
    const decider=await deciderId();
    await assert.rejects(db.pool.query("UPDATE gpr2_quantity_requests SET proposed_quantity=1 WHERE id=$1",[draft]),/a submitted request is not edited/);
    await assert.rejects(db.pool.query("UPDATE gpr2_quantity_requests SET state='APPROVED' WHERE id=$1",[draft]),/needs the submitted snapshot and a decider/);
    await assert.rejects(db.pool.query("UPDATE gpr2_quantity_requests SET state='APPROVED',decided_by=author_id WHERE id=$1",[draft]),/author or submitter cannot approve/);
    await assert.rejects(db.pool.query("UPDATE gpr2_quantity_requests SET state='DRAFT' WHERE id=$1",[draft]),/invalid quantity request transition SUBMITTED -> DRAFT/);
    await assert.rejects(db.pool.query("UPDATE gpr2_quantity_requests SET work_id=$2 WHERE id=$1",[draft,p.plasterWork.work.id]),/identity and source version are immutable/);
    // decided by somebody else but WITHOUT the APPROVE event: the pointer guard refuses at COMMIT
    const client=await db.pool.connect();
    try {
        await client.query('BEGIN');
        await client.query("UPDATE gpr2_quantity_requests SET state='APPROVED',decided_by=$2 WHERE id=$1",[draft,decider]);
        const v=(await client.query(`INSERT INTO work_quantity_versions(tenant_id,object_id,work_id,sequence,quantity,unit,source_kind,approved_request_id,previous_id,created_by)
            VALUES($1,$2,$3,2,900,$4,'APPROVED_REQUEST',$5,$6,$7) RETURNING id`,[p.pm.tenantId,p.object.id,w.id,w.unit,draft,source,p.pm.id])).rows[0].id;
        await client.query('UPDATE work_current_quantity SET approved_version_id=$1 WHERE work_id=$2',[v,w.id]);
        await assert.rejects(client.query('COMMIT'),/provenance incomplete \(no SUBMIT \/ APPROVE event/);
    } finally { await client.query('ROLLBACK').catch(()=>undefined); client.release(); }
    assert.equal((await row('SELECT approved_version_id FROM work_current_quantity WHERE work_id=$1',[w.id])).approved_version_id,source);
    assert.equal((await row('SELECT state FROM gpr2_quantity_requests WHERE id=$1',[draft])).state,'SUBMITTED');
    // the real approval still works, and an APPROVED request is final
    const saved=await row('SELECT payload FROM gpr2_quantity_submissions WHERE request_id=$1',[draft]);
    const done=await call(deputy,'POST',`/${draft}/approve`,{expectedVersion:'2',expectedScopeVersion:String(scope.scope_version),payload:{inputFingerprint:contentHash(saved.payload),expectedSourceVersions:{quantity:source}}});
    assert.equal(done.status,200,JSON.stringify(done.body));
    await assert.rejects(db.pool.query("UPDATE gpr2_quantity_requests SET reason='после' WHERE id=$1",[draft]),/a submitted request is not edited/);
    await assert.rejects(db.pool.query("UPDATE gpr2_quantity_requests SET version=version+1 WHERE id=$1",[draft]),/invalid quantity request transition APPROVED -> APPROVED/);
    await assert.rejects(db.pool.query("UPDATE gpr2_quantity_requests SET state='DRAFT' WHERE id=$1",[draft]),/invalid quantity request transition APPROVED -> DRAFT/);
});

test('R07-REV-05/06 the quantity pointer cannot be deleted and re-inserted under a real RP fact, and an approved request cannot be replayed for another allocation',async()=>{
    await g.h.as(p.pm);
    const w=await g.h.req('works',{objectId:p.object.id,workTypeId:p.plaster.id,contractorId:p.contractors[0].id,
        responsibleUserId:p.pm.id,name:'R07 pointer lifecycle',unit:'м²',plannedQuantity:1000,plannedStartDate:'2026-03-01',plannedFinishDate:'2026-04-30',estimatedCost:'100000'});
    const unit=await g.h.req('execution-units',{objectWorkId:w.id,workTypeId:p.plaster.id,contractorId:p.contractors[0].id,unit:'м²',plannedQuantity:1000,location:'R07 lifecycle zone'});
    const portion=await g.h.req(`execution-units/${unit.id}/portions`,{label:'R07 lifecycle участок',plannedQuantity:1000});
    await reportFact(g.h,p.pm,portion.id,800);
    const source=(await row('SELECT approved_version_id FROM work_current_quantity WHERE work_id=$1',[w.id])).approved_version_id as string;
    const pointerBefore=await row('SELECT * FROM work_current_quantity WHERE work_id=$1',[w.id]);
    // REV-05: the original attack (DELETE the pointer, INSERT a draft request, a version of 300, a new pointer) is refused at its first statement
    const client=await db.pool.connect();
    try {
        await client.query('BEGIN');
        await assert.rejects(client.query('DELETE FROM work_current_quantity WHERE work_id=$1',[w.id]),/the current quantity pointer is never deleted/);
    } finally { await client.query('ROLLBACK').catch(()=>undefined); client.release(); }
    assert.deepEqual(await row('SELECT * FROM work_current_quantity WHERE work_id=$1',[w.id]),pointerBefore);
    await assert.rejects(db.pool.query('UPDATE work_current_quantity SET work_id=$2 WHERE work_id=$1',[w.id,uuid()]),/pointer identity is immutable/);
    assert.equal((await row('SELECT approved_version_id FROM work_current_quantity WHERE work_id=$1',[w.id])).approved_version_id,source);
    // REV-06: a legitimate approval 1000 -> 800 with an allocation, then the SAME request replayed for another allocation version
    const scope=await row('SELECT scope_version FROM work_scope_state WHERE tenant_id=$1 AND object_id=$2',[p.pm.tenantId,p.object.id]);
    const alloc={expectedVersionId:null,units:[{executionUnitId:unit.id,quantity:'800',portions:[{portionId:portion.id,quantity:'800'}]}]};
    const c=await call(pm,'POST','',{expectedScopeVersion:String(scope.scope_version),payload:{workId:w.id,newQuantity:'800',reason:'REV-06 replay',inputFingerprint:'7'.repeat(64),expectedSourceVersions:{quantity:source},allocation:alloc}});
    assert.equal(c.status,200,JSON.stringify(c.body)); const id=c.body.resultIds[0];
    assert.equal((await call(pm,'POST',`/${id}/submit`,{expectedVersion:'1',expectedScopeVersion:String(scope.scope_version),payload:{inputFingerprint:'7'.repeat(64),expectedSourceVersions:{quantity:source}}})).status,200);
    const saved=await row('SELECT payload FROM gpr2_quantity_submissions WHERE request_id=$1',[id]);
    assert.equal((await call(deputy,'POST',`/${id}/approve`,{expectedVersion:'2',expectedScopeVersion:String(scope.scope_version),payload:{inputFingerprint:contentHash(saved.payload),expectedSourceVersions:{quantity:source}}})).status,200);
    const al=await row('SELECT a.version_id, v.sequence, v.quantity_version_id FROM work_current_allocation a JOIN work_allocation_versions v ON v.id=a.version_id WHERE a.work_id=$1',[w.id]);
    const replay=await db.pool.connect();
    try {
        await replay.query('BEGIN');
        await assert.rejects(replay.query(`INSERT INTO work_allocation_versions(tenant_id,object_id,work_id,sequence,previous_id,quantity_version_id,unit,created_by,approved_request_id) VALUES($1,$2,$3,$4,$5,$6,'м²',$7,$8)`,
            [p.pm.tenantId,p.object.id,w.id,al.sequence+1,al.version_id,al.quantity_version_id,p.pm.id,id]),/gpr2_r07_one_allocation_per_work_request/);
    } finally { await replay.query('ROLLBACK').catch(()=>undefined); replay.release(); }
    assert.equal((await row('SELECT version_id FROM work_current_allocation WHERE work_id=$1',[w.id])).version_id,al.version_id);
});
