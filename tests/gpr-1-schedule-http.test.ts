import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeUser, assignPtoToObject, handoffWorkToPto } from './helpers/pbx3-fixtures';
import { gprHarness, pilotScenario, reportFact, acceptInternalSc, type Harness, type Pilot } from './helpers/gpr-fixtures';

/**
 * GPR-1 — Production Schedule, over the REAL backend (HTTP, PGlite, mock auth, demo seed). Every figure is read back through the public API.
 *
 * Fixed calendar: floor 1 is planned 2026-03-01 .. 2026-03-11, floor 2 2026-03-12 .. 2026-03-22. Plan-versus-fact is asked for explicit days
 * (`?asOf=`), so nothing here depends on the day the suite runs. Production facts are reported through the real RP route, Internal СК through
 * the real inspection flow.
 */
let h: Harness;
before(async () => { h = await gprHarness('gpr-1-http-key'); });
after(async () => { await h?.close(); });

const F1 = { start: '2026-03-01', finish: '2026-03-11' }, F2 = { start: '2026-03-12', finish: '2026-03-22' };
const getSchedule = (objectId: string, asOf?: string) => h.req(`objects/${objectId}/schedule${asOf ? '?asOf=' + asOf : ''}`);
const draftVersion = async (objectId: string) => (await getSchedule(objectId)).draft.version as number;
const addEntry = (objectId: string, workId: string, unitId: string | null, start: string, finish: string, extra: Record<string, unknown> = {}) =>
  h.req(`objects/${objectId}/schedule/draft/entries`, { objectWorkId: workId, executionUnitId: unitId, plannedStart: start, plannedFinish: finish, ...extra });
const approve = async (objectId: string, extra: Record<string, unknown> = {}) => h.req(`objects/${objectId}/schedule/draft/approve`, { version: await draftVersion(objectId), ...extra });
const entryOf = (s: any, unitId: string) => s.entries.find((e: any) => e.executionUnitId === unitId);
const raw = (path: string, body?: any) => h.raw(path, body);
// audit_logs.old_value / new_value are jsonb: the driver hands them back already parsed.
const j = (v: any) => (typeof v === 'string' ? JSON.parse(v) : v);

/** A fresh object with the schedule drafted by the РП and approved by the deputy: floor 1 and floor 2 on their own dates. */
async function approvedPilot(): Promise<Pilot> {
  const p = await pilotScenario(h);
  await h.as(p.pm);
  await h.req(`objects/${p.object.id}/schedule/draft`, {});
  await addEntry(p.object.id, p.plasterWork.work.id, p.floor1.unit.id, F1.start, F1.finish);
  await addEntry(p.object.id, p.plasterWork.work.id, p.floor2.unit.id, F2.start, F2.finish);
  await h.login('DEPUTY_DIRECTOR');
  await approve(p.object.id, { comment: 'Базовый график' });
  return p;
}

test('A. authorization: everyone internal may read; the РП of the object (and the deputy) prepare; only the deputy approves; СК / ПТО / СДО / ГД are read-only; the contractor role sees nothing', async () => {
  const p = await pilotScenario(h);
  const read = async (role: string) => { await h.login(role); return raw(`objects/${p.object.id}/schedule`); };
  await assignPtoToObject(p.object.id); // the seeded PTO becomes an active member of THIS object
  const expectView: Record<string, number> = { GENERAL_DIRECTOR: 200, DEPUTY_DIRECTOR: 200, PROJECT_MANAGER: 200, CONSTRUCTION_CONTROL: 200, CONSTRUCTION_CONTROL_HEAD: 200, SDO: 200, SDO_HEAD: 200, ADMIN: 200, PTO: 200, CONTRACTOR_VIEWER: 403 };
  for (const [role, status] of Object.entries(expectView)) {
    const r = await read(role);
    assert.equal(r.status, status, `${role} reads the schedule -> ${status}`);
    if (status === 200) {
      assert.equal(r.data.conclusion.status, 'NO_BASELINE', 'no approved schedule yet: nothing is claimed');
      assert.equal(r.data.current, null);
    }
  }
  // access flags are decided by the server, per role
  const flags = async (role: string) => (await read(role)).data.access;
  assert.deepEqual(await flags('PROJECT_MANAGER'), { canEdit: true, canApprove: false, canRecordDelayReason: true, canCreateDraft: true, canManageCategories: false });
  assert.deepEqual(await flags('DEPUTY_DIRECTOR'), { canEdit: true, canApprove: true, canRecordDelayReason: true, canCreateDraft: true, canManageCategories: false });
  assert.deepEqual(await flags('ADMIN'), { canEdit: true, canApprove: true, canRecordDelayReason: true, canCreateDraft: true, canManageCategories: true });
  assert.deepEqual(await flags('GENERAL_DIRECTOR'), { canEdit: false, canApprove: false, canRecordDelayReason: false, canCreateDraft: false, canManageCategories: false });
  assert.deepEqual(await flags('CONSTRUCTION_CONTROL'), { canEdit: false, canApprove: false, canRecordDelayReason: false, canCreateDraft: false, canManageCategories: false });

  // read-only roles cannot prepare
  for (const role of ['GENERAL_DIRECTOR', 'CONSTRUCTION_CONTROL', 'CONSTRUCTION_CONTROL_HEAD', 'PTO', 'PTO_HEAD', 'SDO', 'SDO_HEAD', 'CONTRACTOR_VIEWER']) {
    await h.login(role);
    assert.equal((await raw(`objects/${p.object.id}/schedule/draft`, {})).status, 403, `${role} cannot open a draft`);
  }
  // another project manager cannot see or touch this object's schedule
  await h.as(p.other);
  assert.equal((await raw(`objects/${p.object.id}/schedule`)).status, 403, 'a РП of another object cannot read');
  assert.equal((await raw(`objects/${p.object.id}/schedule/draft`, {})).status, 403, 'a РП of another object cannot prepare');

  // the owner prepares, but cannot approve
  await h.as(p.pm);
  const draft = await h.req(`objects/${p.object.id}/schedule/draft`, {});
  assert.equal(draft.status, 'DRAFT');
  await addEntry(p.object.id, p.plasterWork.work.id, p.floor1.unit.id, F1.start, F1.finish);
  assert.equal((await raw(`objects/${p.object.id}/schedule/draft/approve`, { version: await draftVersion(p.object.id) })).status, 403, 'the РП does not approve their own plan');
  for (const role of ['GENERAL_DIRECTOR', 'CONSTRUCTION_CONTROL', 'SDO', 'PTO_HEAD', 'CONTRACTOR_VIEWER']) {
    await h.login(role);
    assert.equal((await raw(`objects/${p.object.id}/schedule/draft/approve`, { version: 1 })).status, 403, `${role} cannot approve`);
    assert.equal((await raw(`objects/${p.object.id}/schedule/draft/entries`, { objectWorkId: p.plasterWork.work.id, executionUnitId: p.floor2.unit.id, plannedStart: F2.start, plannedFinish: F2.finish })).status, 403, `${role} cannot edit the draft`);
  }
  // the draft is invisible to those who cannot prepare it
  await h.login('GENERAL_DIRECTOR');
  const asGd = await getSchedule(p.object.id);
  assert.equal(asGd.draft, null);
  assert.deepEqual(asGd.availableScopes, []);
  await h.as(p.pm);
  assert.equal((await getSchedule(p.object.id)).draft.entries.length, 1);

  // an unauthenticated call and a malformed id
  const bare = await fetch(`${h.base}/objects/${p.object.id}/schedule`);
  assert.equal(bare.status, 401);
  await h.login('DEPUTY_DIRECTOR');
  assert.equal((await raw('objects/not-a-uuid/schedule')).status, 400);
  assert.equal((await raw(`objects/${p.object.id}/schedule?asOf=2026-13-40`)).status, 400, 'a malformed calculation date is refused');
  assert.equal((await raw('objects/00000000-0000-4000-8000-000000000000/schedule')).status, 404);
});

test('B. a PTO engineer: no membership -> no plan; a work-level handoff opens THAT work\'s schedule summary only, never the object\'s whole plan; membership opens the object', async () => {
  const p = await approvedPilot();
  await h.login('PTO');
  assert.equal((await raw(`objects/${p.object.id}/schedule`)).status, 403, 'not on the object at all');
  assert.equal((await raw(`works/${p.plasterWork.work.id}/schedule`)).status, 403);

  // PILOT-W01 handoff only: a fresh engineer on a fresh head's team holds an effective assignment on ONE work — object SHELL access, no membership
  const { ObjectTeamService } = await import('../apps/backend/src/team-service');
  const { actorByRole } = await import('./helpers/pbx3-fixtures');
  const svc = new ObjectTeamService();
  const deputy = await actorByRole('DEPUTY_DIRECTOR');
  const head = await makeUser('Начальник ПТО (график)', 'PTO_HEAD'), engineer = await makeUser('Инженер ПТО (график)', 'PTO');
  await svc.assignObjectLead(deputy, p.object.id, { leadUserId: head.id });
  await svc.assignOrgMember(deputy, { memberUserId: engineer.id, managerUserId: head.id });
  await handoffWorkToPto(p.plasterWork.work.id, engineer);
  await h.as(engineer);
  assert.equal((await raw(`objects/${p.object.id}`)).status, 200, 'the handoff opens the object shell (existing behaviour)');
  assert.equal((await raw(`objects/${p.object.id}/schedule`)).status, 403, 'but the whole object\'s plan is more than the handed-off work');
  const own = await raw(`works/${p.plasterWork.work.id}/schedule?asOf=2026-03-06`);
  assert.equal(own.status, 200, 'the handed-off work\'s own schedule summary is readable (W01)');
  assert.equal(own.data.entries.length, 2);
  assert.equal(own.data.canOpenObjectSchedule, false, 'and the response says the object\'s whole plan is shut to this viewer, so W01 offers no door to it');

  // full object membership opens the object\'s schedule
  await assignPtoToObject(p.object.id, { lead: head, member: engineer });
  assert.equal((await raw(`objects/${p.object.id}/schedule`)).status, 200);
  assert.equal((await raw(`works/${p.plasterWork.work.id}/schedule`)).data.canOpenObjectSchedule, true, 'a member may open the object\'s plan from the work');
  const other = await makeUser('Другой ПТО', 'PTO');
  await h.as(other);
  assert.equal((await raw(`objects/${p.object.id}/schedule`)).status, 403, 'another engineer, not a member');
  assert.equal((await raw(`works/${p.plasterWork.work.id}/schedule`)).status, 403, 'and not assigned to the work either');
});

test('C. the schedule is tied to the production domain of ITS object: only that object\'s works and units, with their zone, executor and planned quantity read from the production model', async () => {
  const p = await pilotScenario(h);
  await h.as(p.pm);
  await h.req(`objects/${p.object.id}/schedule/draft`, {});
  const s0 = await getSchedule(p.object.id);
  // what can be planned = the real scopes of this object: the two zones (the work itself is planned through them)
  assert.deepEqual(s0.availableScopes.map((x: any) => [x.workName, x.zone, x.executor, x.unit, x.plannedQuantity]).sort(), [
    ['Штукатурка стен', '1 этаж', p.contractors[0].name, 'м²', '500.0000'],
    ['Штукатурка стен', '2 этаж', p.contractors[1].name, 'м²', '300.0000'],
  ].sort());
  assert.ok(s0.availableScopes.every((x: any) => x.suggestedStart && x.suggestedFinish), 'the work\'s own window is offered as the default dates');

  const e1 = await addEntry(p.object.id, p.plasterWork.work.id, p.floor1.unit.id, F1.start, F1.finish);
  assert.equal(e1.plannedStart, F1.start);
  assert.equal(e1.sequence, 1, 'first entry takes the first place');
  const e2 = await addEntry(p.object.id, p.plasterWork.work.id, p.floor2.unit.id, F2.start, F2.finish);
  assert.equal(e2.sequence, 2);

  // the draft view carries the scope's zone / executor / quantity from the unit, and nothing the schedule could have stored
  const d = (await getSchedule(p.object.id)).draft;
  const row = d.entries.find((x: any) => x.executionUnitId === p.floor1.unit.id);
  assert.equal(row.zone, '1 этаж');
  assert.equal(row.executor, p.contractors[0].name);
  assert.equal(row.plannedQuantity, '500.0000');
  assert.equal(row.unit, 'м²');
  assert.equal(row.workName, 'Штукатурка стен');

  // the schedule stores NO production facts: no quantity / contractor / zone column exists in any of its tables
  const { pool } = await import('../apps/backend/src/db');
  const cols = (await pool.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_name IN ('schedule_items','schedule_revisions','schedule_revision_entries','schedule_delay_reasons') ORDER BY 1,2")).rows;
  const forbidden = cols.filter((c: any) => /quantity|contractor|location|zone|cost|amount|progress|percent|fact/i.test(c.column_name) && c.column_name !== 'responsible_contractor_id');
  assert.deepEqual(forbidden, [], 'planned quantity, executor, zone and progress are read from the production model, never copied');

  // ...and the API refuses to take any of them
  for (const extra of [{ plannedQuantity: 999 }, { contractorId: p.contractors[1].id }, { location: 'Крыша' }, { rpFactQuantity: 500 }, { status: 'DELAYED' }]) {
    const r = await raw(`objects/${p.object.id}/schedule/draft/entries`, { objectWorkId: p.plasterWork.work.id, executionUnitId: p.floor1.unit.id, plannedStart: F1.start, plannedFinish: F1.finish, ...extra });
    assert.equal(r.status, 400, 'strict body: ' + Object.keys(extra)[0]);
  }
  // a scope can be planned once per draft
  assert.equal((await raw(`objects/${p.object.id}/schedule/draft/entries`, { objectWorkId: p.plasterWork.work.id, executionUnitId: p.floor1.unit.id, plannedStart: F1.start, plannedFinish: F1.finish })).status, 400);
  // a work that HAS units is planned through them, not as a whole; and not both
  const whole = await raw(`objects/${p.object.id}/schedule/draft/entries`, { objectWorkId: p.plasterWork.work.id, executionUnitId: null, plannedStart: F1.start, plannedFinish: F2.finish });
  assert.equal(whole.status, 400);
  assert.match(whole.data.message, /есть участки производства/);
  // dates must be a real period
  const backwards = await raw(`objects/${p.object.id}/schedule/draft/entries`, { objectWorkId: p.plasterWork.work.id, executionUnitId: p.floor1.unit.id, plannedStart: F1.finish, plannedFinish: F1.start });
  assert.equal(backwards.status, 400);
  assert.equal((await raw(`objects/${p.object.id}/schedule/draft/entries`, { objectWorkId: p.plasterWork.work.id, executionUnitId: p.floor1.unit.id, plannedStart: '2026-02-30', plannedFinish: F1.finish })).status, 400);

  // cross-object: another object's work / unit simply does not exist for this schedule
  assert.equal((await raw(`objects/${p.object.id}/schedule/draft/entries`, { objectWorkId: p.neighbourWork.work.id, executionUnitId: null, plannedStart: F1.start, plannedFinish: F1.finish })).status, 404);
  assert.equal((await raw(`objects/${p.object.id}/schedule/draft/entries`, { objectWorkId: p.neighbourWork.work.id, executionUnitId: p.neighbourUnit.unit.id, plannedStart: F1.start, plannedFinish: F1.finish })).status, 404);
  // a unit of ANOTHER work of this very object is not a unit of the work named in the request
  await h.as(p.pm);
  const second = await h.req('works', { objectId: p.object.id, workTypeId: p.plaster.id, contractorId: p.contractors[0].id, responsibleUserId: p.pm.id, name: 'Грунтовка', unit: 'м²', plannedQuantity: 100, plannedStartDate: '2026-03-01', plannedFinishDate: '2026-03-10', estimatedCost: '1000' });
  assert.equal((await raw(`objects/${p.object.id}/schedule/draft/entries`, { objectWorkId: second.id, executionUnitId: p.floor1.unit.id, plannedStart: F1.start, plannedFinish: F1.finish })).status, 404);
  // a work with NO units is planned as a whole — the simple shape
  const wholeEntry = await addEntry(p.object.id, second.id, null, '2026-03-01', '2026-03-10');
  assert.equal(wholeEntry.sequence, 3);
  // ...and once planned as a whole it cannot also be planned through units
  const unitOfSecond = await h.req('execution-units', { objectWorkId: second.id, workTypeId: p.plaster.id, contractorId: p.contractors[0].id, unit: 'м²', plannedQuantity: 100, location: 'Коридор' });
  const clash = await raw(`objects/${p.object.id}/schedule/draft/entries`, { objectWorkId: second.id, executionUnitId: unitOfSecond.id, plannedStart: '2026-03-01', plannedFinish: '2026-03-10' });
  assert.equal(clash.status, 400);
  assert.match(clash.data.message, /Работа уже включена в график целиком/);
  // approving that draft is refused too: the work gained units after it was planned as a whole
  await h.login('DEPUTY_DIRECTOR');
  const stale = await raw(`objects/${p.object.id}/schedule/draft/approve`, { version: await draftVersion(p.object.id) });
  assert.equal(stale.status, 400);
  assert.match(stale.data.message, /есть участки производства/);
});

test('D. different zones, different dates — and the object is never mixed: a record of another object cannot be reached by id', async () => {
  const p = await approvedPilot();
  const s = await getSchedule(p.object.id, '2026-03-06');
  assert.equal(s.entries.length, 2);
  const f1 = entryOf(s, p.floor1.unit.id), f2 = entryOf(s, p.floor2.unit.id);
  assert.deepEqual([f1.plannedStart, f1.plannedFinish], [F1.start, F1.finish]);
  assert.deepEqual([f2.plannedStart, f2.plannedFinish], [F2.start, F2.finish]);
  assert.equal(f1.zone, '1 этаж'); assert.equal(f2.zone, '2 этаж');
  assert.equal(f1.executor, p.contractors[0].name); assert.equal(f2.executor, p.contractors[1].name, 'different contractors execute different zones');
  assert.notEqual(f1.itemId, f2.itemId);
  // the neighbour object has its own, independent schedule
  await h.as(p.other);
  await h.req(`objects/${p.neighbour.id}/schedule/draft`, {});
  await addEntry(p.neighbour.id, p.neighbourWork.work.id, p.neighbourUnit.unit.id, '2026-03-01', '2026-03-05');
  const neighbourDraft = (await getSchedule(p.neighbour.id)).draft;
  await h.login('DEPUTY_DIRECTOR');
  await approve(p.neighbour.id);
  const n = await getSchedule(p.neighbour.id, '2026-03-06');
  assert.equal(n.entries.length, 1);
  assert.equal(n.entries[0].workName, 'Окраска фасада');
  assert.ok(!JSON.stringify(n).includes(p.plasterWork.work.id), 'no identifier of another object in this object\'s schedule');
  assert.ok(!JSON.stringify(s).includes(p.neighbourWork.work.id));

  // by id, through the wrong object's URL: not found, never a leak and never a write
  const foreignEntry = n.entries[0];
  await h.as(p.pm);
  await h.req(`objects/${p.object.id}/schedule/draft`, {});
  const mine = (await getSchedule(p.object.id)).draft;
  await h.login('DEPUTY_DIRECTOR');
  assert.equal((await raw(`objects/${p.object.id}/schedule/draft/entries/${neighbourDraft.entries[0].entryId}/edit`, { version: 1, plannedFinish: '2026-04-01' })).status, 404, 'edit through the wrong object');
  assert.equal((await raw(`objects/${p.object.id}/schedule/draft/entries/${neighbourDraft.entries[0].entryId}/remove`, { version: 1 })).status, 404, 'remove through the wrong object');
  assert.equal((await raw(`objects/${p.object.id}/schedule/delay-reasons`, { itemId: foreignEntry.itemId, categoryCode: 'MATERIALS', comment: 'чужой участок' })).status, 404, 'a delay reason about another object\'s item');
  assert.equal((await raw(`objects/${p.object.id}/schedule/delay-reasons/${foreignEntry.entryId}/resolve`, { version: 1 })).status, 404);
  assert.equal((await raw(`works/${p.neighbourWork.work.id}/schedule`)).status, 200, 'the deputy sees every object');
  await h.as(p.pm);
  assert.equal((await raw(`works/${p.neighbourWork.work.id}/schedule`)).status, 403, 'the РП of this object cannot read another object\'s work schedule');
  assert.equal((await raw(`objects/${p.neighbour.id}/schedule`)).status, 403);
  // untouched
  await h.login('DEPUTY_DIRECTOR');
  const after = await getSchedule(p.neighbour.id, '2026-03-06');
  assert.deepEqual(after.entries.map((e: any) => [e.plannedStart, e.plannedFinish]), [['2026-03-01', '2026-03-05']]);
  assert.equal(mine.entries.length, 2, 'this object\'s own draft is its own copy');
});

test('E. approval: the draft becomes the current baseline; approved dates cannot be rewritten — not through the API, not through SQL', async () => {
  const p = await pilotScenario(h);
  await h.as(p.pm);
  const draft = await h.req(`objects/${p.object.id}/schedule/draft`, {});
  assert.equal(draft.revisionNo, 1);
  assert.equal((await raw(`objects/${p.object.id}/schedule/draft`, {})).status, 409, 'one draft at a time');
  // empty draft cannot be approved
  await h.login('DEPUTY_DIRECTOR');
  assert.match((await raw(`objects/${p.object.id}/schedule/draft/approve`, { version: await draftVersion(p.object.id) })).data.message, /Пустой график/);
  await h.as(p.pm);
  const e1 = await addEntry(p.object.id, p.plasterWork.work.id, p.floor1.unit.id, F1.start, F1.finish);
  await addEntry(p.object.id, p.plasterWork.work.id, p.floor2.unit.id, F2.start, F2.finish);

  // the draft is not authoritative: no plan-versus-fact exists until it is approved
  const preview = await getSchedule(p.object.id, '2026-03-06');
  assert.equal(preview.current, null);
  assert.equal(preview.entries.length, 0);
  assert.equal(preview.conclusion.status, 'NO_BASELINE');

  // optimistic locking: approving a stale view of the draft is refused
  await h.login('DEPUTY_DIRECTOR');
  const stale = await draftVersion(p.object.id);
  await h.as(p.pm);
  await h.req(`objects/${p.object.id}/schedule/draft/entries/${e1.id}/edit`, { version: e1.version, plannedFinish: '2026-03-12' });
  await h.login('DEPUTY_DIRECTOR');
  assert.equal((await raw(`objects/${p.object.id}/schedule/draft/approve`, { version: stale })).status, 409, 'the approver must approve exactly what they saw');

  const approved = await approve(p.object.id, { comment: 'Утверждён на совещании' });
  assert.equal(approved.status, 'APPROVED');
  assert.equal(approved.revisionNo, 1);
  const deputy = await (await import('../apps/backend/src/db')).one((await import('../apps/backend/src/db')).pool, "SELECT id FROM users WHERE role='DEPUTY_DIRECTOR' ORDER BY created_at LIMIT 1");
  assert.equal(approved.approvedBy, deputy.id, 'approval provenance: who');
  assert.ok(approved.approvedAt, 'approval provenance: when');
  assert.equal(approved.approvalComment, 'Утверждён на совещании');
  assert.equal(approved.correctionReason, null, 'the first approval is not a correction');

  const s = await getSchedule(p.object.id, '2026-03-06');
  assert.equal(s.current.revisionNo, 1);
  assert.equal(s.current.approvedByName, 'Виктор Соловьёв');
  assert.equal(s.hasDraft, false);
  assert.equal(entryOf(s, p.floor1.unit.id).plannedFinish, '2026-03-12', 'the edited date is what was approved');

  // nothing in the API edits an approved entry; the draft routes refuse it
  const approvedEntry = entryOf(s, p.floor1.unit.id);
  assert.equal((await raw(`objects/${p.object.id}/schedule/draft/entries/${approvedEntry.entryId}/edit`, { version: 1, plannedFinish: '2026-05-01' })).status, 409);
  assert.equal((await raw(`objects/${p.object.id}/schedule/draft/entries/${approvedEntry.entryId}/remove`, { version: 1 })).status, 409);
  assert.equal((await raw(`objects/${p.object.id}/schedule/draft/approve`, { version: 1 })).status, 409, 'no draft to approve');
  assert.equal((await raw(`objects/${p.object.id}/schedule/draft/discard`, { version: 1 })).status, 409);

  // ...and the database itself refuses a writer that bypasses the service
  const { pool } = await import('../apps/backend/src/db');
  await assert.rejects(() => pool.query('UPDATE schedule_revision_entries SET planned_finish=$2 WHERE id=$1', [approvedEntry.entryId, '2026-06-30']), /только в черновике/);
  await assert.rejects(() => pool.query('DELETE FROM schedule_revision_entries WHERE id=$1', [approvedEntry.entryId]), /только в черновике/);
  await assert.rejects(() => pool.query(`INSERT INTO schedule_revision_entries(tenant_id,revision_id,item_id,planned_start,planned_finish,sequence) SELECT tenant_id,revision_id,item_id,planned_start,planned_finish,99 FROM schedule_revision_entries WHERE id=$1`, [approvedEntry.entryId]), /только в черновике|duplicate|unique/i);
  await assert.rejects(() => pool.query("UPDATE schedule_revisions SET approved_by=NULL,approved_at=NULL,status='DRAFT' WHERE id=$1", [approved.id]), /Недопустимый переход|не изменяется/);
  await assert.rejects(() => pool.query("UPDATE schedule_revisions SET approval_comment='подмена' WHERE id=$1", [approved.id]), /не изменяется|не переписываются/);
  await assert.rejects(() => pool.query('DELETE FROM schedule_revisions WHERE id=$1', [approved.id]), /не удаляется/);
  await assert.rejects(() => pool.query('UPDATE schedule_items SET created_by=created_by WHERE id=$1', [approvedEntry.itemId]), /неизменяем/);
  // a second current baseline for the object cannot exist
  await assert.rejects(() => pool.query(`INSERT INTO schedule_revisions(tenant_id,object_id,revision_no,status,created_by,approved_by,approved_at) SELECT tenant_id,object_id,2,'APPROVED',created_by,approved_by,now() FROM schedule_revisions WHERE id=$1`, [approved.id]), /unique|duplicate/i);

  // audit: who / when / what, in the system audit log
  const audit = (await pool.query("SELECT entity_type,action,user_id,old_value,new_value FROM audit_logs WHERE entity_type IN ('ScheduleRevision','ScheduleEntry') AND created_at >= $1 ORDER BY created_at, id", [draft.createdAt])).rows;
  const actions = audit.map((a: any) => a.entity_type + ':' + a.action);
  for (const wanted of ['ScheduleRevision:CREATE_DRAFT', 'ScheduleEntry:ADD', 'ScheduleEntry:EDIT', 'ScheduleRevision:APPROVE']) assert.ok(actions.includes(wanted), wanted);
  const edit = audit.find((a: any) => a.action === 'EDIT' && j(a.new_value).itemId === approvedEntry.itemId);
  assert.equal(j(edit.old_value).plannedFinish, F1.finish, 'audit keeps BEFORE');
  assert.equal(j(edit.new_value).plannedFinish, '2026-03-12', 'audit keeps AFTER');
  assert.equal(edit.user_id, p.pm.id);
});

test('F. a draft can be discarded; history keeps it out of the way, the current baseline stays', async () => {
  const p = await approvedPilot();
  await h.as(p.pm);
  const d = await h.req(`objects/${p.object.id}/schedule/draft`, {});
  assert.equal(d.revisionNo, 2);
  assert.equal(d.basedOnRevisionId !== null, true, 'a correction is cloned from the approved baseline');
  const s = await getSchedule(p.object.id);
  assert.equal(s.draft.entries.length, 2, 'the clone carries the approved entries');
  assert.equal(s.draft.entries.every((e: any) => e.change === null), true, 'nothing changed yet');
  assert.equal(s.draft.changes.length, 0);
  const discarded = await h.req(`objects/${p.object.id}/schedule/draft/discard`, { version: s.draft.version });
  assert.equal(discarded.status, 'DISCARDED');
  const after = await getSchedule(p.object.id);
  assert.equal(after.draft, null);
  assert.equal(after.current.revisionNo, 1, 'the approved baseline is untouched');
  assert.equal(after.history.length, 1);
  const { pool } = await import('../apps/backend/src/db');
  await assert.rejects(() => pool.query("UPDATE schedule_revisions SET status='DRAFT',discarded_at=NULL,discarded_by=NULL WHERE id=$1", [d.id]), /Недопустимый переход|не изменяется/);
  // the next draft gets the next number, never a reused one
  assert.equal((await h.req(`objects/${p.object.id}/schedule/draft`, {})).revisionNo, 3);
});

test('G. plan versus fact from dates and RP fact: on schedule, delayed with calendar days, completed — fact reported through the real RP route', async () => {
  const p = await approvedPilot();
  // no fact at all, floor 1 starts 2026-03-01
  let s = await getSchedule(p.object.id, '2026-02-27');
  assert.equal(entryOf(s, p.floor1.unit.id).state, 'NOT_STARTED');
  assert.equal(entryOf(s, p.floor1.unit.id).expectedPhase, 'NOT_DUE');
  assert.equal(entryOf(s, p.floor1.unit.id).factReported, false);
  assert.equal(s.conclusion.status, 'ON_TRACK', 'nothing is due yet: no delay');
  s = await getSchedule(p.object.id, '2026-03-02');
  assert.equal(entryOf(s, p.floor1.unit.id).state, 'DELAYED', 'a day after the start date and still no fact');
  assert.equal(entryOf(s, p.floor1.unit.id).delayDays, 1);
  assert.equal(entryOf(s, p.floor1.unit.id).delayKind, 'START');
  assert.equal(entryOf(s, p.floor2.unit.id).state, 'NOT_STARTED', 'floor 2 has its own dates');
  assert.equal(s.conclusion.status, 'DELAYED');

  // A. the work progresses according to the schedule: 250 of 500 on the day the plan says 50%
  await reportFact(h, p.pm, p.floor1.portion.id, 250);
  s = await getSchedule(p.object.id, '2026-03-06');
  let f1 = entryOf(s, p.floor1.unit.id);
  assert.equal(f1.state, 'IN_PROGRESS');
  assert.equal(f1.delayDays, 0);
  assert.equal(f1.plannedProgress, 50);
  assert.equal(f1.actualProgress, 50);
  assert.equal(f1.rpFactQuantity, '250.0000');
  assert.equal(s.conclusion.status, 'ON_TRACK');
  assert.equal(s.conclusion.inProgressCount, 1);

  // B. the same fact on a later day is a delay: the plan expected 80%, the equivalent plan date for 50% was three days ago
  s = await getSchedule(p.object.id, '2026-03-09');
  f1 = entryOf(s, p.floor1.unit.id);
  assert.equal(f1.state, 'DELAYED');
  assert.equal(f1.delayDays, 3);
  assert.equal(f1.delayKind, 'PROGRESS');
  assert.equal(f1.plannedProgress, 80);
  assert.equal(f1.actualProgress, 50);
  assert.equal(s.conclusion.status, 'DELAYED');
  assert.equal(s.conclusion.delayedCount, 1);
  assert.equal(s.conclusion.maxDelayDays, 3);

  // what should have started / be underway / be finished is answered from the calendar
  assert.deepEqual(s.conclusion.expected, { notDue: 1, underway: 1, dueComplete: 0 });
  s = await getSchedule(p.object.id, '2026-03-30');
  assert.deepEqual(s.conclusion.expected, { notDue: 0, underway: 0, dueComplete: 2 });
  // exact: Mar 30 is 29 days in, 50% of 10 plan-days = 5 -> 24 days behind
  assert.equal(entryOf(s, p.floor1.unit.id).delayDays, 24);
  assert.equal(entryOf(s, p.floor1.unit.id).delayKind, 'FINISH');

  // the full pilot fact: 500 of 500 -> Выполнено, however late it is asked
  await reportFact(h, p.pm, p.floor1.portion.id, 500);
  s = await getSchedule(p.object.id, '2026-03-30');
  f1 = entryOf(s, p.floor1.unit.id);
  assert.equal(f1.state, 'COMPLETED');
  assert.equal(f1.delayDays, 0);
  assert.equal(f1.actualProgress, 100);
  assert.equal(s.conclusion.completedCount, 1);
  assert.equal(entryOf(s, p.floor2.unit.id).state, 'DELAYED', 'floor 2 is a separate scope with its own dates');
});

test('H. progress is the existing production fact — it cannot be entered into the schedule, and СК / ПТО / СДО do not move it', async () => {
  const p = await approvedPilot();
  await reportFact(h, p.pm, p.floor1.portion.id, 500);
  let s = await getSchedule(p.object.id, '2026-03-06');
  assert.equal(s.progressSource, 'RP_FACT', 'the provenance is stated in the model');
  assert.equal(entryOf(s, p.floor1.unit.id).state, 'COMPLETED');
  assert.equal(entryOf(s, p.floor1.unit.id).internalScAcceptedQuantity, null, 'no СК acceptance yet — and it did not matter');

  // the progress equals the figure the existing readiness is built from
  const snap = await h.req('snapshot');
  assert.equal(snap.executionUnits.find((u: any) => u.id === p.floor1.unit.id).actualQuantity, entryOf(s, p.floor1.unit.id).rpFactQuantity);

  // Internal СК accepts 498 of 500: shown next to the fact, never in place of it
  await acceptInternalSc(h, p.floor1.portion.id, 498);
  await h.login('DEPUTY_DIRECTOR');
  s = await getSchedule(p.object.id, '2026-03-06');
  const f1 = entryOf(s, p.floor1.unit.id);
  assert.equal(f1.rpFactQuantity, '500.0000');
  assert.equal(f1.internalScAcceptedQuantity, '498.0000');
  assert.equal(f1.actualProgress, 100, '498 accepted does not turn 500 reported into 99.6%');
  assert.equal(f1.state, 'COMPLETED');
  assert.equal((await h.req('snapshot')).portions.find((q: any) => q.id === p.floor1.portion.id).rpFactQuantity, '500.0000', 'the RP fact itself is not overwritten');

  // documentation exists independently: the work has no package, no AOSR and no SDO case — and is physically complete all the same
  const { pool } = await import('../apps/backend/src/db');
  assert.equal((await pool.query('SELECT count(*)::int n FROM documentation_packages WHERE object_work_id=$1', [p.plasterWork.work.id])).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM sdo_closing_cases WHERE object_work_id=$1', [p.plasterWork.work.id])).rows[0].n, 0);
  // ...and a documentation package that is returned / still being prepared does not change it either
  await assignPtoToObject(p.object.id);
  await handoffWorkToPto(p.plasterWork.work.id);
  await h.login('PTO');
  const pkg = await h.req('documentation-packages', { objectWorkId: p.plasterWork.work.id, quantityPortionIds: [p.floor1.portion.id] });
  assert.ok(pkg.id);
  await h.login('DEPUTY_DIRECTOR');
  const withPackage = await getSchedule(p.object.id, '2026-03-06');
  assert.deepEqual(entryOf(withPackage, p.floor1.unit.id).state, 'COMPLETED');
  assert.equal(entryOf(withPackage, p.floor1.unit.id).actualProgress, 100);

  // a source-level guard: the schedule code reads no documentation / AOSR / SDO / money table at all
  for (const file of ['apps/backend/src/schedule-service.ts', 'apps/backend/src/schedule-scope.ts', 'packages/domain/schedule.ts']) {
    const src = fs.readFileSync(file, 'utf8');
    for (const forbidden of ['documentation_', 'aosr_', 'sdo_', 'executive_', 'financial_closings', 'estimated_cost', 'contract_value']) assert.equal(src.includes(forbidden), false, `${file} must not mention ${forbidden}`);
  }
});

test('I. schedule survives partial progress: facts arrive in pieces, the approved entry never changes — only the measured figures do', async () => {
  const p = await approvedPilot();
  const first = entryOf(await getSchedule(p.object.id, '2026-03-04'), p.floor1.unit.id);
  const identity = { entryId: first.entryId, itemId: first.itemId, start: first.plannedStart, finish: first.plannedFinish, seq: first.sequence };
  const steps: [number, string, number][] = [[120, 'IN_PROGRESS', 24], [250, 'IN_PROGRESS', 50], [400, 'IN_PROGRESS', 80], [500, 'COMPLETED', 100]];
  for (const [quantity, state, percent] of steps) {
    await reportFact(h, p.pm, p.floor1.portion.id, quantity);
    const s = await getSchedule(p.object.id, '2026-03-04');
    const f1 = entryOf(s, p.floor1.unit.id);
    assert.equal(f1.rpFactQuantity, quantity.toFixed(4));
    assert.equal(Math.round(f1.actualProgress), percent);
    assert.equal(f1.state, state, `${quantity} of 500 on day 3 of 10`);
    assert.deepEqual({ entryId: f1.entryId, itemId: f1.itemId, start: f1.plannedStart, finish: f1.plannedFinish, seq: f1.sequence }, identity, 'the approved entry is exactly what was approved');
    assert.equal(s.current.revisionNo, 1, 'partial progress never creates, supersedes or edits a revision');
    assert.equal(s.hasDraft, false);
  }
  // the portion's append-only history keeps every figure; the schedule just reads the latest
  const { pool } = await import('../apps/backend/src/db');
  assert.equal((await pool.query("SELECT count(*)::int n FROM portion_quantity_confirmations WHERE portion_id=$1 AND source='RP_FACT'", [p.floor1.portion.id])).rows[0].n, 4);
  // the other zone is unaffected by all of it
  assert.equal(entryOf(await getSchedule(p.object.id, '2026-03-04'), p.floor2.unit.id).rpFactQuantity, null);
});

test('J. a unit with several portions: the unit entry adds the portions\' latest RP facts', async () => {
  const p = await pilotScenario(h);
  await h.as(p.pm);
  // a fresh unit of 300 m² split into three portions of 100
  const unit = await h.req('execution-units', { objectWorkId: p.plasterWork.work.id, workTypeId: p.plaster.id, contractorId: p.contractors[0].id, unit: 'м²', plannedQuantity: 300, location: '3 этаж' });
  const portions = [] as any[];
  for (const label of ['Захватка 1', 'Захватка 2', 'Захватка 3']) portions.push(await h.req(`execution-units/${unit.id}/portions`, { label, plannedQuantity: 100 }));
  await h.req(`objects/${p.object.id}/schedule/draft`, {});
  await addEntry(p.object.id, p.plasterWork.work.id, unit.id, '2026-03-01', '2026-03-11');
  await h.login('DEPUTY_DIRECTOR');
  await approve(p.object.id);
  assert.equal(entryOf(await getSchedule(p.object.id, '2026-03-06'), unit.id).rpFactQuantity, null, 'nothing reported anywhere: not a zero');
  await reportFact(h, p.pm, portions[0].id, 100);
  await reportFact(h, p.pm, portions[1].id, 30);
  await reportFact(h, p.pm, portions[1].id, 60); // a newer fact replaces the older one of the SAME portion (latest wins, the history stays)
  let e = entryOf(await getSchedule(p.object.id, '2026-03-06'), unit.id);
  assert.equal(e.rpFactQuantity, '160.0000');
  assert.equal(Math.round(e.actualProgress), 53);
  assert.equal(e.state, 'IN_PROGRESS');
  await reportFact(h, p.pm, portions[1].id, 100);
  await reportFact(h, p.pm, portions[2].id, 100);
  e = entryOf(await getSchedule(p.object.id, '2026-03-06'), unit.id);
  assert.equal(e.state, 'COMPLETED');
  assert.equal(e.actualProgress, 100);
});

test('K. delay reasons: for a real delay only, from an open category list, with who / when / about whom — and they are evidence, not editable', async () => {
  const p = await approvedPilot();
  const { pool } = await import('../apps/backend/src/db');
  const f1 = entryOf(await getSchedule(p.object.id), p.floor1.unit.id);
  assert.equal(f1.state, 'DELAYED', 'the 2026 dates are long past and no fact is reported: a real delay');
  const reasonBody = (extra: Record<string, unknown> = {}) => ({ itemId: f1.itemId, categoryCode: 'MATERIALS', comment: 'Штукатурная смесь задерживается поставщиком', ...extra });

  // permissions: PM of the object and the deputy record; СК and the CEO do not
  for (const role of ['CONSTRUCTION_CONTROL', 'GENERAL_DIRECTOR', 'PTO', 'SDO', 'CONTRACTOR_VIEWER']) {
    await h.login(role);
    assert.equal((await raw(`objects/${p.object.id}/schedule/delay-reasons`, reasonBody())).status, 403, role);
  }
  await h.as(p.other);
  assert.equal((await raw(`objects/${p.object.id}/schedule/delay-reasons`, reasonBody())).status, 403, 'a РП of another object');

  await h.as(p.pm);
  // an unknown category, an empty comment and two responsible parties are refused
  assert.equal((await raw(`objects/${p.object.id}/schedule/delay-reasons`, reasonBody({ categoryCode: 'NO_SUCH_THING' }))).status, 400);
  assert.equal((await raw(`objects/${p.object.id}/schedule/delay-reasons`, reasonBody({ comment: '   ' }))).status, 400);
  assert.equal((await raw(`objects/${p.object.id}/schedule/delay-reasons`, reasonBody({ responsibleUserId: p.pm.id, responsibleContractorId: p.contractors[0].id }))).status, 400);
  // a contractor not working on this object cannot be named
  const outsider = p.contractors.find((c: any) => ![p.contractors[0].id, p.contractors[1].id].includes(c.id));
  assert.equal((await raw(`objects/${p.object.id}/schedule/delay-reasons`, reasonBody({ responsibleContractorId: outsider.id }))).status, 400);
  // unknown fields are not accepted (a delay reason is not a СК remark)
  assert.equal((await raw(`objects/${p.object.id}/schedule/delay-reasons`, reasonBody({ severity: 'CRITICAL' }))).status, 400);

  const rec = await h.req(`objects/${p.object.id}/schedule/delay-reasons`, reasonBody({ responsibleContractorId: p.contractors[1].id }));
  assert.equal(rec.status, 'OPEN');
  assert.equal(rec.recordedBy, p.pm.id, 'recorded by');
  assert.ok(rec.recordedAt, 'timestamp');
  assert.equal(rec.responsibleContractorId, p.contractors[1].id, 'responsible party');
  assert.ok(rec.delayDaysAtRecord >= 1, 'evidence: how late it was when recorded');
  // a second reason about the same scope, a person this time, in a category the tenant adds itself
  await h.login('ADMIN');
  const added = await h.req('schedule/delay-categories', { code: 'CUSTOMER_PERMITS', name: 'Разрешения заказчика', sortOrder: 15 });
  assert.ok(added.categories.some((c: any) => c.code === 'CUSTOMER_PERMITS'));
  await h.login('DEPUTY_DIRECTOR');
  assert.equal((await raw('schedule/delay-categories', { code: 'X1', name: 'нет прав' })).status, 403, 'only the dictionary administrator extends the list');
  const second = await h.req(`objects/${p.object.id}/schedule/delay-reasons`, reasonBody({ categoryCode: 'CUSTOMER_PERMITS', comment: 'Ждём разрешение на леса', responsibleUserId: p.pm.id }));
  assert.equal(second.responsibleUserId, p.pm.id);

  const s = await getSchedule(p.object.id);
  const e = entryOf(s, p.floor1.unit.id);
  assert.deepEqual(e.delayReasons.map((r: any) => r.categoryName).sort(), ['Материалы', 'Разрешения заказчика']);
  const view = e.delayReasons.find((r: any) => r.categoryCode === 'MATERIALS');
  assert.equal(view.recordedByName, p.pm.name);
  assert.equal(view.responsibleContractorName, p.contractors[1].name);
  assert.equal(view.status, 'OPEN');
  assert.equal(s.conclusion.openDelayReasonCount, 2);
  assert.ok(s.delayReasonCategories.some((c: any) => c.code === 'DECISIONS') && s.delayReasonCategories.some((c: any) => c.code === 'MOBILIZATION'), 'the management examples are in the list');
  assert.ok(s.delayReasonCategories.length > 3);

  // resolve once; a closed reason stays as history and cannot be reopened or rewritten
  await h.as(p.pm);
  assert.equal((await raw(`objects/${p.object.id}/schedule/delay-reasons/${rec.id}/resolve`, { version: 999 })).status, 409, 'stale version');
  const resolved = await h.req(`objects/${p.object.id}/schedule/delay-reasons/${rec.id}/resolve`, { version: rec.version, comment: 'Партия поставлена' });
  assert.equal(resolved.status, 'RESOLVED');
  assert.equal(resolved.resolvedBy, p.pm.id);
  assert.equal((await raw(`objects/${p.object.id}/schedule/delay-reasons/${rec.id}/resolve`, { version: resolved.version })).status, 409, 'already closed');
  await assert.rejects(() => pool.query("UPDATE schedule_delay_reasons SET comment='подмена' WHERE id=$1", [rec.id]), /не переписывается/);
  await assert.rejects(() => pool.query("UPDATE schedule_delay_reasons SET status='OPEN',resolved_at=NULL,resolved_by=NULL WHERE id=$1", [rec.id]), /не переписывается|check/i);
  await assert.rejects(() => pool.query('DELETE FROM schedule_delay_reasons WHERE id=$1', [rec.id]), /не удаляется/);
  assert.equal((await getSchedule(p.object.id)).conclusion.openDelayReasonCount, 1);

  // a switched-off category can no longer be chosen, but a reason already recorded keeps its readable name
  await h.login('ADMIN');
  await h.req('schedule/delay-categories', { code: 'CUSTOMER_PERMITS', name: 'Разрешения заказчика', isActive: false });
  const afterOff = await getSchedule(p.object.id);
  assert.equal(afterOff.delayReasonCategories.some((c: any) => c.code === 'CUSTOMER_PERMITS'), false);
  assert.equal(entryOf(afterOff, p.floor1.unit.id).delayReasons.some((r: any) => r.categoryName === 'Разрешения заказчика'), true);
  await h.login('DEPUTY_DIRECTOR');
  assert.equal((await raw(`objects/${p.object.id}/schedule/delay-reasons`, reasonBody({ categoryCode: 'CUSTOMER_PERMITS' }))).status, 400);

  // a reason is for a delay only: a completed scope, or one not yet due, takes none
  await reportFact(h, p.pm, p.floor2.portion.id, 300);
  await h.login('DEPUTY_DIRECTOR');
  const done = entryOf(await getSchedule(p.object.id), p.floor2.unit.id);
  assert.equal(done.state, 'COMPLETED');
  const notDelayed = await raw(`objects/${p.object.id}/schedule/delay-reasons`, reasonBody({ itemId: done.itemId }));
  assert.equal(notDelayed.status, 400);
  assert.match(notDelayed.data.message, /только для участка, по которому есть отставание/);

  // delay reasons are planning reasons: a СК remark (issue) is a different thing in a different table
  const reasonColumns = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='schedule_delay_reasons'")).rows.map((c: any) => c.column_name);
  assert.equal(reasonColumns.some((c: string) => /inspection|severity|issue/.test(c)), false, 'no link to СК inspections / issues: a planning reason is not a construction remark');
  const audit = (await pool.query("SELECT action,user_id FROM audit_logs WHERE entity_type='ScheduleDelayReason' ORDER BY created_at,id")).rows.map((a: any) => a.action);
  assert.ok(audit.includes('RECORD') && audit.includes('RESOLVE'));
});

test('L. correction with provenance: a new draft cloned from the baseline, approved with a reason; the replaced revision stays exactly as it was', async () => {
  const p = await approvedPilot();
  const { pool } = await import('../apps/backend/src/db');
  const original = (await getSchedule(p.object.id)).entries.map((e: any) => ({ itemId: e.itemId, start: e.plannedStart, finish: e.plannedFinish }));

  await h.as(p.pm);
  await h.req(`objects/${p.object.id}/schedule/draft`, {});
  let s = await getSchedule(p.object.id);
  const row = s.draft.entries.find((e: any) => e.executionUnitId === p.floor1.unit.id);
  const moved = await h.req(`objects/${p.object.id}/schedule/draft/entries/${row.entryId}/edit`, { version: row.version, plannedFinish: '2026-03-18' });
  s = await getSchedule(p.object.id);
  assert.deepEqual(s.draft.changes.map((c: any) => [c.kind, c.fields, c.before.plannedFinish, c.after.plannedFinish, c.label]), [['CHANGED', ['plannedFinish'], F1.finish, '2026-03-18', 'Штукатурка стен · 1 этаж']], 'before/after is shown to the approver');
  assert.equal(s.draft.entries.find((e: any) => e.itemId === row.itemId).baseline.plannedFinish, F1.finish);
  assert.equal(s.current.revisionNo, 1, 'the current baseline is still revision 1 while the correction is a draft');
  assert.equal(entryOf(s, p.floor1.unit.id).plannedFinish, F1.finish, 'plan-versus-fact keeps measuring against the approved dates');

  // the РП cannot approve; a correction without a reason or without a change is refused
  assert.equal((await raw(`objects/${p.object.id}/schedule/draft/approve`, { version: s.draft.version, correctionReason: 'сдвиг' })).status, 403);
  await h.login('DEPUTY_DIRECTOR');
  const noReason = await raw(`objects/${p.object.id}/schedule/draft/approve`, { version: s.draft.version });
  assert.equal(noReason.status, 400);
  assert.match(noReason.data.message, /причину корректировки/);
  assert.equal((await raw(`objects/${p.object.id}/schedule/draft/approve`, { version: s.draft.version, correctionReason: '   ' })).status, 400);

  const corrected = await approve(p.object.id, { correctionReason: 'Поставка смеси сдвинута на неделю', comment: 'Согласовано с заказчиком' });
  assert.equal(corrected.revisionNo, 2);
  assert.equal(corrected.correctionReason, 'Поставка смеси сдвинута на неделю');
  assert.equal(corrected.status, 'APPROVED');

  s = await getSchedule(p.object.id);
  assert.equal(s.current.revisionNo, 2);
  assert.equal(s.current.basedOnRevisionNo, 1, 'provenance: which revision it replaced');
  assert.equal(s.current.correctionReason, 'Поставка смеси сдвинута на неделю');
  assert.equal(entryOf(s, p.floor1.unit.id).plannedFinish, '2026-03-18');
  // the correction does not hide itself: the shift against the first approved plan is shown on the entry
  assert.deepEqual(entryOf(s, p.floor1.unit.id).baselineShift, { startDays: 0, finishDays: 7 });
  assert.equal(entryOf(s, p.floor2.unit.id).baselineShift, null, 'untouched entries carry no shift');

  // history: both revisions, the old one intact and marked superseded, with its original dates and the changes the new one made
  assert.deepEqual(s.history.map((r: any) => [r.revisionNo, r.status]), [[1, 'SUPERSEDED'], [2, 'APPROVED']]);
  const old = (await pool.query("SELECT e.item_id, e.planned_start, e.planned_finish FROM schedule_revision_entries e JOIN schedule_revisions r ON r.id=e.revision_id WHERE r.object_id=$1 AND r.revision_no=1 ORDER BY e.sequence", [p.object.id])).rows;
  assert.deepEqual(old.map((r: any) => ({ itemId: r.item_id, start: r.planned_start, finish: r.planned_finish })), original, 'the superseded revision still holds the originally approved dates');
  const rev2 = s.history.find((r: any) => r.revisionNo === 2);
  assert.equal(rev2.supersededAt, null);
  assert.deepEqual(rev2.changes.map((c: any) => [c.kind, c.before.plannedFinish, c.after.plannedFinish]), [['CHANGED', F1.finish, '2026-03-18']]);
  const rev1 = s.history.find((r: any) => r.revisionNo === 1);
  assert.equal(rev1.status, 'SUPERSEDED');
  assert.equal(rev1.supersededByRevisionNo, 2);
  assert.equal(rev1.approvedByName, 'Виктор Соловьёв');
  assert.equal(rev1.changes.length, 2, 'the first revision "added" both entries');

  // the audit log keeps both versions of the changed date and who approved
  const audit = (await pool.query("SELECT user_id,old_value,new_value FROM audit_logs WHERE entity_type='ScheduleRevision' AND action='APPROVE_CORRECTION' ORDER BY created_at DESC LIMIT 1")).rows[0];
  const newValue = j(audit.new_value);
  assert.equal(newValue.correctionReason, 'Поставка смеси сдвинута на неделю');
  assert.equal(newValue.supersedesRevisionNo, 1);
  assert.deepEqual(newValue.changes.map((c: any) => [c.before.plannedFinish, c.after.plannedFinish]), [[F1.finish, '2026-03-18']]);
  assert.ok(j(audit.old_value).entries.some((e: any) => e.plannedFinish === F1.finish), 'the replaced plan is preserved in the audit trail');
  assert.equal(audit.user_id, (await pool.query("SELECT id FROM users WHERE role='DEPUTY_DIRECTOR' ORDER BY created_at LIMIT 1")).rows[0].id);
  assert.equal(moved.plannedFinish, '2026-03-18');

  // a correction that changes nothing is not a correction
  await h.as(p.pm);
  await h.req(`objects/${p.object.id}/schedule/draft`, {});
  await h.login('DEPUTY_DIRECTOR');
  const none = await raw(`objects/${p.object.id}/schedule/draft/approve`, { version: await draftVersion(p.object.id), correctionReason: 'без изменений' });
  assert.equal(none.status, 400);
  assert.match(none.data.message, /нет изменений/);
});

test('M. order and the advisory «follows» reference: a sequence, optional predecessor, no cycles, never a block on production', async () => {
  const p = await pilotScenario(h);
  await h.as(p.pm);
  await h.req(`objects/${p.object.id}/schedule/draft`, {});
  const a = await addEntry(p.object.id, p.plasterWork.work.id, p.floor1.unit.id, F1.start, F1.finish, { sequence: 10 });
  const b = await addEntry(p.object.id, p.plasterWork.work.id, p.floor2.unit.id, '2026-03-08', F2.finish, { sequence: 5, predecessorItemId: a.itemId });
  let d = (await getSchedule(p.object.id)).draft;
  const bRow = d.entries.find((e: any) => e.entryId === b.id);
  assert.equal(bRow.predecessorItemId, a.itemId);
  assert.equal(bRow.followsPredecessor, false, 'starts on Mar 8 before the predecessor finishes on Mar 11: flagged, not refused');
  assert.match(bRow.predecessorLabel, /1 этаж/);
  // no self reference, no cycle, no predecessor from nowhere
  assert.equal((await raw(`objects/${p.object.id}/schedule/draft/entries/${a.id}/edit`, { version: a.version, predecessorItemId: a.itemId })).status, 400);
  assert.equal((await raw(`objects/${p.object.id}/schedule/draft/entries/${a.id}/edit`, { version: a.version, predecessorItemId: b.itemId })).status, 400, 'a cycle');
  assert.equal((await raw(`objects/${p.object.id}/schedule/draft/entries/${a.id}/edit`, { version: a.version, predecessorItemId: '00000000-0000-4000-8000-000000000000' })).status, 400);
  // an entry that others follow cannot be removed from under them
  const blocked = await raw(`objects/${p.object.id}/schedule/draft/entries/${a.id}/remove`, { version: a.version });
  assert.equal(blocked.status, 400);
  assert.match(blocked.data.message, /предшествующий/);
  // fix the overlap, clear the link, and the order is the sequence entered
  await h.req(`objects/${p.object.id}/schedule/draft/entries/${b.id}/edit`, { version: b.version, plannedStart: '2026-03-12' });
  d = (await getSchedule(p.object.id)).draft;
  assert.equal(d.entries.find((e: any) => e.entryId === b.id).followsPredecessor, true);
  assert.deepEqual(d.entries.map((e: any) => e.sequence), [5, 10], 'listed in the planned order');
  // a version-less / stale edit is refused (optimistic concurrency)
  assert.equal((await raw(`objects/${p.object.id}/schedule/draft/entries/${b.id}/edit`, { version: b.version, sequence: 7 })).status, 409);
  assert.equal((await raw(`objects/${p.object.id}/schedule/draft/entries/${b.id}/edit`, { plannedFinish: F2.finish })).status, 400);
  // the dependency is advisory: production is not gated by it (work_dependencies remains the technological gate)
  await h.login('DEPUTY_DIRECTOR');
  await approve(p.object.id);
  await reportFact(h, p.pm, p.floor2.portion.id, 100);
  assert.equal((await h.req(`works/${p.plasterWork.work.id}/transition`)).allowed, true, 'a planning predecessor never blocks the work');
});

test('N. W01: the work\'s own schedule summary, narrowed to that work', async () => {
  const p = await approvedPilot();
  const w = await h.req(`works/${p.plasterWork.work.id}/schedule?asOf=2026-03-15`);
  assert.equal(w.hasBaseline, true);
  assert.equal(w.canOpenObjectSchedule, true);
  assert.equal(w.revisionNo, 1);
  assert.equal(w.summary.plannedStart, F1.start);
  assert.equal(w.summary.plannedFinish, F2.finish);
  assert.equal(w.summary.entryCount, 2);
  assert.equal(w.summary.state, 'DELAYED', 'floor 1 has no fact on 15 March');
  assert.equal(w.summary.delayDays, 14);
  assert.equal(w.entries.length, 2);
  assert.deepEqual(w.entries.map((e: any) => e.zone), ['1 этаж', '2 этаж']);
  assert.ok(!JSON.stringify(w).includes(p.neighbourWork.work.id));

  // report everything: the summary follows
  await reportFact(h, p.pm, p.floor1.portion.id, 500);
  await reportFact(h, p.pm, p.floor2.portion.id, 300);
  const done = await h.req(`works/${p.plasterWork.work.id}/schedule?asOf=2026-03-15`);
  assert.equal(done.summary.state, 'COMPLETED');
  assert.equal(done.summary.delayDays, 0);

  // a work with no entries in the baseline: a summary of nothing, honestly
  await h.as(p.pm);
  const lone = await h.req('works', { objectId: p.object.id, workTypeId: p.plaster.id, contractorId: p.contractors[0].id, responsibleUserId: p.pm.id, name: 'Окна', unit: 'шт', plannedQuantity: 10, plannedStartDate: '2026-03-01', plannedFinishDate: '2026-03-10', estimatedCost: '1000' });
  const none = await h.req(`works/${lone.id}/schedule`);
  assert.equal(none.hasBaseline, true);
  assert.equal(none.summary, null);
  assert.deepEqual(none.entries, []);

  // an object without any approved baseline
  const q = await pilotScenario(h);
  await h.as(q.pm);
  const empty = await h.req(`works/${q.plasterWork.work.id}/schedule`);
  assert.equal(empty.hasBaseline, false);
  assert.equal(empty.summary, null);

  // access: the contractor role has none; unknown work is 404; read-only roles read
  await h.login('CONTRACTOR_VIEWER');
  assert.equal((await raw(`works/${p.plasterWork.work.id}/schedule`)).status, 403);
  await h.login('CONSTRUCTION_CONTROL');
  assert.equal((await raw(`works/${p.plasterWork.work.id}/schedule`)).status, 200);
  assert.equal((await raw('works/00000000-0000-4000-8000-000000000000/schedule')).status, 404);
  // a PTO engineer reaches the summary only through access to THAT work
  await h.login('PTO');
  assert.equal((await raw(`works/${p.plasterWork.work.id}/schedule`)).status, 403);
});

test('O. O01: the object conclusion derives from the approved schedule — По графику / Есть отставание / not approved — with reasons surfaced', async () => {
  const p = await pilotScenario(h);
  await h.as(p.pm);
  assert.equal((await getSchedule(p.object.id)).conclusion.status, 'NO_BASELINE');
  await h.req(`objects/${p.object.id}/schedule/draft`, {});
  await addEntry(p.object.id, p.plasterWork.work.id, p.floor1.unit.id, F1.start, F1.finish);
  assert.equal((await getSchedule(p.object.id)).conclusion.status, 'NO_BASELINE', 'a draft is not a baseline');
  await h.login('DEPUTY_DIRECTOR');
  await approve(p.object.id);
  let c = (await getSchedule(p.object.id, '2026-03-06')).conclusion;
  assert.equal(c.status, 'DELAYED', 'floor 1 should have started on Mar 1 and nothing is reported');
  assert.equal(c.unscheduledCount, 1, 'floor 2 is a production scope that is not in the schedule');
  await reportFact(h, p.pm, p.floor1.portion.id, 250);
  await h.login('DEPUTY_DIRECTOR');
  c = (await getSchedule(p.object.id, '2026-03-06')).conclusion;
  assert.equal(c.status, 'ON_TRACK');
  assert.equal(c.delayedCount, 0);
  c = (await getSchedule(p.object.id, '2026-03-10')).conclusion;
  assert.equal(c.status, 'DELAYED');
  assert.equal(c.delayedCount, 1);
  // the reasons travel with the entries
  const e = entryOf(await getSchedule(p.object.id, '2026-03-10'), p.floor1.unit.id);
  assert.equal(e.state, 'DELAYED');
  // the global readiness figures are untouched by the schedule (no semantic change)
  const snap = await h.req('snapshot');
  const obj = snap.objects.find((o: any) => o.id === p.object.id);
  assert.equal(typeof obj.actualProgress === 'number' || obj.actualProgress === null, true);
  assert.equal(Object.keys(obj).some(k => /schedule(Conclusion|Revision|Baseline)/i.test(k)), false, 'the snapshot gained no schedule field');
});

test('P. the schedule routes do not leak across tenants or break neighbouring slices', async () => {
  const p = await approvedPilot();
  // GET /snapshot and the existing object routes keep their exact shapes
  await h.login('DEPUTY_DIRECTOR');
  const snap = await h.req('snapshot');
  assert.ok(snap.objects.length >= 2 && snap.works.length >= 1);
  assert.equal(Object.keys(snap).some(k => /^schedule/i.test(k)), false);
  const obj = await h.req(`objects/${p.object.id}`);
  assert.deepEqual(Object.keys(obj).sort(), ['object', 'works']);
  // a user token for a different tenant sees nothing
  const { pool, insert } = await import('../apps/backend/src/db');
  const t2 = (await pool.query("INSERT INTO tenants(portal,member_id,name) VALUES('other.local','other-member','Другой тенант') RETURNING id")).rows[0].id;
  const stranger = await insert(pool, 'users', t2, { bitrixUserId: 'x1', name: 'Чужой', role: 'DEPUTY_DIRECTOR', isActive: true });
  await h.as(stranger);
  assert.equal((await raw(`objects/${p.object.id}/schedule`)).status, 404, 'another tenant cannot even tell the object exists');
  assert.equal((await raw(`works/${p.plasterWork.work.id}/schedule`)).status, 404);
  assert.equal((await raw(`objects/${p.object.id}/schedule/draft`, {})).status, 404);
});

test('Q. the work-level schedule names nothing of the object\'s other works: a predecessor outside the work is neither labelled nor referenced — not even for a PTO engineer holding only this work\'s handoff', async () => {
  const p = await approvedPilot();
  await h.as(p.pm);
  // a second work of the same object, planned as a whole, that FOLLOWS floor 1 of the plaster work; and floor 2 follows floor 1 (inside one work)
  const windows = await h.req('works', { objectId: p.object.id, workTypeId: p.plaster.id, contractorId: p.contractors[0].id, responsibleUserId: p.pm.id, name: 'Монтаж окон', unit: 'шт', plannedQuantity: 20, plannedStartDate: '2026-03-12', plannedFinishDate: '2026-03-30', estimatedCost: '1000' });
  await h.req(`objects/${p.object.id}/schedule/draft`, {});
  const floor1 = entryOf(await getSchedule(p.object.id), p.floor1.unit.id);
  const draftFloor2 = (await getSchedule(p.object.id)).draft.entries.find((e: any) => e.executionUnitId === p.floor2.unit.id);
  await h.req(`objects/${p.object.id}/schedule/draft/entries/${draftFloor2.entryId}/edit`, { version: draftFloor2.version, predecessorItemId: floor1.itemId });
  await addEntry(p.object.id, windows.id, null, '2026-03-12', '2026-03-30', { predecessorItemId: floor1.itemId });
  await h.login('DEPUTY_DIRECTOR');
  await approve(p.object.id, { correctionReason: 'Добавлен монтаж окон; второй этаж — после первого' });

  // the OBJECT's schedule names the predecessor: the whole object is this viewer's to see
  const whole = await getSchedule(p.object.id, '2026-03-20');
  const wholeWindows = whole.entries.find((e: any) => e.objectWorkId === windows.id);
  assert.equal(wholeWindows.predecessorItemId, floor1.itemId);
  assert.equal(wholeWindows.predecessorLabel, 'Штукатурка стен · 1 этаж');
  assert.equal(wholeWindows.followsPredecessor, true);

  // the WORK-level view of the windows work: its predecessor belongs to ANOTHER work — not named, not referenced, no verdict about its dates
  const windowsView = await h.req(`works/${windows.id}/schedule?asOf=2026-03-20`);
  assert.equal(windowsView.entries.length, 1);
  assert.equal(windowsView.entries[0].predecessorItemId, null);
  assert.equal(windowsView.entries[0].predecessorLabel, null);
  assert.equal(windowsView.entries[0].followsPredecessor, null);
  const leaked = (text: string) => text.includes(floor1.itemId) || text.includes('Штукатурка') || text.includes(p.plasterWork.work.id) || text.includes(p.floor1.unit.id) || text.includes(p.floor2.unit.id);
  assert.equal(leaked(JSON.stringify(windowsView)), false, 'nothing of the plaster work in the windows work\'s view');

  // inside ONE work the reference stays: floor 2 follows floor 1 in the plaster work's own view
  const plasterView = await h.req(`works/${p.plasterWork.work.id}/schedule?asOf=2026-03-20`);
  const f2 = plasterView.entries.find((e: any) => e.executionUnitId === p.floor2.unit.id);
  assert.equal(f2.predecessorItemId, floor1.itemId);
  assert.equal(f2.predecessorLabel, 'Штукатурка стен · 1 этаж');
  assert.equal(f2.followsPredecessor, true);
  assert.equal(JSON.stringify(plasterView).includes('Монтаж окон'), false, 'nor the windows work in the plaster work\'s view');

  // the same for an engineer who can read ONLY the windows work (a work-level handoff, no object membership)
  const { ObjectTeamService } = await import('../apps/backend/src/team-service');
  const { actorByRole } = await import('./helpers/pbx3-fixtures');
  const svc = new ObjectTeamService();
  const deputy = await actorByRole('DEPUTY_DIRECTOR');
  const head = await makeUser('Начальник ПТО (окна)', 'PTO_HEAD'), engineer = await makeUser('Инженер ПТО (окна)', 'PTO');
  await svc.assignObjectLead(deputy, p.object.id, { leadUserId: head.id });
  await svc.assignOrgMember(deputy, { memberUserId: engineer.id, managerUserId: head.id });
  await handoffWorkToPto(windows.id, engineer);
  await h.as(engineer);
  const viaHandoff = await raw(`works/${windows.id}/schedule?asOf=2026-03-20`);
  assert.equal(viaHandoff.status, 200);
  assert.equal(viaHandoff.data.canOpenObjectSchedule, false);
  assert.equal(viaHandoff.data.entries[0].predecessorLabel, null);
  assert.equal(leaked(JSON.stringify(viaHandoff.data)), false, 'the engineer learns nothing of the plaster work from the windows work');
  assert.equal((await raw(`works/${p.plasterWork.work.id}/schedule`)).status, 403, 'the plaster work was not handed off');
  assert.equal((await raw(`objects/${p.object.id}/schedule`)).status, 403, 'nor is the object\'s plan open');
});

test('R. a two-digit year typed into a date field is refused at the boundary — never measured, never frozen into an approved plan', async () => {
  const p = await pilotScenario(h);
  await h.as(p.pm);
  await h.req(`objects/${p.object.id}/schedule/draft`, {});
  const body = (start: string, finish: string) => ({ objectWorkId: p.plasterWork.work.id, executionUnitId: p.floor1.unit.id, plannedStart: start, plannedFinish: finish });
  for (const [start, finish] of [['0026-03-01', '2026-03-15'], ['2026-03-01', '0026-03-15'], ['1999-12-31', '2026-03-15'], ['2026-03-01', '2101-01-01']]) {
    const r = await raw(`objects/${p.object.id}/schedule/draft/entries`, body(start, finish));
    assert.equal(r.status, 400, `${start} .. ${finish}`);
    assert.match(JSON.stringify(r.data), /2000/, 'the message names the years a schedule plans in');
  }
  assert.equal((await getSchedule(p.object.id)).draft.entries.length, 0, 'nothing was added');

  const added = await addEntry(p.object.id, p.plasterWork.work.id, p.floor1.unit.id, F1.start, F1.finish);
  const draft = (await getSchedule(p.object.id)).draft;
  const edit = await raw(`objects/${p.object.id}/schedule/draft/entries/${added.id}/edit`, { version: draft.entries[0].version, plannedStart: '0026-03-01' });
  assert.equal(edit.status, 400);
  assert.deepEqual((await getSchedule(p.object.id)).draft.entries.map((e: any) => e.plannedStart), [F1.start], 'the edit changed nothing');
  // the day plan-versus-fact is asked for follows the same rule
  assert.equal((await raw(`objects/${p.object.id}/schedule?asOf=0026-03-06`)).status, 400);
  assert.equal((await raw(`objects/${p.object.id}/schedule?asOf=2026-03-06`)).status, 200);
  // the boundaries themselves are fine
  const edge = await raw(`objects/${p.object.id}/schedule/draft/entries/${added.id}/edit`, { version: draft.entries[0].version, plannedStart: '2000-01-01', plannedFinish: '2100-12-31' });
  assert.equal(edge.status, 201);
});

test('S. an open delay reason can still be closed after the scope has caught up — the form for a NEW reason goes with the delay, the old explanation does not stay open for good', async () => {
  const p = await approvedPilot();
  const f1 = entryOf(await getSchedule(p.object.id), p.floor1.unit.id);
  assert.equal(f1.state, 'DELAYED');
  await h.as(p.pm);
  const rec = await h.req(`objects/${p.object.id}/schedule/delay-reasons`, { itemId: f1.itemId, categoryCode: 'MATERIALS', comment: 'Смесь задерживается' });
  await reportFact(h, p.pm, p.floor1.portion.id, 500);
  await h.as(p.pm);
  const caughtUp = entryOf(await getSchedule(p.object.id), p.floor1.unit.id);
  assert.equal(caughtUp.state, 'COMPLETED');
  assert.equal(caughtUp.delayReasons.find((r: any) => r.id === rec.id).status, 'OPEN', 'listed, and still open');
  assert.equal((await getSchedule(p.object.id)).conclusion.openDelayReasonCount, 1);
  // a NEW reason needs a delay that is real now ...
  assert.equal((await raw(`objects/${p.object.id}/schedule/delay-reasons`, { itemId: f1.itemId, categoryCode: 'OTHER', comment: 'ещё одна' })).status, 400);
  // ... closing the old one does not
  const closed = await h.req(`objects/${p.object.id}/schedule/delay-reasons/${rec.id}/resolve`, { version: rec.version, comment: 'Участок выполнен' });
  assert.equal(closed.status, 'RESOLVED');
  assert.equal((await getSchedule(p.object.id)).conclusion.openDelayReasonCount, 0);
});
