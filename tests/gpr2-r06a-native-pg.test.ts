import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createIsolatedDatabase, scrubConnectionEnvironment } from './helpers/gpr2-native-pg';

// Refuse an inherited database URL; the helper admits only the marked loopback disposable cluster.
scrubConnectionEnvironment();

test('R06a 036 native upgrade, initial identity, immutable history and object-scoped honest read', async () => {
    const db = await createIsolatedDatabase('r06a');
    process.env.DATABASE_URL = db.url;
    const { pool, one } = await import('../apps/backend/src/db');
    const { migrate } = await import('../scripts/migrate');
    const { seed } = await import('../scripts/seed');
    const { ProductionService } = await import('../apps/backend/src/service');
    const { readWorkQuantity } = await import('../apps/backend/src/gpr2-r06a-quantity');
    try {
        await migrate({ through: 35 }); await seed();
        const digest = async () => (await pool.query("SELECT md5(coalesce(string_agg(row_to_json(w)::text,'|' ORDER BY id),'')) AS digest FROM works w")).rows[0].digest;
        const before = await digest();
        await migrate();
        assert.equal(await digest(), before, '036 rewrites no historical Work row');
        assert.equal((await migrate()).applied.length, 0, 'restart is a no-op');
        const pm = await one(pool, "SELECT * FROM users WHERE role='PROJECT_MANAGER' AND is_active=true ORDER BY created_at LIMIT 1");
        const object = await one(pool, 'SELECT * FROM objects WHERE project_manager_id=$1 LIMIT 1', [pm.id]);
        const type = await one(pool, 'SELECT * FROM work_types WHERE tenant_id=$1 LIMIT 1', [pm.tenantId]);
        const work = await new ProductionService().createWork(pm, { objectId: object.id, workTypeId: type.id, name: 'R06a native', unit: type.unit, plannedQuantity: '17.1250', idempotencyKey: randomUUID() });
        const read = await readWorkQuantity(pm, object.id, work.id);
        assert.equal(read.originalQuantity, '17.1250');
        assert.equal(read.currentQuantity, '17.1250');
        assert.equal(read.originalProvenance, 'PROVEN_CREATION');
        assert.equal(read.currentSequence, 1);
        assert.equal(read.factQuantity, '0.0000');
        assert.equal(read.baselineQuantity, null);
        const origins = (await pool.query('SELECT id FROM work_quantity_origins WHERE work_id=$1', [work.id])).rows;
        assert.equal(origins.length, 1);
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM work_quantity_versions WHERE work_id=$1', [work.id])).rows[0].n, 1);
        await assert.rejects(pool.query('UPDATE work_quantity_origins SET source_ref=$2 WHERE id=$1', [origins[0].id, 'tamper']), /immutable quantity history/);
        await assert.rejects(pool.query('DELETE FROM work_quantity_versions WHERE work_id=$1', [work.id]), /immutable quantity history/);
        const legacy = (await pool.query(`INSERT INTO works(tenant_id,object_id,work_type_id,name,unit,planned_quantity)
            VALUES($1,$2,$3,'R06a existing fixture',$4,9.5000) RETURNING id`, [pm.tenantId, object.id, type.id, type.unit])).rows[0];
        const observed = await readWorkQuantity(pm, object.id, legacy.id);
        assert.equal(observed.originalQuantity, null);
        assert.equal(observed.originalProvenance, 'UNKNOWN_LEGACY');
        assert.equal(observed.currentQuantity, '9.5000');
        assert.equal(observed.currentProvenance, 'OBSERVED_LEGACY');
        assert.equal(observed.currentVersionId, null);
        await assert.rejects(pool.query(`INSERT INTO work_quantity_origins(tenant_id,object_id,work_id,source_kind,provenance_status,original_quantity,unit,created_by)
            VALUES($1,$2,$3,'MANUAL_CREATE','PROVEN_CREATION',8,$4,$5)`, [pm.tenantId, object.id, legacy.id, type.unit, pm.id]), /proven creation must match/);
        const otherObject = (await pool.query('SELECT id FROM objects WHERE id<>$1 LIMIT 1', [object.id])).rows[0];
        if (otherObject) {
            await assert.rejects(pool.query(`INSERT INTO work_quantity_origins(tenant_id,object_id,work_id,source_kind,provenance_status,unit,created_by)
                VALUES($1,$2,$3,'LEGACY_UNVERIFIED','UNKNOWN_LEGACY',$4,$5)`, [pm.tenantId, otherObject.id, legacy.id, type.unit, pm.id]), /foreign key/);
            await assert.rejects(readWorkQuantity(pm, otherObject.id, work.id));
        }
    } finally { await pool.end(); await db.drop(); }
});
