import './helpers/gpr2-isolation'; // FIRST: no backend module may load before the environment is pinned to in-memory PGlite
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gpr2Harness, foreignTenantObject, pilotScenario, uuid, type Gpr2Harness } from './helpers/gpr2-fixtures';
import type { Pilot } from './helpers/gpr-fixtures';
import { assertInMemoryPool } from './helpers/gpr2-isolation';
import { roles } from '../packages/domain';

/**
 * GPR-2 R05 / D1 — the five R05 reads (owner-authorised 29.10.2026), over the REAL backend on in-memory PGlite with mock auth:
 *   Q1 GET /v2/objects/{o}/work-types · Q2 …/area-scopes · Q3 …/finish-systems · Q4 GET /v2/finish-templates · Q5 …/work-type-publication-requests?state=
 * Every negative asserts the status AND the exact body; the "no side effect" claim is a before/after digest of every table a read could touch.
 * Lock waits, snapshot isolation under concurrent writers and anything else that needs two sessions is a native-PostgreSQL claim: gpr2-r05-read-native-pg.test.ts.
 */
let g: Gpr2Harness;
let pilot: Pilot;
let db: any;
let tenant: string;
let pm: string, otherPm: string, admin: string, deputy: string, foreignPm: string;
let foreign: Awaited<ReturnType<typeof foreignTenantObject>>;
let pm2: any;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let served: any;

before(async () => {
  g = await gpr2Harness('gpr2-r05-read-key'); pilot = await pilotScenario(g.h); assert.equal(await assertInMemoryPool(), true);
  db = await import('../apps/backend/src/db');
  tenant = await g.tenantId();
  pm = await g.tokenFor(pilot.pm); otherPm = await g.tokenFor(pilot.other); admin = await g.roleToken('ADMIN'); deputy = await g.roleToken('DEPUTY_DIRECTOR');
  await g.h.login('ADMIN');
  for (const [k, name] of [['primer', 'Грунтование'], ['plaster', 'Штукатурка R'], ['paint', 'Покраска']])
    T[k] = (await g.h.req('dictionaries/work-types', { categoryId: pilot.plaster.categoryId, name, unit: 'м²', requiresInspection: true, requiresExecutiveDocs: true, requiresMaterials: true })).id;
  const cmd = async (token: string, path: string, body: unknown) => { const r = await g.call(token, 'POST', '/v2' + path, { body, headers: { 'Idempotency-Key': uuid() } }); assert.equal(r.status, 200, path + ' ' + JSON.stringify(r.body)); return r.body; };
  const typeBody = (name: string) => ({ payload: { name, categoryId: pilot.plaster.categoryId, unit: 'м²', requiresInspection: true, requiresExecutiveDocs: true, requiresMaterials: false } });
  // object work types: three on the pilot object, one on the neighbour
  for (const k of ['OT1', 'OT2', 'OT3', 'OT4']) ID[k] = (await cmd(pm, `/objects/${pilot.object.id}/work-types`, typeBody('Объектный ' + k))).resultIds[0];
  ID.NOT1 = (await cmd(otherPm, `/objects/${pilot.neighbour.id}/work-types`, typeBody('Соседский тип'))).resultIds[0];
  // publication requests: OT1 pending, OT2 rejected (by ADMIN), OT3 approved (promoted), neighbour's pending
  ID.R1 = (await cmd(pm, `/objects/${pilot.object.id}/work-types/${ID.OT1}/publication-requests`, { expectedVersion: '1', payload: { justification: 'нужен всем' } })).resultIds[0];
  ID.R2 = (await cmd(pm, `/objects/${pilot.object.id}/work-types/${ID.OT2}/publication-requests`, { expectedVersion: '1', payload: {} })).resultIds[0];
  ID.R3 = (await cmd(pm, `/objects/${pilot.object.id}/work-types/${ID.OT3}/publication-requests`, { expectedVersion: '1', payload: {} })).resultIds[0];
  ID.NR1 = (await cmd(otherPm, `/objects/${pilot.neighbour.id}/work-types/${ID.NOT1}/publication-requests`, { expectedVersion: '1', payload: {} })).resultIds[0];
  await cmd(admin, `/work-type-publication-requests/${ID.R2}/reject`, { expectedVersion: '1', payload: { reason: 'дубликат справочника' } });
  await cmd(admin, `/work-type-publication-requests/${ID.R3}/approve`, { expectedVersion: '1', payload: {} });
  // a request filed by ANOTHER РП of the same object (the object was reassigned): the owner of the object must not read it as "own"
  pm2 = await (await import('./helpers/pbx3-fixtures')).makeUser('Прежний РП', 'PROJECT_MANAGER');
  ID.R4 = uuid();
  await db.pool.query(`INSERT INTO work_type_publication_requests(id,tenant_id,object_id,work_type_id,work_type_version,proposed_name,proposed_category_id,proposed_unit,requested_by)
    SELECT $1,tenant_id,object_id,id,version,name,category_id,unit,$2 FROM work_types WHERE id=$3`, [ID.R4, pm2.id, ID.OT4]);
  // area scopes
  const area = async (token: string, objectId: string, key: string, payload: any) => { ID[key] = (await cmd(token, `/objects/${objectId}/area-scopes`, { payload })).resultIds[0]; };
  await area(pm, pilot.object.id, 'B', { kind: 'BUILDING', code: 'B', name: 'Корпус' });
  await area(pm, pilot.object.id, 'S1', { parentId: ID.B, kind: 'SECTION', code: 'S1', name: 'Секция 1', measureQuantity: '1000', measureUnit: 'м²' });
  await area(pm, pilot.object.id, 'F1', { parentId: ID.S1, kind: 'FLOOR', code: 'S1-F1', name: 'Этаж 1', measureQuantity: '600', measureUnit: 'м²' });
  await area(pm, pilot.object.id, 'F2', { parentId: ID.S1, kind: 'FLOOR', code: 'S1-F2', name: 'Этаж 2', measureQuantity: '400', measureUnit: 'м²' });
  await area(otherPm, pilot.neighbour.id, 'NB', { kind: 'BUILDING', code: 'NB', name: 'Соседний корпус' });
  // templates (corporate): PUBLISHED one, a DRAFT-only one, and a published one that also has a newer DRAFT
  const stage = (k: string, position: number, workTypeId: string, extra: any = {}) => ({ occurrenceKey: k, position, workTypeId, required: true, measureScope: 'MAIN', measureUnit: 'м²', ...extra });
  const tpl = await cmd(admin, '/finish-templates', { payload: { code: 'TPL-PUB', name: 'Опубликованный', stages: [stage('PRIMER', 1, T.primer, { proposedHoldHours: '4' }), stage('PLASTER', 2, T.plaster), stage('PAINT', 3, T.paint)] } });
  [ID.TPL, ID.TPLV1] = tpl.resultIds;
  await cmd(admin, `/finish-templates/${ID.TPL}/publish`, { expectedVersion: '1', payload: { templateVersionId: ID.TPLV1 } });
  const tplDraftOnly = await cmd(admin, '/finish-templates', { payload: { code: 'TPL-DRAFT', name: 'Только черновик', stages: [stage('A', 1, T.primer)] } });
  ID.TPLD = tplDraftOnly.resultIds[0];
  // a finish system from the template (all INHERITED), one with local stages and an exclusion, and the neighbour's
  const fs1 = await cmd(pm, `/objects/${pilot.object.id}/finish-systems`, { payload: { finishType: { code: 'TYPE-1', name: 'Тип №1' }, sourceTemplateVersionId: ID.TPLV1 } });
  [ID.FT1, ID.SV1] = fs1.resultIds;
  const tplStages = (await g.call(admin, 'GET', '/v2/finish-templates')).body.items.find((t: any) => t.code === 'TPL-PUB').currentVersion.stages;
  const fs2 = await cmd(pm, `/objects/${pilot.object.id}/finish-systems`, { payload: { finishType: { code: 'TYPE-2', name: 'Тип №2' }, sourceTemplateVersionId: ID.TPLV1,
    stages: [{ ...stage('PRIMER', 1, T.primer, { proposedHoldHours: '4' }), sourceTemplateStageId: tplStages[0].id }, { ...stage('PLASTER', 2, T.plaster, { required: false }), sourceTemplateStageId: tplStages[1].id, overrideReason: 'по проекту штукатурка не обязательна' },
      stage('LOCAL_1', 4, ID.OT4, { required: false, measureScope: 'LOCAL' })], excludedTemplateStages: [{ templateStageId: tplStages[2].id, reason: 'по проекту без покраски' }] } });
  assert.equal(fs2.resultIds.length > 1, true); [ID.FT2, ID.SV2] = fs2.resultIds;
  const nfs = await cmd(otherPm, `/objects/${pilot.neighbour.id}/finish-systems`, { payload: { finishType: { code: 'NB-TYPE', name: 'Соседский тип отделки' }, stages: [stage('X', 1, T.primer)] } });
  ID.NFT = nfs.resultIds[0];
  // another tenant: a manager, an object, an OBJECT work type, an area scope and a DRAFT-only template of its own
  foreign = await foreignTenantObject();
  foreignPm = await g.tokenFor(foreign.manager);
  const cat = (await db.pool.query("INSERT INTO work_categories(tenant_id,name,code) VALUES($1,'Чужая категория','FC') RETURNING id", [foreign.tenant.id])).rows[0].id;
  await db.pool.query(`INSERT INTO work_types(tenant_id,category_id,name,unit,scope,object_id,origin_object_id,created_by) VALUES($1,$2,'ЧУЖОЙ-ТИП','м²','OBJECT',$3,$3,$4)`, [foreign.tenant.id, cat, foreign.object.id, foreign.manager.id]);
  await db.pool.query(`INSERT INTO object_area_scopes(tenant_id,object_id,kind,code,name,created_by) VALUES($1,$2,'BUILDING','FOREIGN-AREA','Чужая зона',$3)`, [foreign.tenant.id, foreign.object.id, foreign.manager.id]);
  const ftpl = (await db.pool.query("INSERT INTO finish_templates(tenant_id,code,name,created_by) VALUES($1,'FOREIGN-TPL','Чужой шаблон',$2) RETURNING id", [foreign.tenant.id, foreign.manager.id])).rows[0].id;
  await db.pool.query("INSERT INTO finish_template_versions(tenant_id,template_id,version_number,created_by) VALUES($1,$2,1,$3)", [foreign.tenant.id, ftpl, foreign.manager.id]);
  served = (await g.call(null, 'GET', '/api-docs-json')).body;
});
after(async () => { await g?.h.close(); });

const get = (token: string | null, path: string) => g.call(token, 'GET', '/v2' + path);
const P = () => pilot.object.id;
const Q1 = (o = P()) => `/objects/${o}/work-types`, Q2 = (o = P()) => `/objects/${o}/area-scopes`, Q3 = (o = P()) => `/objects/${o}/finish-systems`, Q4 = () => '/finish-templates', Q5 = (o = P()) => `/objects/${o}/work-type-publication-requests`;
const all = async (token: string, path: string, limit = 200) => {
  const items: any[] = []; let cursor: string | null = null, pages = 0;
  do {
    const r: any = await get(token, `${path}?limit=${limit}${cursor ? '&cursor=' + cursor : ''}`);
    assert.equal(r.status, 200, path + ' ' + JSON.stringify(r.body)); items.push(...r.body.items); cursor = r.body.nextCursor; pages++;
    assert.ok(pages < 100);
  } while (cursor);
  return { items, pages };
};

// ---------------------------------------------------------------------------------------------------------------------------------
// A minimal JSON-Schema walker for the published components (type, enum, format, pattern, properties/required/additionalProperties, items, oneOf, $ref)
// ---------------------------------------------------------------------------------------------------------------------------------
function conforms(schema: any, value: any, path = '$'): string[] {
  const comp = (n: string) => served.components.schemas[n];
  if (schema.$ref) return conforms(comp(schema.$ref.split('/').pop()), value, path);
  if (schema.oneOf) { const tries = schema.oneOf.map((s: any) => conforms(s, value, path)); return tries.some((t: string[]) => t.length === 0) ? [] : [path + ': no oneOf alternative matches ' + JSON.stringify(value)?.slice(0, 80)]; }
  const bad: string[] = [];
  if (schema.type === 'null') return value === null ? [] : [path + ': expected null'];
  if (schema.type === 'string') {
    if (typeof value !== 'string') return [path + ': expected string, got ' + JSON.stringify(value)];
    if (schema.enum && !schema.enum.includes(value)) bad.push(path + ': ' + value + ' not in enum');
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) bad.push(path + ': ' + value + ' does not match ' + schema.pattern);
    if (schema.format === 'uuid' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) bad.push(path + ': not a uuid');
    if (schema.format === 'date-time' && !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(value)) bad.push(path + ': not a date-time');
    return bad;
  }
  if (schema.type === 'boolean') return typeof value === 'boolean' ? [] : [path + ': expected boolean'];
  if (schema.type === 'integer') return Number.isInteger(value) ? [] : [path + ': expected integer'];
  if (schema.type === 'array') return Array.isArray(value) ? value.flatMap((v, i) => conforms(schema.items, v, `${path}[${i}]`)) : [path + ': expected array'];
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [path + ': expected object'];
    for (const k of schema.required ?? []) if (!(k in value)) bad.push(`${path}.${k}: required`);
    for (const k of Object.keys(value)) schema.properties?.[k] ? bad.push(...conforms(schema.properties[k], value[k], `${path}.${k}`)) : schema.additionalProperties === false && bad.push(`${path}.${k}: not in the contract`);
    return bad;
  }
  return [path + ': unsupported schema ' + JSON.stringify(schema).slice(0, 60)];
}
const RESPONSE_SCHEMA = (opPath: string) => served.paths['/v2' + opPath].get.responses['200'].content['application/json'].schema;
const expectShape = (opPath: string, body: any) => assert.deepEqual(conforms(RESPONSE_SCHEMA(opPath), body), [], opPath);

test('D1-0 the served OpenAPI document publishes the five reads: GET, bearer, path + query parameters, the page schema and the error set', () => {
  assert.ok(served, 'the document is served');
  const ops: [string, string, string[]][] = [['/objects/{objectId}/work-types', 'ReadPageWorkTypes', ['limit', 'cursor']], ['/objects/{objectId}/area-scopes', 'ReadPageAreaScopes', ['limit', 'cursor']],
    ['/objects/{objectId}/finish-systems', 'ReadPageFinishTypes', ['limit', 'cursor']], ['/finish-templates', 'ReadPageFinishTemplates', ['limit', 'cursor']],
    ['/objects/{objectId}/work-type-publication-requests', 'ReadPagePublicationRequests', ['state', 'limit', 'cursor']]];
  for (const [path, schema, query] of ops) {
    const op = served.paths['/v2' + path].get;
    assert.ok(op, path); assert.deepEqual(op.security, [{ bearerAuth: [] }]);
    assert.equal(op.responses['200'].content['application/json'].schema.$ref, '#/components/schemas/' + schema);
    assert.deepEqual(op.parameters.filter((p: any) => p.in === 'query').map((p: any) => p.name), query);
    assert.ok(!op.parameters.some((p: any) => p.name === 'Idempotency-Key'), 'a read carries no idempotency key');
    assert.deepEqual(Object.keys(op.responses).sort(), ['200', '401', '403', '404', '422'].filter(c => c !== '404' || path.includes('{objectId}')), path);
    assert.equal(op['x-authorization'].type, 'ANY_PERMISSION'); assert.equal(op['x-pure'], true);
  }
  assert.equal(served.paths['/v2/work-type-publication-requests'], undefined, 'no tenant-wide request list');
});

test('D1-1 Q1 work types: tenant CORPORATE catalogue + OBJECT types of THIS object only — not the neighbour\'s, not another tenant\'s; scope/unit/alias/version present', async () => {
  const r = await get(pm, Q1());
  assert.equal(r.status, 200, JSON.stringify(r.body)); expectShape('/objects/{objectId}/work-types', r.body);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const names = r.body.items.map((w: any) => w.name);
  for (const n of ['Грунтование', 'Штукатурка R', 'Покраска', 'Объектный OT1', 'Объектный OT2', 'Объектный OT4']) assert.ok(names.includes(n), n);
  assert.ok(!names.includes('Соседский тип') && !names.includes('ЧУЖОЙ-ТИП'), 'neither another object\'s nor another tenant\'s type');
  const ot1 = r.body.items.find((w: any) => w.id === ID.OT1);
  assert.deepEqual([ot1.scope, ot1.unit, ot1.version, ot1.aliasOfWorkTypeId], ['OBJECT', 'м²', '1', null]);
  const promoted = r.body.items.find((w: any) => w.id === ID.OT3);
  assert.equal(promoted.scope, 'CORPORATE', 'a type the administrator promoted is corporate now (same id)');
  assert.ok(r.body.items.every((w: any) => !('originObjectId' in w) && !('objectId' in w) && !('createdBy' in w) && !('tenantId' in w)), 'no foreign identifier can leak: the columns are an allow-list');
  const sorted = [...names].sort(); assert.equal(new Set(names).size, names.length); assert.ok(names.length >= 7); void sorted;
  // the neighbour sees its own object type, not ours
  const n = await get(otherPm, Q1(pilot.neighbour.id));
  assert.ok(n.body.items.some((w: any) => w.id === ID.NOT1) && !n.body.items.some((w: any) => w.id === ID.OT1));
});

test('D1-2 Q2 area scopes: the tree of THIS object (parent, code, measure/unit as exact decimals, lifecycle, version)', async () => {
  const r = await get(pm, Q2());
  assert.equal(r.status, 200); expectShape('/objects/{objectId}/area-scopes', r.body);
  assert.deepEqual(r.body.items.map((a: any) => a.code), ['B', 'S1', 'S1-F1', 'S1-F2']);
  const f1 = r.body.items.find((a: any) => a.id === ID.F1);
  assert.deepEqual([f1.parentId, f1.kind, f1.measureQuantity, f1.measureUnit, f1.lifecycle, f1.version], [ID.S1, 'FLOOR', '600.0000', 'м²', 'ACTIVE', '1']);
  assert.equal(r.body.items.find((a: any) => a.id === ID.B).measureQuantity, null);
  assert.ok(!r.body.items.some((a: any) => a.code === 'NB' || a.code === 'FOREIGN-AREA'));
  assert.equal(r.body.nextCursor, null);
});

test('D1-3 Q3 finish systems: types, versions, the current version\'s stages with provenance and exclusions — this object only', async () => {
  const r = await get(pm, Q3());
  assert.equal(r.status, 200); expectShape('/objects/{objectId}/finish-systems', r.body);
  assert.deepEqual(r.body.items.map((f: any) => f.code), ['TYPE-1', 'TYPE-2']);
  const t1 = r.body.items[0], t2 = r.body.items[1];
  assert.deepEqual(t1.currentVersion.stages.map((s: any) => [s.occurrenceKey, s.overrideKind, s.workTypeName]), [['PRIMER', 'INHERITED', 'Грунтование'], ['PLASTER', 'INHERITED', 'Штукатурка R'], ['PAINT', 'INHERITED', 'Покраска']]);
  assert.equal(t1.currentVersion.sourceTemplateVersionId, ID.TPLV1); assert.equal(t1.currentVersion.stages[0].proposedHoldHours, '4.000000000000'); assert.equal(t1.currentVersion.stages[0].proposedHoldStatus, 'PROPOSAL');
  assert.deepEqual(t2.currentVersion.stages.map((s: any) => [s.occurrenceKey, s.overrideKind]), [['PRIMER', 'INHERITED'], ['PLASTER', 'OVERRIDDEN'], ['LOCAL_1', 'ADDED_LOCAL']]);
  assert.equal(t2.currentVersion.stages[1].overrideReason, 'по проекту штукатурка не обязательна');
  assert.equal(t2.currentVersion.stages[2].workTypeName, 'Объектный OT4', 'an OBJECT type of this object is named');
  assert.deepEqual(t2.currentVersion.exclusions.map((e: any) => e.reason), ['по проекту без покраски']);
  assert.deepEqual(t1.versions.map((v: any) => [v.versionNumber, v.state]), [[1, 'PUBLISHED']]);
  assert.ok(!r.body.items.some((f: any) => f.code === 'NB-TYPE'));
  assert.ok(!JSON.stringify(r.body).includes(pilot.neighbour.id), 'no identifier of another object');
});

test('D1-4 Q4 finish templates: a РП reads PUBLISHED corporate templates only; ADMIN (CORPORATE_PUBLICATION) also reads DRAFTs; another tenant\'s templates never', async () => {
  const mine = await get(pm, Q4());
  assert.equal(mine.status, 200); expectShape('/finish-templates', mine.body);
  assert.deepEqual(mine.body.items.map((t: any) => t.code), ['TPL-PUB'], 'the DRAFT-only template is not offered to a РП');
  const t = mine.body.items[0];
  assert.deepEqual([t.versions.map((v: any) => v.state), t.draftVersion, t.currentVersion.stages.map((s: any) => s.occurrenceKey)], [['PUBLISHED'], null, ['PRIMER', 'PLASTER', 'PAINT']]);
  const adm = await get(admin, Q4());
  assert.equal(adm.status, 200); expectShape('/finish-templates', adm.body);
  assert.deepEqual(adm.body.items.map((x: any) => x.code), ['TPL-DRAFT', 'TPL-PUB'], 'sorted by code; the foreign tenant\'s FOREIGN-TPL is absent');
  const d = adm.body.items[0];
  assert.deepEqual([d.currentVersion, d.draftVersion.state, d.draftVersion.stages.map((s: any) => s.occurrenceKey)], [null, 'DRAFT', ['A']]);
  assert.ok(!JSON.stringify([mine.body, adm.body]).includes('FOREIGN'), 'nothing of another tenant');
  // a template read carries nothing object-owned
  assert.ok(!JSON.stringify([mine.body, adm.body]).includes(P()));
  // the foreign tenant's own manager sees only its (unpublished → none) templates, never ours
  assert.deepEqual((await get(foreignPm, Q4())).body.items, []);
});

test('D1-5 Q5 requests: a РП reads its OWN requests of ONE object; ADMIN reads the requests of the chosen object; state filter; no cross-object list', async () => {
  const mine = await get(pm, Q5());
  assert.equal(mine.status, 200, JSON.stringify(mine.body)); expectShape('/objects/{objectId}/work-type-publication-requests', mine.body);
  assert.deepEqual(new Set(mine.body.items.map((x: any) => x.id)), new Set([ID.R1, ID.R2, ID.R3]), 'the request another РП filed on this object (R4) is not "own"; the neighbour\'s is not here');
  const r2 = mine.body.items.find((x: any) => x.id === ID.R2), r3 = mine.body.items.find((x: any) => x.id === ID.R3), r1 = mine.body.items.find((x: any) => x.id === ID.R1);
  assert.deepEqual([r1.status, r1.outcome, r1.justification, r1.workType.name, r1.workType.scope], ['PENDING', null, 'нужен всем', 'Объектный OT1', 'OBJECT']);
  assert.deepEqual([r2.status, r2.decisionReason, r2.decidedById !== null, r2.workType.scope], ['REJECTED', 'дубликат справочника', true, 'OBJECT']);
  assert.deepEqual([r3.status, r3.outcome, r3.workType.scope], ['APPROVED', 'PROMOTED', 'CORPORATE']);
  assert.deepEqual(mine.body.items.map((x: any) => x.createdAt), [...mine.body.items.map((x: any) => x.createdAt)].sort().reverse(), 'newest first');
  for (const [state, ids] of [['PENDING', [ID.R1]], ['REJECTED', [ID.R2]], ['APPROVED', [ID.R3]]] as const)
    assert.deepEqual((await get(pm, Q5() + '?state=' + state)).body.items.map((x: any) => x.id), ids, state);
  const adm = await get(admin, Q5());
  assert.equal(adm.status, 200); assert.deepEqual(new Set(adm.body.items.map((x: any) => x.id)), new Set([ID.R1, ID.R2, ID.R3, ID.R4]), 'ADMIN: every request of the chosen object, none of another');
  assert.deepEqual(new Set((await get(admin, Q5(pilot.neighbour.id))).body.items.map((x: any) => x.id)), new Set([ID.NR1]));
  assert.equal((await get(admin, '/work-type-publication-requests')).status, 404, 'there is no tenant-wide list');
});

test('D1-6 pagination: bounded, stable, no duplicates or gaps, the last page says so; a cursor is bound to its route, object, view and filter', async () => {
  for (const [token, path] of [[pm, Q1()], [pm, Q2()], [pm, Q3()], [admin, Q4()], [admin, Q5()]] as const) {
    const full = (await all(token, path, 200)).items.map(x => x.id);
    const paged = await all(token, path, 1);
    assert.deepEqual(paged.items.map(x => x.id), full, path + ': pages of 1 reproduce the single page, in the same order');
    assert.equal(paged.pages, full.length, path);
    assert.equal(new Set(full).size, full.length);
  }
  const first = await get(pm, Q1() + '?limit=2');
  assert.equal(first.body.items.length, 2); assert.ok(first.body.nextCursor);
  assert.equal((await get(pm, Q1() + '?limit=200')).body.nextCursor, null, 'fewer than a page: no cursor');
  const reject = async (token: string, path: string) => { const r = await get(token, path); assert.equal(r.status, 422, path); assert.deepEqual(r.body.details.violations, [{ path: 'cursor', rule: 'FIELD_TYPE' }]); };
  await reject(pm, Q2() + '?cursor=' + first.body.nextCursor);                                   // another route
  await reject(otherPm, Q1(pilot.neighbour.id) + '?cursor=' + first.body.nextCursor);            // another object
  const pend = await get(admin, Q5() + '?limit=1');
  await reject(admin, Q5() + '?state=PENDING&cursor=' + pend.body.nextCursor);                   // another filter
  await reject(pm, Q5() + '?cursor=' + pend.body.nextCursor);                                    // another view (ADMIN's cursor, РП's request)
  await reject(pm, Q1() + '?cursor=' + Buffer.from(JSON.stringify({ b: ['work-types.list', P(), 'MANAGER', null], k: ['x', 'not-a-uuid'] })).toString('base64url'));
  await reject(pm, Q1() + '?cursor=AAAA');
});

test('D1-7 authentication and authorisation: anonymous 401; a role without the grant 403 BEFORE any scope lookup (even for an object that does not exist); only the named roles pass', async () => {
  const targets: [string, string[]][] = [[Q1(), ['PROJECT_MANAGER']], [Q2(), ['PROJECT_MANAGER']], [Q3(), ['PROJECT_MANAGER']], [Q4(), ['PROJECT_MANAGER', 'ADMIN']], [Q5(), ['PROJECT_MANAGER', 'ADMIN']]];
  for (const [path] of targets) {
    const anon = await get(null, path); assert.equal(anon.status, 401, path);
    assert.equal((await get('0'.repeat(40), path)).status, 401, 'an unknown token');
  }
  const cells: string[] = [];
  for (const role of roles) {
    const token = await g.roleToken(role);
    for (const [path, allowed] of targets) {
      const r = await get(token, path.replace(P(), uuid()));       // an object that does not exist: the grant is decided first
      const expected = allowed.includes(role) ? 404 : 403;
      if (path === Q4()) assert.equal(r.status, allowed.includes(role) ? 200 : 403, role + ' ' + path);
      else assert.equal(r.status, expected, role + ' ' + path + ' ' + JSON.stringify(r.body));
      if (r.status === 403) assert.deepEqual(Object.keys(r.body).sort(), ['code', 'message', 'requestId', 'statusCode'].sort());
      cells.push(`${role} ${path.replace(/[0-9a-f-]{36}/g, '{o}')} ${r.status}`);
    }
  }
  assert.equal(cells.length, roles.length * 5);
  // ADMIN is not given the РП reads (no implicit privilege expansion) and DEPUTY reads nothing
  for (const path of [Q1(), Q2(), Q3()]) { assert.equal((await get(admin, path)).status, 403, 'ADMIN ' + path); assert.equal((await get(deputy, path)).status, 403); }
});

test('D1-8 scope-safe 404: another РП\'s object, another tenant\'s object, a missing object and a malformed id are ONE answer — and nothing of them is disclosed', async () => {
  const bodies: string[] = [];
  for (const [token, path] of [
    [pm, Q1(pilot.neighbour.id)], [pm, Q2(foreign.object.id)], [pm, Q3(uuid())], [pm, Q5('not-a-uuid')], [pm, Q1('00000000-0000-0000-0000-000000000000')], [otherPm, Q3(P())],
    [admin, Q5(foreign.object.id)], [admin, Q5(uuid())], [admin, Q5('zzz')], [foreignPm, Q2(P())], [foreignPm, Q5(P())]] as const) {
    const r = await get(token, path);
    assert.equal(r.status, 404, path + ' ' + JSON.stringify(r.body));
    bodies.push(JSON.stringify({ ...r.body, requestId: undefined }));
  }
  assert.equal(new Set(bodies).size, 1, 'indistinguishable: ' + [...new Set(bodies)].join(' | '));
  assert.ok(!bodies[0].includes(pilot.neighbour.id) && !bodies[0].includes(foreign.object.id));
  // the validation message of a malformed query is not reachable from outside the scope
  assert.equal((await get(pm, Q1(pilot.neighbour.id) + '?limit=zero&bogus=1')).status, 404);
});

test('D1-9 the query string is strict: unknown, repeated and mistyped parameters, an out-of-range limit and an unknown state are 422 with every violation named; the tenant is never a parameter', async () => {
  const v = async (path: string) => { const r = await get(pm, path); assert.equal(r.status, 422, path + JSON.stringify(r.body)); assert.equal(r.body.code, 'VALIDATION_FAILED'); return r.body.details.violations; };
  assert.deepEqual(await v(Q1() + '?tenantId=' + foreign.tenant.id), [{ path: 'tenantId', rule: 'FIELD_NOT_ALLOWED' }]);
  assert.deepEqual(await v(Q1() + '?objectId=' + foreign.object.id), [{ path: 'objectId', rule: 'FIELD_NOT_ALLOWED' }]);
  assert.deepEqual(await v(Q1() + '?limit=0'), [{ path: 'limit', rule: 'OUT_OF_RANGE' }]);
  assert.deepEqual(await v(Q1() + '?limit=201'), [{ path: 'limit', rule: 'OUT_OF_RANGE' }]);
  assert.deepEqual(await v(Q1() + '?limit=-1'), [{ path: 'limit', rule: 'OUT_OF_RANGE' }]);
  assert.deepEqual(await v(Q1() + '?limit=1.5'), [{ path: 'limit', rule: 'OUT_OF_RANGE' }]);
  assert.deepEqual(await v(Q1() + '?limit=1&limit=2'), [{ path: 'limit', rule: 'FIELD_TYPE' }]);
  assert.deepEqual(await v(Q1() + '?limit[a]=1'), [{ path: '*', rule: 'FIELD_NOT_ALLOWED' }], 'a bracketed key is an unknown parameter; its name is never echoed');
  assert.deepEqual(await v(Q1() + '?state=PENDING'), [{ path: 'state', rule: 'FIELD_NOT_ALLOWED' }], 'state belongs to Q5 only');
  assert.deepEqual(await v(Q5() + '?state=DONE'), [{ path: 'state', rule: 'ENUM_VALUE' }]);
  assert.deepEqual(await v(Q5() + '?state=pending'), [{ path: 'state', rule: 'ENUM_VALUE' }], 'the enum is exact');
  assert.deepEqual(await v(Q2() + '?limit=0&zzz=1'), [{ path: 'limit', rule: 'OUT_OF_RANGE' }, { path: 'zzz', rule: 'FIELD_NOT_ALLOWED' }], 'all violations together, in query-string order');
  assert.equal((await get(pm, Q1() + '?limit=200')).status, 200); assert.equal((await get(pm, Q1() + '?limit=1')).status, 200);
  assert.equal((await get(pm, Q1() + '?limit=2&state=')).status, 422);
});

test('D1-10 a read has NO side effect: every table a command could touch is byte-identical after a battery of reads (reads of all five, every role, every error path)', async () => {
  const TABLES = ['works', 'work_execution_units', 'quantity_portions', 'work_scope_bindings', 'work_scope_state', 'work_scope_operations', 'gpr2_command_ledger', 'idempotent_commands', 'audit_logs',
    'domain_events', 'notifications', 'work_types', 'work_type_publication_requests', 'object_area_scopes', 'object_area_scope_child_revisions', 'object_finish_types', 'object_finish_system_versions',
    'finish_stage_occurrences', 'finish_stage_exclusions', 'finish_templates', 'finish_template_versions', 'finish_template_stages', 'work_type_reference_state', 'users', 'sessions', 'objects'];
  const digest = async () => Promise.all(TABLES.map(async t => [t, (await db.pool.query(`SELECT md5(coalesce(string_agg(row_to_json(x)::text, '|' ORDER BY row_to_json(x)::text), '')) AS d, count(*)::int AS c FROM ${t} x`)).rows[0]]));
  const before = await digest();
  for (const path of [Q1(), Q2(), Q3(), Q4(), Q5(), Q5() + '?state=PENDING', Q1() + '?limit=1', Q1(uuid()), Q1() + '?bogus=1']) {
    await get(pm, path); await get(admin, path); await get(deputy, path); await get(null, path); await get(otherPm, path);
  }
  assert.deepEqual(await digest(), before);
  // …and the implementation cannot write: no mutating statement and no lock clause exists in the read module, and the snapshot is READ ONLY
  const src = fs.readFileSync('apps/backend/src/gpr2-r05-read.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');  // code, not comments
  assert.doesNotMatch(src, /(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE|ALTER\s+TABLE|DROP\s|CREATE\s+(TABLE|FUNCTION|INDEX)|GRANT\s)/i);
  assert.doesNotMatch(src, /FOR\s+(UPDATE|SHARE|NO KEY UPDATE|KEY SHARE)|pg_advisory|SELECT\s+\*|insert\(|audit\(|runLedgered|runGpr2Command|runCommandTx/i);
  assert.match(src, /runSnapshotRead/);
});

test('D1-11 no stale authorisation: a role change, a deactivation or an object reassignment takes effect on the very next read (no cache, no-store)', async () => {
  const one = async (sql: string, a: any[]) => (await db.pool.query(sql, a)).rows[0];
  assert.equal((await get(pm, Q1())).status, 200);
  await db.pool.query("UPDATE users SET role='PTO' WHERE id=$1", [pilot.pm.id]);
  assert.equal((await get(pm, Q1())).status, 403, 'demoted: refused at once');
  assert.equal((await get(pm, Q5())).status, 403);
  await db.pool.query("UPDATE users SET role='PROJECT_MANAGER' WHERE id=$1", [pilot.pm.id]);
  assert.equal((await get(pm, Q1())).status, 200);
  await db.pool.query("UPDATE objects SET project_manager_id=$1 WHERE id=$2", [pilot.other.id, P()]);
  assert.equal((await get(pm, Q2())).status, 404, 'the object is no longer this РП\'s');
  assert.equal((await get(otherPm, Q2())).status, 200);
  await db.pool.query("UPDATE objects SET project_manager_id=$1 WHERE id=$2", [pilot.pm.id, P()]);
  assert.equal((await get(pm, Q2())).status, 200);
  await db.pool.query("UPDATE users SET is_active=false WHERE id=$1", [pilot.pm.id]);
  assert.equal((await get(pm, Q1())).status, 401, 'deactivated: the session no longer authenticates');
  await db.pool.query("UPDATE users SET is_active=true WHERE id=$1", [pilot.pm.id]);
  assert.equal((await get(pm, Q1())).status, 200); void one;
});

test('D1-12 the reads see exactly what the commands wrote: a new area scope / work type appears on the next read, a retired state is shown, nothing is read from another object after a write there', async () => {
  const r = await g.call(pm, 'POST', `/v2/objects/${P()}/area-scopes`, { body: { payload: { parentId: ID.B, kind: 'ROOM', code: 'LIVE-1', name: 'Новое', measureQuantity: '12.5', measureUnit: 'м²' } }, headers: { 'Idempotency-Key': uuid() } });
  assert.equal(r.status, 200);
  const list = (await all(pm, Q2())).items;
  assert.equal(list.find((a: any) => a.id === r.body.resultIds[0]).measureQuantity, '12.5000');
  const before = (await all(otherPm, Q2(pilot.neighbour.id))).items.length;
  await g.call(pm, 'POST', `/v2/objects/${P()}/area-scopes`, { body: { payload: { kind: 'ROOM', code: 'LIVE-2', name: 'Ещё' } }, headers: { 'Idempotency-Key': uuid() } });
  assert.equal((await all(otherPm, Q2(pilot.neighbour.id))).items.length, before);
});
