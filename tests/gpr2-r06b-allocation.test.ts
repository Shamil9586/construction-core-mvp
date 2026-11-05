import './helpers/gpr2-isolation';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { gprHarness, pilotScenario, type Harness, type Pilot } from './helpers/gpr-fixtures';

let h: Harness, p: Pilot, pool: any;
before(async () => { h = await gprHarness('r06b-alloc'); p = await pilotScenario(h); ({ pool } = await import('../apps/backend/src/db')); });
after(async () => { await h?.close(); await pool?.end(); });
const route = () => `objects/${p.object.id}/works/${p.plasterWork.work.id}/allocations`;
const quantity = () => `objects/${p.object.id}/works/${p.plasterWork.work.id}/quantity`;

test('explicit snapshots expose partial/full/zero separately; CAS and identity preserve history', async () => {
    await h.as(p.pm);
    const initial = await h.req(quantity());
    assert.equal(initial.allocationCoverage, 'NOT_CAPTURED');
    assert.equal(initial.allocatedQuantity, null);
    const one = await h.req(route(), { expectedVersionId: null, units: [
        { executionUnitId: p.floor1.unit.id, quantity: '400.0000', portions: [{ portionId: p.floor1.portion.id, quantity: '300.0000' }] }
    ] });
    assert.equal(one.allocatedQuantity, '400.0000');
    assert.equal(one.unallocatedQuantity, '400.0000');
    const partial = await h.req(quantity());
    assert.equal(partial.allocationCoverage, 'PARTIAL');
    assert.equal(partial.allocations.length, 2);
    await assert.rejects(pool.query(`INSERT INTO work_allocation_lines(tenant_id,object_id,work_id,version_id,execution_unit_id,quantity,unit)
        VALUES($1,$2,$3,$4,$5,1,$6)`, [p.pm.tenantId,p.object.id,p.plasterWork.work.id,one.versionId,p.floor2.unit.id,p.plaster.unit]),
        /historical allocation is immutable/);
    assert.equal((await h.raw(route(), { expectedVersionId: null, units: [] })).status, 409);
    const two = await h.req(route(), { expectedVersionId: one.versionId, units: [
        { executionUnitId: p.floor1.unit.id, quantity: '500', portions: [{ portionId: p.floor1.portion.id, quantity: '500' }] },
        { executionUnitId: p.floor2.unit.id, quantity: '300', portions: [{ portionId: p.floor2.portion.id, quantity: '300' }] }
    ] });
    assert.equal(two.unallocatedQuantity, '0.0000');
    assert.equal((await h.req(quantity())).allocationCoverage, 'FULL');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM work_allocation_versions WHERE work_id=$1', [p.plasterWork.work.id])).rows[0].n, 2);
    await assert.rejects(pool.query('UPDATE work_allocation_lines SET quantity=1 WHERE version_id=$1', [one.versionId]), /immutable allocation history/);
    await h.req(route(), { expectedVersionId: two.versionId, units: [] });
    const zero = await h.req(quantity());
    assert.equal(zero.allocatedQuantity, '0.0000');
    assert.equal(zero.allocationCoverage, 'PARTIAL');
    assert.equal(zero.originalProvenance, 'PROVEN_CREATION');
});

test('direct SQL cannot exceed Work, WEU, portion or cross-object identity; rollback leaves pointer', async () => {
    await h.as(p.pm);
    const current = await h.req(quantity());
    const w = p.plasterWork.work;
    await assert.rejects(pool.query(`INSERT INTO work_execution_units(tenant_id,object_work_id,work_type_id,contractor_id,unit,planned_quantity)
        VALUES($1,$2,$3,$4,$5,1)`, [p.pm.tenantId,w.id,p.plaster.id,p.contractors[0].id,w.unit]), /Work planned WEU cap/);
    await assert.rejects(pool.query('UPDATE work_execution_units SET planned_quantity=1 WHERE id=$1', [p.floor1.unit.id]), /WEU plan below planned portion sum/);
    const version = (await pool.query('SELECT approved_version_id FROM work_current_quantity WHERE work_id=$1', [w.id])).rows[0].approved_version_id;
    await assert.rejects(pool.query(`INSERT INTO work_allocation_lines(tenant_id,object_id,work_id,version_id,execution_unit_id,quantity,unit)
        VALUES($1,$2,$3,$4,$5,1,$6)`, [p.pm.tenantId,p.object.id,w.id,current.allocationVersionId,p.neighbourUnit.unit.id,w.unit]), /foreign key/);
    const before = (await pool.query('SELECT version_id FROM work_current_allocation WHERE work_id=$1', [w.id])).rows[0].version_id;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const v = (await client.query(`INSERT INTO work_allocation_versions(tenant_id,object_id,work_id,sequence,previous_id,quantity_version_id,unit,created_by)
            VALUES($1,$2,$3,4,$4,$5,$6,$7) RETURNING id`, [p.pm.tenantId,p.object.id,w.id,before,version,w.unit,p.pm.id])).rows[0].id;
        await client.query(`INSERT INTO work_allocation_lines(tenant_id,object_id,work_id,version_id,execution_unit_id,quantity,unit)
            VALUES($1,$2,$3,$4,$5,801,$6)`, [p.pm.tenantId,p.object.id,w.id,v,p.floor1.unit.id,w.unit]);
        await client.query('UPDATE work_current_allocation SET version_id=$1 WHERE tenant_id=$2 AND work_id=$3', [v,p.pm.tenantId,w.id]);
        await assert.rejects(client.query('COMMIT'), /allocation cap|pointer must advance/);
    } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
    assert.equal((await pool.query('SELECT version_id FROM work_current_allocation WHERE work_id=$1', [w.id])).rows[0].version_id,before);
});

test('unproven legacy Work remains unallocated and cannot invent a current sidecar', async () => {
    const legacy = (await pool.query(`INSERT INTO works(tenant_id,object_id,work_type_id,name,unit,planned_quantity)
        VALUES($1,$2,$3,'R06b old Work',$4,10) RETURNING id`, [p.pm.tenantId,p.object.id,p.plaster.id,p.plaster.unit])).rows[0].id;
    await h.as(p.pm);
    const q = await h.req(`objects/${p.object.id}/works/${legacy}/quantity`);
    assert.equal(q.originalProvenance, 'UNKNOWN_LEGACY');
    assert.equal(q.allocationCoverage, 'NOT_CAPTURED');
    assert.equal(q.allocatedQuantity, null);
    assert.equal((await h.raw(`objects/${p.object.id}/works/${legacy}/allocations`, { expectedVersionId: null, units: [] })).status,409);
});

test('a complete snapshot cannot omit a distinct confirmed portion scope', async () => {
    await pool.query(`INSERT INTO portion_quantity_confirmations(tenant_id,portion_id,source,quantity,recorded_by)
        VALUES($1,$2,'INTERNAL_SC',2,$3)`, [p.pm.tenantId,p.floor1.portion.id,p.pm.id]);
    await h.as(p.pm);
    const before = await h.req(quantity());
    const refusal = await h.raw(route(), { expectedVersionId: before.allocationVersionId, units: [] });
    assert.equal(refusal.status,409);
    assert.equal((await h.req(quantity())).allocationVersionId,before.allocationVersionId);
    const prior = (await pool.query('SELECT sequence FROM work_allocation_versions WHERE id=$1',[before.allocationVersionId])).rows[0].sequence;
    const approved = (await pool.query('SELECT approved_version_id FROM work_current_quantity WHERE work_id=$1',[p.plasterWork.work.id])).rows[0].approved_version_id;
    const c = await pool.connect();
    try {
        await c.query('BEGIN');
        const next = (await c.query(`INSERT INTO work_allocation_versions(tenant_id,object_id,work_id,sequence,previous_id,quantity_version_id,unit,created_by)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
            [p.pm.tenantId,p.object.id,p.plasterWork.work.id,prior+1,before.allocationVersionId,approved,p.plaster.unit,p.pm.id])).rows[0].id;
        await c.query('UPDATE work_current_allocation SET version_id=$1 WHERE tenant_id=$2 AND object_id=$3 AND work_id=$4',
            [next,p.pm.tenantId,p.object.id,p.plasterWork.work.id]);
        await assert.rejects(c.query('COMMIT'),/allocation is frozen after confirmed evidence/);
    } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
    assert.equal((await h.req(quantity())).allocationVersionId,before.allocationVersionId);
});

test('stale actor role captured before transaction is rechecked under the Work lock', async () => {
    const { session, hash } = await import('../apps/backend/src/security');
    const { replaceWorkAllocation } = await import('../apps/backend/src/gpr2-r06b-allocation');
    const token = await session(p.pm);
    const before = (await pool.query('SELECT version_id FROM work_current_allocation WHERE work_id=$1',[p.plasterWork.work.id])).rows[0].version_id;
    try {
        await pool.query("UPDATE users SET role='GENERAL_DIRECTOR' WHERE tenant_id=$1 AND id=$2",[p.pm.tenantId,p.pm.id]);
        await assert.rejects(replaceWorkAllocation(p.pm,p.object.id,p.plasterWork.work.id,
            {expectedVersionId:before,units:[]},hash(token.token)),/Недостаточно прав/);
        assert.equal((await pool.query('SELECT version_id FROM work_current_allocation WHERE work_id=$1',[p.plasterWork.work.id])).rows[0].version_id,before);
    } finally { await pool.query("UPDATE users SET role='PROJECT_MANAGER' WHERE tenant_id=$1 AND id=$2",[p.pm.tenantId,p.pm.id]); }
});
