import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createIsolatedDatabase, scrubConnectionEnvironment, Session, until, recordEvidence } from './helpers/gpr2-native-pg';

// Refuses to guess a cluster; never uses LIVE or an inherited DATABASE_URL.
scrubConnectionEnvironment();
test('R04 native upgrade/restart + real planning/fact coordination and lost-response retry', async t => {
    const db = await createIsolatedDatabase('r04');
    process.env.DATABASE_URL = db.url;
    const { coordinationKey } = await import('../apps/backend/src/coordination-lock');
    const { pool, one } = await import('../apps/backend/src/db');
    const { migrate } = await import('../scripts/migrate');
    const { seed } = await import('../scripts/seed');
    const { ProductionService } = await import('../apps/backend/src/service');
    const service = new ProductionService();
    const observer = await Session.open(db.url, 'r04-observer');
    try {
        await migrate({ through: 27 }); await seed();
        const digest = async () => (await pool.query("SELECT md5(string_agg(row_to_json(w)::text, '' ORDER BY id)) AS d FROM works w")).rows[0].d;
        const before = await digest(); await migrate(); assert.equal(await digest(), before, '028 rewrites no historical Work row');
        assert.equal((await migrate()).applied.length,0);
        const pm = await one(pool,"SELECT * FROM users WHERE role='PROJECT_MANAGER' AND is_active=true ORDER BY created_at LIMIT 1");
        const object = await one(pool,'SELECT * FROM objects WHERE project_manager_id=$1 LIMIT 1',[pm.id]);
        const type = await one(pool,'SELECT * FROM work_types WHERE tenant_id=$1 LIMIT 1',[pm.tenantId]);
        const assigned = await one(pool,'SELECT * FROM object_contractors_active WHERE tenant_id=$1 AND object_id=$2 LIMIT 1',[pm.tenantId,object.id]);
        const work = await service.createWork(pm,{objectId:object.id,workTypeId:type.id,name:'Native Early Work',unit:type.unit,plannedQuantity:'100',idempotencyKey:randomUUID()});
        assert.equal(work.contractorId,null); assert.equal(work.plannedStartDate,null);
        const blocker = await Session.open(db.url,'r04-shared-blocker');
        await blocker.begin();
        const key=coordinationKey(pm.tenantId,object.id);
        await blocker.query('SELECT pg_advisory_xact_lock_shared($1::bigint)',[key.toString()]);
        const body={contractorId:assigned.contractorId,responsibleUserId:pm.id,version:work.version,idempotencyKey:randomUUID()};
        let completed=false;
        const pending=service.completeWorkPlanning(pm,work.id,body).then(x=>{completed=true;return x;});
        try {
            await until(async()=> (await observer.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND mode='ExclusiveLock' AND NOT granted")).rows[0].n>0,'R04 completion EXCLUSIVE waiting behind shared writer');
            assert.equal(completed,false);
            recordEvidence('r04-planning-blocked',{cluster:db.evidence,blocked:true,sourceModeChanged:false});
        } finally { await blocker.rollback(); await blocker.close(); }
        const completedWork=await pending;
        const retry=await service.completeWorkPlanning(pm,work.id,body); assert.equal(retry.id,work.id);assert.equal(retry.version,completedWork.version);
        await service.progress(pm,work.id,{totalQuantity:'20',version:completedWork.version,comment:'native proof'});
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM work_progress WHERE object_work_id=$1',[work.id])).rows[0].n,1);
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM gpr2_command_ledger WHERE scope_id=$1',[work.id])).rows[0].n,1);
        const latest=await one(pool,'SELECT * FROM works WHERE id=$1',[work.id]);
        const concurrent={estimatedCost:'0.00',version:latest.version,idempotencyKey:randomUUID()};
        const both=await Promise.all([service.completeWorkPlanning(pm,work.id,concurrent),service.completeWorkPlanning(pm,work.id,concurrent)]);
        assert.equal(both[0].version,both[1].version);assert.equal(both[0].id,both[1].id);
        recordEvidence('r04-native-summary',{cluster:db.evidence,upgradePreservedRows:true,restartNoOp:true,barrierObserved:true,retryOneEffect:true,progressRows:1});
    } finally { await observer.close();await pool.end();await db.drop(); }
});
