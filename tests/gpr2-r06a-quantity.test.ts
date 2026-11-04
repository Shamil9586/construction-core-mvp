import './helpers/gpr2-isolation';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { gprHarness, pilotScenario, type Harness, type Pilot } from './helpers/gpr-fixtures';
import { shapeQuantityRead } from '../packages/domain/gpr2/r06a-quantity';

let h: Harness, p: Pilot, pool: any;
before(async () => { h = await gprHarness('r06a-quantity'); p = await pilotScenario(h); ({ pool } = await import('../apps/backend/src/db')); });
after(async () => { await h?.close(); await pool?.end(); });

const path = (objectId: string, workId: string) => `objects/${objectId}/works/${workId}/quantity`;

test('creation records one immutable origin, initial version and pointer in the Work transaction; retry preserves all identities', async () => {
    await h.as(p.pm);
    const id = p.plasterWork.work.id;
    const read = await h.req(path(p.object.id, id));
    assert.equal(read.workId, id);
    assert.equal(read.originalQuantity, '800.0000');
    assert.equal(read.currentQuantity, '800.0000');
    assert.equal(read.originalProvenance, 'PROVEN_CREATION');
    assert.equal(read.originalSource.kind, 'MANUAL_CREATE');
    assert.equal(read.currentProvenance, 'INITIAL_VERSION');
    assert.equal(read.currentSequence, 1);
    assert.equal(read.factQuantity, '0.0000');
    assert.equal(read.baselineQuantity, null);
    assert.equal(read.baselineState, 'NOT_CAPTURED');
    assert.equal(read.unit, 'м²');
    const count = async (table: string) => Number((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE work_id=$1`, [id])).rows[0].n);
    for (const table of ['work_quantity_origins', 'work_quantity_versions', 'work_current_quantity']) assert.equal(await count(table), 1);
    const origin = (await pool.query('SELECT id FROM work_quantity_origins WHERE work_id=$1', [id])).rows[0];
    await assert.rejects(pool.query('UPDATE work_quantity_origins SET source_ref=$2 WHERE id=$1', [origin.id, 'tamper']), /immutable quantity history/);
    await assert.rejects(pool.query('UPDATE work_quantity_versions SET quantity=0 WHERE work_id=$1', [id]), /immutable quantity history/);
    await assert.rejects(pool.query('DELETE FROM work_quantity_versions WHERE work_id=$1', [id]), /immutable quantity history/);
});

test('legacy Work has observed current and unknown original; object/tenant isolation and pointer FK are enforced', async () => {
    const id = (await pool.query(`INSERT INTO works(tenant_id,object_id,work_type_id,name,unit,planned_quantity)
        VALUES($1,$2,$3,'legacy fixture','м²',42.1250) RETURNING id`, [p.pm.tenantId, p.object.id, p.plaster.id])).rows[0].id;
    await h.as(p.pm);
    const legacy = await h.req(path(p.object.id, id));
    assert.equal(legacy.originalQuantity, null);
    assert.equal(legacy.originalProvenance, 'UNKNOWN_LEGACY');
    assert.equal(legacy.currentQuantity, '42.1250');
    assert.equal(legacy.currentProvenance, 'OBSERVED_LEGACY');
    assert.equal(legacy.currentVersionId, null);
    assert.equal(legacy.factQuantity, '0.0000');
    assert.equal((await h.raw(path(p.neighbour.id, id))).status, 404);
    await h.as(p.other);
    assert.equal((await h.raw(path(p.object.id, id))).status, 404);
    await assert.rejects(pool.query(`INSERT INTO work_quantity_origins(tenant_id,object_id,work_id,source_kind,provenance_status,unit,created_by)
        VALUES($1,$2,$3,'LEGACY_UNVERIFIED','UNKNOWN_LEGACY','м²',$4)`, [p.pm.tenantId, p.neighbour.id, id, p.pm.id]), /foreign key|violates/);
    const foreignVersion = (await pool.query('SELECT id FROM work_quantity_versions WHERE work_id=$1', [p.neighbourWork.work.id])).rows[0].id;
    await assert.rejects(pool.query(`UPDATE work_current_quantity SET approved_version_id=$1 WHERE tenant_id=$2 AND object_id=$3 AND work_id=$4`,
        [foreignVersion, p.pm.tenantId, p.object.id, p.plasterWork.work.id]), /foreign key|violates/);
});

test('pure read shape distinguishes zero, unknown and integrity conflict without clamping', () => {
    const input = { workId: 'w', objectId: 'o', origin: null, observedQuantity: null, observedUnit: 'м²',
        pointer: { id: 'v', sequence: 1, quantity: '0', unit: 'м²' }, factQuantity: '0', factState: 'RESOLVED', factSourceMode: 'LEGACY_WORK' };
    const zero = shapeQuantityRead(input);
    assert.equal(zero.currentQuantity, '0.0000'); assert.equal(zero.integrityState, 'NOT_APPLICABLE');
    assert.equal(shapeQuantityRead({ ...input, factQuantity: null }).integrityState, 'UNKNOWN');
    assert.equal(shapeQuantityRead({ ...input, factQuantity: '0.0001' }).integrityState, 'INTEGRITY_CONFLICT');
});
