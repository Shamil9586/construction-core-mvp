import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Client } from 'pg';
import { actorByRole, tenantId } from './helpers/pbx3-fixtures';
import { applyPendingScheduleMigration } from './helpers/gpr-fixtures';

/**
 * GPR-1 — REAL PostgreSQL evidence for the pending schedule migration (infra/pending/gpr-1_production_schedule.sql): the exact schema, the
 * database-level guards that make an approved plan unrewritable by ANY writer, and the concurrency behaviour of the schedule service
 * (PGlite is one connection and cannot show a race). A dedicated fresh database is created and dropped, like the other *-postgres suites.
 * Needs a server at E2E_DATABASE_URL (default postgresql://postgres:local-test-only@127.0.0.1:5432/postgres); without one the hooks fail,
 * exactly as those suites do.
 */
const ADMIN_URL = process.env.E2E_DATABASE_URL ?? 'postgresql://postgres:local-test-only@127.0.0.1:5432/postgres';
const DB_NAME = 'gpr_' + Math.random().toString(36).slice(2, 10);
const dbUrl = () => { const u = new URL(ADMIN_URL); u.pathname = '/' + DB_NAME; return u.toString(); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let admin: Client;
let ctx: any;

before(async () => {
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB_NAME} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`);
  process.env.DB_MODE = 'postgres';
  process.env.DATABASE_URL = dbUrl();
  process.env.AUTH_MODE = 'mock';
  process.env.MOCK_LOGIN_KEY = 'gpr-pg-key';
  const { migrate } = await import('../scripts/migrate');
  const { seed } = await import('../scripts/seed');
  const db = await import('../apps/backend/src/db');
  const { ScheduleService } = await import('../apps/backend/src/schedule-service');
  await migrate();
  await applyPendingScheduleMigration();
  await seed();
  ctx = { db, svc: new ScheduleService() };
});
after(async () => {
  await ctx?.db.pool.end();
  await sleep(300);
  await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  await admin.end();
});
const client = async () => { const c = new Client({ connectionString: dbUrl() }); await c.connect(); return c; };
const F1 = ['2026-03-01', '2026-03-11'], F2 = ['2026-03-12', '2026-03-22'];

/** An object with one work, two zones (units) and a portion each — straight in the production tables, as the other native suites do. */
async function scenario(name: string) {
  const { db } = ctx;
  const t = await tenantId();
  const pm = await actorByRole('PROJECT_MANAGER'), deputy = await actorByRole('DEPUTY_DIRECTOR');
  const contractor = await db.one(db.pool, 'SELECT id FROM contractors WHERE tenant_id=$1 ORDER BY name LIMIT 1', [t]);
  const wt = await db.one(db.pool, 'SELECT id FROM work_types WHERE tenant_id=$1 LIMIT 1', [t]);
  const obj = await db.insert(db.pool, 'objects', t, { externalCode: 'GPRPG-' + name + Date.now(), name, address: 'a', organizationName: 'o', projectManagerId: pm.id, startDate: '2026-01-01', plannedFinishDate: '2026-12-31', contractValue: '1' });
  await db.insert(db.pool, 'object_contractors', t, { objectId: obj.id, contractorId: contractor.id });
  const work = await db.insert(db.pool, 'works', t, { objectId: obj.id, workTypeId: wt.id, contractorId: contractor.id, responsibleUserId: pm.id, name: 'Работа ' + name, unit: 'м²', plannedQuantity: 800, plannedStartDate: '2026-03-01', plannedFinishDate: '2026-03-22', estimatedCost: '1' });
  const mkUnit = async (zone: string, qty: number) => {
    const unit = await db.insert(db.pool, 'work_execution_units', t, { objectWorkId: work.id, workTypeId: wt.id, contractorId: contractor.id, unit: 'м²', plannedQuantity: qty, location: zone });
    const portion = await db.insert(db.pool, 'quantity_portions', t, { executionUnitId: unit.id, label: 'Участок ' + zone, plannedQuantity: qty });
    return { unit, portion };
  };
  return { t, pm, deputy, contractor, obj, work, u1: await mkUnit('1 этаж', 500), u2: await mkUnit('2 этаж', 300) };
}
const entryBody = (s: any, u: any, dates: string[]) => ({ objectWorkId: s.work.id, executionUnitId: u.unit.id, plannedStart: dates[0], plannedFinish: dates[1] });
async function drafted(s: any) {
  await ctx.svc.createDraft(s.pm, s.obj.id);
  const e1 = await ctx.svc.addEntry(s.pm, s.obj.id, entryBody(s, s.u1, F1));
  await ctx.svc.addEntry(s.pm, s.obj.id, entryBody(s, s.u2, F2));
  return e1;
}
const draftOf = async (s: any) => (await ctx.svc.objectSchedule(s.pm, s.obj.id)).draft;

test('A1 fresh native chain: the numbered chain is untouched, the pending file adds exactly its five tables, and re-applying is a no-op', async () => {
  const c = await client();
  try {
    const files = fs.readdirSync('infra').filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
    assert.ok(!files.some((f) => /schedule/i.test(f)), 'this branch claims no production migration number');
    const versions = (await c.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map((r) => r.version);
    assert.deepEqual(versions, files.map((f) => Number(f.split('_')[0])), 'schema_migrations records only the numbered chain');
    const tables = (await c.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'schedule\\_%' ORDER BY 1")).rows.map((r) => r.table_name);
    assert.deepEqual(tables, ['schedule_delay_categories', 'schedule_delay_reasons', 'schedule_items', 'schedule_revision_entries', 'schedule_revisions']);
    const { migrate } = await import('../scripts/migrate');
    await migrate();
    await applyPendingScheduleMigration();
    assert.deepEqual((await c.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map((r) => r.version), versions);
    for (const t of tables) assert.equal((await c.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n >= 0, true);
  } finally { await c.end(); }
});

test('A2 exact schema: one item per scope, one draft and one current baseline per object, tenant-scoped composite FKs, no copied production figures', async () => {
  const c = await client();
  try {
    const idx = async (name: string) => (await c.query('SELECT indexdef FROM pg_indexes WHERE indexname=$1', [name])).rows[0]?.indexdef as string;
    assert.match(await idx('schedule_items_unit_unique'), /UNIQUE INDEX .* ON public\.schedule_items USING btree \(tenant_id, execution_unit_id\) WHERE \(execution_unit_id IS NOT NULL\)/);
    assert.match(await idx('schedule_items_work_unique'), /UNIQUE INDEX .* ON public\.schedule_items USING btree \(tenant_id, object_work_id\) WHERE \(execution_unit_id IS NULL\)/);
    assert.match(await idx('schedule_revisions_one_draft'), /UNIQUE INDEX .* ON public\.schedule_revisions USING btree \(tenant_id, object_id\) WHERE \(status = 'DRAFT'::text\)/);
    assert.match(await idx('schedule_revisions_one_current'), /UNIQUE INDEX .* ON public\.schedule_revisions USING btree \(tenant_id, object_id\) WHERE \(status = 'APPROVED'::text\)/);
    for (const table of ['schedule_items', 'schedule_revisions', 'schedule_revision_entries', 'schedule_delay_categories', 'schedule_delay_reasons']) {
      const fks = (await c.query("SELECT pg_get_constraintdef(oid) def, confrelid::regclass::text ref FROM pg_constraint WHERE contype='f' AND conrelid=$1::regclass", [table])).rows.filter((f) => f.ref !== 'tenants');
      assert.ok(fks.length >= 1, table);
      for (const f of fks) assert.match(f.def, /FOREIGN KEY \(tenant_id, \w+(, \w+)?\) REFERENCES \w+\(tenant_id, \w+(, \w+)?\)/, table + ': ' + f.def);
    }
    const pred = (await c.query("SELECT pg_get_constraintdef(oid) def FROM pg_constraint WHERE contype='f' AND conrelid='schedule_revision_entries'::regclass AND confrelid='schedule_revision_entries'::regclass")).rows;
    assert.equal(pred.length, 1);
    assert.match(pred[0].def, /FOREIGN KEY \(tenant_id, revision_id, predecessor_item_id\) REFERENCES schedule_revision_entries\(tenant_id, revision_id, item_id\)/, 'a predecessor must be an item of the SAME revision');
    const triggers = (await c.query("SELECT tgrelid::regclass::text t FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'schedule\\_%' ORDER BY 1")).rows.map((r) => r.t);
    assert.deepEqual(triggers, ['schedule_delay_reasons', 'schedule_items', 'schedule_revision_entries', 'schedule_revisions']);
    const cols = (await c.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_name IN ('schedule_items','schedule_revisions','schedule_revision_entries','schedule_delay_reasons') ORDER BY 1,2")).rows;
    assert.deepEqual(cols.filter((x) => /quantity|cost|amount|progress|percent|fact|location|zone/i.test(x.column_name)), [], 'no production figure is copied into the schedule tables');
    assert.equal((await c.query('SELECT count(*)::int n FROM schedule_items')).rows[0].n, 0, 'the migration writes no rows (no seed / backfill)');
  } finally { await c.end(); }
});

test('B1 native guards: an approved plan cannot be rewritten by any writer; cross-object and cross-tenant references are refused', async () => {
  const s = await scenario('B1');
  const first = await drafted(s);
  await ctx.svc.approveDraft(s.deputy, s.obj.id, { version: (await draftOf(s)).version });
  const c = await client();
  try {
    const cur = (await c.query("SELECT id FROM schedule_revisions WHERE object_id=$1 AND status='APPROVED'", [s.obj.id])).rows[0];
    await assert.rejects(c.query('UPDATE schedule_revision_entries SET planned_finish=$2 WHERE id=$1', [first.id, '2026-12-31']), /только в черновике/);
    await assert.rejects(c.query('DELETE FROM schedule_revision_entries WHERE id=$1', [first.id]), /только в черновике/);
    await assert.rejects(c.query("UPDATE schedule_revisions SET approval_comment='x' WHERE id=$1", [cur.id]), /не изменяется/);
    await assert.rejects(c.query("UPDATE schedule_revisions SET status='DRAFT',approved_at=NULL,approved_by=NULL WHERE id=$1", [cur.id]), /Недопустимый переход/);
    await assert.rejects(c.query('DELETE FROM schedule_revisions WHERE id=$1', [cur.id]), /не удаляется/);
    await assert.rejects(c.query('DELETE FROM schedule_items WHERE id=$1', [first.itemId]), /неизменяем/);
    await assert.rejects(c.query("INSERT INTO schedule_revisions(tenant_id,object_id,revision_no,status,created_by,approved_by,approved_at) SELECT tenant_id,object_id,9,'APPROVED',created_by,approved_by,now() FROM schedule_revisions WHERE id=$1", [cur.id]), /schedule_revisions_one_current/);
    // a correction (a revision with a base) cannot be stored as approved without its reason, whoever writes it
    await assert.rejects(c.query("INSERT INTO schedule_revisions(tenant_id,object_id,revision_no,status,created_by,approved_by,approved_at,based_on_revision_id) SELECT tenant_id,object_id,5,'APPROVED',created_by,created_by,now(),id FROM schedule_revisions WHERE id=$1", [cur.id]), /schedule_revisions_correction_needs_reason/);

    // cross-object: an item of another object cannot be planned in this object's revision
    const other = await scenario('B1-other');
    await ctx.svc.createDraft(other.pm, other.obj.id);
    const foreign = await ctx.svc.addEntry(other.pm, other.obj.id, entryBody(other, other.u1, F1));
    await ctx.svc.createDraft(s.pm, s.obj.id);
    const draft = (await c.query("SELECT id FROM schedule_revisions WHERE object_id=$1 AND status='DRAFT'", [s.obj.id])).rows[0];
    await assert.rejects(c.query('INSERT INTO schedule_revision_entries(tenant_id,revision_id,item_id,planned_start,planned_finish,sequence) VALUES($1,$2,$3,$4,$5,50)', [s.t, draft.id, foreign.itemId, F1[0], F1[1]]), /другому объекту/);
    // an item may not pair a work with another object, nor a unit with another work
    await assert.rejects(c.query('INSERT INTO schedule_items(tenant_id,object_id,object_work_id,execution_unit_id,created_by) VALUES($1,$2,$3,NULL,$4)', [s.t, s.obj.id, other.work.id, s.pm.id]), /тому же объекту/);
    await assert.rejects(c.query('INSERT INTO schedule_items(tenant_id,object_id,object_work_id,execution_unit_id,created_by) VALUES($1,$2,$3,$4,$5)', [s.t, s.obj.id, s.work.id, other.u1.unit.id, s.pm.id]), /относиться к работе/);
    // cross-tenant references are refused (the guard sees no such work in that tenant; the composite FKs are the second wall)
    const t2 = (await c.query("INSERT INTO tenants(portal,member_id,name) VALUES($1,$2,'x') RETURNING id", ['gprpg-' + Date.now() + '.local', 'gprpg-' + Date.now()])).rows[0].id;
    await assert.rejects(c.query('INSERT INTO schedule_items(tenant_id,object_id,object_work_id,created_by) VALUES($1,$2,$3,$4)', [t2, s.obj.id, s.work.id, s.pm.id]), /тому же объекту|foreign key/);
    // dates and the follows reference
    await assert.rejects(c.query('INSERT INTO schedule_revision_entries(tenant_id,revision_id,item_id,planned_start,planned_finish,sequence) VALUES($1,$2,$3,$4,$5,51)', [s.t, draft.id, first.itemId, '2026-03-10', '2026-03-01']), /check|duplicate|unique/i);
    // evidence: a recorded reason is not rewritten or deleted (also covered through the API on PGlite)
    const reasonItem = await ctx.svc.recordDelayReason(s.pm, s.obj.id, { itemId: first.itemId, categoryCode: 'MATERIALS', comment: 'Задержка поставки' }).catch((e: any) => e);
    assert.ok(reasonItem.id, 'a delay reason is recorded (the 2026 dates are long past): ' + (reasonItem.message ?? ''));
    await assert.rejects(c.query("UPDATE schedule_delay_reasons SET comment='x' WHERE id=$1", [reasonItem.id]), /не переписывается/);
    await assert.rejects(c.query('DELETE FROM schedule_delay_reasons WHERE id=$1', [reasonItem.id]), /не удаляется/);
    await assert.rejects(c.query('INSERT INTO schedule_delay_reasons(tenant_id,object_id,item_id,revision_id,category_code,comment,delay_days_at_record,recorded_by) VALUES($1,$2,$3,$4,$5,$6,3,$7)', [s.t, other.obj.id, first.itemId, cur.id, 'MATERIALS', 'чужой', s.pm.id]), /должны относиться к объекту/);
  } finally { await c.end(); }
});

test('B2 native concurrency: two simultaneous drafts — exactly one is created, the loser gets a conflict, never a second draft', async () => {
  const s = await scenario('B2');
  const results = await Promise.allSettled([ctx.svc.createDraft(s.pm, s.obj.id), ctx.svc.createDraft(s.deputy, s.obj.id), ctx.svc.createDraft(s.pm, s.obj.id), ctx.svc.createDraft(s.deputy, s.obj.id)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  for (const r of results.filter((x): x is PromiseRejectedResult => x.status === 'rejected')) assert.equal(r.reason?.getStatus?.(), 409, String(r.reason?.message));
  assert.equal((await ctx.db.pool.query("SELECT count(*)::int n FROM schedule_revisions WHERE object_id=$1 AND status='DRAFT'", [s.obj.id])).rows[0].n, 1);
});

test('B3 native concurrency: simultaneous approvals of one draft — exactly one wins, one current baseline, no second revision number', async () => {
  const s = await scenario('B3');
  await drafted(s);
  const version = (await draftOf(s)).version;
  const admin2 = await actorByRole('ADMIN');
  const results = await Promise.allSettled([ctx.svc.approveDraft(s.deputy, s.obj.id, { version }), ctx.svc.approveDraft(admin2, s.obj.id, { version }), ctx.svc.approveDraft(s.deputy, s.obj.id, { version })]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, JSON.stringify(results.map((r) => r.status)));
  const rows = (await ctx.db.pool.query('SELECT revision_no,status,approved_by FROM schedule_revisions WHERE object_id=$1 ORDER BY revision_no', [s.obj.id])).rows;
  assert.deepEqual(rows.map((r: any) => [r.revision_no, r.status]), [[1, 'APPROVED']]);
  assert.equal((await ctx.db.pool.query("SELECT count(*)::int n FROM audit_logs WHERE entity_type='ScheduleRevision' AND action='APPROVE' AND entity_id=$1", [(await ctx.db.pool.query('SELECT id FROM schedule_revisions WHERE object_id=$1', [s.obj.id])).rows[0].id])).rows[0].n, 1, 'one approval, one audit record');
});

test('B4 native concurrency: approval racing an edit — the approver approves exactly the draft they saw, or is told it changed; the approved plan never contains an unseen edit', async () => {
  const s = await scenario('B4');
  const e1 = await drafted(s);
  const seen = await draftOf(s);
  const [approve, edit] = await Promise.allSettled([
    ctx.svc.approveDraft(s.deputy, s.obj.id, { version: seen.version }),
    ctx.svc.editEntry(s.pm, s.obj.id, e1.id, { version: e1.version, plannedFinish: '2026-04-30' }),
  ]);
  const current = (await ctx.svc.objectSchedule(s.deputy, s.obj.id)).entries.find((e: any) => e.itemId === e1.itemId);
  if (approve.status === 'fulfilled') {
    // approval first: the edit then finds no draft (or an approved entry) and is refused; the approved date is the one the approver saw
    assert.equal(edit.status, 'rejected');
    assert.equal(current.plannedFinish, F1[1]);
  } else {
    // edit first: the approver's version is stale, nothing was approved
    assert.equal(edit.status, 'fulfilled');
    assert.equal((approve as PromiseRejectedResult).reason?.getStatus?.(), 409);
    assert.equal(current, undefined, 'no baseline exists yet');
  }
});

test('B5 native concurrency: the same scope added twice at once yields one entry; a raw second APPROVED revision blocks on the first, then fails', async () => {
  const s = await scenario('B5');
  await ctx.svc.createDraft(s.pm, s.obj.id);
  const results = await Promise.allSettled([1, 2, 3].map(() => ctx.svc.addEntry(s.pm, s.obj.id, entryBody(s, s.u1, F1))));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await ctx.db.pool.query('SELECT count(*)::int n FROM schedule_items WHERE object_work_id=$1 AND execution_unit_id=$2', [s.work.id, s.u1.unit.id])).rows[0].n, 1, 'one identity per scope');
  assert.equal((await ctx.db.pool.query('SELECT count(*)::int n FROM schedule_revision_entries e JOIN schedule_items i ON i.id=e.item_id WHERE i.object_id=$1', [s.obj.id])).rows[0].n, 1);

  // raw overlap on the "one current baseline" index: the second INSERT blocks on the first's uncommitted row, then fails 23505
  const t = s.t;
  const c1 = await client(), c2 = await client();
  try {
    await c1.query('BEGIN');
    const insert = (c: Client, no: number) => c.query("INSERT INTO schedule_revisions(tenant_id,object_id,revision_no,status,created_by,approved_by,approved_at) VALUES($1,$2,$3,'APPROVED',$4,$4,now())", [t, s.obj.id, no, s.pm.id]);
    await insert(c1, 10);
    const second = insert(c2, 11).then(() => 'inserted', (e: any) => e.code);
    await sleep(300);
    await c1.query('COMMIT');
    assert.equal(await second, '23505');
  } finally { await c1.end(); await c2.end(); }
});

test('B6 native concurrency: two corrections racing — one draft, one superseding approval; the superseded revision keeps its dates', async () => {
  const s = await scenario('B6');
  const e1 = await drafted(s);
  await ctx.svc.approveDraft(s.deputy, s.obj.id, { version: (await draftOf(s)).version });
  const drafts = await Promise.allSettled([ctx.svc.createDraft(s.pm, s.obj.id), ctx.svc.createDraft(s.pm, s.obj.id)]);
  assert.equal(drafts.filter((r) => r.status === 'fulfilled').length, 1);
  const d = await draftOf(s);
  const row = d.entries.find((e: any) => e.itemId === e1.itemId);
  await ctx.svc.editEntry(s.pm, s.obj.id, row.entryId, { version: row.version, plannedFinish: '2026-03-18' });
  const v = (await draftOf(s)).version;
  const results = await Promise.allSettled([ctx.svc.approveDraft(s.deputy, s.obj.id, { version: v, correctionReason: 'Сдвиг поставки' }), ctx.svc.approveDraft(s.deputy, s.obj.id, { version: v, correctionReason: 'Сдвиг поставки' })]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const revisions = (await ctx.db.pool.query('SELECT revision_no,status FROM schedule_revisions WHERE object_id=$1 ORDER BY revision_no', [s.obj.id])).rows;
  assert.deepEqual(revisions.map((r: any) => [r.revision_no, r.status]), [[1, 'SUPERSEDED'], [2, 'APPROVED']]);
  const old = (await ctx.db.pool.query("SELECT e.planned_finish FROM schedule_revision_entries e JOIN schedule_revisions r ON r.id=e.revision_id WHERE r.object_id=$1 AND r.revision_no=1 AND e.item_id=$2", [s.obj.id, e1.itemId])).rows[0];
  assert.equal(old.planned_finish, F1[1], 'the superseded plan still holds the originally approved date');
});

test('B7 native hardening: revision links stay inside one object, planning dates stay in range, a delay reason points at an entry of the approved baseline', async () => {
  const s = await scenario('B7');
  const first = await drafted(s);
  await ctx.svc.approveDraft(s.deputy, s.obj.id, { version: (await draftOf(s)).version });
  const other = await scenario('B7-other');
  await drafted(other);
  await ctx.svc.approveDraft(other.deputy, other.obj.id, { version: (await draftOf(other)).version });
  const c = await client();
  try {
    const cur = (await c.query("SELECT id FROM schedule_revisions WHERE object_id=$1 AND status='APPROVED'", [s.obj.id])).rows[0];
    const foreignRevision = (await c.query("SELECT id FROM schedule_revisions WHERE object_id=$1 AND status='APPROVED'", [other.obj.id])).rows[0];

    // a correction is cloned from the SAME object's baseline; a baseline is superseded by a revision of the SAME object — for any writer
    await assert.rejects(c.query("INSERT INTO schedule_revisions(tenant_id,object_id,revision_no,status,created_by,based_on_revision_id) VALUES($1,$2,7,'DRAFT',$3,$4)", [s.t, s.obj.id, s.pm.id, foreignRevision.id]), /должна относиться к тому же объекту/);
    await assert.rejects(c.query("UPDATE schedule_revisions SET status='SUPERSEDED',superseded_at=now(),superseded_by_revision_id=$2 WHERE id=$1", [cur.id, foreignRevision.id]), /должна относиться к тому же объекту/);
    assert.equal((await c.query('SELECT status FROM schedule_revisions WHERE id=$1', [cur.id])).rows[0].status, 'APPROVED', 'the baseline was not touched');

    // planning dates stay in the years a schedule plans in (a two-digit year typed into a date field arrives as 0026-..)
    await ctx.svc.createDraft(s.pm, s.obj.id);
    const draft = (await c.query("SELECT id FROM schedule_revisions WHERE object_id=$1 AND status='DRAFT'", [s.obj.id])).rows[0];
    await assert.rejects(c.query('UPDATE schedule_revision_entries SET planned_start=$3 WHERE revision_id=$1 AND item_id=$2', [draft.id, first.itemId, '0026-03-01']), /schedule_revision_entries_dates_in_range/);
    await assert.rejects(c.query('UPDATE schedule_revision_entries SET planned_finish=$3 WHERE revision_id=$1 AND item_id=$2', [draft.id, first.itemId, '2101-01-01']), /schedule_revision_entries_dates_in_range/);
    await c.query('UPDATE schedule_revision_entries SET planned_start=$3,planned_finish=$4 WHERE revision_id=$1 AND item_id=$2', [draft.id, first.itemId, '2000-01-01', '2100-12-31']);

    // a delay reason is evidence about the APPROVED baseline's own entry: not a draft, not an item the baseline never planned
    const reasonSql = 'INSERT INTO schedule_delay_reasons(tenant_id,object_id,item_id,revision_id,category_code,comment,delay_days_at_record,recorded_by) VALUES($1,$2,$3,$4,$5,$6,3,$7)';
    await assert.rejects(c.query(reasonSql, [s.t, s.obj.id, first.itemId, draft.id, 'MATERIALS', 'по черновику', s.pm.id]), /относится к участку утверждённого графика/);
    const workType = (await c.query('SELECT work_type_id FROM works WHERE id=$1', [s.work.id])).rows[0].work_type_id;
    const unit3 = await ctx.db.insert(ctx.db.pool, 'work_execution_units', s.t, { objectWorkId: s.work.id, workTypeId: workType, contractorId: s.contractor.id, unit: 'м²', plannedQuantity: 100, location: '3 этаж' });
    const item3 = (await c.query('INSERT INTO schedule_items(tenant_id,object_id,object_work_id,execution_unit_id,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id', [s.t, s.obj.id, s.work.id, unit3.id, s.pm.id])).rows[0];
    await assert.rejects(c.query(reasonSql, [s.t, s.obj.id, item3.id, cur.id, 'MATERIALS', 'участка нет в графике', s.pm.id]), /относится к участку утверждённого графика/);
    await c.query(reasonSql, [s.t, s.obj.id, first.itemId, cur.id, 'MATERIALS', 'участок графика', s.pm.id]);
    assert.equal((await c.query('SELECT count(*)::int n FROM schedule_delay_reasons WHERE object_id=$1', [s.obj.id])).rows[0].n, 1, 'only the legitimate reason was stored');
  } finally { await c.end(); }
});

test('B8 native lock order: a schedule mutation holding the object never deadlocks with a transaction that holds a work row FOR UPDATE and then inserts a row referencing the object', async () => {
  const s = await scenario('B8');
  await ctx.svc.createDraft(s.pm, s.obj.id);
  const spare = (await ctx.db.one(ctx.db.pool, 'SELECT id FROM contractors WHERE tenant_id=$1 AND id<>$2 ORDER BY name LIMIT 1', [s.t, s.contractor.id])).id;
  const holder = await client(), watcher = await client();
  try {
    // the other slice's shape (e.g. an inspection request): lock the work row, later insert something that references the object
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM works WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [s.t, s.work.id]);
    // the schedule mutation takes the object lock, then needs the work row (the new item references it) and waits for the holder
    const adding = ctx.svc.addEntry(s.pm, s.obj.id, entryBody(s, s.u1, F1));
    const started = Date.now();
    for (;;) {
      const waiting = (await watcher.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rows[0].n;
      if (waiting > 0) break;
      assert.ok(Date.now() - started < 8000, 'the schedule mutation should be waiting for the work row');
      await sleep(20);
    }
    // the holder now inserts a row that references the object (FOR KEY SHARE on the object row). It must not wait for the schedule
    // mutation's object lock — FOR UPDATE would turn this into a lock-order inversion that PostgreSQL resolves by aborting one of the two.
    const t0 = Date.now();
    await holder.query('INSERT INTO object_contractors(tenant_id,object_id,contractor_id) VALUES($1,$2,$3)', [s.t, s.obj.id, spare]);
    assert.ok(Date.now() - t0 < 800, 'the insert was not blocked by the schedule mutation (' + (Date.now() - t0) + ' ms)');
    await holder.query('COMMIT');
    const entry = await adding;
    assert.ok(entry.id, 'the schedule mutation completes once the work row is released');
  } finally { await holder.query('ROLLBACK').catch(() => {}); await holder.end(); await watcher.end(); }
});
