import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createIsolatedDatabase, scrubConnectionEnvironment, Session, until, waitUntilBlocked, recordEvidence, settle, advisoryHolders } from './helpers/gpr2-native-pg';

/**
 * GPR-2 R05 — the claims PGlite cannot carry, on NATIVE PostgreSQL (the isolated cluster `gpr2-p1-isolated`, a fresh `gpr2_p1_*` database; never LIVE,
 * never an inherited DATABASE_URL):
 *   * upgrade 028 → 034 on a seeded database: every pre-existing Work / WEU / portion / confirmation / progress row and every legacy WorkType column is
 *     byte-identical; the five new files (033: the corrective of GPT_REVIEW_20261024) are recorded with checksums as additive; a re-run is a no-op;
 *   * two confirms of the same preview with DIFFERENT keys, both proved waiting on the object's coordination lock: exactly one creates Works, the other is
 *     refused (scope changed) and leaves nothing;
 *   * two confirms with the SAME key, both waiting: one execution, one replay, the same Work ids;
 *   * the one-producer guard between two real sessions: a duplicate obligation and an ancestor/descendant overlap, the second session proved blocked
 *     until the first commits, then refused; after a rollback instead, the second succeeds;
 *   * concurrent sibling AreaScopes under one measured parent: the second is checked after the first commits;
 *   * publication vs a late stage insert: the insert waits, then sees PUBLISHED and is refused;
 *   * A30 on native: an aborted confirm leaves no Work, binding, scope bump or ledger row.
 * Every race is staged with a barrier PostgreSQL reports (a waiting lock), never with a sleep.
 */
scrubConnectionEnvironment();

test('R05 native PostgreSQL: upgrade, concurrent confirm, one-producer races, sibling measures, publication race, rollback', async () => {
  const db = await createIsolatedDatabase('r05');
  process.env.DATABASE_URL = db.url;
  const { pool, one } = await import('../apps/backend/src/db');
  const { migrate, planMigrationsOnDatabase } = await import('../scripts/migrate') as any;
  const { seed } = await import('../scripts/seed');
  const { runGpr2Command } = await import('../apps/backend/src/gpr2-command-guard');
  const { R05_HOOKS } = await import('../apps/backend/src/gpr2-r05-hooks');
  const { coordinationKey } = await import('../apps/backend/src/coordination-lock');
  const { endpointById } = await import('../packages/domain/gpr2');
  const observer = await Session.open(db.url, 'r05-observer');
  const evidence: Record<string, unknown> = { cluster: db.evidence, database: db.name };
  try {
    // ---------------------------------------------------------------- upgrade 028 → 034
    await migrate({ through: 28 }); await seed();
    const digest = async (sql: string) => (await pool.query(`SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS d, count(*)::int AS n FROM (${sql}) t`)).rows[0];
    const PROTECTED = {
      works: 'SELECT row_to_json(w)::text FROM works w', weu: 'SELECT row_to_json(u)::text FROM work_execution_units u', portions: 'SELECT row_to_json(p)::text FROM quantity_portions p',
      confirmations: 'SELECT row_to_json(c)::text FROM portion_quantity_confirmations c', progress: 'SELECT row_to_json(p)::text FROM work_progress p', legacyFinish: 'SELECT row_to_json(f)::text FROM finish_types f',
      workTypesLegacyColumns: 'SELECT json_build_array(id, tenant_id, category_id, name, unit, requires_inspection, requires_executive_docs, requires_materials, is_active, created_at, updated_at, version)::text FROM work_types'
    };
    const snap = async () => Object.fromEntries(await Promise.all(Object.entries(PROTECTED).map(async ([k, sql]) => [k, await digest(sql)])));
    const before = await snap();
    const plan = await planMigrationsOnDatabase();
    assert.deepEqual(plan.pending.map((p: any) => [p.version, p.class]), [[29, 'additive'], [30, 'additive'], [31, 'additive'], [32, 'additive'], [33, 'additive'], [34, 'additive']]);
    const applied = await migrate();
    assert.deepEqual(applied.applied.map((a: any) => a.version), [29, 30, 31, 32, 33, 34]);
    assert.deepEqual(await snap(), before, 'no protected row changed by 029–034');
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM work_types WHERE scope<>'CORPORATE' OR object_id IS NOT NULL OR origin_object_id IS NOT NULL")).rows[0].n, 0, 'every existing WorkType reads CORPORATE');
    const ledger = (await pool.query('SELECT version, checksum, migration_class FROM schema_migrations WHERE version>=29 ORDER BY version')).rows;
    assert.ok(ledger.every((r: any) => /^[0-9a-f]{64}$/.test(r.checksum) && r.migration_class === 'additive'));
    assert.equal((await migrate()).applied.length, 0, 're-run is a no-op');
    evidence.upgrade = { from: 28, applied: applied.applied.map((a: any) => a.version), ledger, protectedDigests: before, unchanged: true, rerunNoop: true };

    // ---------------------------------------------------------------- fixtures through the real guarded command path
    const pm = await one(pool, "SELECT * FROM users WHERE role='PROJECT_MANAGER' AND is_active=true ORDER BY created_at LIMIT 1");
    const object = await one(pool, 'SELECT * FROM objects WHERE project_manager_id=$1 ORDER BY created_at LIMIT 1', [pm.id]);
    const category = await one(pool, 'SELECT id FROM work_categories WHERE tenant_id=$1 LIMIT 1', [pm.tenantId]);
    const T: Record<string, string> = {};
    for (const [k, name] of [['primer', 'Грунтование'], ['plaster', 'Штукатурка'], ['paint', 'Покраска']])
      T[k] = (await one(pool, "INSERT INTO work_types(tenant_id,category_id,name,unit) VALUES($1,$2,$3,'м²') RETURNING id", [pm.tenantId, category.id, name])).id;
    const run = async (id: string, params: Record<string, string>, body: unknown, key: string | null = randomUUID(), actor = pm) =>
      runGpr2Command(endpointById(id)!, { actor, params: { objectId: object.id, ...params }, headers: key ? { 'idempotency-key': key } : {}, body }, R05_HOOKS) as Promise<any>;
    const area = async (payload: any) => (await run('area-scope.create', {}, { payload })).resultIds[0] as string;
    const P = await area({ kind: 'SECTION', code: 'NP', name: 'Секция', measureQuantity: '5000', measureUnit: 'м²' });
    const L1 = await area({ parentId: P, kind: 'FLOOR', code: 'NP-1', name: 'Этаж 1', measureQuantity: '300', measureUnit: 'м²' });
    const L2 = await area({ parentId: P, kind: 'FLOOR', code: 'NP-2', name: 'Этаж 2', measureQuantity: '300', measureUnit: 'м²' });
    const st = (k: string, pos: number, wt: string) => ({ occurrenceKey: k, position: pos, workTypeId: wt, required: true, measureScope: 'MAIN', measureUnit: 'м²' });
    const sys = await run('finish-system.upsert', {}, { payload: { finishType: { code: 'NT-1', name: 'Тип №1', }, stages: [st('PRIMER_1', 1, T.primer), st('PLASTER', 2, T.plaster), st('PRIMER_2', 3, T.primer), st('PAINT', 4, T.paint)] } });
    const [ft, sv] = sys.resultIds;
    const previewOf = async (areaScopeIds: string[]) => (await run('finish-system.preview', { id: ft }, { expectedVersion: '1', payload: { systemVersionId: sv, areaScopeIds } }, null)).preview;
    const confirmBody = (p: any, areaScopeIds: string[]) => ({ expectedVersion: '1', expectedScopeVersion: p.scopeVersion, payload: { systemVersionId: sv, areaScopeIds, previewFingerprint: p.previewFingerprint, expectedSourceVersions: { systemVersion: sv } } });
    const count = async (sql: string, args: any[] = []) => (await pool.query(sql, args)).rows[0].n as number;
    const key = coordinationKey(pm.tenantId, object.id);
    const waitingExclusive = async () => (await observer.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND mode='ExclusiveLock' AND NOT granted")).rows[0].n as number;

    // preview on native: zero writes
    const tables = ['works', 'work_scope_bindings', 'work_scope_state', 'gpr2_command_ledger', 'audit_logs'];
    const rowsOf = async () => Promise.all(tables.map(t => digest(`SELECT row_to_json(x)::text FROM ${t} x`)));
    const r0 = await rowsOf();
    const p1 = await previewOf([L1]);
    assert.equal(p1.canConfirm, true); assert.equal(p1.proposedWorks.length, 4);
    assert.deepEqual(await rowsOf(), r0, 'native preview wrote nothing');

    // ---------------------------------------------------------------- two confirms, DIFFERENT keys, same preview, both proved waiting
    {
      const blocker = await Session.open(db.url, 'r05-shared-writer');
      await blocker.begin(); await blocker.query('SELECT pg_advisory_xact_lock_shared($1::bigint)', [key.toString()]); // an in-flight fact writer of the object
      const worksBefore = await count('SELECT count(*)::int AS n FROM works');
      const a = settle(run('finish-system.confirm', { id: ft }, confirmBody(p1, [L1])));
      const b = settle(run('finish-system.confirm', { id: ft }, confirmBody(p1, [L1])));
      try { await until(async () => (await waitingExclusive()) >= 2, 'both confirms waiting for the EXCLUSIVE coordination lock'); }
      finally { await blocker.rollback(); await blocker.close(); }
      const [ra, rb] = await Promise.all([a, b]);
      const ok = [ra, rb].filter(r => r.ok), refused = [ra, rb].filter(r => !r.ok);
      assert.equal(ok.length, 1, 'exactly one confirm created Works'); assert.equal(refused.length, 1);
      assert.equal((refused[0] as any).error.code, 'SCOPE_VERSION_CHANGED');
      assert.equal(await count('SELECT count(*)::int AS n FROM works') - worksBefore, 4);
      assert.equal(await count("SELECT count(*)::int AS n FROM work_scope_bindings WHERE area_scope_id=$1", [L1]), 4);
      assert.equal(await count("SELECT count(*)::int AS n FROM gpr2_command_ledger WHERE command_kind='finish-system.confirm'"), 1, 'the refused command left no ledger row');
      evidence.differentKeys = { bothObservedWaiting: true, created: (ok[0] as any).value.resultIds, refused: (refused[0] as any).error.code };
    }

    // ---------------------------------------------------------------- two confirms, SAME key, both waiting: one execution, one replay
    {
      const p2 = await previewOf([L2]);
      const k = randomUUID();
      const blocker = await Session.open(db.url, 'r05-shared-writer-2');
      await blocker.begin(); await blocker.query('SELECT pg_advisory_xact_lock_shared($1::bigint)', [key.toString()]);
      const a = settle(run('finish-system.confirm', { id: ft }, confirmBody(p2, [L2]), k));
      const b = settle(run('finish-system.confirm', { id: ft }, confirmBody(p2, [L2]), k));
      try { await until(async () => (await waitingExclusive()) >= 2, 'both same-key confirms waiting'); }
      finally { await blocker.rollback(); await blocker.close(); }
      const [ra, rb] = await Promise.all([a, b]);
      assert.ok(ra.ok && rb.ok, JSON.stringify([ra, rb].map((r: any) => r.error?.code)));
      assert.deepEqual((ra as any).value, (rb as any).value, 'the same command id and the same Work ids');
      assert.equal(await count('SELECT count(*)::int AS n FROM work_scope_bindings WHERE area_scope_id=$1', [L2]), 4, 'one effect');
      evidence.sameKey = { bothObservedWaiting: true, resultIds: (ra as any).value.resultIds, oneEffect: true };
    }

    // ---------------------------------------------------------------- one-producer guard between two real sessions (direct SQL)
    const freshWork = async (wt: string) => (await one(pool, "INSERT INTO works(tenant_id,object_id,work_type_id,name,unit,planned_quantity) VALUES($1,$2,$3,'x','м²',1) RETURNING id", [pm.tenantId, object.id, wt])).id;
    const occ = async (k: string) => (await one(pool, 'SELECT id FROM finish_stage_occurrences WHERE system_version_id=$1 AND occurrence_key=$2', [sv, k])).id;
    const L3 = await area({ parentId: P, kind: 'FLOOR', code: 'NP-3', name: 'Этаж 3', measureQuantity: '300', measureUnit: 'м²' });
    const bindSql = `INSERT INTO work_scope_bindings(tenant_id,object_id,work_id,finish_type_id,system_version_id,occurrence_id,occurrence_key,area_scope_id,measure_scope,basis_quantity,command_id,created_by)
      VALUES($1,$2,$3,$4,$5,$6,'PLASTER',$7,'MAIN',1,$8,$9)`;
    const bindArgs = (work: string, areaId: string, plaster: string) => [pm.tenantId, object.id, work, ft, sv, plaster, areaId, randomUUID(), pm.id];
    const plasterOcc = await occ('PLASTER');
    const race = async (label: string, first: string, second: string, outcome: 'commit' | 'rollback', expect: RegExp | null) => {
      const s1 = await Session.open(db.url, 'r05-' + label + '-1'), s2 = await Session.open(db.url, 'r05-' + label + '-2');
      try {
        const w1 = await freshWork(T.plaster), w2 = await freshWork(T.plaster);
        await s1.begin(); await s1.query(bindSql, bindArgs(w1, first, plasterOcc));
        await s2.begin();
        const second2 = settle(s2.query(bindSql, bindArgs(w2, second, plasterOcc)));
        await waitUntilBlocked(observer.client, s2.pid, label + ': the second producer insert');
        if (outcome === 'commit') await s1.commit(); else await s1.rollback();
        const r = await second2;
        if (expect) { assert.equal(r.ok, false, label); assert.match((r as any).error.message + ' ' + (r as any).error.code, expect, label); await s2.rollback(); }
        else { assert.equal(r.ok, true, label + ': ' + (r as any).error?.message); await s2.commit(); }
        return { label, secondObservedBlocked: true, firstOutcome: outcome, secondResult: r.ok ? 'INSERTED' : ((r as any).error.code + ' ' + String((r as any).error.message).slice(0, 80)) };
      } finally { await s1.close(); await s2.close(); }
    };
    const races = [];
    races.push(await race('duplicate-obligation', L3, L3, 'commit', /23505|work_scope_bindings_one_producer/));
    const L4 = await area({ parentId: P, kind: 'FLOOR', code: 'NP-4', name: 'Этаж 4', measureQuantity: '100', measureUnit: 'м²' });
    const L4a = await area({ parentId: L4, kind: 'ROOM', code: 'NP-4-A', name: 'Комната 4А', measureQuantity: '50', measureUnit: 'м²' });
    races.push(await race('ancestor-then-descendant', L4, L4a, 'commit', /GPR2_R05:ONE_PRODUCER_CONFLICT/));
    const L5 = await area({ parentId: P, kind: 'FLOOR', code: 'NP-5', name: 'Этаж 5', measureQuantity: '100', measureUnit: 'м²' });
    const L5a = await area({ parentId: L5, kind: 'ROOM', code: 'NP-5-A', name: 'Комната 5А', measureQuantity: '50', measureUnit: 'м²' });
    races.push(await race('descendant-then-ancestor', L5a, L5, 'commit', /GPR2_R05:ONE_PRODUCER_CONFLICT/));
    const L6 = await area({ kind: 'ZONE', code: 'NP-6', name: 'Зона 6', measureQuantity: '10', measureUnit: 'м²' });
    races.push(await race('first-rolls-back', L6, L6, 'rollback', null));
    assert.equal(await count("SELECT count(*)::int AS n FROM work_scope_bindings WHERE area_scope_id=$1 AND occurrence_key='PLASTER'", [L6]), 1);
    evidence.oneProducerRaces = races;

    // ---------------------------------------------------------------- sibling AreaScopes under one measured parent
    {
      const parent = await area({ kind: 'SECTION', code: 'SIB', name: 'Секция', measureQuantity: '1000', measureUnit: 'м²' });
      const sql = `INSERT INTO object_area_scopes(tenant_id,object_id,parent_id,kind,code,name,measure_quantity,measure_unit,created_by) VALUES($1,$2,$3,'FLOOR',$4,'x',$5,'м²',$6)`;
      const s1 = await Session.open(db.url, 'r05-sibling-1'), s2 = await Session.open(db.url, 'r05-sibling-2');
      try {
        await s1.begin(); await s1.query(sql, [pm.tenantId, object.id, parent, 'SIB-1', '600', pm.id]);
        await s2.begin();
        const r2p = settle(s2.query(sql, [pm.tenantId, object.id, parent, 'SIB-2', '500', pm.id]));
        await waitUntilBlocked(observer.client, s2.pid, 'the second sibling');
        await s1.commit();
        const r2 = await r2p;
        assert.equal(r2.ok, false); assert.match((r2 as any).error.message, /GPR2_R05:AREA_SCOPE_CONFLICT/);
        await s2.rollback();
        evidence.siblings = { secondObservedBlocked: true, secondRefused: 'AREA_SCOPE_CONFLICT', parent: '1000', first: '600', second: '500' };
      } finally { await s1.close(); await s2.close(); }
    }

    // ---------------------------------------------------------------- publication vs a late stage insert
    {
      const admin = await one(pool, "SELECT * FROM users WHERE tenant_id=$1 AND role='ADMIN' LIMIT 1", [pm.tenantId]);
      const tpl = await run('finish-template.draft', {}, { payload: { code: 'NT-TPL', name: 'Шаблон', stages: [st('PAINT', 1, T.paint)] } }, randomUUID(), admin);
      const [, versionId] = tpl.resultIds;
      const s1 = await Session.open(db.url, 'r05-publish'), s2 = await Session.open(db.url, 'r05-late-stage');
      try {
        await s1.begin(); await s1.query("UPDATE finish_template_versions SET state='PUBLISHED', content_hash=repeat('c',64), published_by=$2, published_at=now() WHERE id=$1", [versionId, admin.id]);
        await s2.begin();
        const late = settle(s2.query("INSERT INTO finish_template_stages(tenant_id,template_version_id,occurrence_key,position,work_type_id,required,measure_scope,measure_unit) VALUES($1,$2,'LATE',2,$3,true,'MAIN','м²')", [pm.tenantId, versionId, T.paint]));
        await waitUntilBlocked(observer.client, s2.pid, 'the late stage insert');
        await s1.commit();
        const r = await late;
        assert.equal(r.ok, false); assert.match((r as any).error.message, /GPR2_R05:VERSION_IMMUTABLE/);
        await s2.rollback();
        evidence.publicationRace = { lateInsertObservedBlocked: true, lateInsertRefused: 'VERSION_IMMUTABLE' };
      } finally { await s1.close(); await s2.close(); }
    }

    // ---------------------------------------------------------------- A30 on native: an aborted confirm leaves nothing
    {
      const L7 = await area({ kind: 'ZONE', code: 'NP-7', name: 'Зона 7', measureQuantity: '20', measureUnit: 'м²' });
      const p = await previewOf([L7]);
      await pool.query(`CREATE FUNCTION r05_native_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.occurrence_key = 'PAINT' THEN RAISE EXCEPTION 'injected native failure'; END IF; RETURN NEW; END $$`);
      await pool.query('CREATE TRIGGER r05_native_fail AFTER INSERT ON work_scope_bindings FOR EACH ROW EXECUTE FUNCTION r05_native_fail()');
      const before = await rowsOf();
      const k = randomUUID();
      try {
        const r = await settle(run('finish-system.confirm', { id: ft }, confirmBody(p, [L7]), k));
        assert.equal(r.ok, false);
        assert.deepEqual(await rowsOf(), before, 'no Work, binding, scope bump, ledger or audit row survives');
      } finally { await pool.query('DROP TRIGGER r05_native_fail ON work_scope_bindings'); await pool.query('DROP FUNCTION r05_native_fail()'); }
      const retry = await run('finish-system.confirm', { id: ft }, confirmBody(p, [L7]), k);
      assert.equal(retry.resultIds.length, 4);
      evidence.rollback = { abortedLeftNothing: true, retryCleanFirstExecution: true };
    }
    assert.deepEqual(await advisoryHolders(observer.client, key), [], 'no coordination lock left held');
    evidence.result = 'PASS';
  } finally {
    recordEvidence('r05-native-summary', evidence);
    await observer.close(); await pool.end(); await db.drop();
  }
});
