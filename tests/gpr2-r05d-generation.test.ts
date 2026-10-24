import './helpers/gpr2-isolation'; // FIRST: no backend module may load before the environment is pinned to in-memory PGlite
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { gpr2Harness, pilotScenario, uuid, type Gpr2Harness } from './helpers/gpr2-fixtures';
import type { Pilot } from './helpers/gpr-fixtures';
import { assertInMemoryPool } from './helpers/gpr2-isolation';

/**
 * GPR-2 R05d — Work generation preview / confirm (TD §4.1, §5.2, §11.1–11.2, §12.2–12.4; D01, D06, D09; A01, A07, A12, A19, A30) over the real backend on
 * in-memory PGlite. Concurrent confirms, lock waits and two-session constraint races are native PostgreSQL claims: gpr2-r05-native-pg.test.ts.
 */
let g: Gpr2Harness;
let pilot: Pilot;
let db: any;
let pmToken: string, otherPmToken: string, adminToken: string, tenant: string;
const T: Record<string, string> = {};
const A: Record<string, string> = {};
let ft = '', sv1 = '';
before(async () => {
  g = await gpr2Harness('gpr2-r05d-key'); pilot = await pilotScenario(g.h); assert.equal(await assertInMemoryPool(), true);
  db = await import('../apps/backend/src/db');
  pmToken = await g.tokenFor(pilot.pm); otherPmToken = await g.tokenFor(pilot.other); adminToken = await g.roleToken('ADMIN'); tenant = await g.tenantId();
  await g.h.login('ADMIN');
  for (const [k, name, unit] of [['primer', 'Грунтование', 'м²'], ['plaster', 'Штукатурка', 'м²'], ['putty', 'Шпаклевание', 'м²'], ['paint', 'Покраска', 'м²'], ['water', 'Гидроизоляция', 'м²'], ['tile', 'Плитка', 'м²']])
    T[k] = (await g.h.req('dictionaries/work-types', { categoryId: pilot.plaster.categoryId, name, unit, requiresInspection: true, requiresExecutiveDocs: true, requiresMaterials: true })).id;
  const mk = async (key: string, payload: any) => { const r = await post(pmToken, `/objects/${pilot.object.id}/area-scopes`, { payload }); assert.equal(r.status, 200, JSON.stringify(r.body)); A[key] = r.body.resultIds[0]; };
  await mk('B', { kind: 'BUILDING', code: 'B', name: 'Корпус' });
  await mk('S1', { parentId: A.B, kind: 'SECTION', code: 'S1', name: 'Секция 1', measureQuantity: '1000', measureUnit: 'м²' });
  await mk('F1', { parentId: A.S1, kind: 'FLOOR', code: 'S1-F1', name: 'Этаж 1', measureQuantity: '600', measureUnit: 'м²' });
  await mk('F2', { parentId: A.S1, kind: 'FLOOR', code: 'S1-F2', name: 'Этаж 2', measureQuantity: '400', measureUnit: 'м²' });
  await mk('S2', { parentId: A.B, kind: 'SECTION', code: 'S2', name: 'Секция 2', measureQuantity: '500', measureUnit: 'м²' });
  await mk('NOMEASURE', { parentId: A.B, kind: 'ROOM', code: 'R-NOMEASURE', name: 'Помещение без обмера' });
  await mk('CUBIC', { parentId: A.B, kind: 'ZONE', code: 'Z-CUBIC', name: 'Зона в м³', measureQuantity: '30', measureUnit: 'м³' });
  const sys = await post(pmToken, `/objects/${pilot.object.id}/finish-systems`, { payload: { finishType: { code: 'TYPE-1', name: 'Тип №1', }, stages: [
    stage('PRIMER_1', 1, T.primer, { proposedHoldHours: '4' }), stage('PLASTER', 2, T.plaster, { proposedHoldHours: '48' }), stage('PRIMER_2', 3, T.primer), stage('PUTTY', 4, T.putty), stage('PAINT', 5, T.paint),
    stage('WATERPROOF', 6, T.water, { required: false, measureScope: 'LOCAL' })] } });
  assert.equal(sys.status, 200, JSON.stringify(sys.body));
  [ft, sv1] = sys.body.resultIds;
});
after(async () => { await g?.h.close(); });

function stage(occurrenceKey: string, position: number, workTypeId: string, extra: any = {}) { return { occurrenceKey, position, workTypeId, required: true, measureScope: 'MAIN', measureUnit: 'м²', ...extra }; }
const post = (token: string | null, path: string, body: unknown, key: string | null = uuid()) =>
  g.call(token, 'POST', '/v2' + path, { body, headers: key ? { 'Idempotency-Key': key } : {} });
const q = async (sql: string, args: any[] = []) => (await db.pool.query(sql, args)).rows;
const n = async (sql: string, args: any[] = []) => Number((await q(sql, args))[0].n);
const fails = async (sql: string, args: any[], re: RegExp) => assert.rejects(db.pool.query(sql, args), (e: any) => re.test(e.message), sql);
const TABLES = ['works', 'work_execution_units', 'quantity_portions', 'portion_quantity_confirmations', 'work_progress', 'work_scope_bindings', 'work_scope_state', 'gpr2_command_ledger',
  'audit_logs', 'domain_events', 'notifications', 'object_area_scopes', 'object_finish_types', 'object_finish_system_versions', 'finish_stage_occurrences', 'idempotent_commands'];
const digestAll = async () => Promise.all(TABLES.map(async t => [t, (await q(`SELECT md5(coalesce(string_agg(row_to_json(x)::text, '|' ORDER BY row_to_json(x)::text), '')) AS d, count(*)::int AS c FROM ${t} x`))[0]]));
const preview = (payload: any, opts: { token?: string; finishType?: string; expectedVersion?: string } = {}) =>
  post(opts.token ?? pmToken, `/objects/${pilot.object.id}/finish-systems/${opts.finishType ?? ft}/preview`, { expectedVersion: opts.expectedVersion ?? '1', payload }, null);
async function okPreview(payload: any) { const r = await preview(payload); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.preview; }
const confirm = (p: any, payload: any, opts: { key?: string; token?: string; scope?: string; fingerprint?: string; source?: string; finishType?: string } = {}) =>
  post(opts.token ?? pmToken, `/objects/${pilot.object.id}/finish-systems/${opts.finishType ?? ft}/confirm`, {
    expectedVersion: '1', expectedScopeVersion: opts.scope ?? p.scopeVersion,
    payload: { ...payload, previewFingerprint: opts.fingerprint ?? p.previewFingerprint, expectedSourceVersions: { systemVersion: opts.source ?? p.systemVersionId } }
  }, opts.key ?? uuid());

let mainKey = '', mainResult: any, mainPayload: any;

test('R05d-12 preview: proposed Works per occurrence (the two primers stay two Works), nothing invented, zero database writes', async () => {
  mainPayload = { systemVersionId: sv1, areaScopeIds: [A.S1], includeOptional: ['WATERPROOF'], localQuantities: [{ occurrenceKey: 'WATERPROOF', areaScopeId: A.F1, quantity: '150' }] };
  const before = await digestAll();
  const r = await preview(mainPayload);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const p = r.body.preview;
  assert.deepEqual(await digestAll(), before, 'a preview writes nothing — not a Work, a binding, a ledger row, an audit row or a scope bump');
  assert.equal(p.canConfirm, true); assert.deepEqual(p.blockers, []);
  assert.match(p.previewFingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(p.proposedWorks.map((w: any) => [w.occurrenceKey, w.quantity, w.unit, w.areaScopeIds.length]),
    [['PRIMER_1', '1000.0000', 'м²', 2], ['PLASTER', '1000.0000', 'м²', 2], ['PRIMER_2', '1000.0000', 'м²', 2], ['PUTTY', '1000.0000', 'м²', 2], ['PAINT', '1000.0000', 'м²', 2], ['WATERPROOF', '150.0000', 'м²', 1]]);
  const primers = p.proposedWorks.filter((w: any) => w.workTypeId === T.primer);
  assert.equal(primers.length, 2); assert.notEqual(primers[0].occurrenceId, primers[1].occurrenceId, 'WorkType ≠ StageOccurrence');
  for (const w of p.proposedWorks) assert.deepEqual([w.contractorId, w.responsibleUserId, w.estimatedCost, w.plannedStartDate, w.plannedFinishDate, w.sourceSystemVersionId], [null, null, null, null, null, sv1]);
  assert.deepEqual(p.proposedWorks.find((w: any) => w.occurrenceKey === 'PLASTER').proposedHold, { hours: '48.000000000000', status: 'PROPOSAL' });
  assert.deepEqual(p.warnings.map((w: any) => w.code).sort(), ['EARLY_WORK_UNASSIGNED', 'PROPOSED_HOLD_NOT_NORMATIVE']);
  assert.equal(p.scopeVersion, r.body.appliedVersions.scope);
  // the same preview twice is the same fingerprint; the order the client lists ids in does not matter
  assert.equal((await okPreview({ ...mainPayload })).previewFingerprint, p.previewFingerprint);
  // an optional LOCAL stage left out is simply not proposed; local quantities apply only where stated
  const without = await okPreview({ systemVersionId: sv1, areaScopeIds: [A.S1] });
  assert.deepEqual(without.proposedWorks.map((w: any) => w.occurrenceKey), ['PRIMER_1', 'PLASTER', 'PRIMER_2', 'PUTTY', 'PAINT']);
  assert.notEqual(without.previewFingerprint, p.previewFingerprint);
});

test('R05d-19 blockers: a missing quantity or unit, a unit mismatch, overlapping selections, a local quantity in the wrong place — structured, never invented', async () => {
  const missing = await okPreview({ systemVersionId: sv1, areaScopeIds: [A.NOMEASURE] });
  assert.equal(missing.canConfirm, false);
  assert.ok(missing.blockers.every((b: any) => b.error === 'MISSING_REQUIRED_DATA' && b.rule === 'QUANTITY_MISSING' && b.areaScopeId === A.NOMEASURE));
  assert.equal(missing.blockers.length, 5); assert.equal(missing.missingInputs.length, 5);
  assert.deepEqual(missing.proposedWorks, [], 'no quantity → no Work proposed, nothing guessed');
  const before = await n('SELECT count(*)::int AS n FROM works');
  const r = await confirm(missing, { systemVersionId: sv1, areaScopeIds: [A.NOMEASURE] });
  assert.equal(r.status, 422); assert.equal(r.body.code, 'MISSING_REQUIRED_DATA');
  assert.ok(r.body.details.violations.every((v: any) => v.rule === 'QUANTITY_MISSING'));
  const cubic = await okPreview({ systemVersionId: sv1, areaScopeIds: [A.CUBIC] });
  assert.ok(cubic.blockers.length && cubic.blockers.every((b: any) => b.error === 'INVALID_MEASUREMENT' && b.rule === 'UNIT_MISMATCH'), 'м³ is not м² — no conversion');
  assert.equal((await confirm(cubic, { systemVersionId: sv1, areaScopeIds: [A.CUBIC] })).body.code, 'INVALID_MEASUREMENT');
  const overlap = await okPreview({ systemVersionId: sv1, areaScopeIds: [A.S1, A.F1] });
  assert.equal(overlap.blockers[0].error, 'AREA_SCOPE_CONFLICT'); assert.equal(overlap.blockers[0].rule, 'AREA_OVERLAP');
  assert.equal((await confirm(overlap, { systemVersionId: sv1, areaScopeIds: [A.S1, A.F1] })).body.code, 'AREA_SCOPE_CONFLICT');
  const wrongLocal = await okPreview({ systemVersionId: sv1, areaScopeIds: [A.S2], includeOptional: ['WATERPROOF'], localQuantities: [{ occurrenceKey: 'WATERPROOF', areaScopeId: A.F1, quantity: '10' }] });
  assert.ok(wrongLocal.blockers.some((b: any) => b.rule === 'REFERENCE_NOT_IN_SCOPE' && b.error === 'INVALID_MEASUREMENT'));
  const requiredLocal = await post(pmToken, `/objects/${pilot.object.id}/finish-systems`, { payload: { finishType: { code: 'LOCAL-REQ', name: 'Обязательная локальная' }, stages: [stage('WP', 1, T.water, { measureScope: 'LOCAL' })] } });
  const [ftLocal, svLocal] = requiredLocal.body.resultIds;
  const noLocal = (await preview({ systemVersionId: svLocal, areaScopeIds: [A.S2] }, { finishType: ftLocal })).body.preview;
  assert.deepEqual(noLocal.blockers.map((b: any) => [b.error, b.rule, b.path]), [['MISSING_REQUIRED_DATA', 'QUANTITY_MISSING', 'localQuantities']]);
  assert.equal(await n('SELECT count(*)::int AS n FROM works'), before, 'refused confirms created nothing');
  // invalid input is refused before anything: a zero / negative / malformed local quantity, an unknown optional key
  for (const bad of [{ quantity: '0' }, { quantity: '-1' }, { quantity: 1.5 }])
    assert.equal((await preview({ systemVersionId: sv1, areaScopeIds: [A.S2], includeOptional: ['WATERPROOF'], localQuantities: [{ occurrenceKey: 'WATERPROOF', areaScopeId: A.S2, ...bad }] })).status, 422);
  const unknownOptional = await preview({ systemVersionId: sv1, areaScopeIds: [A.S2], includeOptional: ['PAINT'] }); // PAINT is required, not an optional key
  assert.equal(unknownOptional.status, 422); assert.equal(unknownOptional.body.code, 'CROSS_SCOPE_REFERENCE');
});

test('R05d-13/14 confirm: atomic Works + producer bindings in one transaction; retry with the same key returns the same Work ids and writes nothing', async () => {
  const p = await okPreview(mainPayload);
  const worksBefore = await q('SELECT id, md5(row_to_json(w)::text) AS d FROM works w ORDER BY id');
  mainKey = uuid();
  const r = await confirm(p, mainPayload, { key: mainKey });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  mainResult = r.body;
  assert.equal(r.body.resultIds.length, 6);
  assert.equal(r.body.appliedVersions.aggregate, '1');
  assert.ok(BigInt(r.body.appliedVersions.scope) > BigInt(p.scopeVersion), 'the object scope version moved');
  const works = await q('SELECT * FROM works WHERE id = ANY($1::uuid[])', [r.body.resultIds]);
  assert.equal(works.length, 6);
  for (const w of works) {
    assert.equal(w.object_id, pilot.object.id); assert.equal(w.unit, 'м²'); assert.equal(w.status, 'PLANNED');
    assert.deepEqual([w.contractor_id, w.responsible_user_id, w.estimated_cost, w.planned_start_date, w.planned_finish_date, w.fact_source_mode], [null, null, null, null, null, null], 'R04: nothing invented');
  }
  const bindings = await q('SELECT * FROM work_scope_bindings WHERE work_id = ANY($1::uuid[]) ORDER BY occurrence_key, area_scope_id', [r.body.resultIds]);
  assert.equal(bindings.length, 11, '5 main stages × 2 floors + 1 local');
  assert.ok(bindings.every((b: any) => b.command_id === r.body.commandId && b.finish_type_id === ft && b.system_version_id === sv1));
  assert.deepEqual(bindings.filter((b: any) => b.occurrence_key === 'WATERPROOF').map((b: any) => [b.area_scope_id, b.basis_quantity, b.measure_scope]), [[A.F1, '150.0000', 'LOCAL']]);
  const primerWorks = new Set(bindings.filter((b: any) => b.occurrence_key.startsWith('PRIMER')).map((b: any) => b.work_id));
  assert.equal(primerWorks.size, 2, 'two primer occurrences → two Works, never merged');
  // every pre-existing Work row is byte-identical
  const after = new Map((await q('SELECT id, md5(row_to_json(w)::text) AS d FROM works w')).map((x: any) => [x.id, x.d]));
  for (const w of worksBefore) assert.equal(after.get(w.id), w.d, 'historical Work ' + w.id + ' unchanged');
  // lost-response retry: the same key + payload → the stored result, not one new row
  const snapshot = await digestAll();
  const again = await confirm(p, mainPayload, { key: mainKey });
  assert.equal(again.status, 200); assert.deepEqual(again.body, r.body);
  assert.deepEqual(await digestAll(), snapshot, 'a replay writes nothing');
  // the preview now shows them as EXISTING, and a new confirm of the same obligations is refused
  const p2 = await okPreview(mainPayload);
  assert.equal(p2.proposedWorks.length, 0); assert.equal(p2.existingWorks.length, 11);
  assert.deepEqual(p2.blockers.map((b: any) => [b.error, b.rule]), [['ONE_PRODUCER_CONFLICT', 'NOTHING_TO_GENERATE']]);
  const dup = await confirm(p2, mainPayload);
  assert.equal(dup.status, 422); assert.equal(dup.body.code, 'ONE_PRODUCER_CONFLICT');
  assert.deepEqual(await digestAll(), snapshot);
});

test('R05d-15 same key + different semantic payload → 409 IDEMPOTENCY_PAYLOAD_MISMATCH, nothing executed; replay re-authorises (A19)', async () => {
  const snapshot = await digestAll();
  const p = await okPreview(mainPayload);
  const other = await confirm(p, { ...mainPayload, grouping: 'PER_AREA' }, { key: mainKey });
  assert.equal(other.status, 409); assert.equal(other.body.code, 'IDEMPOTENCY_PAYLOAD_MISMATCH');
  const fence = await confirm(p, mainPayload, { key: mainKey, scope: '0' });
  assert.equal(fence.status, 409); assert.equal(fence.body.code, 'IDEMPOTENCY_PAYLOAD_MISMATCH', 'expected versions are part of the fingerprint');
  // the key is not a door: another РП, ADMIN, the deputy
  assert.equal((await confirm(p, mainPayload, { key: mainKey, token: otherPmToken })).status, 404);
  assert.equal((await confirm(p, mainPayload, { key: mainKey, token: adminToken })).status, 403);
  assert.equal((await confirm(p, mainPayload, { key: mainKey, token: await g.roleToken('DEPUTY_DIRECTOR') })).status, 403);
  // the owner loses the object: the stored result is not replayed to them
  await db.pool.query('UPDATE objects SET project_manager_id=$2 WHERE id=$1', [pilot.object.id, pilot.other.id]);
  try { assert.equal((await post(pmToken, `/objects/${pilot.object.id}/finish-systems/${ft}/confirm`, { expectedVersion: '1', expectedScopeVersion: p.scopeVersion, payload: { ...mainPayload, previewFingerprint: p.previewFingerprint, expectedSourceVersions: { systemVersion: sv1 } } }, mainKey)).status, 404); }
  finally { await db.pool.query('UPDATE objects SET project_manager_id=$2 WHERE id=$1', [pilot.object.id, pilot.pm.id]); }
  assert.deepEqual(await digestAll(), snapshot);
});

test('R05d stale inputs: scope changed (409), stale preview (409), superseded source version (409), stale aggregate (409), foreign references (422 / 404)', async () => {
  const payload = { systemVersionId: sv1, areaScopeIds: [A.S2] };
  // scope changed: a Work created in the object after the preview (legacy POST /works bumps the scope version in PostgreSQL)
  const p1 = await okPreview(payload);
  await g.h.as(pilot.pm);
  await g.h.req('works', { objectId: pilot.object.id, workTypeId: T.tile, name: 'Плитка вне системы', unit: 'м²', plannedQuantity: '5', idempotencyKey: uuid() });
  const scope = await confirm(p1, payload);
  assert.equal(scope.status, 409); assert.equal(scope.body.code, 'SCOPE_VERSION_CHANGED');
  // stale preview: the AreaScope tree changed (a child under S2) — the scope version did not, the preview did
  const p2 = await okPreview(payload);
  const child = (await post(pmToken, `/objects/${pilot.object.id}/area-scopes`, { payload: { parentId: A.S2, kind: 'ROOM', code: 'S2-R1', name: 'Комната', measureQuantity: '200', measureUnit: 'м²' } })).body.resultIds[0];
  A.S2R1 = child;
  const stale = await confirm(p2, payload);
  assert.equal(stale.status, 409); assert.equal(stale.body.code, 'STALE_PREVIEW');
  // a forged / mistyped fingerprint is the same answer
  assert.equal((await confirm(await okPreview(payload), payload, { fingerprint: 'f'.repeat(64) })).body.code, 'STALE_PREVIEW');
  // superseded source version: a new finish-system version is published after the preview
  const p3 = await okPreview(payload);
  const v2 = await post(pmToken, `/objects/${pilot.object.id}/finish-systems`, { payload: { finishTypeId: ft, stages: [stage('PLASTER', 1, T.plaster), stage('PAINT', 2, T.paint)] } });
  assert.equal(v2.status, 200);
  const src = await confirm(p3, payload);
  assert.equal(src.status, 409); assert.equal(src.body.code, 'STALE_SOURCE_VERSION');
  const oldVersion = await okPreview(payload);
  assert.equal(oldVersion.canConfirm, false); assert.equal(oldVersion.blockers[0].error, 'STALE_SOURCE_VERSION', 'the old version is still readable, never confirmable');
  assert.equal((await confirm(p3, payload, { source: uuid() })).body.code, 'STALE_SOURCE_VERSION', 'the fence must name the confirmed version');
  // stale aggregate token
  assert.equal((await preview(payload, { expectedVersion: '9' })).body.code, 'STALE_VERSION');
  // a reference outside the object: another object's AreaScope, another finish type's version — the same 422; another object's finish system — 404
  const theirArea = (await post(otherPmToken, `/objects/${pilot.neighbour.id}/area-scopes`, { payload: { kind: 'ROOM', code: 'THEIRS', name: 'x', measureQuantity: '5', measureUnit: 'м²' } })).body.resultIds[0];
  const cross = await preview({ systemVersionId: sv1, areaScopeIds: [theirArea] });
  assert.equal(cross.status, 422); assert.equal(cross.body.code, 'CROSS_SCOPE_REFERENCE');
  const otherFt = (await post(pmToken, `/objects/${pilot.object.id}/finish-systems`, { payload: { finishType: { code: 'TYPE-2', name: 'Тип №2' }, stages: [stage('PLASTER', 1, T.plaster), stage('TILE', 2, T.tile)] } })).body.resultIds;
  assert.equal((await preview({ systemVersionId: otherFt[1], areaScopeIds: [A.S2] })).body.code, 'CROSS_SCOPE_REFERENCE', "another finish type's version is not this system's");
  const theirSystem = (await post(otherPmToken, `/objects/${pilot.neighbour.id}/finish-systems`, { payload: { finishType: { code: 'N-1', name: 'x' }, stages: [stage('PAINT', 1, T.paint)] } })).body.resultIds[0];
  assert.equal((await preview({ systemVersionId: sv1, areaScopeIds: [A.S2] }, { finishType: theirSystem })).status, 404);
  assert.equal((await preview({ systemVersionId: sv1, areaScopeIds: [A.S2] }, { finishType: uuid() })).status, 404);
  // permissions: only the РП of the object; ADMIN gets nothing from its legacy "all permissions"
  assert.equal((await preview(payload, { token: adminToken })).status, 403);
  assert.equal((await preview(payload, { token: otherPmToken })).status, 404);
});

test('R05d-18 one producer per atomic obligation: a child of a produced AreaScope cannot get a second producer; Тип №2 «Штукатурка» is another obligation', async () => {
  const child = (await post(pmToken, `/objects/${pilot.object.id}/area-scopes`, { payload: { parentId: A.F1, kind: 'ROOM', code: 'F1-R1', name: 'Комната этажа 1', measureQuantity: '100', measureUnit: 'м²' } })).body.resultIds[0];
  const svCurrent = (await q('SELECT id FROM object_finish_system_versions WHERE finish_type_id=$1 ORDER BY version_number DESC LIMIT 1', [ft]))[0].id;
  const p = await okPreview({ systemVersionId: svCurrent, areaScopeIds: [A.F1] }); // F1 now has a child; F1 itself was produced for PLASTER / PAINT
  assert.ok(p.blockers.some((b: any) => b.error === 'ONE_PRODUCER_CONFLICT' && b.rule === 'PRODUCER_EXISTS' && b.areaScopeId === child));
  const r = await confirm(p, { systemVersionId: svCurrent, areaScopeIds: [A.F1] });
  assert.equal(r.status, 422); assert.equal(r.body.code, 'ONE_PRODUCER_CONFLICT');
  // another finish type over the same floors is a separate obligation (not merged with Тип №1's plaster) — and is flagged, not silently allowed
  const t2 = (await q("SELECT id FROM object_finish_types WHERE object_id=$1 AND code='TYPE-2'", [pilot.object.id]))[0].id;
  const t2v = (await q('SELECT id FROM object_finish_system_versions WHERE finish_type_id=$1', [t2]))[0].id;
  const p2 = (await preview({ systemVersionId: t2v, areaScopeIds: [A.F2] }, { finishType: t2 })).body.preview;
  assert.equal(p2.canConfirm, true);
  assert.ok(p2.warnings.some((w: any) => w.code === 'AREA_HAS_OTHER_FINISH_TYPE'));
  const ok = await post(pmToken, `/objects/${pilot.object.id}/finish-systems/${t2}/confirm`, { expectedVersion: '1', expectedScopeVersion: p2.scopeVersion, payload: { systemVersionId: t2v, areaScopeIds: [A.F2], previewFingerprint: p2.previewFingerprint, expectedSourceVersions: { systemVersion: t2v } } }, uuid());
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const plaster = await q("SELECT DISTINCT work_id, finish_type_id FROM work_scope_bindings WHERE area_scope_id=$1 AND occurrence_key='PLASTER'", [A.F2]);
  assert.equal(plaster.length, 2); assert.notEqual(plaster[0].work_id, plaster[1].work_id, 'two finish systems, two plaster Works');
});

test('R05d-17 PostgreSQL one-producer guard without the API (PGlite; the concurrent form is native): duplicate, overlap, foreign Work, historical Work, wrong unit', async () => {
  const b = (await q("SELECT * FROM work_scope_bindings WHERE finish_type_id=$1 AND occurrence_key='PLASTER' AND area_scope_id=$2", [ft, A.F1]))[0];
  const cols = 'tenant_id,object_id,work_id,finish_type_id,system_version_id,occurrence_id,occurrence_key,area_scope_id,measure_scope,basis_quantity,command_id,created_by';
  const ins = (o: any) => db.pool.query(`INSERT INTO work_scope_bindings(${cols}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [tenant, o.object ?? pilot.object.id, o.work ?? b.work_id, ft, sv1, b.occurrence_id, 'PLASTER', o.area ?? b.area_scope_id, 'MAIN', '1', uuid(), pilot.pm.id]);
  await assert.rejects(ins({}), (e: any) => e.code === '23505' && e.constraint === 'work_scope_bindings_one_producer', 'the same obligation twice');
  await assert.rejects(ins({ area: A.S1 }), (e: any) => /GPR2_R05:ONE_PRODUCER_CONFLICT/.test(e.message), 'the parent of a produced leaf');
  const fresh = (await q("INSERT INTO works(tenant_id,object_id,work_type_id,name,unit,planned_quantity) VALUES($1,$2,$3,'x','м²',1) RETURNING id", [tenant, pilot.object.id, T.plaster]))[0].id;
  await assert.rejects(ins({ work: fresh, area: (await q("SELECT id FROM object_area_scopes WHERE code='F1-R1'"))[0].id }), (e: any) => /GPR2_R05:ONE_PRODUCER_CONFLICT/.test(e.message), 'the child of a produced leaf');
  await assert.rejects(ins({ work: pilot.plasterWork.work.id, area: A.S2 }), (e: any) => /GPR2_R05:(HISTORICAL_WORK|INVALID_MEASUREMENT)/.test(e.message), 'a historical Work is never bound');
  await assert.rejects(ins({ work: pilot.neighbourWork.work.id, area: A.S2 }), (e: any) => /GPR2_R05:CROSS_SCOPE_REFERENCE/.test(e.message), 'a Work of another object');
  const wrong = (await q("INSERT INTO works(tenant_id,object_id,work_type_id,name,unit,planned_quantity) VALUES($1,$2,$3,'x','м²',1) RETURNING id", [tenant, pilot.object.id, T.paint]))[0].id;
  await assert.rejects(ins({ work: wrong, area: A.NOMEASURE }), (e: any) => /GPR2_R05:INVALID_MEASUREMENT/.test(e.message), 'the Work must have the occurrence WorkType');
  await fails('UPDATE work_scope_bindings SET area_scope_id=$2 WHERE id=$1', [b.id, A.S2], /Append-only/);
  await fails('DELETE FROM work_scope_bindings WHERE id=$1', [b.id], /Append-only/);
  await fails("UPDATE object_area_scopes SET lifecycle='RETIRED', version=version+1 WHERE id=$1", [A.F2], /GPR2_R05:AREA_SCOPE_CONFLICT/);
});

test('R05d-20 R04 Early Work compatibility: a generated Work is the same real Work — visible, planning completed later, production blocked until assignments exist', async () => {
  const workId = mainResult.resultIds[1];
  await g.h.as(pilot.pm);
  const snap = await g.h.req('snapshot');
  const seen = snap.works.find((w: any) => w.id === workId);
  assert.ok(seen, 'the generated Work is in the read model (LEFT JOINs: no contractor yet)');
  const row = (await q('SELECT * FROM works WHERE id=$1', [workId]))[0];
  const start = await g.h.raw(`works/${workId}/start`, { version: row.version });
  assert.notEqual(start.status, 201, 'no production before contractor and responsible are assigned');
  const fact = await g.h.raw(`works/${workId}/progress`, { totalQuantity: 1, version: row.version, comment: 'x' });
  assert.notEqual(fact.status, 201);
  const assigned = (await q('SELECT contractor_id FROM object_contractors_active WHERE tenant_id=$1 AND object_id=$2 LIMIT 1', [tenant, pilot.object.id]))[0].contractor_id;
  const planned = await g.h.req(`works/${workId}/complete-planning`, { contractorId: assigned, responsibleUserId: pilot.pm.id, version: row.version, idempotencyKey: uuid() }, 201);
  assert.equal(planned.id, workId, 'the same identity after planning');
  assert.equal(planned.estimatedCost, null, 'unknown cost stays NULL, not 0');
  const started = await g.h.req(`works/${workId}/start`, { version: planned.version }, 201);
  assert.equal(started.id, workId); assert.equal(started.status, 'ACTIVE');
  assert.equal((await q('SELECT count(*)::int AS n FROM work_scope_bindings WHERE work_id=$1', [workId]))[0].n, 2, 'its producer bindings are unchanged by planning / start');
});

test('R05d A30 atomicity: a failure after the first Work is inserted rolls back EVERYTHING — Works, bindings, scope bump, audit, ledger claim; the retry runs clean', async () => {
  const payload = { systemVersionId: (await q('SELECT id FROM object_finish_system_versions WHERE finish_type_id=$1 ORDER BY version_number DESC LIMIT 1', [ft]))[0].id, areaScopeIds: [A.S2R1] };
  const p = await okPreview(payload);
  assert.equal(p.proposedWorks.length, 2);
  await db.pool.query(`CREATE FUNCTION r05_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.occurrence_key = 'PAINT' THEN RAISE EXCEPTION 'injected failure after the first Work'; END IF; RETURN NEW; END $$`);
  await db.pool.query('CREATE TRIGGER r05_test_fail AFTER INSERT ON work_scope_bindings FOR EACH ROW EXECUTE FUNCTION r05_test_fail()');
  const before = await digestAll();
  const key = uuid();
  try {
    const r = await confirm(p, payload, { key });
    assert.equal(r.status, 500, JSON.stringify(r.body));
    assert.deepEqual(await digestAll(), before, 'nothing of the aborted command survives: no Work, binding, scope bump, audit or ledger row');
  } finally {
    await db.pool.query('DROP TRIGGER r05_test_fail ON work_scope_bindings'); await db.pool.query('DROP FUNCTION r05_test_fail()');
  }
  const retry = await confirm(p, payload, { key });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.resultIds.length, 2, 'the retry is a clean first execution of the same command');
});

test('R05d per-area grouping and legacy overlap warning: one Work per leaf on request; an unbound historical Work of the same WorkType is shown, never merged', async () => {
  const sys = await post(pmToken, `/objects/${pilot.object.id}/finish-systems`, { payload: { finishType: { code: 'TYPE-PA', name: 'По захваткам' }, stages: [stage('PLASTER', 1, T.plaster)] } });
  const [ftPa, svPa] = sys.body.resultIds;
  await g.h.as(pilot.pm);
  await g.h.req('works', { objectId: pilot.object.id, workTypeId: T.plaster, name: 'Историческая штукатурка', unit: 'м²', plannedQuantity: '50', idempotencyKey: uuid() });
  const p = (await preview({ systemVersionId: svPa, areaScopeIds: [A.S1], grouping: 'PER_AREA' }, { finishType: ftPa })).body.preview;
  // S1's leaves today: F1-R1 (the room added under F1 above — F1 itself is no longer a leaf) and F2
  assert.deepEqual(p.proposedWorks.map((w: any) => [w.areaScopeIds.length, w.quantity]).sort(), [[1, '100.0000'], [1, '400.0000']]);
  assert.ok(p.warnings.some((w: any) => w.code === 'LEGACY_WORK_SAME_WORK_TYPE'), 'possible overlap with a historical Work is visible');
  const r = await post(pmToken, `/objects/${pilot.object.id}/finish-systems/${ftPa}/confirm`, { expectedVersion: '1', expectedScopeVersion: p.scopeVersion, payload: { systemVersionId: svPa, areaScopeIds: [A.S1], grouping: 'PER_AREA', previewFingerprint: p.previewFingerprint, expectedSourceVersions: { systemVersion: svPa } } }, uuid());
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.resultIds.length, 2);
  assert.equal(Number((await q("SELECT count(*)::int AS n FROM works WHERE name='Историческая штукатурка'"))[0].n), 1, 'the historical Work is untouched and unbound');
});
