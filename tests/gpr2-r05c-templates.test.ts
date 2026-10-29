import './helpers/gpr2-isolation'; // FIRST: no backend module may load before the environment is pinned to in-memory PGlite
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { gpr2Harness, pilotScenario, uuid, type Gpr2Harness } from './helpers/gpr2-fixtures';
import type { Pilot } from './helpers/gpr-fixtures';
import { assertInMemoryPool } from './helpers/gpr2-isolation';

/**
 * GPR-2 R05c — versioned corporate templates, object finish-system versions, repeated stage occurrences and object-local overrides (TD §4.1, §5.2;
 * D06, D20; A07) over the real backend on in-memory PGlite. WorkType ≠ StageOccurrence: the two primers of «Грунт → Штукатурка → Грунт → Шпаклёвка →
 * Покраска» are two occurrences with their own ids. Published versions are immutable in PostgreSQL itself (direct SQL below).
 */
let g: Gpr2Harness;
let pilot: Pilot;
let db: any;
let pmToken: string, otherPmToken: string, adminToken: string, tenant: string;
const T: Record<string, string> = {};
before(async () => {
  g = await gpr2Harness('gpr2-r05c-key'); pilot = await pilotScenario(g.h); assert.equal(await assertInMemoryPool(), true);
  db = await import('../apps/backend/src/db');
  pmToken = await g.tokenFor(pilot.pm); otherPmToken = await g.tokenFor(pilot.other); adminToken = await g.roleToken('ADMIN'); tenant = await g.tenantId();
  // the corporate catalogue, through the existing dictionaries API (ADMIN_DICTIONARIES)
  await g.h.login('ADMIN');
  for (const [k, name, unit] of [['primer', 'Грунтование', 'м²'], ['plaster', 'Штукатурка', 'м²'], ['putty', 'Шпаклевание', 'м²'], ['paint', 'Покраска', 'м²'], ['tile', 'Плитка', 'м²'], ['water', 'Гидроизоляция', 'м²'], ['screed', 'Стяжка', 'м³']])
    T[k] = (await g.h.req('dictionaries/work-types', { categoryId: pilot.plaster.categoryId, name, unit, requiresInspection: true, requiresExecutiveDocs: true, requiresMaterials: true })).id;
});
after(async () => { await g?.h.close(); });

const post = (token: string | null, path: string, body: unknown, key: string | null = uuid()) =>
  g.call(token, 'POST', '/v2' + path, { body, headers: key ? { 'Idempotency-Key': key } : {} });
const q = async (sql: string, args: any[] = []) => (await db.pool.query(sql, args)).rows;
const digest = async (table: string, where = 'true', args: any[] = []) => (await q(`SELECT md5(coalesce(string_agg(row_to_json(t)::text, '|' ORDER BY id), '')) AS d FROM ${table} t WHERE ${where}`, args))[0].d;
const fails = async (sql: string, args: any[], re: RegExp) => assert.rejects(db.pool.query(sql, args), (e: any) => re.test(e.message), sql);
const stage = (occurrenceKey: string, position: number, workTypeId: string, extra: any = {}) => ({ occurrenceKey, position, workTypeId, required: true, measureScope: 'MAIN', measureUnit: 'м²', ...extra });
const TYPE1 = () => [stage('PRIMER_1', 1, T.primer, { proposedHoldHours: '4' }), stage('PLASTER', 2, T.plaster, { proposedHoldHours: '48' }), stage('PRIMER_2', 3, T.primer), stage('PUTTY', 4, T.putty), stage('PAINT', 5, T.paint)];
async function draft(payload: any) { const r = await post(adminToken, '/finish-templates', { payload }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; }
async function publish(templateId: string, versionId: string, expectedVersion: string) {
  const r = await post(adminToken, `/finish-templates/${templateId}/publish`, { expectedVersion, payload: { templateVersionId: versionId } });
  assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body;
}
const upsert = (payload: any, token = pmToken, objectId = pilot.object.id) => post(token, `/objects/${objectId}/finish-systems`, { payload });
let templateId: string, v1: string;

test('R05c-9 corporate template: the same WorkType twice is two stage occurrences with their own ids; only the Admin drafts; corporate types and exact units only', async () => {
  const r = await draft({ code: 'TPL-TYPE1', name: 'Штукатурка + покраска', stages: TYPE1() });
  [templateId, v1] = r.resultIds;
  const stages = await q('SELECT * FROM finish_template_stages WHERE template_version_id=$1 ORDER BY position', [v1]);
  assert.deepEqual(stages.map((s: any) => s.occurrence_key), ['PRIMER_1', 'PLASTER', 'PRIMER_2', 'PUTTY', 'PAINT']);
  const primers = stages.filter((s: any) => s.work_type_id === T.primer);
  assert.equal(primers.length, 2); assert.notEqual(primers[0].id, primers[1].id, 'first and third primer: different occurrence identities');
  assert.deepEqual(r.resultIds.slice(2), stages.map((s: any) => s.id));
  assert.ok(stages.every((s: any) => s.proposed_hold_status === 'PROPOSAL'), 'holds are proposals, never normative');
  assert.equal(stages[1].proposed_hold_hours, '48.000000000000');
  const n = Number((await q('SELECT count(*)::int AS n FROM finish_template_stages'))[0].n);
  // РП and deputy may not; duplicates, object types and wrong units are refused
  assert.equal((await post(pmToken, '/finish-templates', { payload: { code: 'X', name: 'x', stages: TYPE1() } })).status, 403);
  assert.equal((await post(await g.roleToken('DEPUTY_DIRECTOR'), '/finish-templates', { payload: { code: 'X', name: 'x', stages: TYPE1() } })).status, 403);
  const dupKey = await post(adminToken, '/finish-templates', { payload: { code: 'X1', name: 'x', stages: [stage('A', 1, T.primer), stage('A', 2, T.paint)] } });
  assert.equal(dupKey.status, 422); assert.ok(dupKey.body.details.violations.some((v: any) => v.rule === 'DUPLICATE_VALUE'));
  const objectType = (await post(pmToken, `/objects/${pilot.object.id}/work-types`, { payload: { name: 'Объектный грунт', categoryId: pilot.plaster.categoryId, unit: 'м²', requiresInspection: true, requiresExecutiveDocs: true, requiresMaterials: true } })).body.resultIds[0];
  T.objectPrimer = objectType;
  const obj = await post(adminToken, '/finish-templates', { payload: { code: 'X2', name: 'x', stages: [stage('A', 1, objectType)] } });
  assert.equal(obj.status, 422); assert.equal(obj.body.code, 'CROSS_SCOPE_REFERENCE');
  const unit = await post(adminToken, '/finish-templates', { payload: { code: 'X3', name: 'x', stages: [stage('A', 1, T.screed)] } }); // screed is м³
  assert.equal(unit.status, 422); assert.equal(unit.body.code, 'INVALID_MEASUREMENT');
  assert.equal(Number((await q('SELECT count(*)::int AS n FROM finish_template_stages'))[0].n), n);
  assert.equal(Number((await q("SELECT count(*)::int AS n FROM finish_templates WHERE code LIKE 'X%'"))[0].n), 0, 'a refused draft leaves no template behind');
  // PostgreSQL agrees without the API: an object WorkType or a wrong unit in a corporate stage
  await fails(`INSERT INTO finish_template_stages(tenant_id,template_version_id,occurrence_key,position,work_type_id,required,measure_scope,measure_unit) VALUES($1,$2,'SQL',9,$3,true,'MAIN','м²')`, [tenant, v1, objectType], /GPR2_R05:CROSS_SCOPE_REFERENCE/);
  await fails(`INSERT INTO finish_template_stages(tenant_id,template_version_id,occurrence_key,position,work_type_id,required,measure_scope,measure_unit) VALUES($1,$2,'SQL',9,$3,true,'MAIN','м²')`, [tenant, v1, T.screed], /GPR2_R05:INVALID_MEASUREMENT/);
});

test('R05c-11 published template is immutable (PostgreSQL); a change is a new version that rewrites nothing of the old one', async () => {
  const pub = await publish(templateId, v1, '1');
  assert.deepEqual(pub.resultIds, [templateId, v1]); assert.equal(pub.appliedVersions.aggregate, '2');
  const version = (await q('SELECT * FROM finish_template_versions WHERE id=$1', [v1]))[0];
  assert.equal(version.state, 'PUBLISHED'); assert.match(version.content_hash, /^[0-9a-f]{64}$/);
  const frozen = await Promise.all([digest('finish_template_versions', 'id=$1', [v1]), digest('finish_template_stages', 'template_version_id=$1', [v1])]);
  const stageId = (await q('SELECT id FROM finish_template_stages WHERE template_version_id=$1 LIMIT 1', [v1]))[0].id;
  await fails('UPDATE finish_template_stages SET required=false WHERE id=$1', [stageId], /GPR2_R05:VERSION_IMMUTABLE/);
  await fails('DELETE FROM finish_template_stages WHERE id=$1', [stageId], /GPR2_R05:VERSION_IMMUTABLE/);
  await fails(`INSERT INTO finish_template_stages(tenant_id,template_version_id,occurrence_key,position,work_type_id,required,measure_scope,measure_unit) VALUES($1,$2,'LATE',9,$3,true,'MAIN','м²')`, [tenant, v1, T.paint], /GPR2_R05:VERSION_IMMUTABLE/);
  await fails("UPDATE finish_template_versions SET content_hash=repeat('0',64) WHERE id=$1", [v1], /GPR2_R05:VERSION_IMMUTABLE/);
  await fails("UPDATE finish_template_versions SET state='DRAFT', content_hash=NULL, published_by=NULL, published_at=NULL WHERE id=$1", [v1], /GPR2_R05:VERSION_IMMUTABLE/);
  await fails('DELETE FROM finish_template_versions WHERE id=$1', [v1], /GPR2_R05:VERSION_IMMUTABLE/);
  // a second publication of the same version, and a stale template version token, are refused
  const again = await post(adminToken, `/finish-templates/${templateId}/publish`, { expectedVersion: '2', payload: { templateVersionId: v1 } });
  assert.equal(again.status, 422); assert.equal(again.body.code, 'VERSION_IMMUTABLE');
  // version 2: a new draft of the same template; version 1 is byte-identical afterwards
  const v2 = (await draft({ templateId, stages: [...TYPE1(), stage('VARNISH', 6, T.paint, { required: false })] })).resultIds[1];
  const twoDrafts = await post(adminToken, '/finish-templates', { payload: { templateId, stages: TYPE1() } });
  assert.equal(twoDrafts.status, 422); assert.equal(twoDrafts.body.code, 'INVALID_TRANSITION', 'one draft at a time');
  const stale = await post(adminToken, `/finish-templates/${templateId}/publish`, { expectedVersion: '1', payload: { templateVersionId: v2 } });
  assert.equal(stale.status, 409); assert.equal(stale.body.code, 'STALE_VERSION');
  await publish(templateId, v2, '2');
  assert.deepEqual((await q('SELECT version_number FROM finish_template_versions WHERE template_id=$1 ORDER BY 1', [templateId])).map((r: any) => r.version_number), [1, 2]);
  assert.deepEqual(await Promise.all([digest('finish_template_versions', 'id=$1', [v1]), digest('finish_template_stages', 'template_version_id=$1', [v1])]), frozen);
  // a version without stages is not publishable (direct SQL — the API cannot even draft one)
  const empty = (await q("INSERT INTO finish_template_versions(tenant_id,template_id,version_number,created_by) VALUES($1,$2,3,$3) RETURNING id", [tenant, templateId, (await q("SELECT id FROM users WHERE tenant_id=$1 AND role='ADMIN' LIMIT 1", [tenant]))[0].id]))[0].id;
  await fails("UPDATE finish_template_versions SET state='PUBLISHED', content_hash=repeat('a',64), published_by=created_by, published_at=now() WHERE id=$1", [empty], /GPR2_R05:MISSING_REQUIRED_DATA/);
});

test('R05c-9 object finish system from the template: provenance per occurrence, repeated WorkType kept apart, versions immutable', async () => {
  const before = Number((await q('SELECT count(*)::int AS n FROM works'))[0].n);
  const r = await upsert({ finishType: { code: 'TYPE-1', name: 'Тип №1' }, sourceTemplateVersionId: v1 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [ft, sv, ...occIds] = r.body.resultIds;
  const occ = await q('SELECT * FROM finish_stage_occurrences WHERE system_version_id=$1 ORDER BY position', [sv]);
  assert.deepEqual(occ.map((o: any) => o.id), occIds);
  assert.deepEqual(occ.map((o: any) => [o.occurrence_key, o.override_kind]), [['PRIMER_1', 'INHERITED'], ['PLASTER', 'INHERITED'], ['PRIMER_2', 'INHERITED'], ['PUTTY', 'INHERITED'], ['PAINT', 'INHERITED']]);
  const primers = occ.filter((o: any) => o.work_type_id === T.primer);
  assert.equal(primers.length, 2); assert.notEqual(primers[0].id, primers[1].id); assert.notEqual(primers[0].occurrence_key, primers[1].occurrence_key);
  assert.ok(occ.every((o: any) => o.source_template_version_id === v1 && o.object_id === pilot.object.id && o.proposed_hold_status === 'PROPOSAL'));
  assert.equal((await q('SELECT state, version_number, finish_type_id FROM object_finish_system_versions WHERE id=$1', [sv]))[0].state, 'PUBLISHED');
  assert.equal(Number((await q('SELECT count(*)::int AS n FROM works'))[0].n), before, 'publishing a finish system creates no Work (generation is R05d)');
  // immutable once published
  await fails('UPDATE finish_stage_occurrences SET required=false WHERE id=$1', [occIds[0]], /GPR2_R05:VERSION_IMMUTABLE/);
  await fails('DELETE FROM finish_stage_occurrences WHERE id=$1', [occIds[0]], /GPR2_R05:VERSION_IMMUTABLE/);
  await fails(`INSERT INTO finish_stage_occurrences(tenant_id,object_id,system_version_id,occurrence_key,position,work_type_id,required,measure_scope,measure_unit,override_kind) VALUES($1,$2,$3,'LATE',9,$4,true,'MAIN','м²','ADDED_LOCAL')`, [tenant, pilot.object.id, sv, T.paint], /GPR2_R05:VERSION_IMMUTABLE/);
  await fails("UPDATE object_finish_system_versions SET source_template_version_id=NULL WHERE id=$1", [sv], /GPR2_R05:VERSION_IMMUTABLE/);
  const frozen = await Promise.all([digest('object_finish_system_versions', 'id=$1', [sv]), digest('finish_stage_occurrences', 'system_version_id=$1', [sv])]);

  // version 2 of the same finish type: local overrides — an OVERRIDDEN stage needs a reason, a skipped template stage an explicit exclusion
  const tpl = await q('SELECT * FROM finish_template_stages WHERE template_version_id=$1 ORDER BY position', [v1]);
  const base = tpl.map((s: any) => ({ occurrenceKey: s.occurrence_key, position: s.position, workTypeId: s.work_type_id, required: s.required, measureScope: s.measure_scope, measureUnit: s.measure_unit, proposedHoldHours: s.proposed_hold_hours, sourceTemplateStageId: s.id }));
  const changed = base.map((s: any) => s.occurrenceKey === 'PLASTER' ? { ...s, proposedHoldHours: '72' } : s).filter((s: any) => s.occurrenceKey !== 'PUTTY');
  const local = { occurrenceKey: 'WATERPROOF', position: 6, workTypeId: T.objectPrimer, required: false, measureScope: 'LOCAL', measureUnit: 'м²' };
  const noReason = await upsert({ finishTypeId: ft, sourceTemplateVersionId: v1, stages: changed, excludedTemplateStages: [{ templateStageId: tpl[3].id, reason: 'по проекту без шпаклёвки' }] });
  assert.equal(noReason.status, 422); assert.equal(noReason.body.code, 'REASON_REQUIRED');
  const uncovered = await upsert({ finishTypeId: ft, sourceTemplateVersionId: v1, stages: changed.map((s: any) => s.occurrenceKey === 'PLASTER' ? { ...s, overrideReason: 'зимний период' } : s) });
  assert.equal(uncovered.status, 422); assert.deepEqual(uncovered.body.details.violations, [{ path: 'excludedTemplateStages', rule: 'FIELD_REQUIRED' }], 'a template stage never disappears silently');
  const ok2 = await upsert({ finishTypeId: ft, sourceTemplateVersionId: v1, stages: [...changed.map((s: any) => s.occurrenceKey === 'PLASTER' ? { ...s, overrideReason: 'зимний период' } : s), local],
    excludedTemplateStages: [{ templateStageId: tpl[3].id, reason: 'по проекту без шпаклёвки' }] });
  assert.equal(ok2.status, 200, JSON.stringify(ok2.body));
  const sv2 = ok2.body.resultIds[1];
  const occ2 = await q('SELECT occurrence_key, override_kind, override_reason, proposed_hold_hours::text AS h FROM finish_stage_occurrences WHERE system_version_id=$1 ORDER BY position', [sv2]);
  assert.deepEqual(occ2.map((o: any) => [o.occurrence_key, o.override_kind]), [['PRIMER_1', 'INHERITED'], ['PLASTER', 'OVERRIDDEN'], ['PRIMER_2', 'INHERITED'], ['PAINT', 'INHERITED'], ['WATERPROOF', 'ADDED_LOCAL']]);
  assert.equal(occ2[1].override_reason, 'зимний период');
  assert.deepEqual((await q('SELECT template_stage_id, reason FROM finish_stage_exclusions WHERE system_version_id=$1', [sv2])), [{ template_stage_id: tpl[3].id, reason: 'по проекту без шпаклёвки' }]);
  assert.deepEqual((await q('SELECT version_number FROM object_finish_system_versions WHERE finish_type_id=$1 ORDER BY 1', [ft])).map((r: any) => r.version_number), [1, 2]);
  assert.deepEqual(await Promise.all([digest('object_finish_system_versions', 'id=$1', [sv]), digest('finish_stage_occurrences', 'system_version_id=$1', [sv])]), frozen, 'version 1 untouched');
  // PostgreSQL refuses a provenance lie: INHERITED that is not an exact copy (direct SQL into a fresh draft)
  const draftSv = (await q(`INSERT INTO object_finish_system_versions(tenant_id,object_id,finish_type_id,version_number,source_template_version_id,created_by) VALUES($1,$2,$3,99,$4,$5) RETURNING id`, [tenant, pilot.object.id, ft, v1, pilot.pm.id]))[0].id;
  await fails(`INSERT INTO finish_stage_occurrences(tenant_id,object_id,system_version_id,occurrence_key,position,work_type_id,required,measure_scope,measure_unit,source_template_version_id,source_template_stage_id,override_kind) VALUES($1,$2,$3,'PLASTER',2,$4,false,'MAIN','м²',$5,$6,'INHERITED')`,
    [tenant, pilot.object.id, draftSv, T.plaster, v1, tpl[1].id], /GPR2_R05:PROVENANCE_MISMATCH/);
  await fails(`INSERT INTO finish_stage_occurrences(tenant_id,object_id,system_version_id,occurrence_key,position,work_type_id,required,measure_scope,measure_unit,source_template_version_id,source_template_stage_id,override_kind) VALUES($1,$2,$3,'PLASTER',2,$4,true,'MAIN','м²',$5,$6,'OVERRIDDEN')`,
    [tenant, pilot.object.id, draftSv, T.plaster, v1, tpl[1].id], /check/i); // OVERRIDDEN without a reason
  await fails("UPDATE object_finish_system_versions SET state='PUBLISHED', content_hash=repeat('b',64), published_by=created_by, published_at=now() WHERE id=$1", [draftSv], /GPR2_R05:MISSING_REQUIRED_DATA/);
});

test('R05c two finish systems of one object (Тип №1 plaster→putty→paint, Тип №2 plaster→tile) keep their common WorkType apart; scope / unit / role checks', async () => {
  const t2 = await upsert({ finishType: { code: 'TYPE-2', name: 'Тип №2' }, stages: [stage('PLASTER', 1, T.plaster), stage('TILE', 2, T.tile)] });
  assert.equal(t2.status, 200, JSON.stringify(t2.body));
  const occ = await q("SELECT o.id, o.override_kind, f.code FROM finish_stage_occurrences o JOIN object_finish_system_versions v ON v.id=o.system_version_id JOIN object_finish_types f ON f.id=v.finish_type_id WHERE o.work_type_id=$1 AND o.object_id=$2", [T.plaster, pilot.object.id]);
  const codes = new Set(occ.map((o: any) => o.code));
  assert.ok(codes.has('TYPE-1') && codes.has('TYPE-2'), 'Штукатурка is an occurrence of each system');
  assert.equal(new Set(occ.map((o: any) => o.id)).size, occ.length, 'never one shared occurrence');
  assert.ok(occ.filter((o: any) => o.code === 'TYPE-2').every((o: any) => o.override_kind === 'ADDED_LOCAL'), 'no template: local stages');
  // refusals: a draft template version as source, another object's WorkType, a wrong unit, ADMIN, another РП — nothing written
  const n = Number((await q('SELECT count(*)::int AS n FROM object_finish_system_versions'))[0].n);
  const draftV = (await draft({ code: 'TPL-DRAFT', name: 'черновик', stages: [stage('A', 1, T.paint)] })).resultIds[1];
  const r1 = await upsert({ finishType: { code: 'TYPE-3', name: 'x' }, sourceTemplateVersionId: draftV });
  assert.equal(r1.status, 422); assert.equal(r1.body.code, 'CROSS_SCOPE_REFERENCE');
  const theirs = (await post(otherPmToken, `/objects/${pilot.neighbour.id}/work-types`, { payload: { name: 'Чужой', categoryId: pilot.plaster.categoryId, unit: 'м²', requiresInspection: true, requiresExecutiveDocs: true, requiresMaterials: true } })).body.resultIds[0];
  const r2 = await upsert({ finishType: { code: 'TYPE-4', name: 'x' }, stages: [stage('A', 1, theirs)] });
  assert.equal(r2.status, 422); assert.equal(r2.body.code, 'CROSS_SCOPE_REFERENCE');
  const r3 = await upsert({ finishType: { code: 'TYPE-5', name: 'x' }, stages: [stage('A', 1, T.screed)] });
  assert.equal(r3.status, 422); assert.equal(r3.body.code, 'INVALID_MEASUREMENT');
  assert.equal((await upsert({ finishType: { code: 'TYPE-6', name: 'x' }, stages: [stage('A', 1, T.paint)] }, adminToken)).status, 403);
  assert.equal((await upsert({ finishType: { code: 'TYPE-7', name: 'x' }, stages: [stage('A', 1, T.paint)] }, otherPmToken)).status, 404);
  assert.equal((await upsert({ finishType: { code: 'TYPE-8', name: 'x' } })).status, 422, 'no template and no stages: nothing to version');
  assert.equal(Number((await q('SELECT count(*)::int AS n FROM object_finish_system_versions'))[0].n), n);
  assert.equal(Number((await q("SELECT count(*)::int AS n FROM object_finish_types WHERE code LIKE 'TYPE-%' AND code NOT IN ('TYPE-1','TYPE-2')"))[0].n), 0, 'a refused upsert leaves no registry entry behind');
  // the unit of a WorkType a stage measures in is frozen
  await fails("UPDATE work_types SET unit='м' WHERE id=$1", [T.tile], /GPR2_R05:UNIT_IMMUTABLE/);
});

test('R05c-10 no fictitious "no finish" entity: a non-finish Work has no finish system; the registry holds only what was registered', async () => {
  const registry = await q('SELECT code FROM object_finish_types WHERE object_id=$1 ORDER BY code', [pilot.object.id]);
  assert.ok(registry.every((r: any) => r.code.startsWith('TYPE-')), JSON.stringify(registry));
  assert.equal(Number((await q("SELECT count(*)::int AS n FROM object_finish_types WHERE name ILIKE '%без отделки%' OR name ILIKE '%no finish%'"))[0].n), 0);
  await g.h.as(pilot.pm);
  const work = await g.h.req('works', { objectId: pilot.object.id, workTypeId: T.screed, name: 'Стяжка пола (не отделка)', unit: 'м³', plannedQuantity: '12.5', idempotencyKey: uuid() });
  assert.equal(work.contractorId, null, 'R04 Early Work: no fake contractor');
  assert.deepEqual(await q('SELECT code FROM object_finish_types WHERE object_id=$1 ORDER BY code', [pilot.object.id]), registry, 'creating a non-finish Work adds no registry entry');
});
