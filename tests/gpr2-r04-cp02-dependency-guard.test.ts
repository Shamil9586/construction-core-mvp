import './helpers/gpr2-isolation';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { gprHarness, pilotScenario, reportFact, type Harness, type Pilot } from './helpers/gpr-fixtures';
import { dependencyAdditionVerdict, DEPENDENCY_FACT_UNKNOWN_MESSAGE, DEPENDENCY_STARTED_MESSAGE } from '../packages/domain/dependency-guard';
import type { ConfirmationRecord, WorkFactEvidence } from '../packages/domain/gpr2/fact-resolver';

// R04 CP02 — POST /work-dependencies decides "production has not started" from the R02 resolver, not from works.actual_quantity.
let h: Harness, p: Pilot, pool: any;
let seq = 0;
before(async () => {
    h = await gprHarness('r04-cp02'); p = await pilotScenario(h);
    ({ pool } = await import('../apps/backend/src/db'));
});
after(async () => { await h?.close(); await pool?.end(); });

const mkWork = async (name: string, unit = 'м²') => {
    await h.as(p.pm);
    return h.req('works', { objectId: p.object.id, workTypeId: p.plaster.id, contractorId: p.contractors[0].id, responsibleUserId: p.pm.id, name: name + ' ' + (++seq), unit, plannedQuantity: 100, plannedStartDate: '2026-03-01', plannedFinishDate: '2026-04-30', estimatedCost: '1000' });
};
const mkPortion = async (work: any) => {
    await h.as(p.pm);
    const u = await h.req('execution-units', { objectWorkId: work.id, workTypeId: p.plaster.id, contractorId: p.contractors[0].id, unit: work.unit, plannedQuantity: 100, location: 'Зона ' + (++seq) });
    return h.req(`execution-units/${u.id}/portions`, { label: 'Участок ' + seq, plannedQuantity: 100 });
};
const dep = (predecessor: any, successor: any) => h.raw('work-dependencies', { predecessorWorkId: predecessor.id, successorWorkId: successor.id, requiresAcceptance: false });
const persisted = async (successor: any) => ({
    dependencies: (await pool.query('SELECT count(*)::int AS n FROM work_dependencies WHERE successor_work_id=$1', [successor.id])).rows[0].n,
    audit: (await pool.query("SELECT count(*)::int AS n FROM audit_logs WHERE entity_id=$1 AND action='DEPENDENCY'", [successor.id])).rows[0].n
});
const refused = async (r: { status: number; data: any }, successor: any, message: string) => {
    assert.equal(r.status, 400, JSON.stringify(r.data));
    assert.equal(r.data.message, message);
    assert.deepEqual(await persisted(successor), { dependencies: 0, audit: 0 }, 'a refused dependency leaves no row and no audit record');
};

test('CP02-1 portion fact 500 with legacy actualQuantity 0 and status PLANNED: dependency refused', async () => {
    const predecessor = await mkWork('Предшествующая');
    const successor = p.plasterWork.work;
    await reportFact(h, p.pm, p.floor1.portion.id, 500);
    const row = (await pool.query('SELECT actual_quantity AS q,status FROM works WHERE id=$1', [successor.id])).rows[0];
    assert.equal(Number(row.q), 0, 'the defect premise: the legacy column still says 0');
    assert.equal(row.status, 'PLANNED', 'and the Work was never started through /start');
    await h.as(p.pm);
    const snap = await h.req('snapshot');
    assert.equal(Number(snap.works.find((w: any) => w.id === successor.id).actualQuantity), 500, 'the resolver reads the portion fact');
    await refused(await dep(predecessor, successor), successor, DEPENDENCY_STARTED_MESSAGE);
    await refused(await dep(predecessor, successor), successor, DEPENDENCY_STARTED_MESSAGE); // a retry is refused the same way
});

test('CP02-2 confirmed zero: no fact at all, and an RP fact of 0 reported per portion — dependency allowed', async () => {
    const predecessor = await mkWork('Предшествующая');
    const untouched = await mkWork('Без факта');
    await h.as(p.pm);
    assert.equal((await dep(predecessor, untouched)).status, 201);
    const zeroWork = await mkWork('Ноль по участку');
    const portion = await mkPortion(zeroWork);
    await reportFact(h, p.pm, portion.id, 0);
    await h.as(p.pm);
    assert.equal((await dep(predecessor, zeroWork)).status, 201);
    assert.deepEqual(await persisted(zeroWork), { dependencies: 1, audit: 1 });
});

test('CP02-3 UNKNOWN fact (unorderable RP tie) is not a confirmed zero: dependency refused', async () => {
    const predecessor = await mkWork('Предшествующая');
    const successor = await mkWork('Неизвестный факт');
    const portion = await mkPortion(successor);
    const at = '2026-09-01T10:00:00.000000Z';
    for (const q of ['0', '40'])
        await pool.query("INSERT INTO portion_quantity_confirmations(tenant_id,portion_id,source,quantity,recorded_by,recorded_at,created_at,confirmation_seq) VALUES($1,$2,'RP_FACT',$3,$4,$5::timestamptz,$5::timestamptz,NULL)", [p.pm.tenantId, portion.id, q, p.pm.id, at]);
    await h.as(p.pm);
    assert.equal((await h.req('snapshot')).works.find((w: any) => w.id === successor.id).factState, 'UNKNOWN_TIE');
    await refused(await dep(predecessor, successor), successor, DEPENDENCY_FACT_UNKNOWN_MESSAGE);
});

test('CP02-4 positive legacy fact refuses — through /progress (ACTIVE) and on a PLANNED row that carries it', async () => {
    const predecessor = await mkWork('Предшествующая');
    const progressed = await mkWork('Легаси факт');
    await h.as(p.pm);
    await h.req(`works/${progressed.id}/progress`, { totalQuantity: '10', version: progressed.version, comment: 'факт' });
    await refused(await dep(predecessor, progressed), progressed, DEPENDENCY_STARTED_MESSAGE);
    const plannedWithFact = await mkWork('Легаси факт без старта');
    await pool.query('UPDATE works SET actual_quantity=10 WHERE id=$1', [plannedWithFact.id]);
    await h.as(p.pm);
    await refused(await dep(predecessor, plannedWithFact), plannedWithFact, DEPENDENCY_STARTED_MESSAGE);
});

test('CP02-5 a positive portion fact in a unit the Work sum does not add in (legacy data) still counts as a start', async () => {
    const predecessor = await mkWork('Предшествующая');
    const successor = await mkWork('Другая единица');
    const portion = await mkPortion(successor);
    await reportFact(h, p.pm, portion.id, 5);
    // new units must match the Work's unit; a mismatching one exists only in pre-F8.1-04 data, so it is placed here directly
    await pool.query("UPDATE work_execution_units SET unit='м³' WHERE id=$1", [portion.executionUnitId]);
    await h.as(p.pm);
    const w = (await h.req('snapshot')).works.find((x: any) => x.id === successor.id);
    assert.equal(Number(w.actualQuantity), 0, 'the resolver keeps the incompatible unit out of the Work figure');
    await refused(await dep(predecessor, successor), successor, DEPENDENCY_STARTED_MESSAGE);
});

test('CP02-6 authorization, object scope and cycle checks stay in force; a refused caller learns nothing about the fact', async () => {
    const a = await mkWork('Цикл A'), b = await mkWork('Цикл B');
    await h.as(p.pm);
    assert.equal((await dep(a, b)).status, 201);
    const cycle = await dep(b, a);
    assert.equal(cycle.status, 400); assert.equal(cycle.data.message, 'Циклическая зависимость');
    const self = await dep(a, a);
    assert.equal(self.status, 400);
    const foreign = await dep(p.neighbourWork.work, a);
    assert.notEqual(foreign.status, 201, 'a predecessor in another object is never linked');
    const started = p.plasterWork.work; // carries the portion fact of CP02-1
    await h.as(p.other);
    assert.ok([403, 404].includes((await dep(a, started)).status), 'a PM without access to the object is refused before any fact guard');
    await h.login('PTO');
    assert.equal((await dep(a, started)).status, 403, 'no WORK_CREATE: refused before the fact is read');
    await h.login('CONTRACTOR_VIEWER');
    assert.equal((await dep(a, started)).status, 403);
    assert.deepEqual(await persisted(started), { dependencies: 0, audit: 0 });
});

test('CP02-7 the pure verdict over resolver evidence', () => {
    const rp = (id: string, quantity: string, at = '2026-09-01T10:00:00.000000Z', sequence: string | null = '1'): ConfirmationRecord => ({ id, portionId: 'p', source: 'RP_FACT', quantity, recordedAt: at, createdAt: at, sequence });
    const ev = (o: Partial<WorkFactEvidence> = {}, rpFacts: ConfirmationRecord[] = [], unit = 'м²'): WorkFactEvidence => ({ workId: 'w', workUnit: 'м²', createdAt: '2026-01-01T00:00:00.000000Z', persistedMode: 'LEGACY_WORK', modeHistory: [], legacyActualQuantity: '0', legacyProgress: [], units: rpFacts.length ? [{ id: 'u', unit, createdAt: '2026-01-01T00:00:00.000000Z', portions: [{ id: 'p', createdAt: '2026-01-01T00:00:00.000000Z', rpFacts }] }] : [], ...o });
    assert.deepEqual(dependencyAdditionVerdict({ status: 'PLANNED' }, ev()), { allowed: true, rule: null, message: null });
    assert.equal(dependencyAdditionVerdict({ status: 'ACTIVE' }, ev()).allowed, false);
    assert.equal(dependencyAdditionVerdict({ status: 'PLANNED' }, undefined).allowed, false, 'no evidence is not a zero');
    const v = (e: WorkFactEvidence) => { const r = dependencyAdditionVerdict({ status: 'PLANNED' }, e); return r.allowed ? 'ALLOWED' : r.rule; };
    assert.equal(v(ev({ persistedMode: 'PORTION' }, [rp('a', '500')])), 'PRODUCTION_STARTED', 'portion 500, legacy 0');
    assert.equal(v(ev({ persistedMode: null }, [rp('a', '500')])), 'PRODUCTION_STARTED', 'unclassified Work, portion 500');
    assert.equal(v(ev({ persistedMode: 'PORTION' }, [rp('a', '0')])), 'ALLOWED', 'a reported zero is a confirmed zero');
    assert.equal(v(ev({ persistedMode: 'PORTION' }, [rp('a', '0', undefined, null), rp('b', '7', undefined, null)])), 'FACT_UNKNOWN');
    assert.equal(v(ev({ persistedMode: 'LEGACY_WORK', legacyActualQuantity: '3' })), 'PRODUCTION_STARTED');
    assert.equal(v(ev({ persistedMode: null, legacyActualQuantity: '3' }, [rp('a', '0')])), 'PRODUCTION_STARTED', 'overlap: the legacy figure is not hidden by a portion 0');
    assert.equal(v(ev({ persistedMode: 'PORTION' }, [rp('a', '5')], 'м³')), 'PRODUCTION_STARTED', 'incompatible unit still proves a start');
    assert.equal(v(ev({ persistedMode: 'PORTION' }, [rp('a', '0', undefined, null), rp('b', '5', undefined, null)], 'м³')), 'FACT_UNKNOWN');
});
