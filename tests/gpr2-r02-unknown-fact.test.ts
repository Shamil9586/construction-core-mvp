import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import './helpers/gpr2-isolation';

/**
 * GPR-2 R02-001 — an UNKNOWN fact is not a confirmed zero (independent acceptance finding, HIGH).
 *
 * The resolver returned `quantity = null` for UNKNOWN_TIE, but `ReadService.snapshot()` turned it into "0.0000" and fed that into progress, the schedule
 * status, the closing potential, the dependency blockers and the object / dashboard aggregates. This file follows ONE unknown Work from the resolver
 * to the read-model snapshot (PGlite; the fixtures are real rows: a portion with two RP facts at the very same instant and no sequence), next to
 * controls that must not move: a CONFIRMED zero, an ordinary KNOWN fact, and a Work nobody has reported on.
 */
const t = (micro: number, hour = 10) => `2026-09-01T${String(hour).padStart(2, '0')}:00:00.${String(micro).padStart(6, '0')}Z`;

let pool: any, one: any, rows: any, read: any, service: any, tenantId: string, admin: any, viewer: any;
let objectId: string;
const W: Record<string, any> = {};

before(async () => {
  ({ pool, one, rows } = await import('../apps/backend/src/db'));
  const { migrate } = await import('../scripts/migrate');
  const { seed } = await import('../scripts/seed');
  const { ProductionService } = await import('../apps/backend/src/service');
  const { ReadService } = await import('../apps/backend/src/read-service');
  await migrate();
  const tenant = await seed();
  tenantId = tenant.id;
  service = new ProductionService();
  read = new ReadService();
  admin = await one(pool, "SELECT * FROM users WHERE tenant_id=$1 AND role='ADMIN' LIMIT 1", [tenantId]);
  viewer = await one(pool, "SELECT * FROM users WHERE tenant_id=$1 AND role='CONTRACTOR_VIEWER' LIMIT 1", [tenantId]);

  const object = await one(pool, "SELECT * FROM objects WHERE tenant_id=$1 AND external_code='DEMO-2026-004'", [tenantId]);
  objectId = object.id;
  const pm = await one(pool, 'SELECT * FROM users WHERE tenant_id=$1 AND id=$2', [tenantId, object.projectManagerId]);
  const fresh = await rows(pool, "SELECT * FROM works w WHERE tenant_id=$1 AND object_id=$2 AND actual_quantity=0 AND NOT EXISTS(SELECT 1 FROM work_progress p WHERE p.tenant_id=w.tenant_id AND p.object_work_id=w.id) AND NOT EXISTS(SELECT 1 FROM work_dependencies d WHERE d.tenant_id=w.tenant_id AND (d.successor_work_id=w.id OR d.predecessor_work_id=w.id)) ORDER BY name", [tenantId, object.id]);
  assert.ok(fresh.length >= 5, 'fixture: five untouched Works on the fourth demo object');
  [W.unknown, W.zero, W.afterUnknown, W.afterZero, W.silent] = fresh;

  // every fixture Work is long overdue, so a fact of 0 would be a genuine, loud delay (RED) — the thing an unknown must NOT be turned into
  await pool.query("UPDATE works SET planned_start_date='2026-01-01', planned_finish_date='2026-02-01', estimated_cost=1000000, planned_quantity=1000 WHERE id = ANY($1::uuid[])", [fresh.map((w: any) => w.id)]);

  const portionOf = async (work: any) => {
    const unit = await service.createExecutionUnit(pm, { objectWorkId: work.id, workTypeId: work.workTypeId, contractorId: work.contractorId, unit: work.unit, plannedQuantity: '1000' });
    const portion = await service.createQuantityPortion(pm, unit.id, { label: 'Участок', plannedQuantity: '1000' });
    await pool.query("UPDATE works SET created_at='2026-08-01T00:00:00Z' WHERE id=$1", [work.id]);
    await pool.query("UPDATE work_execution_units SET created_at='2026-08-01T00:00:00Z' WHERE id=$1", [unit.id]);
    await pool.query("UPDATE quantity_portions SET created_at='2026-08-01T00:00:00Z' WHERE id=$1", [portion.id]);
    return portion;
  };
  const confirm = (portionId: string, quantity: string, at: string, noSeq = false) =>
    pool.query(`INSERT INTO portion_quantity_confirmations(tenant_id,portion_id,source,quantity,recorded_by,recorded_at,created_at${noSeq ? ',confirmation_seq' : ''}) VALUES($1,$2,'RP_FACT',$3,$4,$5::timestamptz,$5::timestamptz${noSeq ? ',NULL' : ''})`, [tenantId, portionId, quantity, pm.id, at]);

  // UNKNOWN_TIE: two RP facts at the very same instant, different quantities, no sequence (the legacy shape) -> the resolver cannot say which one holds
  const tie = await portionOf(W.unknown);
  await confirm(tie.id, '400', t(5), true);
  await confirm(tie.id, '650', t(5), true);
  // a CONFIRMED zero: the project manager reported 0
  const zero = await portionOf(W.zero);
  await confirm(zero.id, '0', t(6));
  // the two dependants: both unstarted, each behind one predecessor; no acceptance / document requirement, so the quantity is the only thing that can block
  await pool.query("INSERT INTO work_dependencies(tenant_id,predecessor_work_id,successor_work_id,requires_acceptance,requires_document) VALUES($1,$2,$3,false,false),($1,$4,$5,false,false)", [tenantId, W.unknown.id, W.afterUnknown.id, W.zero.id, W.afterZero.id]);
});

const snapshot = (actor = admin) => read.snapshot(actor);
const work = async (id: string, actor = admin) => (await snapshot(actor)).works.find((w: any) => w.id === id);

test('R02-001 #1 UNKNOWN_TIE reaches the read model as actualQuantity = null, with the reason beside it', async () => {
  const w = await work(W.unknown.id);
  assert.equal(w.actualQuantity, null, 'null, not "0.0000"');
  assert.equal(w.factState, 'UNKNOWN_TIE');
  assert.equal(w.factUnknown, true);
  assert.equal(JSON.parse(JSON.stringify(w)).actualQuantity, null, 'and null survives the wire');
});

test('R02-001 #2 progress: an unknown fact is not 0 % — it is not stated', async () => {
  const w = await work(W.unknown.id);
  assert.equal(w.actualProgress, null);
  assert.equal(w.variance, null);
});

test('R02-001 #3 schedule: an unknown fact on an overdue Work is GRAY, never RED, and invents no delay — the plan itself is still stated', async () => {
  const unknown = await work(W.unknown.id), zero = await work(W.zero.id);
  assert.equal(unknown.scheduleStatus, 'GRAY');
  assert.equal(unknown.delayDays, 0, 'no fictitious lag');
  assert.equal(typeof unknown.plannedProgress, 'number', 'the known part (the plan) is not hidden');
  assert.ok(Math.abs(unknown.plannedProgress - zero.plannedProgress) < 0.001, 'and it is the same plan the control Work has');
  // the control: the very same dates with a CONFIRMED 0 is the real, loud delay
  assert.equal(zero.scheduleStatus, 'RED');
  assert.ok(zero.delayDays > 0);
});

test('R02-001 #4 potential closing: an unknown fact is null, not a fictitious "0.00"; what was closed is still known', async () => {
  const w = await work(W.unknown.id);
  assert.equal(w.financial.potential, null);
  assert.equal(w.financial.physical, null);
  assert.equal(w.financial.buckets, null);
  assert.equal(w.financial.closed, '0.00', 'the closed amount does not depend on the physical fact');
  assert.equal(w.financial.factUnknown, true);
  assert.equal(w.closed, '0.00');
});

test('R02-001 #5 dependency: an unknown predecessor blocks the successor, says WHY, and does not claim "not finished"', async () => {
  const dependant = await work(W.afterUnknown.id);
  assert.equal(dependant.blockers.length, 1);
  assert.match(dependant.blockers[0], /факт выполнения не определён \(UNKNOWN_TIE\)/);
  assert.match(dependant.blockers[0], /не разрешён/);
  assert.doesNotMatch(dependant.blockers.join(), /не завершена/, 'an unknown is not a confirmed shortfall');
  // the control: a CONFIRMED 0 predecessor is "not finished", as before
  const control = await work(W.afterZero.id);
  assert.equal(control.blockers.length, 1);
  assert.match(control.blockers[0], /не завершена/);
});

test('R02-001 #6 object and dashboard aggregates say they are incomplete instead of looking certain', async () => {
  const snap = await snapshot();
  const object = snap.objects.find((o: any) => o.id === objectId);
  assert.equal(object.unknownFactWorks, 1);
  assert.equal(object.actualProgress, null, 'no object-level progress from incomplete data');
  assert.equal(object.potential, null);
  assert.equal(typeof object.plannedProgress, 'number', 'the plan average is unaffected');
  assert.equal(typeof object.potentialKnownPart, 'string', 'the part that IS known is shown separately');
  assert.notEqual(object.healthStatus, 'GREEN', 'an object with an unknown fact is never GREEN');

  const d = snap.dashboard;
  assert.ok(d.unknownFactWorks >= 1);
  assert.equal(d.potentialClosing, null, 'the portfolio total is not stated');
  assert.equal(typeof d.potentialClosingKnownPart, 'string');
  assert.deepEqual(Object.values(d.buckets), [null, null, null, null, null], 'no bucket is presented as a total');
  assert.ok(Object.values(d.bucketsKnownPart).every((v: any) => typeof v === 'string'));

  // the attention queue names the problem; it does not file it as a delay, and the stale-fact item is not duplicated
  const own = d.attentionRequired.filter((a: any) => a.entityId === W.unknown.id);
  assert.deepEqual(own.map((a: any) => a.title), ['Факт выполнения не определён']);
  assert.equal(own[0].severity, 'GRAY');
  assert.equal(own[0].moneyImpact, null, 'no money impact is made up');
  assert.match(own[0].reason, /UNKNOWN_TIE/);

  // CONTRACTOR_VIEWER: the known part of the potential is financial and is stripped like `potential`
  const asViewer = await snapshot(viewer);
  for (const o of asViewer.objects) {
    assert.equal('potentialKnownPart' in o, false);
    assert.equal('potential' in o, false);
  }
  assert.equal(asViewer.works.some((w: any) => 'financial' in w), false);
});

test('R02-001 #7 a CONFIRMED zero stays "0.0000" and a real, calculated zero', async () => {
  const w = await work(W.zero.id);
  assert.equal(w.actualQuantity, '0.0000');
  assert.equal(w.factState, 'KNOWN');
  assert.equal(w.factUnknown, false);
  assert.equal(w.actualProgress, 0);
  assert.equal(w.financial.physical, '0.00');
  assert.equal(w.financial.potential, '0.00');
  assert.notEqual(w.financial.buckets, null);
});

test('R02-001 #7b a Work nobody has reported on keeps its pre-R02 reading (GRAY, 0.0000) and is told apart from the unknown by its state', async () => {
  const silent = await work(W.silent.id), unknown = await work(W.unknown.id);
  assert.equal(silent.actualQuantity, '0.0000');
  assert.equal(silent.factState, 'KNOWN'); // a Work with no units and no progress: the legacy source, nothing recorded
  assert.equal(silent.factUnknown, false);
  assert.equal(silent.scheduleStatus, 'GRAY', 'never reported: GRAY, exactly as before');
  assert.equal(silent.actualProgress, null);
  assert.notEqual(silent.factState, unknown.factState);
});

test('R02-001 #8 ordinary KNOWN facts are unchanged (legacy figure, numbers, funnel)', async () => {
  const legacyObject = await one(pool, "SELECT * FROM objects WHERE tenant_id=$1 AND external_code='DEMO-2026-002'", [tenantId]);
  const known = (await snapshot()).works.filter((w: any) => w.objectId === legacyObject.id && Number(w.actualQuantity) > 0);
  assert.ok(known.length >= 2);
  for (const w of known) {
    assert.equal(w.factState, 'KNOWN');
    assert.equal(w.factUnknown, false);
    assert.match(w.actualQuantity, /^\d+\.\d{4}$/);
    assert.equal(typeof w.actualProgress, 'number');
    assert.equal(typeof w.financial.potential, 'string');
    assert.notEqual(w.financial.buckets, null);
  }
  const object = (await snapshot()).objects.find((o: any) => o.id === legacyObject.id);
  assert.equal(object.unknownFactWorks, 0);
  assert.equal(typeof object.actualProgress, 'number', 'a complete object keeps its aggregate');
  assert.equal(typeof object.potential, 'string');
  assert.equal(object.actualProgressKnownPart, object.actualProgress, 'complete: the known part IS the whole');
  assert.equal(object.potentialKnownPart, object.potential);
});

test('R02-001 #9 the fix is in the read model only: the resolver, F12.1 customer-SC grouping and the write-side guard are untouched', () => {
  const read = fs.readFileSync('apps/backend/src/read-service.ts', 'utf8');
  assert.doesNotMatch(read, /fact\.quantity \?\? ['"]0/, 'no zero substitution of an unknown fact remains in the read service');
  assert.doesNotMatch(read, /Number\(actualQuantity\)\s*[<>]/, 'no comparison of a possibly-null quantity as a number');
  // the write-side guard keeps failing closed on the same states
  const service = fs.readFileSync('apps/backend/src/service.ts', 'utf8');
  assert.match(service, /predecessorActual !== null && new Decimal\(predecessorActual\)\.gte/);
});

test('R02-001 #10 the frontend reads null as "not determined", never as a quantity: status, dash formatting, no Decimal(null)', async () => {
  const { workExecutionState, workExecutionPresentation } = await import('../apps/frontend/src/view-models/status');
  const { formatQuantityWithUnit, formatMoney, formatPercent } = await import('../apps/frontend/src/formatters');
  const unknown: any = { lastReportedAt: '2026-09-01T10:00:00.000Z', actualQuantity: null, plannedQuantity: '1000.0000' };
  assert.equal(workExecutionState(unknown), 'UNKNOWN');
  assert.deepEqual(workExecutionPresentation(unknown), { variant: 'Neutral', label: 'Факт не определён' });
  // a confirmed zero and a never-reported Work are exactly what they were
  assert.equal(workExecutionState({ ...unknown, actualQuantity: '0.0000' }), 'NOT_STARTED');
  assert.equal(workExecutionState({ lastReportedAt: null, actualQuantity: '0.0000', plannedQuantity: '1000.0000' } as any), 'NOT_STARTED');
  assert.equal(workExecutionState({ ...unknown, actualQuantity: '300.0000' }), 'IN_PROGRESS');
  assert.equal(workExecutionState({ ...unknown, actualQuantity: '1000.0000' }), 'COMPLETED');
  assert.equal(formatQuantityWithUnit(null, 'м²'), '—');
  assert.equal(formatMoney(null), '—');
  assert.equal(formatPercent(null), '—');
});
