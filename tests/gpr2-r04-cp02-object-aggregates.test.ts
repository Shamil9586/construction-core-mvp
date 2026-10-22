import './helpers/gpr2-isolation';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { gprHarness, pilotScenario, dt, type Harness, type Pilot } from './helpers/gpr-fixtures';

// R04 CP-02 / REG-01 — object percentages with Early Works. A cost-weighted percentage is null exactly when a weight (cost) is unknown, and the
// planned percentage also when a Work has no planned interval; otherwise the accepted pre-R04 formula applies unchanged (a dated Work nobody has
// reported on counts as it always did). Unknown is never turned into zero, and no money figure stands in for a missing weight.
let h: Harness, p: Pilot, pool: any;
let n = 0;
before(async () => {
    h = await gprHarness('r04-cp02-reg01'); p = await pilotScenario(h);
    ({ pool } = await import('../apps/backend/src/db'));
});
after(async () => { await h?.close(); await pool?.end(); });

const mkObject = async () => {
    await h.login('DEPUTY_DIRECTOR');
    const o = await h.req('objects', { externalCode: 'CP02-' + Date.now() + '-' + (++n), name: 'CP02 агрегаты ' + n, address: 'г. Тест, 1', organizationName: 'ООО Тест', projectManagerId: p.pm.id, startDate: dt(-90), plannedFinishDate: dt(90), contractValue: '1000000', contractorIds: [p.contractors[0].id] });
    await h.as(p.pm);
    return o;
};
const legacyWork = (objectId: string, cost: string, start: string, finish: string) =>
    h.req('works', { objectId, workTypeId: p.plaster.id, contractorId: p.contractors[0].id, responsibleUserId: p.pm.id, name: 'Работа ' + (++n), unit: 'м²', plannedQuantity: 100, plannedStartDate: start, plannedFinishDate: finish, estimatedCost: cost });
const earlyWork = (objectId: string, extra: Record<string, unknown> = {}) =>
    h.req('works', { objectId, workTypeId: p.plaster.id, name: 'Ранняя ' + (++n), unit: 'м²', plannedQuantity: '100', idempotencyKey: randomUUID(), ...extra });
const progress = (w: any, q: string) => h.req(`works/${w.id}/progress`, { totalQuantity: q, version: w.version, comment: 'факт' });
const snapshot = async (objectId: string) => { await h.as(p.pm); const s = await h.req('snapshot'); return { o: s.objects.find((x: any) => x.id === objectId), ws: s.works.filter((x: any) => x.objectId === objectId) }; };
/** The accepted pre-R04 formula, restated independently: cost-weighted, a missing per-Work figure counts as 0, equal weights when all costs are 0. */
const formula = (ws: any[], field: string) => { const c = ws.reduce((s, w) => s + Number(w.estimatedCost), 0); return c ? ws.reduce((s, w) => s + Number(w.estimatedCost) * (w[field] ?? 0), 0) / c : ws.reduce((s, w) => s + (w[field] ?? 0), 0) / ws.length; };

test('REG-01-a dated Works with known cost, one never reported: plannedProgress is stated (the R04 regression), by the pre-R04 formula', async () => {
    const o = await mkObject();
    const reported = await legacyWork(o.id, '1000', dt(-10), dt(10));
    await legacyWork(o.id, '3000', dt(-30), dt(-10)); // never reported: ScheduleStatusService gives it plannedProgress null (GRAY)
    await progress(reported, '20');
    const { o: obj, ws } = await snapshot(o.id);
    assert.ok(ws.some(w => w.plannedProgress === null), 'fixture: a dated Work whose per-Work plannedProgress is null');
    assert.equal(typeof obj.plannedProgress, 'number');
    assert.equal(obj.plannedProgress, formula(ws, 'plannedProgress'));
    assert.equal(obj.actualProgress, formula(ws, 'actualProgress'));
    assert.equal(obj.actualProgressKnownPart, formula(ws, 'actualProgress'));
});

test('REG-01-b known cost, UNKNOWN fact: actual is null with its known part beside it; the plan is still stated', async () => {
    const o = await mkObject();
    const known = await legacyWork(o.id, '1000', dt(-10), dt(10));
    await progress(known, '50');
    const unknown = await legacyWork(o.id, '1000', dt(-20), dt(20));
    const u = await h.req('execution-units', { objectWorkId: unknown.id, workTypeId: p.plaster.id, contractorId: p.contractors[0].id, unit: 'м²', plannedQuantity: 100, location: 'Зона ' + n });
    const portion = await h.req(`execution-units/${u.id}/portions`, { label: 'Участок ' + n, plannedQuantity: 100 });
    for (const q of ['10', '30'])
        await pool.query("INSERT INTO portion_quantity_confirmations(tenant_id,portion_id,source,quantity,recorded_by,recorded_at,created_at,confirmation_seq) VALUES($1,$2,'RP_FACT',$3,$4,'2026-09-01T10:00:00Z','2026-09-01T10:00:00Z',NULL)", [p.pm.tenantId, portion.id, q, p.pm.id]);
    const { o: obj, ws } = await snapshot(o.id);
    assert.equal(ws.find(w => w.id === unknown.id).factState, 'UNKNOWN_TIE');
    assert.equal(obj.unknownFactWorks, 1);
    assert.equal(obj.actualProgress, null, 'unknown fact: no object actual');
    assert.equal(obj.potential, null);
    assert.equal(obj.actualProgressKnownPart, formula(ws.filter(w => !w.factUnknown), 'actualProgress'));
    assert.equal(typeof obj.plannedProgress, 'number', 'the plan does not depend on the fact');
    assert.equal(obj.plannedProgress, formula(ws, 'plannedProgress'));
});

test('REG-01-c unknown cost (Early Work with dates, no cost): every cost-weighted percentage is null, money known part stays separate', async () => {
    const o = await mkObject();
    const known = await legacyWork(o.id, '1000', dt(-10), dt(10));
    await progress(known, '50');
    await earlyWork(o.id, { plannedStartDate: dt(-5), plannedFinishDate: dt(5) });
    const { o: obj } = await snapshot(o.id);
    assert.equal(obj.plannedProgress, null, 'weights unknown: no plan average');
    assert.equal(obj.actualProgress, null, 'weights unknown: no actual average');
    assert.equal(obj.actualProgressKnownPart, null, 'the known-fact part is still cost-weighted: weights unknown');
    assert.equal(obj.potential, null, 'an unknown contribution is never silently zero');
    assert.equal(typeof obj.potentialKnownPart, 'string', 'the known money part is shown separately (not a K01 figure)');
});

test('REG-01-d missing dates (Early Work with cost, no dates): plannedProgress null; the fact side is unaffected', async () => {
    const o = await mkObject();
    const known = await legacyWork(o.id, '1000', dt(-10), dt(10));
    await progress(known, '50');
    await earlyWork(o.id, { estimatedCost: '500' });
    const { o: obj, ws } = await snapshot(o.id);
    assert.equal(obj.plannedProgress, null, 'a Work without a planned interval has no plan position');
    assert.equal(typeof obj.actualProgress, 'number');
    assert.equal(obj.actualProgress, formula(ws, 'actualProgress'));
    assert.equal(obj.actualProgressKnownPart, formula(ws, 'actualProgress'));
});

test('REG-01-e mixed Early Work: null while cost and dates are unknown, then the same Work completed -> stated by the pre-R04 formula', async () => {
    const o = await mkObject();
    const known = await legacyWork(o.id, '1000', dt(-10), dt(10));
    await progress(known, '50');
    const early = await earlyWork(o.id);
    let s = await snapshot(o.id);
    assert.deepEqual([s.o.plannedProgress, s.o.actualProgress, s.o.actualProgressKnownPart], [null, null, null]);
    await h.req(`works/${early.id}/complete-planning`, { version: early.version, idempotencyKey: randomUUID(), estimatedCost: '3000', plannedStartDate: dt(-20), plannedFinishDate: dt(20) });
    s = await snapshot(o.id);
    assert.equal(s.ws.length, 2, 'same Work, no clone');
    assert.equal(s.o.plannedProgress, formula(s.ws, 'plannedProgress'));
    assert.equal(s.o.actualProgress, formula(s.ws, 'actualProgress'));
    assert.equal(typeof s.o.plannedProgress, 'number');
});
