import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createIsolatedDatabase, recordEvidence, scrubConnectionEnvironment, Session, waitUntilBlocked, until, settle } from './helpers/gpr2-native-pg';

scrubConnectionEnvironment();
test('R06b 037 native upgrade, direct SQL caps and two-session Work cap serialization', async () => {
    const db = await createIsolatedDatabase('r06b');
    process.env.DATABASE_URL = db.url;
    const { pool, one } = await import('../apps/backend/src/db');
    const { migrate } = await import('../scripts/migrate');
    const { seed } = await import('../scripts/seed');
    const { ProductionService } = await import('../apps/backend/src/service');
    const observer = await Session.open(db.url,'r06b-observer');
    let a: Session | undefined, b: Session | undefined;
    try {
        await migrate({ through: 36 }); await seed();
        const before = (await pool.query("SELECT md5(coalesce(string_agg(row_to_json(w)::text,'|' ORDER BY id),'')) AS d FROM works w")).rows[0].d;
        await migrate();
        assert.equal((await pool.query("SELECT md5(coalesce(string_agg(row_to_json(w)::text,'|' ORDER BY id),'')) AS d FROM works w")).rows[0].d,before);
        assert.equal((await migrate()).applied.length,0);
        const pm = await one(pool,"SELECT * FROM users WHERE role='PROJECT_MANAGER' AND is_active=true LIMIT 1");
        const object = await one(pool,'SELECT * FROM objects WHERE project_manager_id=$1 LIMIT 1',[pm.id]);
        const type = await one(pool,'SELECT * FROM work_types WHERE tenant_id=$1 LIMIT 1',[pm.tenantId]);
        const contractor = await one(pool,'SELECT * FROM object_contractors_active WHERE tenant_id=$1 AND object_id=$2 LIMIT 1',[pm.tenantId,object.id]);
        const work = await new ProductionService().createWork(pm,{objectId:object.id,workTypeId:type.id,
            contractorId:contractor.contractorId,responsibleUserId:pm.id,name:'R06b cap',unit:type.unit,plannedQuantity:'10',
            plannedStartDate:'2026-03-01',plannedFinishDate:'2026-04-30',estimatedCost:'1000.00',idempotencyKey:randomUUID()});
        a = await Session.open(db.url,'r06b-first'); b = await Session.open(db.url,'r06b-second');
        const insertUnit = (s: Session, quantity: string) => s.query(`INSERT INTO work_execution_units(tenant_id,object_work_id,work_type_id,contractor_id,unit,planned_quantity)
            VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,[pm.tenantId,work.id,type.id,contractor.contractorId,type.unit,quantity]);
        await a.begin(); const first = (await insertUnit(a,'6')).rows[0].id;
        await b.begin(); const contender = settle(insertUnit(b,'6'));
        await waitUntilBlocked(observer.client,b.pid,'second WEU insertion against same Work cap');
        await a.commit();
        const exceeded = await contender;
        assert.equal(exceeded.ok,false);
        if (!exceeded.ok) assert.match(String(exceeded.error),/Work planned WEU cap exceeded/);
        await b.rollback();
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM work_execution_units WHERE object_work_id=$1',[work.id])).rows[0].n,1);
        const portion = (await pool.query(`INSERT INTO quantity_portions(tenant_id,execution_unit_id,label,planned_quantity)
            VALUES($1,$2,'part',4) RETURNING id`,[pm.tenantId,first])).rows[0].id;
        await assert.rejects(pool.query(`INSERT INTO quantity_portions(tenant_id,execution_unit_id,label,planned_quantity)
            VALUES($1,$2,'invalid',3)`,[pm.tenantId,first]),/WEU planned portion cap exceeded/);
        const { replaceWorkAllocation } = await import('../apps/backend/src/gpr2-r06b-allocation');
        const { session, hash } = await import('../apps/backend/src/security');
        const login = await session(pm);
        const good = await replaceWorkAllocation(pm,object.id,work.id,{expectedVersionId:null,units:[
            {executionUnitId:first,quantity:'6',portions:[{portionId:portion,quantity:'4'}]}]},hash(login.token));
        assert.equal(good.unallocatedQuantity,'4.0000');
        const blocker = await Session.open(db.url,'r06b-work-blocker');
        await blocker.begin();
        await blocker.query('SELECT id FROM works WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[pm.tenantId,work.id]);
        // Attach both resolution paths before unlocking the Work. The command
        // may reject immediately after release, before the later assertion.
        const pending = settle(replaceWorkAllocation(pm,object.id,work.id,{expectedVersionId:good.versionId,units:[]},hash(login.token)));
        try {
            await until(async () => (await observer.query(`SELECT count(*)::int AS n FROM pg_stat_activity
                WHERE wait_event_type='Lock' AND query LIKE 'SELECT * FROM works WHERE tenant_id=%FOR UPDATE'`)).rows[0].n>0,
                'R06b allocation blocked behind Work lock');
            await pool.query("UPDATE users SET role='GENERAL_DIRECTOR' WHERE tenant_id=$1 AND id=$2",[pm.tenantId,pm.id]);
        } finally { await blocker.rollback(); await blocker.close(); }
        const revoked = await pending;
        assert.equal(revoked.ok,false);
        if (!revoked.ok) assert.match(String(revoked.error),/Недостаточно прав/);
        await pool.query("UPDATE users SET role='PROJECT_MANAGER' WHERE tenant_id=$1 AND id=$2",[pm.tenantId,pm.id]);
        const pointer = (await pool.query('SELECT version_id FROM work_current_allocation WHERE work_id=$1',[work.id])).rows[0].version_id;
        await assert.rejects(pool.query(`INSERT INTO work_allocation_lines(tenant_id,object_id,work_id,version_id,execution_unit_id,quantity,unit)
            VALUES($1,$2,$3,$4,$5,99,$6)`,[pm.tenantId,object.id,work.id,pointer,first,type.unit]),/duplicate key|allocation cap/);
        await pool.query(`INSERT INTO portion_quantity_confirmations(tenant_id,portion_id,source,quantity,recorded_by)
            VALUES($1,$2,'INTERNAL_SC',2,$3)`,[pm.tenantId,portion,pm.id]);
        const d = await pool.connect();
        try {
            await d.query('BEGIN');
            const next = (await d.query(`INSERT INTO work_allocation_versions(tenant_id,object_id,work_id,sequence,previous_id,quantity_version_id,unit,created_by)
                SELECT $1,$2,$3,2,$4,approved_version_id,$5,$6 FROM work_current_quantity WHERE tenant_id=$1 AND object_id=$2 AND work_id=$3 RETURNING id`,
                [pm.tenantId,object.id,work.id,pointer,type.unit,pm.id])).rows[0].id;
            await d.query('UPDATE work_current_allocation SET version_id=$1 WHERE tenant_id=$2 AND object_id=$3 AND work_id=$4',
                [next,pm.tenantId,object.id,work.id]);
            await assert.rejects(d.query('COMMIT'),/allocation is frozen after confirmed evidence/);
        } finally { await d.query('ROLLBACK').catch(() => undefined); d.release(); }
        assert.equal((await pool.query('SELECT version_id FROM work_current_allocation WHERE work_id=$1',[work.id])).rows[0].version_id,pointer);
        recordEvidence('r06b-native-summary',{cluster:db.evidence,upgradePreservedWorks:true,restartNoOp:true,concurrentSecondBlocked:true,
            concurrentSecondRolledBack:true,revocationBeforeWorkLockWon:true,protectedFactDirectPointerBlocked:true,workUnits:1,explicitAllocated:good.allocatedQuantity});
    } finally {
        await a?.rollback().catch(() => undefined); await b?.rollback().catch(() => undefined);
        await a?.close(); await b?.close(); await observer.close(); await pool.end(); await db.drop();
    }
});
