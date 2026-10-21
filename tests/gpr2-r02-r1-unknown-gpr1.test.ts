import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gprHarness, pilotScenario, reportFact, type Harness, type Pilot } from './helpers/gpr-fixtures';

/**
 * GPR-2 R02-001-R1 + GPR1-UNKNOWN-01 — an UNKNOWN fact, followed from the resolver through every place that used to turn it into a number:
 *
 *   resolver (portion figures / Work fact) → execution-unit snapshot → GPR-1 scope → schedule entry → object conclusion → W01 / API consumers
 *
 * Real backend over HTTP (PGlite, mock auth, demo seed), the pilot scenario of GPR-1, and DETERMINISTIC dates: floor 1 is planned 2026-03-01..11,
 * every read asks for an explicit `?asOf=`. An UNKNOWN_TIE is a portion with two RP facts at the very same instant, different quantities and no
 * sequence — the legacy shape the resolver cannot order (inserted directly, as the R02 tests do).
 *
 * Scopes (one unit each, all in the object's approved schedule, dates F1):
 *   floor1  500 м²   one portion, UNKNOWN_TIE                       T01
 *   floor2  300 м²   one portion, nothing ever reported              T04 / T12
 *   M      1000 м²   portions 400 (KNOWN 400) + 600 (UNKNOWN_TIE)    T02
 *   Z       300 м²   one portion, a CONFIRMED 0                      T03 / T11
 *   K       500 м²   portions 150 + 250, both KNOWN                  T05
 */
let h: Harness, p: Pilot, pool: any, tenantId: string;
const ids: Record<string, any> = {};
const F1 = { start: '2026-03-01', finish: '2026-03-11' };
const OVERDUE = '2026-03-20', BEFORE_START = '2026-02-15';

const addEntry = (objectId: string, workId: string, unitId: string, start: string, finish: string) =>
  h.req(`objects/${objectId}/schedule/draft/entries`, { objectWorkId: workId, executionUnitId: unitId, plannedStart: start, plannedFinish: finish });
const schedule = (asOf: string) => h.req(`objects/${p.object.id}/schedule?asOf=${asOf}`);
const entryOf = (s: any, unitId: string) => s.entries.find((e: any) => e.executionUnitId === unitId);
const unitInSnapshot = async (unitId: string) => (await h.req('snapshot')).executionUnits.find((u: any) => u.id === unitId);

/** Two RP facts for one portion at the very same instant with different quantities and no sequence: the resolver cannot say which one holds. */
async function tie(portionId: string, a: string, b: string) {
  for (const q of [a, b])
    await pool.query("INSERT INTO portion_quantity_confirmations(tenant_id,portion_id,source,quantity,recorded_by,recorded_at,created_at,confirmation_seq) VALUES($1,$2,'RP_FACT',$3,$4,'2026-03-05T10:00:00.000005Z','2026-03-05T10:00:00.000005Z',NULL)", [tenantId, portionId, q, p.pm.id]);
}

before(async () => {
  h = await gprHarness('gpr2-r02-r1-key');
  ({ pool } = await import('../apps/backend/src/db'));
  p = await pilotScenario(h);
  tenantId = p.pm.tenantId;
  await h.as(p.pm);
  const portion = async (unitId: string, label: string, planned: number) => h.req(`execution-units/${unitId}/portions`, { label, plannedQuantity: planned });
  const mkUnit = (workId: string, zone: string, planned: number) => h.req('execution-units', { objectWorkId: workId, workTypeId: p.plaster.id, contractorId: p.contractors[0].id, unit: 'м²', plannedQuantity: planned, location: zone });
  const work = await h.req('works', { objectId: p.object.id, workTypeId: p.plaster.id, contractorId: p.contractors[0].id, responsibleUserId: p.pm.id, name: 'Окраска стен', unit: 'м²', plannedQuantity: 1800, plannedStartDate: '2026-03-01', plannedFinishDate: '2026-04-30', estimatedCost: '100000' });
  ids.work2 = work;
  ids.M = await mkUnit(work.id, 'Зона M', 1000);
  ids.Mk = await portion(ids.M.id, 'M известный', 400);
  ids.Mt = await portion(ids.M.id, 'M неоднозначный', 600);
  ids.Z = await mkUnit(work.id, 'Зона Z', 300);
  ids.Zp = await portion(ids.Z.id, 'Z', 300);
  ids.K = await mkUnit(work.id, 'Зона K', 500);
  ids.Ka = await portion(ids.K.id, 'K 1', 150);
  ids.Kb = await portion(ids.K.id, 'K 2', 250);

  await reportFact(h, p.pm, ids.Mk.id, 400);
  await tie(ids.Mt.id, '200', '350');
  await tie(p.floor1.portion.id, '120', '480');
  await reportFact(h, p.pm, ids.Zp.id, 0);
  await reportFact(h, p.pm, ids.Ka.id, 150);
  await reportFact(h, p.pm, ids.Kb.id, 250);

  await h.as(p.pm);
  await h.req(`objects/${p.object.id}/schedule/draft`, {});
  for (const u of [p.floor1.unit, p.floor2.unit, ids.M, ids.Z, ids.K])
    await addEntry(p.object.id, u === ids.M || u === ids.Z || u === ids.K ? work.id : p.plasterWork.work.id, u.id, F1.start, F1.finish);
  await h.login('DEPUTY_DIRECTOR');
  const draft = (await h.req(`objects/${p.object.id}/schedule`)).draft;
  await h.req(`objects/${p.object.id}/schedule/draft/approve`, { version: draft.version, comment: 'Базовый график' });
});
after(async () => { await h?.close(); });

test('T01 one unit, one UNKNOWN_TIE portion: the unit total is NOT stated — null with its reason, not 0 and not a guess', async () => {
  await h.as(p.pm);
  const u = await unitInSnapshot(p.floor1.unit.id);
  assert.equal(u.actualQuantity, null);
  assert.equal(u.factState, 'UNKNOWN_TIE');
  assert.deepEqual(u.unknownPortionIds, [p.floor1.portion.id]);
  assert.equal(u.actualQuantityKnownPart, '0.0000', 'no known portion: the known part is an honest, explicitly partial 0.0000');
  const portion = (await h.req('snapshot')).portions.find((x: any) => x.id === p.floor1.portion.id);
  assert.deepEqual([portion.rpFactQuantity, portion.rpFactState], [null, 'UNKNOWN_TIE'], 'and the portion says WHY its quantity is null');
});

test('T02 a unit with KNOWN 400 and an UNKNOWN_TIE portion: the total is null — 400 is only ever the labelled partial figure', async () => {
  await h.as(p.pm);
  const u = await unitInSnapshot(ids.M.id);
  assert.equal(u.actualQuantity, null, 'not "400.0000"');
  assert.equal(u.factState, 'UNKNOWN_TIE');
  assert.equal(u.actualQuantityKnownPart, '400.0000', 'the known portion is shown apart, as partial');
  assert.deepEqual(u.unknownPortionIds, [ids.Mt.id]);
  // GPR-1 does not take the 400 as the unit's fact either
  const e = entryOf(await schedule(OVERDUE), ids.M.id);
  assert.equal(e.rpFactQuantity, null);
  assert.equal(e.factReliability, 'UNKNOWN');
});

test('T03 a CONFIRMED zero stays a real 0.0000 — a stated fact, not an unknown', async () => {
  await h.as(p.pm);
  const u = await unitInSnapshot(ids.Z.id);
  assert.deepEqual([u.actualQuantity, u.factState, u.actualQuantityKnownPart, u.unknownPortionIds], ['0.0000', 'KNOWN', null, []]);
});

test('T04 a unit nobody reported on keeps the pre-R02 reading: "0.0000", NONE_REPORTED — told apart from an unknown by its state', async () => {
  await h.as(p.pm);
  const u = await unitInSnapshot(p.floor2.unit.id);
  assert.deepEqual([u.actualQuantity, u.factState, u.unknownPortionIds], ['0.0000', 'NONE_REPORTED', []]);
  const portion = (await h.req('snapshot')).portions.find((x: any) => x.id === p.floor2.portion.id);
  assert.deepEqual([portion.rpFactQuantity, portion.rpFactState], [null, 'NONE'], 'null quantity, but NONE — not UNKNOWN_TIE');
});

test('T05 several KNOWN portions still add up (150 + 250), unchanged', async () => {
  await h.as(p.pm);
  const u = await unitInSnapshot(ids.K.id);
  assert.deepEqual([u.actualQuantity, u.factState, u.actualQuantityKnownPart], ['400.0000', 'KNOWN', null]);
  const e = entryOf(await schedule(OVERDUE), ids.K.id);
  assert.deepEqual([e.rpFactQuantity, e.factReliability, e.assessable], ['400.0000', 'REPORTED', true]);
});

test('T06 the resolver, the snapshot and GPR-1 agree about the same Work', async () => {
  const { loadWorkFacts, loadPortionFigures } = await import('../apps/backend/src/fact-resolver');
  const { loadObjectScopes, scopeKey } = await import('../apps/backend/src/schedule-scope');
  const figures = await loadPortionFigures(pool, tenantId, [ids.Mk.id, ids.Mt.id, p.floor1.portion.id, p.floor2.portion.id]);
  assert.deepEqual([figures.get(ids.Mk.id)!.rp.state, figures.get(ids.Mt.id)!.rp.state, figures.get(p.floor1.portion.id)!.rp.state, figures.get(p.floor2.portion.id)!.rp.state], ['RESOLVED', 'UNKNOWN_TIE', 'UNKNOWN_TIE', 'NONE']);
  const facts = await loadWorkFacts(pool, tenantId, [ids.work2.id, p.plasterWork.work.id]);
  for (const id of [ids.work2.id, p.plasterWork.work.id])
    assert.deepEqual([facts.get(id)!.state, facts.get(id)!.quantity], ['UNKNOWN_TIE', null], 'resolver: the Work fact is unknown');
  await h.as(p.pm);
  const snap = await h.req('snapshot');
  for (const id of [ids.work2.id, p.plasterWork.work.id]) {
    const w = snap.works.find((x: any) => x.id === id);
    assert.deepEqual([w.actualQuantity, w.factState, w.factUnknown], [null, 'UNKNOWN_TIE', true], 'snapshot: the same verdict');
  }
  const scopes = await loadObjectScopes(pool, tenantId, p.object.id);
  assert.equal(scopes.get(scopeKey(ids.work2.id, null))!.factUnknown, true, 'GPR-1 whole-work scope: the same verdict');
  assert.equal(scopes.get(scopeKey(ids.work2.id, ids.M.id))!.factUnknown, true, 'GPR-1 unit scope: the same verdict');
  assert.equal(scopes.get(scopeKey(ids.work2.id, ids.K.id))!.factUnknown, false);
  assert.equal(scopes.get(scopeKey(p.plasterWork.work.id, p.floor2.unit.id))!.factUnknown, false, 'a unit with nothing reported is NOT unknown');
});

test('T07 + T08 an UNKNOWN_TIE on an overdue entry is not DELAYED and has no days of delay; the calendar part is still stated', async () => {
  for (const asOf of [OVERDUE, '2026-03-06', '2026-04-15']) {
    const s = await schedule(asOf);
    for (const id of [p.floor1.unit.id, ids.M.id]) {
      const e = entryOf(s, id);
      assert.equal(e.state, null, `${asOf}: no production state is claimed`);
      assert.notEqual(e.state, 'DELAYED');
      assert.equal(e.assessable, false);
      assert.equal(e.factReliability, 'UNKNOWN');
      assert.equal(e.delayDays, 0, `${asOf}: no fictitious days`);
      assert.equal(e.delayKind, null);
      assert.equal(e.actualProgress, null);
      assert.equal(e.factReported, false);
      assert.equal(e.overperformed, false);
      assert.equal(typeof e.plannedProgress, 'number', 'the approved plan is still stated');
      assert.ok(['NOT_DUE', 'UNDERWAY', 'DUE_COMPLETE'].includes(e.expectedPhase));
    }
  }
  // the control: the same dates with nothing reported are a real delay, as before
  const real = entryOf(await schedule(OVERDUE), p.floor2.unit.id);
  assert.equal(real.state, 'DELAYED');
  assert.ok(real.delayDays > 0);
});

test('T09 the object schedule is never ON_TRACK on incomplete data — and a PROVED delay elsewhere still reads DELAYED', async () => {
  // before any entry starts nothing is delayed: the old code read ON_TRACK; the unknown entries make it UNDETERMINED
  const early = await schedule(BEFORE_START);
  assert.equal(early.conclusion.status, 'UNDETERMINED');
  assert.equal(early.conclusion.delayedCount, 0);
  assert.equal(early.conclusion.unassessedCount, 2);
  assert.equal(early.conclusion.entryCount, 5);
  // later, entries with a stated fact ARE delayed (floor 2 never reported, Z a confirmed zero): that proof stands
  const late = await schedule(OVERDUE);
  assert.equal(late.conclusion.status, 'DELAYED');
  assert.equal(late.conclusion.unassessedCount, 2);
  assert.ok(late.conclusion.delayedCount >= 2);
  assert.equal(late.conclusion.delayedCount + late.conclusion.completedCount + late.conclusion.inProgressCount + late.conclusion.notStartedCount + late.conclusion.unassessedCount, 5, 'every entry is in exactly one bucket');
  // work-level summary: unknown + not yet due -> no state; unknown + proved delay -> the delay
  const w1 = await h.req(`works/${p.plasterWork.work.id}/schedule?asOf=${BEFORE_START}`);
  assert.deepEqual([w1.summary.state, w1.summary.assessable], [null, false], 'a scheduled Work with an unknown fact: not "not scheduled", not "on track"');
  const w2 = await h.req(`works/${p.plasterWork.work.id}/schedule?asOf=${OVERDUE}`);
  assert.deepEqual([w2.summary.state, w2.summary.assessable], ['DELAYED', false]);
});

test('T10 a delay reason cannot be recorded when the only ground is an unknown fact (server-side); a genuinely delayed entry still accepts one', async () => {
  await h.as(p.pm);
  const s = await schedule(OVERDUE);
  const body = (itemId: string) => ({ itemId, categoryCode: 'MATERIALS', comment: 'Поставка задерживается' });
  for (const id of [p.floor1.unit.id, ids.M.id]) {
    const r = await h.raw(`objects/${p.object.id}/schedule/delay-reasons`, body(entryOf(s, id).itemId));
    assert.ok(r.status >= 400 && r.status < 500, 'refused, status ' + r.status);
    assert.match(JSON.stringify(r.data), /факт выполнения .* не определён/);
  }
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM schedule_delay_reasons WHERE item_id = ANY($1::uuid[])', [[entryOf(s, p.floor1.unit.id).itemId, entryOf(s, ids.M.id).itemId]])).rows[0].n, 0, 'nothing was written');
  const ok = await h.raw(`objects/${p.object.id}/schedule/delay-reasons`, body(entryOf(s, p.floor2.unit.id).itemId));
  assert.equal(ok.status, 201, 'a stated, real delay (nothing reported, dates long past) still takes a reason');
});

test('T11 a CONFIRMED zero on an overdue entry keeps the earlier behaviour: a real delay', async () => {
  const e = entryOf(await schedule(OVERDUE), ids.Z.id);
  assert.deepEqual([e.factReported, e.factReliability, e.assessable, e.rpFactQuantity], [true, 'REPORTED', true, '0.0000']);
  assert.equal(e.state, 'DELAYED');
  assert.ok(e.delayDays > 0);
  assert.equal(e.actualProgress, 0);
});

test('T12 "nothing reported" keeps its own semantics: NOT_REPORTED, no progress figure, a delay once the dates have passed — and NOT_STARTED before them', async () => {
  const late = entryOf(await schedule(OVERDUE), p.floor2.unit.id);
  assert.deepEqual([late.factReliability, late.assessable, late.factReported, late.rpFactQuantity, late.state], ['NOT_REPORTED', true, false, null, 'DELAYED']);
  const early = entryOf(await schedule(BEFORE_START), p.floor2.unit.id);
  assert.deepEqual([early.factReliability, early.state, early.delayDays], ['NOT_REPORTED', 'NOT_STARTED', 0]);
});

test('T13 LEGACY_WORK cannot reach UNKNOWN_TIE in a current-state read, so GPR-1 cannot bypass the resolver there — proved, not assumed', async () => {
  const { loadWorkFacts } = await import('../apps/backend/src/fact-resolver');
  const { loadObjectScopes, scopeKey } = await import('../apps/backend/src/schedule-scope');
  // a Work with NO units and two progress rows at the very same instant with different totals (the tie that would be unorderable)
  await h.as(p.pm);
  const legacy = await h.req('works', { objectId: p.object.id, workTypeId: p.plaster.id, contractorId: p.contractors[0].id, responsibleUserId: p.pm.id, name: 'Грунтовка (легаси)', unit: 'м²', plannedQuantity: 100, plannedStartDate: '2026-03-01', plannedFinishDate: '2026-04-30', estimatedCost: '1000' });
  for (const total of ['30', '70'])
    await pool.query("INSERT INTO work_progress(tenant_id,object_work_id,quantity_delta,total_quantity,reported_by,created_at,reported_at) VALUES($1,$2,$3,$3,$4,'2026-03-05T10:00:00.000007Z','2026-03-05T10:00:00.000007Z')", [tenantId, legacy.id, total, p.pm.id]);
  await pool.query('UPDATE works SET actual_quantity=70 WHERE id=$1', [legacy.id]);
  const now = (await loadWorkFacts(pool, tenantId, [legacy.id])).get(legacy.id)!;
  assert.deepEqual([now.mode, now.state, now.quantity], ['LEGACY_WORK', 'KNOWN', '70.0000'], 'current state: the legacy figure IS the works column, the resolver never calls it a tie');
  const past = (await loadWorkFacts(pool, tenantId, [legacy.id], { knownAt: new Date(Date.now() + 86400000).toISOString().replace('Z', '000Z') })).get(legacy.id)!;
  assert.equal(past.state, 'UNKNOWN_TIE', 'the same rows ARE a tie — but only when asked "as known at", which no GPR-1 read does');
  const scope = (await loadObjectScopes(pool, tenantId, p.object.id)).get(scopeKey(legacy.id, null))!;
  assert.deepEqual([scope.rpFactQuantity, scope.factUnknown], ['70.0000', false], 'GPR-1 reads exactly the resolver\'s current figure');
  // and the guard is not legacy-specific: the resolver's verdict is honoured BEFORE the mode decides where the figure comes from
  const src = fs.readFileSync('apps/backend/src/schedule-scope.ts', 'utf8');
  assert.ok(src.indexOf('UNKNOWN_FACT_STATES.has(fact.state)') > 0 && src.indexOf('UNKNOWN_FACT_STATES.has(fact.state)') < src.indexOf("fact.mode === 'LEGACY_WORK' ? legacyFact"), 'the unknown verdict is tested before the legacy branch');
});

test('T14 the real API payloads, through the frontend: guards accept them and every consumer says "fact not determined" in words', async () => {
  const { isObjectSchedule, isWorkSchedule } = await import('../apps/frontend/src/data/scheduleApi');
  const { validateSnapshot } = await import('../apps/frontend/src/data/validateSnapshot');
  const vm = await import('../apps/frontend/src/view-models/schedule');
  await h.as(p.pm);
  const early = await schedule(BEFORE_START), late = await schedule(OVERDUE);
  const workEarly = await h.req(`works/${p.plasterWork.work.id}/schedule?asOf=${BEFORE_START}`);
  assert.equal(isObjectSchedule(early, p.object.id), true, 'the object schedule with unassessed entries is a valid response');
  assert.equal(isObjectSchedule(late, p.object.id), true);
  assert.equal(isWorkSchedule(workEarly, p.plasterWork.work.id), true, 'and so is the work summary with state null / assessable false');
  const snapshot = await h.req('snapshot');
  assert.ok(snapshot.executionUnits.some((u: any) => u.actualQuantity === null));
  assert.doesNotThrow(() => validateSnapshot(snapshot), 'the snapshot with a null unit actualQuantity is valid');

  const gpr = vm.buildGprViewModel(early);
  const row = gpr.rows.find((r: any) => r.itemId === entryOf(early, p.floor1.unit.id).itemId)!;
  assert.deepEqual(row.state, { variant: 'Neutral', label: 'Факт не определён' });
  assert.equal(row.fact, 'Не определён');
  assert.equal(row.needsAttention, false, 'not filed as a delay');
  assert.equal(row.delay, null);
  assert.equal(row.canRecordReason, false, 'and the form for a delay reason is not offered');
  assert.deepEqual(vm.objectScheduleStatusPresentation(early.conclusion.status), { variant: 'Neutral', label: 'Оценка невозможна: факт не определён' });

  const o01 = vm.buildO01ScheduleView({ status: 'Loaded', value: early } as any) as any;
  assert.equal(o01.kind, 'Ready');
  assert.match(o01.text, /оценка графика невозможна/);
  assert.doesNotMatch(o01.text, /Отставаний нет/, 'never "no delays" from incomplete data');
  const compliance = vm.buildObjectWorkCompliance({ status: 'Loaded', value: early } as any, p.object.id);
  assert.equal(compliance(p.plasterWork.work.id).kind, 'Undetermined');
  assert.equal(compliance(p.plasterWork.work.id).presentation.label, 'Оценка невозможна: факт не определён');
  const w01 = vm.buildW01ScheduleView({ status: 'Loaded', value: workEarly } as any, p.plasterWork.work.id) as any;
  assert.equal(w01.kind, 'Ready', 'a scheduled Work with an unknown fact is not "not scheduled"');
  assert.deepEqual(w01.state, { variant: 'Neutral', label: 'Факт не определён' });
});

test('T15 the protected F8 / F12 semantics did not move: a CUSTOMER_SC group of two different values is still unknown, a KNOWN figure is still the figure', async () => {
  const { loadPortionFigures } = await import('../apps/backend/src/fact-resolver');
  for (const q of ['100', '250'])
    await pool.query("INSERT INTO portion_quantity_confirmations(tenant_id,portion_id,source,quantity,recorded_by,recorded_at,created_at,confirmation_seq) VALUES($1,$2,'CUSTOMER_SC',$3,$4,'2026-03-06T10:00:00.000001Z','2026-03-06T10:00:00.000001Z',NULL)", [tenantId, ids.Ka.id, q, p.pm.id]);
  const f = (await loadPortionFigures(pool, tenantId, [ids.Ka.id, ids.Mk.id])).get(ids.Ka.id)!;
  assert.equal(f.customerAccepted, null, 'F12.1: the whole latest group decides, a disagreeing group is unknown');
  assert.equal(f.rpFact, '150.0000');
  await h.as(p.pm);
  const portion = (await h.req('snapshot')).portions.find((x: any) => x.id === ids.Ka.id);
  assert.deepEqual([portion.rpFactQuantity, portion.customerScConfirmedQuantity], ['150.0000', null]);
  // the unit total is not touched by the SC contour at all
  assert.equal((await unitInSnapshot(ids.K.id)).actualQuantity, '400.0000');
});
