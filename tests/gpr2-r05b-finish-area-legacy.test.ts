import './helpers/gpr2-isolation'; // FIRST: no backend module may load before the environment is pinned to in-memory PGlite
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { gpr2Harness, foreignTenantObject, pilotScenario, uuid, type Gpr2Harness } from './helpers/gpr2-fixtures';
import type { Pilot } from './helpers/gpr-fixtures';
import { assertInMemoryPool } from './helpers/gpr2-isolation';

/**
 * GPR-2 R05b — object finish registry, AreaScopes, legacy finish mapping and historical Work classification (TD §4.1, §5.2, §13.2 I05; D01, D03, D20,
 * C02; A01, A03, A25) over the real backend on in-memory PGlite. Every refusal asserts that nothing was written; direct SQL proves the infra/030
 * guards hold without the API. Concurrent sibling inserts under one parent are a native PostgreSQL claim — gpr2-r05-native-pg.test.ts.
 */
let g: Gpr2Harness;
let pilot: Pilot;
let db: any;
let pmToken: string, otherPmToken: string, tenant: string;
let svc: typeof import('../apps/backend/src/gpr2-r05-legacy');
let catalog: typeof import('../apps/backend/src/gpr2-r05-catalog');
before(async () => {
  g = await gpr2Harness('gpr2-r05b-key'); pilot = await pilotScenario(g.h); assert.equal(await assertInMemoryPool(), true);
  db = await import('../apps/backend/src/db');
  svc = await import('../apps/backend/src/gpr2-r05-legacy');
  catalog = await import('../apps/backend/src/gpr2-r05-catalog');
  pmToken = await g.tokenFor(pilot.pm); otherPmToken = await g.tokenFor(pilot.other); tenant = await g.tenantId();
});
after(async () => { await g?.h.close(); });

const post = (token: string | null, path: string, body: unknown, key: string | null = uuid()) =>
  g.call(token, 'POST', '/v2' + path, { body, headers: key ? { 'Idempotency-Key': key } : {} });
const q = async (sql: string, args: any[] = []) => (await db.pool.query(sql, args)).rows;
const count = async (table: string) => Number((await q(`SELECT count(*)::int AS n FROM ${table}`))[0].n);
const digest = async (table: string, where = 'true', args: any[] = []) => (await q(`SELECT md5(coalesce(string_agg(row_to_json(t)::text, '|' ORDER BY id), '')) AS d FROM ${table} t WHERE ${where}`, args))[0].d;
const fails = async (sql: string, args: any[], re: RegExp) => assert.rejects(db.pool.query(sql, args), (e: any) => re.test(e.message), sql);
const area = async (payload: any, token = pmToken, objectId = pilot.object.id) => post(token, `/objects/${objectId}/area-scopes`, { payload });
const areaId = async (payload: any, objectId = pilot.object.id, token = pmToken) => { const r = await area(payload, token, objectId); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.resultIds[0] as string; };
const protectedDigests = async () => Promise.all(['works', 'work_execution_units', 'quantity_portions', 'portion_quantity_confirmations', 'work_progress', 'finish_types'].map(t => digest(t)));

test('R05b-18a AreaScope: a flexible tree (any kind under any kind), stable ids, same-object parent, children never measure more than their parent', async () => {
  const b = await areaId({ kind: 'BUILDING', code: 'K1', name: 'Корпус 1' });
  const s1 = await areaId({ parentId: b, kind: 'SECTION', code: 'K1-S1', name: 'Секция 1', measureQuantity: '1000', measureUnit: 'м²' });
  const f1 = await areaId({ parentId: s1, kind: 'FLOOR', code: 'K1-S1-F1', name: 'Этаж 1', measureQuantity: '600', measureUnit: 'м²' });
  await areaId({ parentId: s1, kind: 'FLOOR', code: 'K1-S1-F2', name: 'Этаж 2', measureQuantity: '400', measureUnit: 'м²' }); // 600 + 400 = 1000: exactly allowed
  const room = await areaId({ parentId: b, kind: 'ROOM', code: 'K1-R-ROOF', name: 'Помещение на кровле' }); // no fixed hierarchy: a room directly under a building
  const zone = await areaId({ parentId: f1, kind: 'ZONE', code: 'K1-Z1', name: 'Захватка 1', measureQuantity: '12.5', measureUnit: 'м³' }); // another unit is another measure
  const rows = await q('SELECT id, parent_id, kind, measure_quantity::text AS m FROM object_area_scopes WHERE id = ANY($1::uuid[]) ORDER BY code', [[b, s1, f1, room, zone]]);
  assert.equal(rows.length, 5);
  const before = await count('object_area_scopes');
  // double counting refused: a third floor would make the section's children measure 1000.0001 > 1000
  const over = await area({ parentId: s1, kind: 'FLOOR', code: 'K1-S1-F3', name: 'Этаж 3', measureQuantity: '0.0001', measureUnit: 'м²' });
  assert.equal(over.status, 422); assert.equal(over.body.code, 'AREA_SCOPE_CONFLICT');
  // code is a stable identity, unique in the object; a measure needs its unit; an unknown unit is refused
  const dup = await area({ kind: 'BUILDING', code: 'K1', name: 'Ещё один корпус 1' });
  assert.equal(dup.status, 422); assert.deepEqual(dup.body.details.violations, [{ path: 'code', rule: 'DUPLICATE_VALUE' }]);
  assert.equal((await area({ kind: 'ROOM', code: 'NOUNIT', name: 'x', measureQuantity: '5' })).status, 422);
  assert.equal((await area({ kind: 'ROOM', code: 'BADUNIT', name: 'x', measureQuantity: '5', measureUnit: 'гектар' })).status, 422);
  assert.equal((await area({ kind: 'ROOM', code: 'ZERO', name: 'x', measureQuantity: '0', measureUnit: 'м²' })).status, 422);
  // a parent of another object is not addressable — over the API and by key
  const theirs = await areaId({ kind: 'BUILDING', code: 'N1', name: 'Соседний корпус' }, pilot.neighbour.id, otherPmToken);
  const beforeCross = await count('object_area_scopes');
  const cross = await area({ parentId: theirs, kind: 'FLOOR', code: 'X1', name: 'x' });
  assert.equal(cross.status, 422); assert.equal(cross.body.code, 'CROSS_SCOPE_REFERENCE');
  await fails(`INSERT INTO object_area_scopes(tenant_id,object_id,parent_id,kind,code,name,created_by) VALUES($1,$2,$3,'FLOOR','SQL-X','x',$4)`, [tenant, pilot.object.id, theirs, pilot.pm.id], /foreign key/i);
  assert.equal(await count('object_area_scopes'), beforeCross, 'refusals wrote nothing');
  assert.equal(beforeCross, before + 1, 'only the neighbour\'s own building was added');
  // the same code in ANOTHER object is another identity
  assert.ok(await areaId({ kind: 'BUILDING', code: 'K1', name: 'Корпус 1 соседа' }, pilot.neighbour.id, otherPmToken));
});

test('R05b-18b AreaScope guards in PostgreSQL: parent / measure / code immutable (no cycle can be formed), never deleted, a parent with active children is not retired', async () => {
  const a = await areaId({ kind: 'BUILDING', code: 'G-A', name: 'A' });
  const b = await areaId({ parentId: a, kind: 'SECTION', code: 'G-B', name: 'B', measureQuantity: '10', measureUnit: 'м²' });
  await fails('UPDATE object_area_scopes SET parent_id=$2 WHERE id=$1', [a, b], /GPR2_R05:AREA_SCOPE_CONFLICT/); // the only way to a cycle
  await fails("UPDATE object_area_scopes SET measure_quantity='11' WHERE id=$1", [b], /GPR2_R05:AREA_SCOPE_CONFLICT/);
  await fails("UPDATE object_area_scopes SET code='G-Z' WHERE id=$1", [b], /GPR2_R05:AREA_SCOPE_CONFLICT/);
  await fails('DELETE FROM object_area_scopes WHERE id=$1', [b], /GPR2_R05:AREA_SCOPE_CONFLICT/);
  await fails("UPDATE object_area_scopes SET lifecycle='RETIRED' WHERE id=$1", [a], /GPR2_R05:AREA_SCOPE_CONFLICT/);
  await fails('UPDATE object_area_scopes SET object_id=$2 WHERE id=$1', [b, pilot.neighbour.id], /GPR2_R05:AREA_SCOPE_CONFLICT|foreign key/i);
  // a leaf can be retired (and then takes no children); the name is display text and may change
  await db.pool.query("UPDATE object_area_scopes SET lifecycle='RETIRED', version=version+1 WHERE id=$1", [b]);
  await fails(`INSERT INTO object_area_scopes(tenant_id,object_id,parent_id,kind,code,name,created_by) VALUES($1,$2,$3,'ZONE','G-C','c',$4)`, [tenant, pilot.object.id, b, pilot.pm.id], /GPR2_R05:AREA_SCOPE_CONFLICT/);
  await db.pool.query("UPDATE object_area_scopes SET name='A2' WHERE id=$1", [a]);
});

test('R05b AreaScope isolation: another РП\'s object, another tenant, ADMIN — refused before anything is written', async () => {
  const n = await count('object_area_scopes');
  const foreign = await foreignTenantObject();
  const strip = (b: any) => { const { requestId, ...rest } = b ?? {}; return rest; };
  const r1 = await area({ kind: 'ROOM', code: 'ISO1', name: 'x' }, otherPmToken, pilot.object.id);
  const r2 = await area({ kind: 'ROOM', code: 'ISO2', name: 'x' }, pmToken, foreign.object.id);
  assert.equal(r1.status, 404); assert.equal(r2.status, 404); assert.deepEqual(strip(r1.body), strip(r2.body));
  assert.equal((await area({ kind: 'ROOM', code: 'ISO3', name: 'x' }, await g.roleToken('ADMIN'))).status, 403);
  assert.equal((await area({ kind: 'ROOM', code: 'ISO4', name: 'x' }, await g.roleToken('DEPUTY_DIRECTOR'))).status, 403);
  assert.equal(await count('object_area_scopes'), n);
});

test('R05b-6 single active object finish registry: stable unique codes per object, identity immutable, never deleted; a legacy finish id is not an object finish type', async () => {
  const t1 = (await catalog.registerObjectFinishType(pilot.pm, pilot.object.id, { code: 'FT-1', name: 'Тип №1' })).resultIds[0];
  const t2 = (await catalog.registerObjectFinishType(pilot.pm, pilot.object.id, { code: 'FT-2', name: 'Тип №2' })).resultIds[0];
  assert.notEqual(t1, t2);
  await assert.rejects(catalog.registerObjectFinishType(pilot.pm, pilot.object.id, { code: 'FT-1', name: 'Тип №1 повтор' }), (e: any) => e.code === 'VALIDATION_FAILED' && e.details.violations[0].rule === 'DUPLICATE_VALUE');
  // another object may use the same code: it is another registry
  assert.ok((await catalog.registerObjectFinishType(pilot.other, pilot.neighbour.id, { code: 'FT-1', name: 'Тип №1' })).resultIds[0]);
  // only the РП of the object, with the object-catalogue grant
  await assert.rejects(catalog.registerObjectFinishType(pilot.other, pilot.object.id, { code: 'FT-9', name: 'x' }), (e: any) => e.code === 'RESOURCE_NOT_FOUND');
  const admin = (await q("SELECT * FROM users WHERE tenant_id=$1 AND role='ADMIN' LIMIT 1", [tenant]))[0];
  await assert.rejects(catalog.registerObjectFinishType(db.camel(admin), pilot.object.id, { code: 'FT-9', name: 'x' }), (e: any) => e.code === 'PERMISSION_DENIED');
  await fails("UPDATE object_finish_types SET code='FT-X' WHERE id=$1", [t1], /GPR2_R05:VERSION_IMMUTABLE/);
  await fails('UPDATE object_finish_types SET object_id=$2 WHERE id=$1', [t1, pilot.neighbour.id], /GPR2_R05:VERSION_IMMUTABLE|foreign key/i);
  await fails('DELETE FROM object_finish_types WHERE id=$1', [t1], /GPR2_R05:VERSION_IMMUTABLE/);
  await db.pool.query("UPDATE object_finish_types SET lifecycle='RETIRED', version=version+1 WHERE id=$1", [t2]);
  await fails("UPDATE object_finish_types SET lifecycle='ACTIVE' WHERE id=$1", [t2], /GPR2_R05:VERSION_IMMUTABLE/);
  // the retired code is still taken: a stable code is never reused
  await assert.rejects(catalog.registerObjectFinishType(pilot.pm, pilot.object.id, { code: 'FT-2', name: 'новый' }), (e: any) => e.code === 'VALIDATION_FAILED');
  // a legacy tenant finish id is not an address of the object registry (the finish-system routes resolve it to nothing)
  const legacy = await db.insert(db.pool, 'finish_types', tenant, { name: 'Тип №1' });
  const { resolveR05Owner } = await import('../apps/backend/src/gpr2-r05-support');
  assert.deepEqual(await resolveR05Owner(db.pool, { kind: 'FINISH_SYSTEM', id: legacy.id }), { found: false });
  assert.deepEqual(await resolveR05Owner(db.pool, { kind: 'FINISH_SYSTEM', id: t1 }), { found: true, tenantId: tenant, objectId: pilot.object.id });
});

test('R05b-7 legacy finish mapping: no row = UNRESOLVED; a same-named object finish type is NOT a mapping; AMBIGUOUS has no target; corrections supersede, nothing is rewritten', async () => {
  const legacy = await db.insert(db.pool, 'finish_types', tenant, { name: 'Покраска стен' });
  const target = (await catalog.registerObjectFinishType(pilot.pm, pilot.object.id, { code: 'MAP-T', name: 'Покраска стен' })).resultIds[0];
  const legacy2 = await db.insert(db.pool, 'finish_types', tenant, { name: 'Плитка' });
  const protectedBefore = await protectedDigests();
  assert.deepEqual(await svc.resolveLegacyFinish(pilot.pm, pilot.object.id, legacy.id), { state: 'UNRESOLVED', objectFinishTypeId: null, mappingId: null }, 'same name, no mapping → still unresolved');
  const amb = (await svc.recordLegacyFinishMapping(pilot.pm, pilot.object.id, { legacyFinishTypeId: legacy.id, resolutionState: 'AMBIGUOUS', basis: 'два варианта по ведомости' })).resultIds[0];
  assert.deepEqual(await svc.resolveLegacyFinish(pilot.pm, pilot.object.id, legacy.id), { state: 'AMBIGUOUS', objectFinishTypeId: null, mappingId: amb });
  // an AMBIGUOUS mapping cannot name a target; a RESOLVED one must
  await assert.rejects(svc.recordLegacyFinishMapping(pilot.pm, pilot.object.id, { legacyFinishTypeId: legacy.id, resolutionState: 'AMBIGUOUS', targetFinishTypeId: target, basis: 'x', supersedesMappingId: amb }), (e: any) => e.code === 'VALIDATION_FAILED');
  await assert.rejects(svc.recordLegacyFinishMapping(pilot.pm, pilot.object.id, { legacyFinishTypeId: legacy.id, resolutionState: 'RESOLVED', basis: 'x', supersedesMappingId: amb }), (e: any) => e.code === 'VALIDATION_FAILED');
  // a second root for the same (object, legacy finish) is refused: corrections supersede the current row
  await assert.rejects(svc.recordLegacyFinishMapping(pilot.pm, pilot.object.id, { legacyFinishTypeId: legacy.id, resolutionState: 'RESOLVED', targetFinishTypeId: target, basis: 'x' }), (e: any) => e.code === 'INVALID_TRANSITION');
  const res = (await svc.recordLegacyFinishMapping(pilot.pm, pilot.object.id, { legacyFinishTypeId: legacy.id, resolutionState: 'RESOLVED', targetFinishTypeId: target, basis: 'акт осмотра №7', supersedesMappingId: amb })).resultIds[0];
  assert.deepEqual(await svc.resolveLegacyFinish(pilot.pm, pilot.object.id, legacy.id), { state: 'RESOLVED', objectFinishTypeId: target, mappingId: res });
  await assert.rejects(svc.recordLegacyFinishMapping(pilot.pm, pilot.object.id, { legacyFinishTypeId: legacy.id, resolutionState: 'AMBIGUOUS', basis: 'x', supersedesMappingId: amb }), (e: any) => e.code === 'INVALID_TRANSITION', 'a superseded row is superseded once');
  // the same legacy tenant id is independent in another object: still unresolved there
  assert.equal((await svc.resolveLegacyFinish(pilot.other, pilot.neighbour.id, legacy.id)).state, 'UNRESOLVED');
  // a target of another object is not addressable
  const theirs = (await catalog.registerObjectFinishType(pilot.other, pilot.neighbour.id, { code: 'MAP-N', name: 'x' })).resultIds[0];
  await assert.rejects(svc.recordLegacyFinishMapping(pilot.pm, pilot.object.id, { legacyFinishTypeId: legacy2.id, resolutionState: 'RESOLVED', targetFinishTypeId: theirs, basis: 'x' }), (e: any) => e.code === 'CROSS_SCOPE_REFERENCE');
  await fails(`INSERT INTO legacy_finish_mappings(tenant_id,object_id,legacy_finish_type_id,resolution_state,target_finish_type_id,basis,recorded_by) VALUES($1,$2,$3,'RESOLVED',$4,'x',$5)`,
    [tenant, pilot.object.id, legacy2.id, theirs, pilot.pm.id], /foreign key/i);
  // append-only
  await fails("UPDATE legacy_finish_mappings SET basis='y' WHERE id=$1", [res], /Append-only/);
  await fails('DELETE FROM legacy_finish_mappings WHERE id=$1', [res], /Append-only/);
  // and a mapping rewrites no legacy id, WEU, Work or fact
  assert.deepEqual(await protectedDigests(), protectedBefore);
});

test('R05b-8 historical mixed Work: evidence says MIXED, a classification is recorded ABOUT the Work — its id, WEUs, portions and facts stay byte-identical; no split', async () => {
  const f1 = await db.insert(db.pool, 'finish_types', tenant, { name: 'Отделка А' });
  const f2 = await db.insert(db.pool, 'finish_types', tenant, { name: 'Отделка Б' });
  await g.h.as(pilot.pm);
  const work = await g.h.req('works', { objectId: pilot.object.id, workTypeId: pilot.plaster.id, contractorId: pilot.contractors[0].id, responsibleUserId: pilot.pm.id, name: 'Историческая смешанная', unit: 'м²', plannedQuantity: 300, plannedStartDate: '2026-03-01', plannedFinishDate: '2026-04-30', estimatedCost: '1000' });
  const u1 = await g.h.req('execution-units', { objectWorkId: work.id, workTypeId: pilot.plaster.id, finishTypeId: f1.id, contractorId: pilot.contractors[0].id, unit: 'м²', plannedQuantity: 200, location: 'Секция А' });
  const u2 = await g.h.req('execution-units', { objectWorkId: work.id, workTypeId: pilot.plaster.id, finishTypeId: f2.id, contractorId: pilot.contractors[0].id, unit: 'м²', plannedQuantity: 100, location: 'Секция Б' });
  const p1 = await g.h.req(`execution-units/${u1.id}/portions`, { label: 'А', plannedQuantity: 200 });
  const snap = await g.h.req('snapshot');
  await g.h.req(`portions/${p1.id}/fact`, { quantity: 50, version: snap.portions.find((p: any) => p.id === p1.id).version, comment: 'факт' });
  const workDigest = async () => Promise.all([digest('works', 'id=$1', [work.id]), digest('work_execution_units', 'object_work_id=$1', [work.id]),
    digest('quantity_portions', 'execution_unit_id = ANY($1::uuid[])', [[u1.id, u2.id]]), digest('portion_quantity_confirmations', 'portion_id=$1', [p1.id])]);
  const before = await workDigest(), worksBefore = await count('works');
  const ev = await svc.legacyWorkFinishEvidence(pilot.pm, work.id);
  assert.deepEqual({ units: ev.executionUnits, ids: ev.legacyFinishTypeIds, gaps: ev.unitsWithoutFinish, supported: ev.supported, current: ev.current },
    { units: 2, ids: [f1.id, f2.id].sort(), gaps: 0, supported: 'MIXED_FINISH', current: null });
  assert.deepEqual(await workDigest(), before, 'reading evidence writes nothing');
  const cls = (await svc.recordLegacyWorkClassification(pilot.pm, { workId: work.id, classification: 'MIXED_FINISH', basis: 'две отделки в одной Work' })).resultIds[0];
  const row = (await q('SELECT * FROM legacy_work_classifications WHERE id=$1', [cls]))[0];
  assert.equal(row.work_id, work.id); assert.equal(row.object_id, pilot.object.id); assert.deepEqual(row.evidence.legacyFinishTypeIds, [f1.id, f2.id].sort());
  assert.deepEqual(await workDigest(), before, 'the Work, its WEUs, portions and facts are untouched');
  assert.equal(await count('works'), worksBefore, 'no split: not one new Work');
  assert.equal((await svc.legacyWorkFinishEvidence(pilot.pm, work.id)).current?.id, cls);
  // a correction supersedes; a second root is refused; append-only
  await assert.rejects(svc.recordLegacyWorkClassification(pilot.pm, { workId: work.id, classification: 'UNKNOWN', basis: 'x' }), (e: any) => e.code === 'INVALID_TRANSITION');
  const fix = (await svc.recordLegacyWorkClassification(pilot.pm, { workId: work.id, classification: 'UNKNOWN', basis: 'нужна инвентаризация', supersedesClassificationId: cls })).resultIds[0];
  assert.equal((await svc.legacyWorkFinishEvidence(pilot.pm, work.id)).current?.id, fix);
  await fails("UPDATE legacy_work_classifications SET classification='SINGLE_FINISH' WHERE id=$1", [cls], /Append-only/);
  // a classification is about a Work of its OWN object (direct SQL: the neighbour object's id with this Work)
  await fails(`INSERT INTO legacy_work_classifications(tenant_id,object_id,work_id,classification,evidence,basis,recorded_by) VALUES($1,$2,$3,'UNKNOWN','{}','x',$4)`,
    [tenant, pilot.neighbour.id, work.id, pilot.pm.id], /GPR2_R05:CROSS_SCOPE_REFERENCE/);
  // another РП cannot classify or read this Work's evidence
  await assert.rejects(svc.recordLegacyWorkClassification(pilot.other, { workId: work.id, classification: 'UNKNOWN', basis: 'x', supersedesClassificationId: fix }), (e: any) => e.code === 'RESOURCE_NOT_FOUND');
  await assert.rejects(svc.legacyWorkFinishEvidence(pilot.other, work.id), (e: any) => e.code === 'RESOURCE_NOT_FOUND');
  // a pure single-finish / unknown Work: the pilot plaster Work has units without a finish → UNKNOWN, never NON_FINISH by guess
  assert.equal((await svc.legacyWorkFinishEvidence(pilot.pm, pilot.plasterWork.work.id)).supported, 'UNKNOWN');
  assert.deepEqual(await workDigest(), before);
});

test('R05b idempotency of the service entries: same key → same id, other payload → 409; a mapping is never applied twice', async () => {
  const legacy = await db.insert(db.pool, 'finish_types', tenant, { name: 'Идемпотентная' });
  const key = uuid();
  const input = { legacyFinishTypeId: legacy.id, resolutionState: 'UNRESOLVED', basis: 'ожидает инвентаризации' };
  const a = await svc.recordLegacyFinishMapping(pilot.pm, pilot.object.id, input, key);
  const b = await svc.recordLegacyFinishMapping(pilot.pm, pilot.object.id, input, key);
  assert.deepEqual(b, a);
  await assert.rejects(svc.recordLegacyFinishMapping(pilot.pm, pilot.object.id, { ...input, basis: 'другое' }, key), (e: any) => e.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH');
  assert.equal(Number((await q('SELECT count(*)::int AS n FROM legacy_finish_mappings WHERE legacy_finish_type_id=$1', [legacy.id]))[0].n), 1);
});
