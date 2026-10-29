import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createIsolatedDatabase, scrubConnectionEnvironment, recordEvidence, settle, until, Session } from './helpers/gpr2-native-pg';

/**
 * GPR-2 R05 / D1 — the five reads on NATIVE PostgreSQL (isolated cluster `gpr2-p1-isolated`, a fresh `gpr2_p1_*` database, migrations 001–035; never LIVE).
 * What PGlite cannot say: the real column types (numeric → exact text, timestamptz → microsecond keys), the real collation in keyset order, that the
 * snapshot is READ ONLY in PostgreSQL itself, that a read is never blocked by — and never blocks — a command in flight (object coordination lock, row
 * locks), that it sees committed state only, and that it leaves no lock, no row and no sequence value behind.
 */
scrubConnectionEnvironment();

test('D1 reads on native PostgreSQL: exact types, keyset paging, READ ONLY snapshot, no lock interaction with a command in flight, no residue', async () => {
  const db = await createIsolatedDatabase('d1read');
  process.env.DATABASE_URL = db.url;
  const { pool, one } = await import('../apps/backend/src/db');
  const { migrate } = await import('../scripts/migrate') as any;
  const { seed } = await import('../scripts/seed');
  const { runGpr2Command } = await import('../apps/backend/src/gpr2-command-guard');
  const { R05_HOOKS } = await import('../apps/backend/src/gpr2-r05-hooks');
  const { runR05Read } = await import('../apps/backend/src/gpr2-r05-read');
  const { runSnapshotRead } = await import('../apps/backend/src/tx-context');
  const { endpointById } = await import('../packages/domain/gpr2');
  const observer = await Session.open(db.url, 'd1read-observer');
  const writer = await Session.open(db.url, 'd1read-writer');
  const evidence: Record<string, any> = { cluster: db.evidence, database: db.name };
  const count = async (sql: string, args: any[] = []) => Number((await pool.query(sql, args)).rows[0].n);
  try {
    await migrate(); await seed();
    const pm = await one(pool, "SELECT * FROM users WHERE role='PROJECT_MANAGER' AND is_active=true ORDER BY created_at LIMIT 1");
    const otherPm = await one(pool, "SELECT * FROM users WHERE role='PROJECT_MANAGER' AND is_active=true AND id<>$1 ORDER BY created_at LIMIT 1", [pm.id]);
    const admin = await one(pool, "SELECT * FROM users WHERE role='ADMIN' AND is_active=true LIMIT 1");
    const deputy = await one(pool, "SELECT * FROM users WHERE role='DEPUTY_DIRECTOR' AND is_active=true LIMIT 1");
    const object = await one(pool, 'SELECT * FROM objects WHERE project_manager_id=$1 ORDER BY created_at LIMIT 1', [pm.id]);
    const category = await one(pool, 'SELECT id FROM work_categories WHERE tenant_id=$1 LIMIT 1', [pm.tenantId]);
    const T = pm.tenantId, O = object.id;
    const actorOf = (u: any) => one(pool, 'SELECT * FROM users WHERE id=$1', [u.id]);
    const cmd = async (who: any, id: string, params: Record<string, string>, body: unknown) =>
      runGpr2Command(endpointById(id)!, { actor: await actorOf(who), params: { objectId: O, ...params }, headers: { 'idempotency-key': randomUUID() }, body }, R05_HOOKS) as Promise<any>;
    const read = async (who: any, id: string, query: Record<string, unknown> = {}, objectId: string | null = O) =>
      runR05Read(endpointById(id)!, { actor: await actorOf(who), params: objectId ? { objectId } : {}, query }) as Promise<any>;

    // ---------------------------------------------------------------- data, written by the real commands
    const names = ['Бетон', 'арматура', 'Арматура', 'Zинк', 'zeta', 'Монтаж', 'Ёлка', 'А-1', 'a-1', 'b'];
    const typeIds: string[] = [];
    for (const [i, name] of names.entries())
      typeIds.push((await cmd(pm, 'work-type.create', {}, { payload: { name: 'T ' + name, categoryId: category.id, unit: i % 2 ? 'м³' : 'м²', requiresInspection: true, requiresExecutiveDocs: false, requiresMaterials: true } })).resultIds[0]);
    const areaIds: string[] = [];
    for (let i = 0; i < 7; i++)
      areaIds.push((await cmd(pm, 'area-scope.create', {}, { payload: { kind: 'ZONE', code: 'Z' + String(i).padStart(2, '0'), name: 'Зона ' + i, measureQuantity: (i + 1) + '.1234', measureUnit: 'м²' } })).resultIds[0]);
    const req = (await cmd(pm, 'work-type.publication.request', { id: typeIds[0] }, { expectedVersion: '1', payload: { justification: 'нужен' } })).resultIds[0];
    for (const [i, t] of [typeIds[1], typeIds[2], typeIds[3]].entries()) await cmd(pm, 'work-type.publication.request', { id: t }, { expectedVersion: '1', payload: i ? {} : { justification: 'ещё' } });
    const tpl = await cmd(admin, 'finish-template.draft', {}, { payload: { code: 'NATIVE-TPL', name: 'Нативный шаблон', stages: [
      { occurrenceKey: 'A', position: 1, workTypeId: (await one(pool, "SELECT id FROM work_types WHERE scope='CORPORATE' AND unit='м²' LIMIT 1")).id, required: true, measureScope: 'MAIN', measureUnit: 'м²', proposedHoldHours: '0.5' }] } });
    await cmd(admin, 'finish-template.publish', { id: tpl.resultIds[0] }, { expectedVersion: '1', payload: { templateVersionId: tpl.resultIds[1] } });
    const fsys = await cmd(pm, 'finish-system.upsert', {}, { payload: { finishType: { code: 'N-1', name: 'Нативная система' }, sourceTemplateVersionId: tpl.resultIds[1] } });

    // ---------------------------------------------------------------- shapes and exact types
    const q2 = await read(pm, 'area-scopes.list');
    assert.deepEqual(q2.items.map((a: any) => a.measureQuantity), ['1.1234', '2.1234', '3.1234', '4.1234', '5.1234', '6.1234', '7.1234'], 'numeric(24,4) is the exact text, never a float');
    assert.match(q2.items[0].createdAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    const q3 = await read(pm, 'finish-systems.list');
    assert.equal(q3.items[0].currentVersion.stages[0].proposedHoldHours, '0.500000000000', 'numeric(30,12) is the exact text');
    assert.equal(q3.items[0].currentVersion.stages[0].workTypeName !== null, true);
    const q4pm = await read(pm, 'finish-templates.list'); assert.deepEqual(q4pm.items.map((t: any) => t.code), ['NATIVE-TPL']);
    const q5 = await read(pm, 'work-type-publication-requests.list');
    assert.equal(q5.items.length, 4); assert.equal(q5.items[0].workTypeVersion, '1');

    // ---------------------------------------------------------------- keyset paging reproduces the single page in the database's own order (collation C: bytewise)
    const pagedIds = async (id: string, who: any, extra: Record<string, unknown> = {}) => {
      const out: string[] = []; let cursor: string | undefined, pages = 0;
      do { const p: any = await read(who, id, { limit: '2', ...(cursor ? { cursor } : {}), ...extra }); out.push(...p.items.map((i: any) => i.id)); cursor = p.nextCursor ?? undefined; pages++; assert.ok(pages < 50); } while (cursor);
      return out;
    };
    const whole = async (id: string, who: any) => (await read(who, id, { limit: '200' })).items.map((i: any) => i.id);
    for (const [id, who] of [['work-types.list', pm], ['area-scopes.list', pm], ['work-type-publication-requests.list', admin], ['work-type-publication-requests.list', pm]] as const)
      assert.deepEqual(await pagedIds(id, who), await whole(id, who), id);
    const wt = await read(pm, 'work-types.list', { limit: '200' });
    const sortedNames = [...wt.items.map((i: any) => i.name)].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    assert.deepEqual(wt.items.map((i: any) => i.name), sortedNames, 'ORDER BY name under collation C = bytewise order, and the keyset comparison uses the same collation');
    assert.ok(wt.items.length >= names.length + 1);

    // ---------------------------------------------------------------- authorisation on the real row, scope-safe
    for (const who of [admin, deputy]) await assert.rejects(read(who, 'work-types.list'), (e: any) => e.code === 'PERMISSION_DENIED' && e.status === 403);
    await assert.rejects(read(otherPm, 'area-scopes.list'), (e: any) => e.code === 'RESOURCE_NOT_FOUND' && e.status === 404);
    await assert.rejects(read(admin, 'work-type-publication-requests.list', {}, randomUUID()), (e: any) => e.code === 'RESOURCE_NOT_FOUND');
    assert.equal((await read(admin, 'work-type-publication-requests.list')).items.length, 4, 'ADMIN reads the chosen object\'s requests');

    // ---------------------------------------------------------------- READ ONLY in PostgreSQL itself: the helper every read runs in refuses a write
    const roAttempt = await settle(runSnapshotRead(async (tx: any) => { await tx.c.query("UPDATE work_types SET name=name WHERE id=$1", [typeIds[0]]); }));
    assert.equal(roAttempt.ok, false); assert.equal((roAttempt as any).error.code, '25006', 'read_only_sql_transaction');
    const ro = await runSnapshotRead(async (tx: any) => (await tx.c.query("SELECT current_setting('transaction_read_only') AS ro, current_setting('transaction_isolation') AS iso")).rows[0]);
    assert.deepEqual(ro, { ro: 'on', iso: 'repeatable read' });
    evidence.snapshot = { ...ro, writeAttemptSqlstate: (roAttempt as any).error.code };

    // ---------------------------------------------------------------- a command in flight: exclusive object coordination lock + row locks + an uncommitted insert
    const { coordinationKey } = await import('../apps/backend/src/coordination-lock') as any;
    await writer.begin();
    if (typeof coordinationKey === 'function') await writer.query('SELECT pg_advisory_xact_lock($1::bigint)', [coordinationKey(T, O).toString()]);
    await writer.query('SELECT id FROM work_types WHERE id=ANY($1::uuid[]) FOR UPDATE', [typeIds]);
    await writer.query('SELECT id FROM object_area_scopes WHERE object_id=$1 FOR UPDATE', [O]);
    await writer.query("INSERT INTO object_area_scopes(tenant_id,object_id,kind,code,name,created_by) VALUES($1,$2,'ROOM','UNCOMMITTED','не зафиксировано',$3)", [T, O, pm.id]);
    await writer.query("UPDATE work_types SET name='T ПЕРЕИМЕНОВАНО' WHERE id=$1", [typeIds[0]]);
    const startedAt = Date.now();
    const duringA = await Promise.all([read(pm, 'work-types.list'), read(pm, 'area-scopes.list'), read(pm, 'finish-systems.list'), read(pm, 'finish-templates.list', {}, null),
      read(pm, 'work-type-publication-requests.list')]);
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 5000, 'the reads did not wait for the command: ' + elapsed + ' ms');
    assert.ok(!duringA[1].items.some((a: any) => a.code === 'UNCOMMITTED'), 'uncommitted state is never read');
    assert.ok(duringA[0].items.some((t: any) => t.name === 'T ' + names[0]) && !duringA[0].items.some((t: any) => t.name === 'T ПЕРЕИМЕНОВАНО'));
    const waiting = await observer.query(`SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a USING (pid) WHERE NOT l.granted AND a.application_name NOT LIKE 'gpr2-p1:%'`);
    assert.equal(waiting.rows[0].n, 0, 'no read is waiting on a lock');
    await writer.commit();
    assert.ok((await read(pm, 'area-scopes.list')).items.some((a: any) => a.code === 'UNCOMMITTED'), 'once committed, the next read sees it');
    assert.ok((await read(pm, 'work-types.list')).items.some((t: any) => t.name === 'T ПЕРЕИМЕНОВАНО'));
    evidence.concurrency = { readsWhileCommandInFlightMs: elapsed, unGrantedLocksDuringReads: waiting.rows[0].n };

    // ---------------------------------------------------------------- the opposite direction: an open reader (a long snapshot) does not block a command
    const reader = await Session.open(db.url, 'd1read-reader');
    try {
      await reader.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const seen = (await reader.query('SELECT count(*)::int AS n FROM object_area_scopes WHERE object_id=$1', [O])).rows[0].n;
      const w = await settle(cmd(pm, 'area-scope.create', {}, { payload: { kind: 'ROOM', code: 'AFTER-SNAPSHOT', name: 'после снимка' } }));
      assert.equal(w.ok, true, 'a command is not blocked by a reader');
      assert.equal((await reader.query('SELECT count(*)::int AS n FROM object_area_scopes WHERE object_id=$1', [O])).rows[0].n, seen, 'the snapshot is stable');
      await reader.client.query('COMMIT');
    }
    finally { await reader.close(); }

    // ---------------------------------------------------------------- no residue: a battery of reads changes no row, no sequence, leaves no lock or open transaction
    const TABLES = ['works', 'gpr2_command_ledger', 'idempotent_commands', 'audit_logs', 'domain_events', 'notifications', 'work_types', 'work_type_publication_requests', 'object_area_scopes',
      'object_finish_types', 'object_finish_system_versions', 'finish_stage_occurrences', 'finish_templates', 'finish_template_versions', 'finish_template_stages', 'work_scope_state', 'work_scope_operations',
      'work_type_reference_state', 'object_area_scope_child_revisions', 'users', 'sessions'];
    const digest = async () => Promise.all(TABLES.map(async t => [t, (await pool.query(`SELECT md5(coalesce(string_agg(row_to_json(x)::text, '|' ORDER BY row_to_json(x)::text), '')) AS d, count(*)::int AS c FROM ${t} x`)).rows[0]]));
    // the next transaction id to be assigned: a read-only transaction never takes one, so 100 reads cannot move it
    const nextXid = async () => (await observer.query('SELECT txid_snapshot_xmax(txid_current_snapshot())::text AS x')).rows[0].x;
    const xidBefore = await nextXid();
    const before = await digest();
    for (let i = 0; i < 20; i++) for (const [id, who, oid] of [['work-types.list', pm, O], ['area-scopes.list', pm, O], ['finish-systems.list', pm, O], ['finish-templates.list', admin, null], ['work-type-publication-requests.list', admin, O]] as const)
      await read(who, id, { limit: '3' }, oid);
    for (const bad of [{ limit: '0' }, { zzz: '1' }, { cursor: 'AAAA' }]) await settle(read(pm, 'work-types.list', bad));
    assert.deepEqual(await digest(), before);
    assert.equal(await nextXid(), xidBefore, 'no transaction id was consumed: PostgreSQL saw no read-write transaction during 100 reads');
    const open = await observer.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND state LIKE 'idle in transaction%' AND application_name NOT LIKE 'gpr2-p1:%'`);
    assert.equal(open.rows[0].n, 0, 'no transaction is left open by a read (even a refused one)');
    assert.equal(await count("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory'"), 0, 'no advisory lock is taken or left');
    evidence.noResidue = { nextXidBefore: xidBefore, nextXidAfter: await nextXid() };
    void req; void areaIds; void fsys;
    recordEvidence('d1-read-native-pg', evidence);
  }
  finally {
    await observer.close(); await writer.close();
    const { pool } = await import('../apps/backend/src/db');
    await pool.end().catch(() => undefined);
    await db.drop();
  }
});
