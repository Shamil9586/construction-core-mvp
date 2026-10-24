import './helpers/gpr2-isolation'; // FIRST: no backend module may load before the environment is pinned to in-memory PGlite
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { gpr2Harness, foreignTenantObject, pilotScenario, uuid, type Gpr2Harness } from './helpers/gpr2-fixtures';
import type { Pilot } from './helpers/gpr-fixtures';
import { assertInMemoryPool } from './helpers/gpr2-isolation';

/**
 * GPR-2 R05a — corporate / object WorkType and the publication workflow (TD §5.2, §11.2–11.3; D03, D05; A03, A19), over the REAL backend on in-memory
 * PGlite with mock auth and the R05 hooks the production module provides. Every negative path asserts the status AND that nothing was written.
 * Direct SQL proves the same rules hold without the API (infra/029 triggers). Concurrency claims are not made here — see gpr2-r05-native-pg.test.ts.
 */
let g: Gpr2Harness;
let pilot: Pilot;
let db: any;
let pmToken: string, otherPmToken: string, adminToken: string, deputyToken: string, tenant: string, categoryId: string;
before(async () => {
  g = await gpr2Harness('gpr2-r05a-key'); pilot = await pilotScenario(g.h); assert.equal(await assertInMemoryPool(), true);
  db = await import('../apps/backend/src/db');
  pmToken = await g.tokenFor(pilot.pm); otherPmToken = await g.tokenFor(pilot.other);
  adminToken = await g.roleToken('ADMIN'); deputyToken = await g.roleToken('DEPUTY_DIRECTOR');
  tenant = await g.tenantId(); categoryId = pilot.plaster.categoryId;
});
after(async () => { await g?.h.close(); });

const post = (token: string | null, path: string, body: unknown, key: string | null = uuid()) =>
  g.call(token, 'POST', '/v2' + path, { body, headers: key ? { 'Idempotency-Key': key } : {} });
const q = async (sql: string, args: any[] = []) => (await db.pool.query(sql, args)).rows;
const count = async (table: string) => Number((await q(`SELECT count(*)::int AS n FROM ${table}`))[0].n);
const typeBody = (name: string, unit = 'м²') => ({ payload: { name, categoryId, unit, requiresInspection: true, requiresExecutiveDocs: true, requiresMaterials: false } });
async function createType(name: string, token = pmToken, objectId = pilot.object.id, unit = 'м²') {
  const r = await post(token, `/objects/${objectId}/work-types`, typeBody(name, unit));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { id: r.body.resultIds[0] as string, result: r.body };
}
const typeRow = async (id: string) => (await q('SELECT * FROM work_types WHERE id=$1', [id]))[0];
const digest = async (table: string, where = 'true', args: any[] = []) => (await q(`SELECT md5(coalesce(string_agg(row_to_json(t)::text, '|' ORDER BY id), '')) AS d FROM ${table} t WHERE ${where}`, args))[0].d;

test('R05a-1 object WorkType creation: РП creates an OBJECT type in its own object; unit validated; nothing corporate appears', async () => {
  const before = await count('work_types');
  const { id, result } = await createType('Грунтование R05a');
  const row = await typeRow(id);
  assert.equal(row.scope, 'OBJECT'); assert.equal(row.object_id, pilot.object.id); assert.equal(row.origin_object_id, pilot.object.id);
  assert.equal(row.unit, 'м²'); assert.equal(row.created_by, pilot.pm.id); assert.equal(row.alias_of_work_type_id, null);
  assert.deepEqual(result.appliedVersions, { aggregate: '1', scope: null });
  assert.equal(await count('work_types'), before + 1);
  // the tenant dictionary (legacy API) still lists the CORPORATE catalogue only
  const dict = await (await fetch(g.h.base + '/dictionaries', { headers: { Authorization: 'Bearer ' + pmToken } })).json();
  assert.ok(!dict.workTypes.some((w: any) => w.id === id), 'an object type is not a tenant-wide dictionary entry');
  assert.ok(dict.workTypes.length > 0 && dict.workTypes.every((w: any) => w.scope === 'CORPORATE'));
  // ASCII spelling of the same unit is normalised; an unknown or missing unit is refused before anything is written
  const ascii = await createType('Шпаклевание R05a', pmToken, pilot.object.id, 'm2');
  assert.equal((await typeRow(ascii.id)).unit, 'м²');
  const n = await count('work_types');
  for (const unit of ['parsec', '', null]) {
    const r = await post(pmToken, `/objects/${pilot.object.id}/work-types`, typeBody('Плохая единица', unit as any));
    assert.equal(r.status, 422); assert.equal(r.body.code, 'VALIDATION_FAILED');
    assert.ok(r.body.details.violations.some((v: any) => v.path === 'unit' && ['UNIT_UNKNOWN', 'UNIT_MISSING'].includes(v.rule)), JSON.stringify(r.body));
  }
  // a category of another tenant is not addressable
  const foreign = await foreignTenantObject();
  const foreignCategory = await db.insert(db.pool, 'work_categories', foreign.tenant.id, { name: 'Чужая', code: 'FX' });
  const r = await post(pmToken, `/objects/${pilot.object.id}/work-types`, { payload: { ...typeBody('x').payload, categoryId: foreignCategory.id } });
  assert.equal(r.status, 422); assert.equal(r.body.code, 'CROSS_SCOPE_REFERENCE');
  assert.equal(await count('work_types'), n, 'refused calls wrote nothing');
});

test('R05a-4 same-name WorkTypes keep independent ids: no auto-merge by name (corporate, same object, other object)', async () => {
  const corporateName = pilot.plaster.name;
  const a = await createType(corporateName);
  assert.deepEqual(a.result.warnings, [{ code: 'SAME_NAME_EXISTS', path: 'name' }], 'a same name is reported, not merged');
  const b = await createType(corporateName);
  const c = await createType(corporateName, otherPmToken, pilot.neighbour.id);
  const ids = new Set([pilot.plaster.id, a.id, b.id, c.id]);
  assert.equal(ids.size, 4, 'four different ids for one name');
  assert.equal((await typeRow(c.id)).object_id, pilot.neighbour.id);
  // the corporate row is untouched
  assert.equal((await typeRow(pilot.plaster.id)).scope, 'CORPORATE');
  assert.equal((await typeRow(pilot.plaster.id)).version, 1);
});

test('R05a-2 publication: request → reject leaves the object type unchanged; request → approve PROMOTED keeps the id; ALIASED rewrites no reference', async () => {
  // reject
  const t1 = await createType('Гидроизоляция R05a');
  const t1Before = await digest('work_types', 'id=$1', [t1.id]);
  const req = await post(pmToken, `/objects/${pilot.object.id}/work-types/${t1.id}/publication-requests`, { expectedVersion: '1', payload: { justification: 'нужна во всех объектах' } });
  assert.equal(req.status, 200, JSON.stringify(req.body));
  const requestId = req.body.resultIds[0];
  const stored = (await q('SELECT * FROM work_type_publication_requests WHERE id=$1', [requestId]))[0];
  assert.equal(stored.status, 'PENDING'); assert.equal(stored.object_id, pilot.object.id); assert.equal(stored.proposed_name, 'Гидроизоляция R05a'); assert.equal(stored.requested_by, pilot.pm.id);
  // a second pending request for the same type is refused
  const dup = await post(pmToken, `/objects/${pilot.object.id}/work-types/${t1.id}/publication-requests`, { expectedVersion: '1', payload: {} });
  assert.equal(dup.status, 422); assert.equal(dup.body.code, 'INVALID_TRANSITION');
  // the РП cannot decide; the deputy cannot either; ADMIN can, with a reason
  for (const token of [pmToken, deputyToken]) {
    const r = await post(token, `/work-type-publication-requests/${requestId}/reject`, { expectedVersion: '1', payload: { reason: 'нет' } });
    assert.equal(r.status, 403);
  }
  const noReason = await post(adminToken, `/work-type-publication-requests/${requestId}/reject`, { expectedVersion: '1', payload: { reason: '  ' } });
  assert.equal(noReason.status, 422);
  const rej = await post(adminToken, `/work-type-publication-requests/${requestId}/reject`, { expectedVersion: '1', payload: { reason: 'объектная специфика' } });
  assert.equal(rej.status, 200, JSON.stringify(rej.body));
  assert.equal((await q('SELECT status, decision_reason FROM work_type_publication_requests WHERE id=$1', [requestId]))[0].status, 'REJECTED');
  assert.equal(await digest('work_types', 'id=$1', [t1.id]), t1Before, 'rejection does not touch the object WorkType');
  // a decided request is final
  const again = await post(adminToken, `/work-type-publication-requests/${requestId}/approve`, { expectedVersion: '2', payload: {} });
  assert.equal(again.status, 422); assert.equal(again.body.code, 'INVALID_TRANSITION');

  // approve PROMOTED: the same id becomes corporate; a Work that already used it keeps the id
  const t2 = await createType('Армирование сеткой R05a');
  await g.h.as(pilot.pm);
  const created = await g.h.req('works', { objectId: pilot.object.id, workTypeId: t2.id, name: 'Армирование', unit: 'м²', plannedQuantity: '10', idempotencyKey: uuid() });
  const req2 = (await post(pmToken, `/objects/${pilot.object.id}/work-types/${t2.id}/publication-requests`, { expectedVersion: '1', payload: {} })).body.resultIds[0];
  const ap = await post(adminToken, `/work-type-publication-requests/${req2}/approve`, { expectedVersion: '1', payload: {} });
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  assert.deepEqual(ap.body.resultIds, [req2, t2.id]);
  const promoted = await typeRow(t2.id);
  assert.equal(promoted.scope, 'CORPORATE'); assert.equal(promoted.object_id, null); assert.equal(promoted.origin_object_id, pilot.object.id, 'provenance kept');
  assert.equal((await q('SELECT work_type_id FROM works WHERE id=$1', [created.id]))[0].work_type_id, t2.id, 'historical reference unchanged');
  assert.equal((await q("SELECT outcome FROM work_type_publication_requests WHERE id=$1", [req2]))[0].outcome, 'PROMOTED');
  // now corporate: visible in the tenant dictionary, usable in another object
  const dict = await (await fetch(g.h.base + '/dictionaries', { headers: { Authorization: 'Bearer ' + otherPmToken } })).json();
  assert.ok(dict.workTypes.some((w: any) => w.id === t2.id));

  // approve ALIASED: the object type stays an object type and names a corporate type of the same unit; units must match
  const t3 = await createType('Окраска R05a', pmToken, pilot.object.id, 'м²');
  const req3 = (await post(pmToken, `/objects/${pilot.object.id}/work-types/${t3.id}/publication-requests`, { expectedVersion: '1', payload: {} })).body.resultIds[0];
  const otherUnit = (await q("SELECT id FROM work_types WHERE tenant_id=$1 AND scope='CORPORATE' AND unit<>'м²' LIMIT 1", [tenant]))[0].id;
  const bad = await post(adminToken, `/work-type-publication-requests/${req3}/approve`, { expectedVersion: '1', payload: { aliasOfWorkTypeId: otherUnit } });
  assert.equal(bad.status, 422); assert.equal(bad.body.code, 'INVALID_MEASUREMENT');
  const objectAlias = await post(adminToken, `/work-type-publication-requests/${req3}/approve`, { expectedVersion: '1', payload: { aliasOfWorkTypeId: t1.id } });
  assert.equal(objectAlias.status, 422); assert.equal(objectAlias.body.code, 'CROSS_SCOPE_REFERENCE', 'an alias names a CORPORATE type');
  assert.equal((await q('SELECT status FROM work_type_publication_requests WHERE id=$1', [req3]))[0].status, 'PENDING', 'refusals left the request pending');
  const al = await post(adminToken, `/work-type-publication-requests/${req3}/approve`, { expectedVersion: '1', payload: { aliasOfWorkTypeId: pilot.plaster.id } });
  assert.equal(al.status, 200, JSON.stringify(al.body));
  const aliased = await typeRow(t3.id);
  assert.equal(aliased.scope, 'OBJECT'); assert.equal(aliased.alias_of_work_type_id, pilot.plaster.id);
  assert.equal((await typeRow(pilot.plaster.id)).version, 1, 'the corporate target is not modified');
});

test('R05a-3 PM privilege isolation: РП gets no Admin right through publication; ADMIN gets no object-catalogue right; stale versions refused', async () => {
  const t = await createType('Изоляция РП R05a');
  const req = (await post(pmToken, `/objects/${pilot.object.id}/work-types/${t.id}/publication-requests`, { expectedVersion: '1', payload: {} })).body.resultIds[0];
  const n = await count('work_type_publication_requests'), types = await count('work_types');
  // РП cannot approve its own request, cannot use the legacy corporate dictionary write
  assert.equal((await post(pmToken, `/work-type-publication-requests/${req}/approve`, { expectedVersion: '1', payload: {} })).status, 403);
  const legacy = await fetch(g.h.base + '/dictionaries/work-types', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + pmToken }, body: JSON.stringify({ categoryId, name: 'x', unit: 'м²', requiresInspection: true, requiresExecutiveDocs: true, requiresMaterials: true }) });
  assert.equal(legacy.status, 403);
  // ADMIN holds CORPORATE_PUBLICATION only: no object WorkType, no publication request
  assert.equal((await post(adminToken, `/objects/${pilot.object.id}/work-types`, typeBody('admin'))).status, 403);
  assert.equal((await post(adminToken, `/objects/${pilot.object.id}/work-types/${t.id}/publication-requests`, { expectedVersion: '1', payload: {} })).status, 403);
  // stale aggregate versions
  const stale = await post(adminToken, `/work-type-publication-requests/${req}/approve`, { expectedVersion: '7', payload: {} });
  assert.equal(stale.status, 409); assert.equal(stale.body.code, 'STALE_VERSION');
  assert.equal(await count('work_type_publication_requests'), n); assert.equal(await count('work_types'), types);
  // after an approval the РП's grants are what they were
  assert.equal((await post(adminToken, `/work-type-publication-requests/${req}/approve`, { expectedVersion: '1', payload: {} })).status, 200);
  const { GPR2_GRANTS } = await import('../packages/domain/gpr2');
  assert.ok(!GPR2_GRANTS.PROJECT_MANAGER.includes('GPR2_CORPORATE_PUBLICATION' as any));
  assert.equal((await post(pmToken, `/work-type-publication-requests/${req}/reject`, { expectedVersion: '2', payload: { reason: 'x' } })).status, 403);
});

test('R05a-5 tenant / object isolation: another РП\'s object, another tenant, a corporate type on an object route — one scope-safe 404; legacy createWork refuses a foreign object type', async () => {
  const mine = await createType('Только мой объект R05a');
  const n = await count('work_types');
  // another РП cannot create in my object, nor request publication of my type
  const r1 = await post(otherPmToken, `/objects/${pilot.object.id}/work-types`, typeBody('чужой'));
  const r2 = await post(otherPmToken, `/objects/${pilot.neighbour.id}/work-types/${mine.id}/publication-requests`, { expectedVersion: '1', payload: {} });
  const r3 = await post(pmToken, `/objects/${pilot.object.id}/work-types/${pilot.plaster.id}/publication-requests`, { expectedVersion: '1', payload: {} });
  const foreign = await foreignTenantObject();
  const r4 = await post(pmToken, `/objects/${foreign.object.id}/work-types`, typeBody('чужой tenant'));
  const strip = (b: any) => { const { requestId, ...rest } = b ?? {}; return rest; };
  for (const r of [r1, r2, r3, r4]) { assert.equal(r.status, 404, JSON.stringify(r.body)); assert.deepEqual(strip(r.body), strip(r1.body)); }
  assert.equal(await count('work_types'), n);
  // legacy POST /works: the neighbour's РП cannot use my object type in the neighbour object (same 404 as a missing type)
  await g.h.as(pilot.other);
  const w = await g.h.raw('works', { objectId: pilot.neighbour.id, workTypeId: mine.id, name: 'x', unit: 'м²', plannedQuantity: '1', idempotencyKey: uuid() });
  assert.equal(w.status, 404);
  // a request id of another tenant is the same 404 on the tenant-level route
  const foreignReq = await post(adminToken, `/work-type-publication-requests/${uuid()}/approve`, { expectedVersion: '1', payload: {} });
  assert.equal(foreignReq.status, 404);
});

test('R05a PostgreSQL guards hold without the API: scope change, alias, cross-object use, unit change of a referenced type, decided request', async () => {
  const t = await createType('Прямой SQL R05a');
  const fails = async (sql: string, args: any[], code: RegExp) => { await assert.rejects(db.pool.query(sql, args), (e: any) => code.test(e.message), sql); };
  await fails("UPDATE work_types SET scope='CORPORATE', object_id=NULL WHERE id=$1", [t.id], /GPR2_R05:SCOPE_CHANGE_FORBIDDEN/);
  await fails("UPDATE work_types SET scope='OBJECT', object_id=$2, origin_object_id=$2 WHERE id=$1", [pilot.plaster.id, pilot.object.id], /GPR2_R05:(SCOPE_CHANGE_FORBIDDEN|IDENTITY_IMMUTABLE)/);
  await fails('UPDATE work_types SET alias_of_work_type_id=$2 WHERE id=$1', [t.id, pilot.plaster.id], /GPR2_R05:ALIAS_FORBIDDEN/);
  await fails('UPDATE work_types SET origin_object_id=$2 WHERE id=$1', [t.id, pilot.neighbour.id], /GPR2_R05:IDENTITY_IMMUTABLE/);
  await fails("INSERT INTO work_types(tenant_id,category_id,name,unit,scope,object_id,origin_object_id) VALUES($1,$2,'x','м²','CORPORATE',NULL,$3)", [tenant, categoryId, pilot.object.id], /GPR2_R05:SCOPE_CHANGE_FORBIDDEN/);
  await fails("INSERT INTO work_types(tenant_id,category_id,name,unit,scope,object_id) VALUES($1,$2,'x','м²','OBJECT',NULL)", [tenant, categoryId], /check/i);
  // a Work of another object may not use the object type; nor may an execution unit of such a Work
  await fails(`INSERT INTO works(tenant_id,object_id,work_type_id,name,unit,planned_quantity) VALUES($1,$2,$3,'x','м²',1)`, [tenant, pilot.neighbour.id, t.id], /GPR2_R05:CROSS_SCOPE_REFERENCE/);
  await fails(`INSERT INTO work_execution_units(tenant_id,object_work_id,work_type_id,contractor_id,unit,planned_quantity) VALUES($1,$2,$3,$4,'м²',1)`, [tenant, pilot.neighbourWork.work.id, t.id, pilot.contractors[0].id], /GPR2_R05:CROSS_SCOPE_REFERENCE/);
  // the unit of a referenced corporate type cannot change (the pilot works use it)
  await fails("UPDATE work_types SET unit='м³' WHERE id=$1", [pilot.plaster.id], /GPR2_R05:UNIT_IMMUTABLE/);
  // decided requests are immutable and nothing is ever deleted
  const req = (await post(pmToken, `/objects/${pilot.object.id}/work-types/${t.id}/publication-requests`, { expectedVersion: '1', payload: {} })).body.resultIds[0];
  await fails('DELETE FROM work_type_publication_requests WHERE id=$1', [req], /GPR2_R05:APPEND_ONLY/);
  await fails("UPDATE work_type_publication_requests SET proposed_name='y', status='REJECTED', decided_by=requested_by, decided_at=now(), decision_reason='r', version=version+1 WHERE id=$1", [req], /GPR2_R05:INVALID_DECISION/);
  assert.equal((await post(adminToken, `/work-type-publication-requests/${req}/reject`, { expectedVersion: '1', payload: { reason: 'нет' } })).status, 200);
  await fails("UPDATE work_type_publication_requests SET decision_reason='other' WHERE id=$1", [req], /GPR2_R05:DECIDED_IMMUTABLE/);
});

test('R05a idempotency: same key + same payload → same id, one row; same key + other payload → 409; replay re-authorises (a reassigned object is 404)', async () => {
  const key = uuid();
  const body = typeBody('Идемпотентный R05a');
  const n = await count('work_types');
  const a = await post(pmToken, `/objects/${pilot.object.id}/work-types`, body, key);
  const b = await post(pmToken, `/objects/${pilot.object.id}/work-types`, body, key);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.deepEqual(b.body, a.body, 'lost-response retry returns the stored result');
  assert.equal(await count('work_types'), n + 1);
  const c = await post(pmToken, `/objects/${pilot.object.id}/work-types`, typeBody('Другое имя'), key);
  assert.equal(c.status, 409); assert.equal(c.body.code, 'IDEMPOTENCY_PAYLOAD_MISMATCH');
  assert.equal(await count('work_types'), n + 1);
  // the object moves to another РП: the original key is not a way back in
  await db.pool.query('UPDATE objects SET project_manager_id=$2 WHERE id=$1', [pilot.object.id, pilot.other.id]);
  try {
    const d = await post(pmToken, `/objects/${pilot.object.id}/work-types`, body, key);
    assert.equal(d.status, 404);
  } finally { await db.pool.query('UPDATE objects SET project_manager_id=$2 WHERE id=$1', [pilot.object.id, pilot.pm.id]); }
});
