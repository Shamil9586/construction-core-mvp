import './helpers/gpr2-isolation';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { gprHarness, pilotScenario, reportFact, acceptInternalSc, type Harness, type Pilot } from './helpers/gpr-fixtures';

let h: Harness, p: Pilot, pool: any;
before(async () => { h = await gprHarness('r08-schema'); p = await pilotScenario(h); ({ pool } = await import('../apps/backend/src/db')); });
after(async () => { await h?.close(); await pool?.end(); });

test('R08 039 binds WEU to active AreaScope of exact Work and object, and preserves policy history', async () => {
  const t = p.pm.tenantId, o = p.object.id, w = p.plasterWork.work.id;
  await h.as(p.pm);
  const route = `objects/${o}/works/${w}/execution-units/${p.floor1.unit.id}/release`;
  assert.deepEqual((await h.req(route)).reasons, ['ASSIGNMENT_MISSING', 'EVIDENCE_MISSING', 'POLICY_UNKNOWN']);
  const area = (await pool.query(`INSERT INTO object_area_scopes(tenant_id,object_id,kind,code,name,created_by)
    VALUES($1,$2,'ZONE','r08-a1','Zone 1',$3) RETURNING id`, [t,o,p.pm.id])).rows[0].id;
  await assert.rejects(pool.query(`INSERT INTO gpr2_execution_unit_area_scopes(tenant_id,object_id,work_id,execution_unit_id,area_scope_id,created_by)
    VALUES($1,$2,$3,$4,$5,$6)`, [t,o,w,p.neighbourUnit.unit.id,area,p.pm.id]), /mismatch/);
  await pool.query(`INSERT INTO gpr2_execution_unit_area_scopes(tenant_id,object_id,work_id,execution_unit_id,area_scope_id,created_by)
    VALUES($1,$2,$3,$4,$5,$6)`, [t,o,w,p.floor1.unit.id,area,p.pm.id]);
  const v1 = (await pool.query(`INSERT INTO gpr2_internal_sc_policy_versions(tenant_id,object_id,version,policy,basis,actor_id)
    VALUES($1,$2,1,'REQUIRED','R08 synthetic policy',$3) RETURNING id`, [t,o,p.pm.id])).rows[0].id;
  await pool.query(`INSERT INTO gpr2_current_internal_sc_policy(tenant_id,object_id,version_id) VALUES($1,$2,$3)`, [t,o,v1]);
  assert.deepEqual((await h.req(route)).reasons, ['ASSIGNMENT_MISSING', 'EVIDENCE_MISSING']);
  await pool.query(`INSERT INTO gpr2_release_scope_completeness(tenant_id,object_id,work_id,execution_unit_id,area_scope_id,basis,declared_by)
    VALUES($1,$2,$3,$4,$5,'synthetic no-prerequisite target',$6)`,[t,o,w,p.floor1.unit.id,area,p.pm.id]);
  assert.deepEqual((await h.req(route)).reasons,['ASSIGNMENT_MISSING']);
  await h.req(`objects/${o}/works/${w}/allocations`,{expectedVersionId:null,units:[{
    executionUnitId:p.floor1.unit.id,quantity:'500',portions:[{portionId:p.floor1.portion.id,quantity:'500'}]},
    {executionUnitId:p.floor2.unit.id,quantity:'300',portions:[{portionId:p.floor2.portion.id,quantity:'300'}]}]});
  assert.equal((await h.req(route)).allowed,true);
  const area2=(await pool.query(`INSERT INTO object_area_scopes(tenant_id,object_id,kind,code,name,created_by)
    VALUES($1,$2,'ZONE','r08-a2','Zone 2',$3) RETURNING id`,[t,o,p.pm.id])).rows[0].id;
  const setup={workId:w,executionUnitId:p.floor2.unit.id,areaScopeId:area2,basis:'explicit synthetic second zone',policy:'REQUIRED',requirements:[]};
  await h.login('DEPUTY_DIRECTOR');
  assert.equal((await h.raw(`objects/${o}/r08-release-setup`,setup)).status,403);
  await h.as(p.pm);
  await h.req(`objects/${o}/r08-release-setup`,setup);
  const route2=`objects/${o}/works/${w}/execution-units/${p.floor2.unit.id}/release`;
  assert.equal((await h.req(route2)).allowed,true);
  const inspection=(await pool.query(`INSERT INTO inspections(tenant_id,object_id,object_work_id,requested_by)
    VALUES($1,$2,$3,$4) RETURNING id`,[t,o,w,p.pm.id])).rows[0].id;
  await h.login('CONSTRUCTION_CONTROL');
  const scopedIssue=(await h.req(`inspections/${inspection}/issues`,{title:'Zone 2 issue',severity:'CRITICAL',
    responsibleUserId:p.pm.id,dueDate:'2026-12-01',version:1,areaScopeId:area2,executionUnitId:p.floor2.unit.id})).id;
  await h.as(p.pm);
  assert.equal((await h.req(route)).allowed,true,'the adjacent zone remains ready');
  assert.deepEqual((await h.req(route2)).reasons,['CRITICAL_ISSUE']);
  await pool.query("UPDATE issues SET status='CLOSED' WHERE id=$1",[scopedIssue]);
  await h.login('CONSTRUCTION_CONTROL');
  const globalIssue=(await h.req(`inspections/${inspection}/issues`,{title:'Whole-object legacy issue',
    severity:'CRITICAL',responsibleUserId:p.pm.id,dueDate:'2026-12-01',version:2})).id;
  await h.as(p.pm);
  assert.deepEqual((await h.req(route)).reasons,['CRITICAL_ISSUE']);
  await pool.query("UPDATE issues SET status='CLOSED' WHERE id=$1",[globalIssue]);
  await assert.rejects(pool.query(`UPDATE gpr2_internal_sc_policy_versions SET policy='NOT_REQUIRED' WHERE id=$1`, [v1]), /immutable/);
  const v3 = (await pool.query(`INSERT INTO gpr2_internal_sc_policy_versions(tenant_id,object_id,version,policy,basis,actor_id)
    VALUES($1,$2,3,'NOT_REQUIRED','skip version',$3) RETURNING id`, [t,o,p.pm.id])).rows[0].id;
  await assert.rejects(pool.query(`UPDATE gpr2_current_internal_sc_policy SET version_id=$1 WHERE object_id=$2`, [v3,o]), /advance by one/);
  assert.equal((await pool.query('SELECT version_id FROM gpr2_current_internal_sc_policy WHERE object_id=$1',[o])).rows[0].version_id, v1);
  await reportFact(h,p.pm,p.floor1.portion.id,100);
});

test('R08 source RP and applicable SC remain independent gates; no synthetic SC confirmation', async () => {
  await h.as(p.pm);
  const t=p.pm.tenantId,o=p.object.id,source=p.plasterWork.work.id;
  const sourceArea=(await pool.query('SELECT area_scope_id FROM gpr2_execution_unit_area_scopes WHERE execution_unit_id=$1',[p.floor1.unit.id])).rows[0].area_scope_id;
  const work=await h.req('works',{objectId:o,workTypeId:p.plaster.id,contractorId:p.contractors[0].id,
    responsibleUserId:p.pm.id,name:'R08 target',unit:'м²',plannedQuantity:20,plannedStartDate:'2026-03-01',
    plannedFinishDate:'2026-04-30',estimatedCost:'1000'});
  const u=await h.req('execution-units',{objectWorkId:work.id,workTypeId:p.plaster.id,
    contractorId:p.contractors[0].id,unit:'м²',plannedQuantity:20,location:'explicit target'});
  const portion=await h.req(`execution-units/${u.id}/portions`,{label:'Target',plannedQuantity:20});
  const area=(await pool.query(`INSERT INTO object_area_scopes(tenant_id,object_id,kind,code,name,created_by)
    VALUES($1,$2,'ZONE','r08-target','Target zone',$3) RETURNING id`,[t,o,p.pm.id])).rows[0].id;
  await h.req(`objects/${o}/works/${work.id}/allocations`,{expectedVersionId:null,units:[{
    executionUnitId:u.id,quantity:'20',portions:[{portionId:portion.id,quantity:'20'}]}]});
  await h.req(`objects/${o}/r08-release-setup`,{workId:work.id,executionUnitId:u.id,areaScopeId:area,
    basis:'explicit source scope',policy:'REQUIRED',requirements:[{sourceWorkId:source,
      sourceExecutionUnitId:p.floor1.unit.id,sourceAreaScopeId:sourceArea,requiresInternalSc:true,cureDays:0}]});
  const route=`objects/${o}/works/${work.id}/execution-units/${u.id}/release`;
  assert.deepEqual((await h.req(route)).reasons,['PREDECESSOR_RP_MISSING','INTERNAL_SC_MISSING']);
  await reportFact(h,p.pm,p.floor1.portion.id,500);
  assert.deepEqual((await h.req(route)).reasons,['INTERNAL_SC_MISSING']);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM portion_quantity_confirmations WHERE portion_id=$1 AND source='INTERNAL_SC'`,
    [p.floor1.portion.id])).rows[0].n,0);
  await acceptInternalSc(h,p.floor1.portion.id,500);
  await h.as(p.pm);
  assert.equal((await h.req(route)).allowed,true);
});
