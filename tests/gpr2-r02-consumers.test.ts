import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers/gpr2-isolation';

/**
 * GPR-2 R02 — the one resolver, as every production consumer sees it (PGlite; the native-PostgreSQL counterpart is gpr2-r02-fact-resolver-pg.test.ts).
 * Scenarios A05 (legacy 300 and an empty execution unit) and A24 (ties, CUSTOMER_SC group, known-at), plus the persisted source mode (C13).
 *
 * Fixtures come from seed(): DEMO-2026-004 has PLANNED Works with no progress (a "fresh" Work); DEMO-2026-002 has Works with legacy progress.
 * "Persisted" Works are produced by classifying a Work the way R19 later will — with the guard trigger switched off for that one statement,
 * because no R02 code path classifies a real Work.
 */
delete process.env.DATABASE_URL;
process.env.AUTH_MODE = 'mock';
process.env.MOCK_LOGIN_KEY = 'gpr2-r02-consumers-key';
process.env.DB_MODE = 'pglite';
process.env.PGLITE_DIR = 'memory://';

const t = (micro: number, hour = 10) => `2026-09-01T${String(hour).padStart(2, '0')}:00:00.${String(micro).padStart(6, '0')}Z`;

test('R02: the persisted fact source, ties, known-at and the readers that must agree', async () => {
  const { pool, one, rows } = await import('../apps/backend/src/db');
  const { migrate } = await import('../scripts/migrate');
  const { seed } = await import('../scripts/seed');
  const { ProductionService } = await import('../apps/backend/src/service');
  const { ReadService } = await import('../apps/backend/src/read-service');
  const { loadObjectScopes, scopeKey } = await import('../apps/backend/src/schedule-scope');
  const { scopePortionInputs } = await import('../apps/backend/src/documentation-scope');
  const { loadPortionFigures, loadWorkFacts, loadWorkEvidence } = await import('../apps/backend/src/fact-resolver');
  const { resolveCompletionObservedAt } = await import('../packages/domain/gpr2/fact-resolver');

  await migrate();
  const tenant = await seed();
  const service = new ProductionService(), read = new ReadService();
  const admin = await one(pool, "SELECT * FROM users WHERE tenant_id=$1 AND role='ADMIN' LIMIT 1", [tenant.id]);

  const freshObject = await one(pool, "SELECT * FROM objects WHERE tenant_id=$1 AND external_code='DEMO-2026-004'", [tenant.id]);
  const legacyObject = await one(pool, "SELECT * FROM objects WHERE tenant_id=$1 AND external_code='DEMO-2026-002'", [tenant.id]);
  const pmOf = (o: any) => one(pool, 'SELECT * FROM users WHERE tenant_id=$1 AND id=$2', [tenant.id, o.projectManagerId]);
  const freshPm = await pmOf(freshObject), legacyPm = await pmOf(legacyObject);
  const freshWorks = await rows(pool, "SELECT * FROM works w WHERE tenant_id=$1 AND object_id=$2 AND actual_quantity=0 AND NOT EXISTS(SELECT 1 FROM work_progress p WHERE p.tenant_id=w.tenant_id AND p.object_work_id=w.id) AND NOT EXISTS(SELECT 1 FROM work_dependencies d WHERE d.tenant_id=w.tenant_id AND (d.successor_work_id=w.id OR d.predecessor_work_id=w.id)) ORDER BY name", [tenant.id, freshObject.id]);
  const legacyWorks = await rows(pool, "SELECT * FROM works w WHERE tenant_id=$1 AND object_id=$2 AND actual_quantity>0 AND status='ACTIVE' AND NOT EXISTS(SELECT 1 FROM work_dependencies d WHERE d.tenant_id=w.tenant_id AND (d.successor_work_id=w.id OR d.predecessor_work_id=w.id)) ORDER BY name", [tenant.id, legacyObject.id]);
  assert.ok(freshWorks.length >= 3, 'fixture: seed() gives the fourth object several untouched Works');
  assert.ok(legacyWorks.length >= 2, 'fixture: seed() gives the second object Works with legacy progress');

  const snapshotWork = async (actor: any, id: string) => (await read.snapshot(actor)).works.find((w: any) => w.id === id);
  const unitFor = (work: any, plannedQuantity: string) => ({ objectWorkId: work.id, workTypeId: work.workTypeId, contractorId: work.contractorId, unit: work.unit, plannedQuantity });
  const classify = async (workId: string, mode: string) => {
    await pool.query('ALTER TABLE works DISABLE TRIGGER works_fact_source_mode_guard');
    await pool.query('UPDATE works SET fact_source_mode=$2 WHERE id=$1', [workId, mode]);
    await pool.query('ALTER TABLE works ENABLE TRIGGER works_fact_source_mode_guard');
  };
  const sdate = (x: any) => JSON.stringify(x, (_k, v) => (v instanceof Date ? v.toISOString() : v));

  // ---------------------------------------------------------------------------------------------------------------------------------
  // A05 — an unclassified Work with a legacy figure: an EMPTY execution unit takes nothing away
  // ---------------------------------------------------------------------------------------------------------------------------------
  {
    const work = legacyWorks[0];
    assert.equal(work.factSourceMode, null, 'nothing in R02 classifies a Work: a seeded Work is unclassified');
    const before = await snapshotWork(admin, work.id);
    assert.ok(Number(before.actualQuantity) > 0);
    const sourceDigestBefore = sdate({ w: await one(pool, 'SELECT * FROM works WHERE id=$1', [work.id]), p: await rows(pool, 'SELECT * FROM work_progress WHERE object_work_id=$1 ORDER BY id', [work.id]) });

    const unit = await service.createExecutionUnit(legacyPm, unitFor(work, '500'));
    const after = await snapshotWork(admin, work.id);
    assert.equal(after.actualQuantity, before.actualQuantity, 'A05: the legacy figure survives the first (empty) execution unit');
    assert.equal(after.factSourceMode, 'LEGACY_WORK');
    assert.equal(after.factSourceModeProvenance, 'DERIVED_UNCLASSIFIED');
    assert.equal(after.factState, 'KNOWN');
    assert.equal(sdate({ w: await one(pool, 'SELECT * FROM works WHERE id=$1', [work.id]), p: await rows(pool, 'SELECT * FROM work_progress WHERE object_work_id=$1 ORDER BY id', [work.id]) }), sourceDigestBefore, 'the immutable source rows are untouched');
    assert.equal((await one(pool, 'SELECT fact_source_mode FROM works WHERE id=$1', [work.id])).factSourceMode, null, 'and still unclassified: a unit is not a classification');

    // the GPR-1 scope reader measures the same figure
    const scope = (await loadObjectScopes(pool, tenant.id, legacyObject.id)).get(scopeKey(work.id, null))!;
    assert.equal(scope.rpFactQuantity, Number(before.actualQuantity).toFixed(4));

    // a unit that nobody has reported on, and a Work that was never reported on: still "nothing reported" (null), not a quiet 0
    const portion = await service.createQuantityPortion(legacyPm, unit.id, { label: 'Захватка 1', plannedQuantity: '500' });
    assert.equal((await snapshotWork(admin, work.id)).actualQuantity, before.actualQuantity, 'an empty portion changes nothing either');

    // The pre-R02 recording behaviour of an unclassified Work is kept (protected F8.x/F12.x flows record portion facts on Works that carry progress);
    // the overlap is reported, not hidden.
    await service.recordPortionFact(legacyPm, portion.id, { quantity: '120', version: portion.version, comment: 'первый факт по участку' });
    const overlap = await snapshotWork(admin, work.id);
    assert.equal(overlap.factState, 'OVERLAP_UNRECONCILED');
    assert.equal(overlap.actualQuantity, '120.0000');
    assert.equal(overlap.factSourceMode, 'PORTION');
    assert.equal(overlap.factSourceModeProvenance, 'DERIVED_UNCLASSIFIED');
    assert.equal((await one(pool, 'SELECT fact_source_mode FROM works WHERE id=$1', [work.id])).factSourceMode, null, 'still nothing written to the Work');
    assert.equal((await rows(pool, 'SELECT * FROM work_fact_source_mode_history WHERE work_id=$1', [work.id])).length, 0);
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  // C13 — a CLASSIFIED legacy Work: the strict gate
  // ---------------------------------------------------------------------------------------------------------------------------------
  {
    const work = legacyWorks[1];
    await classify(work.id, 'LEGACY_WORK');
    const before = await snapshotWork(admin, work.id);
    assert.equal(before.factSourceModeProvenance, 'PERSISTED');
    const unit = await service.createExecutionUnit(legacyPm, unitFor(work, '300'));
    const portion = await service.createQuantityPortion(legacyPm, unit.id, { label: 'П1', plannedQuantity: '300' });
    assert.equal((await snapshotWork(admin, work.id)).actualQuantity, before.actualQuantity, 'persisted LEGACY_WORK: the unit and the portion change nothing');
    await assert.rejects(() => service.recordPortionFact(legacyPm, portion.id, { quantity: '10', version: portion.version, comment: 'x' }), /факт, внесённый по работе в целом/);
    assert.equal((await rows(pool, 'SELECT * FROM portion_quantity_confirmations WHERE portion_id=$1', [portion.id])).length, 0, 'refused: no confirmation row');
    assert.equal((await one(pool, 'SELECT fact_source_mode FROM works WHERE id=$1', [work.id])).factSourceMode, 'LEGACY_WORK', 'and the mode did not move');
    assert.equal((await snapshotWork(admin, work.id)).actualQuantity, before.actualQuantity);
  }
  {
    const work = freshWorks[0];
    await classify(work.id, 'LEGACY_WORK');
    const unit = await service.createExecutionUnit(freshPm, unitFor(work, '400'));
    const portion = await service.createQuantityPortion(freshPm, unit.id, { label: 'П1', plannedQuantity: '400' });
    const quiet = await snapshotWork(admin, work.id);
    assert.deepEqual([quiet.factSourceMode, quiet.actualQuantity], ['LEGACY_WORK', '0.0000']);
    assert.equal((await rows(pool, "SELECT * FROM work_fact_source_mode_history WHERE work_id=$1 AND to_mode='PORTION'", [work.id])).length, 0, 'creating a unit and a portion is not a transition');
    const fact = await service.recordPortionFact(freshPm, portion.id, { quantity: '150', version: portion.version, comment: 'первый факт' });
    assert.equal(fact.quantity, '150.0000');
    assert.equal((await one(pool, 'SELECT fact_source_mode FROM works WHERE id=$1', [work.id])).factSourceMode, 'PORTION', 'the first portion fact of a Work with no legacy fact takes it to PORTION, once');
    const history = await rows(pool, "SELECT * FROM work_fact_source_mode_history WHERE work_id=$1 AND to_mode='PORTION'", [work.id]);
    assert.equal(history.length, 1);
    assert.deepEqual([history[0].fromMode, history[0].toMode, history[0].basis, history[0].changedBy], ['LEGACY_WORK', 'PORTION', 'NO_LEGACY_FACT_AT_FIRST_PORTION_FACT', freshPm.id]);
    const shown = await snapshotWork(admin, work.id);
    assert.deepEqual([shown.factSourceMode, shown.actualQuantity, shown.factState], ['PORTION', '150.0000', 'KNOWN']);
    await service.recordPortionFact(freshPm, portion.id, { quantity: '210', version: portion.version + 1, comment: 'второй факт' });
    assert.equal((await rows(pool, "SELECT * FROM work_fact_source_mode_history WHERE work_id=$1 AND to_mode='PORTION'", [work.id])).length, 1, 'no second transition');
    assert.equal((await snapshotWork(admin, work.id)).actualQuantity, '210.0000');
    const workVersion = (await one(pool, 'SELECT version FROM works WHERE id=$1', [work.id])).version;
    await assert.rejects(() => service.progress(freshPm, work.id, { totalQuantity: '5', version: workVersion, comment: 'legacy' }), /единицами исполнения/, 'a PORTION Work takes no whole-Work fact');
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  // The database guard, directly — whatever the application does
  // ---------------------------------------------------------------------------------------------------------------------------------
  {
    const w = freshWorks[1], v = legacyWorks[0];
    const fails = (sql: string, args: any[], re: RegExp) => assert.rejects(() => pool.query(sql, args), re);
    await fails("UPDATE works SET fact_source_mode='PORTION' WHERE id=$1", [w.id], /NULL -> PORTION is not a permitted change/); // unclassified: only R19
    await fails("UPDATE works SET fact_source_mode='LEGACY_WORK' WHERE id=$1", [w.id], /NULL -> LEGACY_WORK is not a permitted change/);
    await classify(w.id, 'LEGACY_WORK');
    await fails('UPDATE works SET fact_source_mode=NULL WHERE id=$1', [w.id], /LEGACY_WORK -> NULL is not a permitted change/);
    await fails("UPDATE works SET fact_source_mode='bogus' WHERE id=$1", [w.id], /LEGACY_WORK -> bogus is not a permitted change/);
    await fails("INSERT INTO work_fact_source_mode_history(tenant_id,work_id,from_mode,to_mode,basis) VALUES($1,$2,'LEGACY_WORK','bogus','x')", [tenant.id, w.id], /check constraint|violates/);
    await classify(v.id, 'LEGACY_WORK');
    await fails("UPDATE works SET fact_source_mode='PORTION' WHERE id=$1", [v.id], /LEGACY_FACT_PRESENT/); // legacy figure present
    await pool.query("SELECT set_config('gpr2.basis','TEST_BASIS',false)");
    await pool.query("UPDATE works SET fact_source_mode='PORTION' WHERE id=$1", [w.id]); // no legacy fact: allowed
    await pool.query("SELECT set_config('gpr2.basis','',false)");
    const h = await one(pool, "SELECT * FROM work_fact_source_mode_history WHERE work_id=$1 AND to_mode='PORTION'", [w.id]);
    assert.deepEqual([h.fromMode, h.toMode, h.basis], ['LEGACY_WORK', 'PORTION', 'TEST_BASIS'], 'the history is written by the trigger, so no path can skip it');
    await fails("UPDATE works SET fact_source_mode='LEGACY_WORK' WHERE id=$1", [w.id], /PORTION -> LEGACY_WORK is not a permitted change/);
    await fails("UPDATE work_fact_source_mode_history SET basis='x' WHERE id=$1", [h.id], /Append-only history/);
    await fails('DELETE FROM work_fact_source_mode_history WHERE id=$1', [h.id], /Append-only history/);
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  // A24 — ties: one deterministic answer, or an explicit "unknown"; every reader agrees
  // ---------------------------------------------------------------------------------------------------------------------------------
  const tieWork = freshWorks[2];
  const unit = await service.createExecutionUnit(freshPm, unitFor(tieWork, '1000'));
  const portion = await service.createQuantityPortion(freshPm, unit.id, { label: 'Ничья', plannedQuantity: '1000' });
  const insertConfirmation = (source: string, quantity: string, recordedAt: string, extra: { createdAt?: string; seq?: null } = {}) =>
    pool.query(`INSERT INTO portion_quantity_confirmations(tenant_id,portion_id,source,quantity,recorded_by,recorded_at,created_at${extra.seq === null ? ',confirmation_seq' : ''}) VALUES($1,$2,$3,$4,$5,$6::timestamptz,$7::timestamptz${extra.seq === null ? ',NULL' : ''})`,
      [tenant.id, portion.id, source, quantity, freshPm.id, recordedAt, extra.createdAt ?? recordedAt]);
  const everyReaderSays = async (rp: string | null, internal: string | null, customer: string | null, label: string) => {
    const f = (await loadPortionFigures(pool, tenant.id, [portion.id])).get(portion.id)!;
    assert.deepEqual([f.rpFact, f.internalSc, f.customerAccepted], [rp, internal, customer], label + ': loader');
    const doc = (await scopePortionInputs(pool, tenant.id, [portion.id]))[0];
    assert.deepEqual([doc.rpFact, doc.internalSc, doc.customerAccepted], [rp, internal, customer], label + ': documentation scope');
    const shown = (await read.snapshot(admin)).portions.find((p: any) => p.id === portion.id);
    assert.deepEqual([shown.rpFactQuantity, shown.internalScConfirmedQuantity, shown.customerScConfirmedQuantity], [rp, internal, customer], label + ': read model');
  };

  // The confirmations below carry fixed instants in September 2026, so the Work, its unit and its portion are dated before them (a known-at read
  // correctly refuses to see a row that predates the Work it belongs to).
  await pool.query("UPDATE works SET created_at='2026-08-01T00:00:00Z' WHERE id=$1", [tieWork.id]);
  await pool.query("UPDATE work_execution_units SET created_at='2026-08-01T00:00:00Z' WHERE id=$1", [unit.id]);
  await pool.query("UPDATE quantity_portions SET created_at='2026-08-01T00:00:00Z' WHERE id=$1", [portion.id]);
  // legacy-shaped tie (no sequence): different quantities at the very same instant -> unknown, by every reader
  await insertConfirmation('RP_FACT', '400', t(5), { seq: null });
  await insertConfirmation('RP_FACT', '650', t(5), { seq: null });
  await insertConfirmation('INTERNAL_SC', '300', t(7), { seq: null });
  await insertConfirmation('INTERNAL_SC', '300', t(7), { seq: null });
  await everyReaderSays(null, '300.0000', null, 'unorderable tie / agreeing tie');
  {
    const scope = (await loadObjectScopes(pool, tenant.id, freshObject.id)).get(scopeKey(tieWork.id, unit.id))!;
    assert.equal(scope.rpFactQuantity, null, 'GPR-1 scope reader: unknown, not a guess');
    const fact = (await loadWorkFacts(pool, tenant.id, [tieWork.id])).get(tieWork.id)!;
    assert.deepEqual([fact.state, fact.quantity, fact.unknownPortionIds], ['UNKNOWN_TIE', null, [portion.id]]);
  }
  // a LATER confirmation settles it, as it always did
  await insertConfirmation('RP_FACT', '700', t(9));
  await everyReaderSays('700.0000', '300.0000', null, 'a later confirmation');
  // tie among NEW confirmations (they carry a sequence): the later-numbered one is the figure
  await insertConfirmation('RP_FACT', '710', t(11));
  await insertConfirmation('RP_FACT', '720', t(11));
  await everyReaderSays('720.0000', '300.0000', null, 'sequence breaks the tie');
  // CUSTOMER_SC: the whole latest-timestamp group (F12.1)
  await insertConfirmation('CUSTOMER_SC', '100', t(12), { seq: null });
  await insertConfirmation('CUSTOMER_SC', '100', t(12), { seq: null });
  await everyReaderSays('720.0000', '300.0000', '100.0000', 'customer group of two equal values');
  await insertConfirmation('CUSTOMER_SC', '100', t(13), { seq: null });
  await insertConfirmation('CUSTOMER_SC', '250', t(13), { seq: null });
  await everyReaderSays('720.0000', '300.0000', null, 'customer group of two different values is unknown, never one of them');

  // ---------------------------------------------------------------------------------------------------------------------------------
  // Known-at over the real tables, to the microsecond; completionObservedAt
  // ---------------------------------------------------------------------------------------------------------------------------------
  {
    const at = async (knownAt: string | null) => (await loadWorkFacts(pool, tenant.id, [tieWork.id], { knownAt })).get(tieWork.id)!;
    assert.equal((await at(t(6))).state, 'UNKNOWN_TIE', 'at t6 the tie at t5 is already there');
    assert.equal((await at(t(9))).quantity, '700.0000');
    assert.equal((await at(t(10))).quantity, '700.0000');
    assert.equal((await at(null)).quantity, '720.0000');
    // a fact recorded "for" the past but learned later is not visible in the past
    await insertConfirmation('RP_FACT', '999', t(1), { createdAt: t(40) });
    assert.equal((await at(null)).quantity, '720.0000', 'recorded_at t1 is older than the latest, so it does not win now');
    assert.equal((await at(t(30))).quantity, '720.0000');
    const unitB = await service.createExecutionUnit(freshPm, unitFor(freshWorks[0], '100')).catch(() => null); // the classified PORTION Work from above: one more unit is harmless
    void unitB;
    // completion: the run at/above the target started at the first confirmation that reached it
    const evidence = (await loadWorkEvidence(pool, tenant.id, [tieWork.id], { history: true })).get(tieWork.id)!;
    assert.deepEqual(resolveCompletionObservedAt(evidence, '720'), { state: 'OBSERVED', at: t(11), provenance: 'SYSTEM_RECORDED_CREATED_AT' }, 'the run at/above 720 starts where 720 was first recorded, after the old tie');
    assert.deepEqual(resolveCompletionObservedAt(evidence, '400'), { state: 'UNKNOWN', reason: 'TIE_UNORDERABLE' }, 'a run that reaches back into an unorderable tie has no provable start: the date is unknown, not a guess');
  }
  {
    const w = legacyWorks[0];
    const evidence = (await loadWorkEvidence(pool, tenant.id, [w.id], { history: true })).get(w.id)!;
    const target = evidence.legacyActualQuantity;
    const observed = resolveCompletionObservedAt({ ...evidence, units: [], persistedMode: null }, target);
    assert.equal(observed.state, 'OBSERVED', 'legacy figure with a progress row: the instant the system recorded it');
    assert.equal((observed as any).provenance, 'SYSTEM_RECORDED_CREATED_AT');
    const noHistory = resolveCompletionObservedAt({ ...evidence, units: [], persistedMode: null, legacyProgress: [] }, target);
    assert.deepEqual(noHistory, { state: 'UNKNOWN', reason: 'HISTORY_UNAVAILABLE' }, 'the same figure without any history is not an observed completion');
  }
});
