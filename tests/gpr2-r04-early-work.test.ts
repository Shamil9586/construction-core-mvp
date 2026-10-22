import './helpers/gpr2-isolation';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { gprHarness, pilotScenario, type Harness, type Pilot } from './helpers/gpr-fixtures';
import { destructiveStatements } from '../scripts/migration-runner';
import { buildW01ViewModel } from '../apps/frontend/src/view-models/w01';
import { buildC01ViewModel } from '../apps/frontend/src/view-models/c01';
import { validateSnapshot } from '../apps/frontend/src/data/validateSnapshot';
import { buildO01ViewModel } from '../apps/frontend/src/view-models/o01';
import { foreignTenantObject } from './helpers/gpr2-fixtures';
import { recordEvidence } from './helpers/gpr2-native-pg';
let h: Harness, p: Pilot, work: any, pool: any;
const protectedBefore: Record<string, { id: string; digest: string }[]> = {};
const protectedTables = ['work_progress','portion_quantity_confirmations','documentation_document_versions','documentation_customer_acceptances','financial_closings','sdo_closing_status_history'];
const key = randomUUID();
let input: any;
before(async () => {
    h = await gprHarness('r04-isolated'); p = await pilotScenario(h);
    ({ pool } = await import('../apps/backend/src/db'));
    for (const table of protectedTables) protectedBefore[table] = (await pool.query(`SELECT id,md5(row_to_json(t)::text) AS digest FROM ${table} t ORDER BY id`)).rows;
    await h.as(p.pm);
    input = { objectId: p.object.id, workTypeId: p.plaster.id, name: 'Ранняя работа', unit: 'м²', plannedQuantity: '100.0000', idempotencyKey: key };
});
after(async () => {
    try {
        if (pool) {
            const verified: Record<string, unknown> = {};
            for (const table of protectedTables) {
                const old = protectedBefore[table] ?? [];
                const after = (await pool.query(`SELECT id,md5(row_to_json(t)::text) AS digest FROM ${table} t WHERE id=ANY($1::uuid[]) ORDER BY id`, [old.map(x=>x.id)])).rows;
                assert.deepEqual(after,old,table + ': existing evidence rows must not change');
                verified[table]={preservedRows:old.length,idsAndDigests:after};
            }
            recordEvidence('r04-existing-history-preservation',{candidate:process.env.R04_CANDIDATE_SHA,mode:'PGlite',productionCredentialsUsed:false,tables:verified});
        }
    } finally { await h?.close(); await pool?.end(); }
});

test('R04 migration expand exemption rejects destructive tails and combined changes', () => {
    assert.deepEqual(destructiveStatements('ALTER TABLE works ALTER COLUMN estimated_cost DROP NOT NULL;'), []);
    for (const sql of [
        'ALTER TABLE works ALTER COLUMN estimated_cost DROP NOT NULL, DROP COLUMN id;',
        'ALTER TABLE works ALTER COLUMN estimated_cost DROP NOT NULL; DROP TABLE works;',
        'ALTER TABLE works ALTER COLUMN estimated_cost SET NOT NULL;',
        'ALTER TABLE works DROP COLUMN estimated_cost;',
        'ALTER TABLE works ALTER COLUMN estimated_cost DROP NOT NULL; UPDATE works SET actual_quantity=0;'
    ]) assert.ok(destructiveStatements(sql).length, sql);
});
test('R04-A create NULL planning fields; retry one ID, no fabricated defaults or planning clone', async () => {
    work = await h.req('works', input);
    for (const f of ['contractorId','responsibleUserId','estimatedCost','plannedStartDate','plannedFinishDate']) assert.equal(work[f], null, f);
    assert.equal(work.status, 'PLANNED');
    const retry = await h.req('works', input); assert.equal(retry.id, work.id);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM works WHERE id=$1 OR (object_id=$2 AND name=$3)', [work.id,p.object.id,input.name])).rows[0].n, 1);
    const changed = await h.raw('works', { ...input, name: 'Изменённый payload' }); assert.equal(changed.status, 409);
});
test('R04-B/E/J full read survives NULL; weighted object KPI and money projection unknown; C01/O01/W01 safe', async () => {
    const snap = await h.req('snapshot'); validateSnapshot(snap);
    const w = snap.works.find((x: any) => x.id === work.id), o = snap.objects.find((x: any) => x.id === p.object.id);
    assert.ok(w); assert.equal(w.contractor, 'Не назначен'); assert.equal(w.financial.potential, null);
    assert.equal(w.scheduleStatus, 'GRAY'); assert.equal(w.plannedProgress, null); assert.equal(w.delayDays, 0);
    assert.equal(o.actualProgress, null); assert.equal(o.potential, null); assert.equal(snap.dashboard.potentialClosing, null);
    assert.equal(w.productionEligibility.state, 'MISSING_ASSIGNMENTS');
    assert.equal((await h.req('works/' + work.id)).id, work.id);
    assert.doesNotThrow(() => buildW01ViewModel(w, o));
    assert.doesNotThrow(() => buildC01ViewModel(snap.objects, snap.works));
    assert.doesNotThrow(() => buildO01ViewModel(o, snap.works));
    await h.req(`objects/${p.object.id}/schedule/draft`, {});
    const schedule = await h.req(`objects/${p.object.id}/schedule`);
    const scope = schedule.availableScopes.find((x: any) => x.objectWorkId === work.id);
    assert.ok(scope); assert.equal(scope.suggestedStart, null); assert.equal(scope.suggestedFinish, null);
    assert.equal((await h.req(`works/${work.id}/schedule`)).hasBaseline, false);
});
test('R04-C fact and start blocked before assignments; no progress/history written', async () => {
    const transition = await h.req(`works/${work.id}/transition`);
    assert.equal(transition.allowed, false); assert.equal(transition.reasons.length, 2);
    assert.equal((await h.raw(`works/${work.id}/progress`, { totalQuantity:'20', version:work.version, comment:'нет допуска' })).status, 400);
    assert.equal((await h.raw(`works/${work.id}/start`, { version:work.version })).status, 400);
    assert.equal((await h.req(`works/${work.id}/progress`)).length, 0);
});
test('R04-G wrong object and denied role cannot create/complete; replay rechecks current authority', async () => {
    await h.as(p.other);
    assert.equal((await h.raw('works', input)).status, 403);
    assert.equal((await h.raw(`works/${work.id}/complete-planning`, { responsibleUserId:p.other.id,version:work.version,idempotencyKey:randomUUID() })).status, 403);
    await h.login('PTO'); assert.equal((await h.raw('works', input)).status, 403);
    await h.as(p.pm);
    const key2 = randomUUID(), body = { responsibleUserId:p.pm.id, version:work.version, idempotencyKey:key2 };
    work = await h.req(`works/${work.id}/complete-planning`, body);
    const replay = await h.req(`works/${work.id}/complete-planning`, body); assert.equal(replay.id,work.id); assert.equal(replay.version,work.version);
    // Own-object access is checked before a stored successful replay.
    await pool.query('UPDATE objects SET project_manager_id=$1 WHERE id=$2',[p.other.id,p.object.id]);
    assert.equal((await h.raw(`works/${work.id}/complete-planning`, body)).status,403);
    await pool.query('UPDATE objects SET project_manager_id=$1 WHERE id=$2',[p.pm.id,p.object.id]);
});
test('R04-F/I rollback stale version; fill only missing; schema rerun no-op', async () => {
    const n = await pool.query('SELECT count(*)::int AS n FROM gpr2_command_ledger');
    assert.equal((await h.raw(`works/${work.id}/complete-planning`, { estimatedCost:'0',version:1,idempotencyKey:randomUUID() })).status,409);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM gpr2_command_ledger')).rows[0].n,n.rows[0].n);
    assert.equal((await h.raw(`works/${work.id}/complete-planning`, { responsibleUserId:p.other.id,version:work.version,idempotencyKey:randomUUID() })).status,400);
    const { migrate } = await import('../scripts/migrate');
    assert.equal((await migrate()).applied.length,0);
});
test('R04-C same Work can produce after assignments without cost or provisional dates; history preserved', async () => {
    const id=work.id;
    work = await h.req(`works/${id}/complete-planning`, { contractorId:p.contractors[0].id, version:work.version,idempotencyKey:randomUUID() });
    assert.equal(work.id,id); assert.equal(work.estimatedCost,null); assert.equal(work.plannedStartDate,null);
    assert.equal((await h.req(`works/${id}/transition`)).allowed,true);
    await h.req(`works/${id}/progress`, { totalQuantity:'20',version:work.version,comment:'Первый факт после назначения' });
    const history=await h.req(`works/${id}/progress`); assert.equal(history.length,1); assert.equal(history[0].totalQuantity,'20.0000');
    const snap=await h.req('snapshot'), w=snap.works.find((x:any)=>x.id===id);
    assert.equal(w.actualQuantity,'20.0000'); assert.equal(w.actualProgress,20); assert.equal(w.financial.potential,null);
    assert.equal(w.scheduleStatus,'GRAY'); assert.equal(w.factSourceMode,'LEGACY_WORK');
    const counts=await pool.query('SELECT count(*)::int AS n FROM work_progress WHERE object_work_id=$1',[id]);
    await h.req(`works/${id}/complete-planning`, { estimatedCost:'0',version:w.version,idempotencyKey:randomUUID() });
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM work_progress WHERE object_work_id=$1',[id])).rows[0].n,counts.rows[0].n);
});

test('R04-G foreign tenant responsible rejected atomically; revoked role cannot replay creation', async () => {
    const foreign = await foreignTenantObject();
    const fresh = await h.req('works', { ...input, name:'Проверка границы',idempotencyKey:randomUUID() });
    const count = (await pool.query('SELECT count(*)::int AS n FROM gpr2_command_ledger')).rows[0].n;
    const bad = await h.raw(`works/${fresh.id}/complete-planning`,{ responsibleUserId:foreign.manager.id,version:fresh.version,idempotencyKey:randomUUID() });
    assert.equal(bad.status,400);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM gpr2_command_ledger')).rows[0].n,count);
    assert.equal((await pool.query('SELECT responsible_user_id FROM works WHERE id=$1',[fresh.id])).rows[0].responsible_user_id,null);
    await pool.query("UPDATE users SET role='PTO' WHERE id=$1",[p.pm.id]);
    try { assert.equal((await h.raw('works',input)).status,403); }
    finally { await pool.query("UPDATE users SET role='PROJECT_MANAGER' WHERE id=$1",[p.pm.id]); }
});
