import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createIsolatedDatabase, scrubConnectionEnvironment, Session, until, advisoryHolders, recordEvidence } from './helpers/gpr2-native-pg';
import { DEPENDENCY_STARTED_MESSAGE } from '../packages/domain/dependency-guard';

// R04 CP02 on a real server: the first portion fact and a new dependency in front of the same Work, in both orders. PGlite has one
// connection and cannot show either wait. Refuses to guess a cluster; never uses LIVE or an inherited DATABASE_URL.
scrubConnectionEnvironment();
test('R04 CP02 native: first portion fact <-> dependency addition serialise; exactly one wins, nothing partial', async () => {
    const db = await createIsolatedDatabase('r04cp02');
    process.env.DATABASE_URL = db.url;
    const { coordinationKey } = await import('../apps/backend/src/coordination-lock');
    const { pool, one } = await import('../apps/backend/src/db');
    const { migrate } = await import('../scripts/migrate');
    const { seed } = await import('../scripts/seed');
    const { ProductionService } = await import('../apps/backend/src/service');
    const service = new ProductionService();
    const observer = await Session.open(db.url, 'r04cp02-observer');
    const count = async (sql: string, args: any[]) => (await pool.query(sql, args)).rows[0].n as number;
    try {
        await migrate(); await seed();
        const pm = await one(pool, "SELECT * FROM users WHERE role='PROJECT_MANAGER' AND is_active=true ORDER BY created_at LIMIT 1");
        const object = await one(pool, 'SELECT * FROM objects WHERE project_manager_id=$1 LIMIT 1', [pm.id]);
        const type = await one(pool, 'SELECT * FROM work_types WHERE tenant_id=$1 LIMIT 1', [pm.tenantId]);
        const assigned = await one(pool, 'SELECT * FROM object_contractors_active WHERE tenant_id=$1 AND object_id=$2 LIMIT 1', [pm.tenantId, object.id]);
        const key = coordinationKey(pm.tenantId, object.id);
        const isolation = (await one(pool, "SELECT current_setting('transaction_isolation') AS v")).v;
        assert.equal(isolation, 'read committed', 'P1B-L1: the writers run READ COMMITTED');
        let n = 0;
        const mkWork = (name: string) => service.createWork(pm, { objectId: object.id, workTypeId: type.id, contractorId: assigned.contractorId, responsibleUserId: pm.id, name: name + ' ' + (++n), unit: type.unit, plannedQuantity: '500', plannedStartDate: '2026-03-01', plannedFinishDate: '2026-04-30', estimatedCost: '1000' });
        const pair = async () => {
            const predecessor = await mkWork('CP02 предшествующая'), successor = await mkWork('CP02 последующая');
            const unit = await service.createExecutionUnit(pm, { objectWorkId: successor.id, workTypeId: type.id, contractorId: assigned.contractorId, unit: type.unit, plannedQuantity: '500', location: 'Зона ' + n });
            const portion = await service.createQuantityPortion(pm, unit.id, { label: 'Участок ' + n, plannedQuantity: '500' });
            return { predecessor, successor, portion };
        };
        const fact = (portion: any) => service.recordPortionFact(pm, portion.id, { quantity: '500', version: portion.version, comment: 'native CP02', idempotencyKey: randomUUID() });
        const link = (x: { predecessor: any; successor: any }) => service.dependency(pm, { predecessorWorkId: x.predecessor.id, successorWorkId: x.successor.id, requiresAcceptance: false });
        const state = async (x: { successor: any; portion: any }) => ({
            dependencies: await count('SELECT count(*)::int AS n FROM work_dependencies WHERE successor_work_id=$1', [x.successor.id]),
            dependencyAudit: await count("SELECT count(*)::int AS n FROM audit_logs WHERE entity_id=$1 AND action='DEPENDENCY'", [x.successor.id]),
            rpFacts: await count("SELECT count(*)::int AS n FROM portion_quantity_confirmations WHERE portion_id=$1 AND source='RP_FACT'", [x.portion.id]),
            factCommands: await count("SELECT count(*)::int AS n FROM idempotent_commands WHERE operation='PORTION_FACT' AND scope_id=$1", [x.portion.id]),
            legacy: (await one(pool, 'SELECT actual_quantity AS q,status FROM works WHERE id=$1', [x.successor.id]))
        });
        const settledLater = <T>(p: Promise<T>) => { const s = { done: false }; p.then(() => (s.done = true), () => (s.done = true)); return s; };
        const waitingBehind = (pid: number) => until(async () => (await observer.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])).rows[0].n > 0, 'a writer blocked behind the barrier session');

        // Order A: the fact writer is in flight (SHARED held, paused on the portion row) when the dependency arrives (EXCLUSIVE waits).
        const a = await pair();
        const barrierA = await Session.open(db.url, 'r04cp02-barrier-a');
        await barrierA.begin();
        await barrierA.query('SELECT id FROM quantity_portions WHERE id=$1 FOR UPDATE', [a.portion.id]);
        const factA = fact(a.portion); const factADone = settledLater(factA);
        await waitingBehind(barrierA.pid);
        assert.ok((await advisoryHolders(observer.client, key)).some(h => h.mode === 'ShareLock' && h.granted), 'fact writer holds SHARED');
        const linkA = link(a); const linkADone = settledLater(linkA);
        await until(async () => (await advisoryHolders(observer.client, key)).some(h => h.mode === 'ExclusiveLock' && !h.granted), 'dependency EXCLUSIVE waiting behind the fact writer');
        assert.equal(factADone.done || linkADone.done, false, 'both are still in flight at the barrier');
        await barrierA.rollback(); await barrierA.close();
        const factAResult = await factA;
        await assert.rejects(linkA, (e: any) => e?.response?.message === DEPENDENCY_STARTED_MESSAGE || e?.message === DEPENDENCY_STARTED_MESSAGE);
        const afterA = await state(a);
        assert.deepEqual({ ...afterA, legacy: undefined }, { dependencies: 0, dependencyAudit: 0, rpFacts: 1, factCommands: 1, legacy: undefined });
        assert.equal(Number(afterA.legacy.q), 0, 'legacy column still 0 — the guard saw the portion fact, not this column');
        assert.equal(afterA.legacy.status, 'PLANNED');

        // Order B: the dependency holds EXCLUSIVE (paused on the object row) when the first fact arrives (SHARED waits) — the fact is then refused.
        const b = await pair();
        const barrierB = await Session.open(db.url, 'r04cp02-barrier-b');
        await barrierB.begin();
        await barrierB.query('SELECT id FROM objects WHERE id=$1 FOR UPDATE', [object.id]);
        const linkB = link(b); const linkBDone = settledLater(linkB);
        await waitingBehind(barrierB.pid);
        assert.ok((await advisoryHolders(observer.client, key)).some(h => h.mode === 'ExclusiveLock' && h.granted), 'dependency holds EXCLUSIVE');
        const factB = fact(b.portion); const factBDone = settledLater(factB);
        await until(async () => (await advisoryHolders(observer.client, key)).some(h => h.mode === 'ShareLock' && !h.granted), 'fact writer SHARED waiting behind the dependency');
        assert.equal(linkBDone.done || factBDone.done, false);
        await barrierB.rollback(); await barrierB.close();
        const linkBResult = await linkB;
        await assert.rejects(factB, (e: any) => /не завершена/.test(e?.response?.message ?? e?.message ?? ''));
        assert.deepEqual({ ...(await state(b)), legacy: undefined }, { dependencies: 1, dependencyAudit: 1, rpFacts: 0, factCommands: 0, legacy: undefined });

        // Unbarriered races: whichever commits first, exactly one of the two succeeds and the other leaves nothing behind.
        const rounds: { winner: string; state: any }[] = [];
        for (let i = 0; i < 8; i++) {
            const x = await pair();
            const [f, l] = await Promise.allSettled([fact(x.portion), link(x)]);
            assert.equal([f, l].filter(r => r.status === 'fulfilled').length, 1, 'round ' + i + ': exactly one wins: ' + JSON.stringify([f, l].map(r => r.status === 'rejected' ? String((r as any).reason?.message) : 'ok')));
            const s = await state(x);
            assert.equal(s.dependencies + s.rpFacts, 1, 'never both a dependency and a fact, never neither');
            assert.equal(s.dependencies, s.dependencyAudit);
            assert.equal(s.rpFacts, s.factCommands);
            rounds.push({ winner: f.status === 'fulfilled' ? 'FACT' : 'DEPENDENCY', state: { ...s, legacy: { q: String(s.legacy.q), status: s.legacy.status } } });
        }
        recordEvidence('r04-cp02-native-dependency-race', {
            cluster: db.evidence, isolation,
            orderA: { fact: factAResult.id, dependencyRefused: DEPENDENCY_STARTED_MESSAGE, state: { ...afterA, legacy: { q: String(afterA.legacy.q), status: afterA.legacy.status } } },
            orderB: { dependency: linkBResult.id, factRefused: true },
            unbarrieredRounds: rounds
        });
    } finally { await observer.close(); await pool.end(); await db.drop(); }
});
