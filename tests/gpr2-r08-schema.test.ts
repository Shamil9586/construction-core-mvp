import './helpers/gpr2-isolation';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { gprHarness, pilotScenario, type Harness, type Pilot } from './helpers/gpr-fixtures';

let h: Harness, p: Pilot, pool: any;
before(async () => { h = await gprHarness('r08-schema'); p = await pilotScenario(h); ({ pool } = await import('../apps/backend/src/db')); });
after(async () => { await h?.close(); await pool?.end(); });

test('R08 039 binds WEU to active AreaScope of exact Work and object, and preserves policy history', async () => {
  const t = p.pm.tenantId, o = p.object.id, w = p.plasterWork.work.id;
  const area = (await pool.query(`INSERT INTO object_area_scopes(tenant_id,object_id,kind,code,name,created_by)
    VALUES($1,$2,'ZONE','r08-a1','Zone 1',$3) RETURNING id`, [t,o,p.pm.id])).rows[0].id;
  await assert.rejects(pool.query(`INSERT INTO gpr2_execution_unit_area_scopes(tenant_id,object_id,work_id,execution_unit_id,area_scope_id,created_by)
    VALUES($1,$2,$3,$4,$5,$6)`, [t,o,w,p.neighbourUnit.unit.id,area,p.pm.id]), /mismatch/);
  await pool.query(`INSERT INTO gpr2_execution_unit_area_scopes(tenant_id,object_id,work_id,execution_unit_id,area_scope_id,created_by)
    VALUES($1,$2,$3,$4,$5,$6)`, [t,o,w,p.floor1.unit.id,area,p.pm.id]);
  const v1 = (await pool.query(`INSERT INTO gpr2_internal_sc_policy_versions(tenant_id,object_id,version,policy,basis,actor_id)
    VALUES($1,$2,1,'REQUIRED','R08 synthetic policy',$3) RETURNING id`, [t,o,p.pm.id])).rows[0].id;
  await pool.query(`INSERT INTO gpr2_current_internal_sc_policy(tenant_id,object_id,version_id) VALUES($1,$2,$3)`, [t,o,v1]);
  await assert.rejects(pool.query(`UPDATE gpr2_internal_sc_policy_versions SET policy='NOT_REQUIRED' WHERE id=$1`, [v1]), /immutable/);
  const v3 = (await pool.query(`INSERT INTO gpr2_internal_sc_policy_versions(tenant_id,object_id,version,policy,basis,actor_id)
    VALUES($1,$2,3,'NOT_REQUIRED','skip version',$3) RETURNING id`, [t,o,p.pm.id])).rows[0].id;
  await assert.rejects(pool.query(`UPDATE gpr2_current_internal_sc_policy SET version_id=$1 WHERE object_id=$2`, [v3,o]), /advance by one/);
  assert.equal((await pool.query('SELECT version_id FROM gpr2_current_internal_sc_policy WHERE object_id=$1',[o])).rows[0].version_id, v1);
});
