import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createIsolatedDatabase, scrubConnectionEnvironment, Session, until, waitUntilBlocked, recordEvidence, settle, advisoryHolders } from './helpers/gpr2-native-pg';

/**
 * GPR-2 R05 corrective — the first independent review (GPT_REVIEW_20261024, findings R05-GPT-B01..B04) on NATIVE PostgreSQL (the isolated cluster
 * `gpr2-p1-isolated`, a fresh `gpr2_p1_*` database; never LIVE, never an inherited DATABASE_URL). Direct SQL is used on purpose: the findings are about
 * what PostgreSQL itself guarantees, not what the API happens to send.
 *   upgrade   the previous candidate's schema (029–032) WITH R05 data → 033: a row violating B03 makes 033 fail and leave nothing behind; without it 033
 *             applies, every protected and R05 row is byte-identical, the CHECK is validated, the ledger holds the file checksum, a re-run is a no-op;
 *   B01       a bound Work keeps tenant / object / WorkType / unit (incl. a CORPORATE-type Work moved to another object); a classified Work keeps its
 *             object; R04 planning completion and start still run on a bound Work; the bind ↔ update race in both orders, READ COMMITTED and
 *             REPEATABLE READ, each second session PROVED blocked before the first finishes; a refused statement rolls the whole transaction back;
 *   B02       template_id / finish_type_id / object_id / source_template_version_id cannot change at publication (or before it); no version is inserted
 *             PUBLISHED; broken provenance (written with triggers off) is refused at publication; publication vs a late child insert; published = frozen;
 *   B03       OBJECT WorkType without origin refused on INSERT and (CHECK alone) on UPDATE; a valid object type and a promotion keep their provenance;
 *   B04       parent 1000 / child 600 is refused by confirm with the uncovered 400 named; 600 + 500 is refused by PostgreSQL; 600 + 400 confirms; a stale
 *             fingerprint is refused after the coverage changes; two concurrent confirms of an incompletely covered parent both refuse and write nothing.
 * Every race is staged with a barrier PostgreSQL reports (a waiting lock), never with a sleep.
 */
scrubConnectionEnvironment();

test('R05 corrective on native PostgreSQL: 033 upgrade, B01 bound-Work identity + races, B02 version identity, B03 origin, B04 coverage', async () => {
  const db = await createIsolatedDatabase('r05corr');
  process.env.DATABASE_URL = db.url;
  const { pool, one, transaction } = await import('../apps/backend/src/db');
  const { migrate, planMigrationsOnDatabase } = await import('../scripts/migrate') as any;
  const { checksumOf, destructiveStatements } = await import('../scripts/migration-runner');
  const { seed } = await import('../scripts/seed');
  const { runGpr2Command } = await import('../apps/backend/src/gpr2-command-guard');
  const { R05_HOOKS } = await import('../apps/backend/src/gpr2-r05-hooks');
  const { ProductionService } = await import('../apps/backend/src/service');
  const { coordinationKey } = await import('../apps/backend/src/coordination-lock');
  const { endpointById } = await import('../packages/domain/gpr2');
  void transaction;
  const observer = await Session.open(db.url, 'r05c-observer');
  const evidence: Record<string, any> = { cluster: db.evidence, database: db.name };
  const count = async (sql: string, args: any[] = []) => Number((await pool.query(sql, args)).rows[0].n);
  const digest = async (sql: string) => (await pool.query(`SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS d, count(*)::int AS n FROM (${sql}) t`)).rows[0];
  /** Runs one statement in its own transaction and rolls it back: { ok } or the refusal (SQLSTATE, constraint, message head). */
  const attempt = async (sql: string, args: any[] = []) => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      try { const r = await c.query(sql, args); return { ok: true as const, rowCount: r.rowCount }; }
      catch (e: any) { return { ok: false as const, code: e.code as string, constraint: e.constraint as string | undefined, message: String(e.message).slice(0, 140) }; }
      finally { await c.query('ROLLBACK'); }
    } finally { c.release(); }
  };
  const refused = async (label: string, sql: string, args: any[], re: RegExp, sink: Record<string, unknown>) => {
    const r = await attempt(sql, args);
    assert.equal(r.ok, false, label + ' must be refused');
    assert.match((r as any).code + ' ' + ((r as any).constraint ?? '') + ' ' + (r as any).message, re, label);
    sink[label] = r;
  };
  try {
    // ================================================================ the previous candidate's schema (through 032) with R05 data
    await migrate({ through: 32 }); await seed();
    const pm = await one(pool, "SELECT * FROM users WHERE role='PROJECT_MANAGER' AND is_active=true ORDER BY created_at LIMIT 1");
    const admin = await one(pool, "SELECT * FROM users WHERE tenant_id=$1 AND role='ADMIN' LIMIT 1", [pm.tenantId]);
    const object = await one(pool, 'SELECT * FROM objects WHERE project_manager_id=$1 ORDER BY created_at LIMIT 1', [pm.id]);
    const other = await one(pool, 'SELECT * FROM objects WHERE tenant_id=$1 AND id<>$2 ORDER BY created_at LIMIT 1', [pm.tenantId, object.id]);
    const category = await one(pool, 'SELECT id FROM work_categories WHERE tenant_id=$1 LIMIT 1', [pm.tenantId]);
    const T: Record<string, string> = {};
    for (const [k, name, unit] of [['plaster', 'Штукатурка', 'м²'], ['paint', 'Покраска', 'м²'], ['screed', 'Стяжка', 'м³']])
      T[k] = (await one(pool, 'INSERT INTO work_types(tenant_id,category_id,name,unit) VALUES($1,$2,$3,$4) RETURNING id', [pm.tenantId, category.id, name, unit])).id;
    const run = (id: string, params: Record<string, string>, body: unknown, key: string | null = randomUUID(), actor = pm) =>
      runGpr2Command(endpointById(id)!, { actor, params: { objectId: object.id, ...params }, headers: key ? { 'idempotency-key': key } : {}, body }, R05_HOOKS) as Promise<any>;
    const area = async (payload: any) => (await run('area-scope.create', {}, { payload })).resultIds[0] as string;
    const st = (k: string, pos: number, wt: string) => ({ occurrenceKey: k, position: pos, workTypeId: wt, required: true, measureScope: 'MAIN', measureUnit: 'м²' });
    const R0 = await area({ kind: 'ZONE', code: 'C-R0', name: 'Зона', measureQuantity: '10', measureUnit: 'м²' });
    const sys = await run('finish-system.upsert', {}, { payload: { finishType: { code: 'C-T1', name: 'Тип №1' }, stages: [st('PLASTER', 1, T.plaster)] } });
    const [ft, sv] = sys.resultIds as string[];
    const previewOf = async (areaScopeIds: string[]) => (await run('finish-system.preview', { id: ft }, { expectedVersion: '1', payload: { systemVersionId: sv, areaScopeIds } }, null)).preview;
    const confirmBody = (p: any, areaScopeIds: string[]) => ({ expectedVersion: '1', expectedScopeVersion: p.scopeVersion, payload: { systemVersionId: sv, areaScopeIds, previewFingerprint: p.previewFingerprint, expectedSourceVersions: { systemVersion: sv } } });
    const p0 = await previewOf([R0]);
    const bound = (await run('finish-system.confirm', { id: ft }, confirmBody(p0, [R0]))).resultIds[0] as string;
    const historical = await one(pool, 'SELECT w.* FROM works w WHERE w.tenant_id=$1 AND w.object_id=$2 AND NOT EXISTS (SELECT 1 FROM work_scope_bindings b WHERE b.work_id=w.id) ORDER BY w.created_at LIMIT 1', [pm.tenantId, object.id]);
    const classifySql = "INSERT INTO legacy_work_classifications(tenant_id,object_id,work_id,classification,evidence,basis,recorded_by) VALUES($1,$2,$3,'UNKNOWN','{}'::jsonb,'проверка',$4)";
    await pool.query(classifySql, [pm.tenantId, object.id, historical.id, pm.id]);
    const tpl1 = await run('finish-template.draft', {}, { payload: { code: 'C-TPL1', name: 'Шаблон', stages: [st('PLASTER', 1, T.plaster), st('PAINT', 2, T.paint)] } }, randomUUID(), admin);
    const [tpl1Id, tv1] = tpl1.resultIds as string[];
    await run('finish-template.publish', { id: tpl1Id }, { expectedVersion: '1', payload: { templateVersionId: tv1 } }, randomUUID(), admin);
    const objType = (await run('work-type.create', {}, { payload: { name: 'Объектная', categoryId: category.id, unit: 'м²', requiresInspection: true, requiresExecutiveDocs: true, requiresMaterials: false } })).resultIds[0] as string;

    const PROTECTED: Record<string, string> = {
      works: 'SELECT row_to_json(x)::text FROM works x', weu: 'SELECT row_to_json(x)::text FROM work_execution_units x', portions: 'SELECT row_to_json(x)::text FROM quantity_portions x',
      confirmations: 'SELECT row_to_json(x)::text FROM portion_quantity_confirmations x', progress: 'SELECT row_to_json(x)::text FROM work_progress x', workTypes: 'SELECT row_to_json(x)::text FROM work_types x',
      bindings: 'SELECT row_to_json(x)::text FROM work_scope_bindings x', scopeState: 'SELECT row_to_json(x)::text FROM work_scope_state x', classifications: 'SELECT row_to_json(x)::text FROM legacy_work_classifications x',
      templateVersions: 'SELECT row_to_json(x)::text FROM finish_template_versions x', templateStages: 'SELECT row_to_json(x)::text FROM finish_template_stages x',
      systemVersions: 'SELECT row_to_json(x)::text FROM object_finish_system_versions x', occurrences: 'SELECT row_to_json(x)::text FROM finish_stage_occurrences x',
      areas: 'SELECT row_to_json(x)::text FROM object_area_scopes x', ledger: 'SELECT row_to_json(x)::text FROM gpr2_command_ledger x',
      migrationsThrough32: 'SELECT row_to_json(x)::text FROM schema_migrations x WHERE version <= 32'
    };
    const snap = async () => Object.fromEntries(await Promise.all(Object.entries(PROTECTED).map(async ([k, sql]) => [k, await digest(sql)])));
    const before = await snap();
    const file033 = fs.readFileSync('infra/033_gpr2_r05_corrective.sql', 'utf8');
    assert.deepEqual(destructiveStatements(file033), [], '033 passes the additive scan');
    const plan = await planMigrationsOnDatabase();
    assert.deepEqual(plan.pending.map((p: any) => [p.version, p.class, p.checksum]), [[33, 'additive', checksumOf(file033)]]);

    // ---------------------------------------------------------------- a B03-violating row: 033 fails and leaves nothing
    const bad = (await one(pool, "INSERT INTO work_types(tenant_id,category_id,name,unit,scope,object_id,origin_object_id) VALUES($1,$2,'без происхождения','м²','OBJECT',$3,NULL) RETURNING id", [pm.tenantId, category.id, object.id])).id;
    const failed = await settle(migrate());
    assert.equal(failed.ok, false, '033 refuses to validate over an OBJECT WorkType without origin');
    const objectsOf033 = async () => ({
      ledger: await count('SELECT count(*)::int AS n FROM schema_migrations WHERE version=33'),
      constraint: await count("SELECT count(*)::int AS n FROM pg_constraint WHERE conname='work_types_object_origin_required'"),
      triggers: await count("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname IN ('gpr2_bound_work_identity_guard','gpr2_binding_work_lock','gpr2_classification_work_lock','gpr2_template_version_identity_guard','gpr2_system_version_identity_guard','gpr2_system_version_publish_provenance')"),
      functions: await count("SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('gpr2_bound_work_identity_guard','gpr2_binding_work_lock','gpr2_classification_work_lock','gpr2_template_version_identity_guard','gpr2_system_version_identity_guard','gpr2_system_version_publish_provenance')")
    });
    assert.deepEqual(await objectsOf033(), { ledger: 0, constraint: 0, triggers: 0, functions: 0 }, 'the failed run left no ledger row, constraint, trigger or function');
    await pool.query('DELETE FROM work_types WHERE id=$1', [bad]); // test fixture cleanup (the row this test inserted); no migration deletes anything
    assert.deepEqual(await snap(), before, 'the failed run changed no row');
    evidence.upgradeFailureRollsBack = { sqlstate: (failed as any).error.code, message: String((failed as any).error.message).slice(0, 160), leftBehind: { ledger: 0, constraint: 0, triggers: 0, functions: 0 }, rowsUnchanged: true };

    // ---------------------------------------------------------------- 032 → 033
    const applied = await migrate();
    assert.deepEqual(applied.applied.map((a: any) => a.version), [33]);
    assert.deepEqual(await snap(), before, 'no protected or R05 row changed by 033');
    const ledger33 = await one(pool, 'SELECT version, checksum, migration_class FROM schema_migrations WHERE version=33');
    assert.equal(ledger33.checksum, checksumOf(file033)); assert.equal(ledger33.migrationClass, 'additive');
    assert.equal(await count("SELECT count(*)::int AS n FROM pg_constraint WHERE conname='work_types_object_origin_required' AND convalidated"), 1, 'the B03 CHECK is VALIDATED');
    assert.deepEqual(await objectsOf033(), { ledger: 1, constraint: 1, triggers: 6, functions: 6 });
    assert.equal((await migrate()).applied.length, 0, 're-run is a no-op');
    evidence.upgrade = {
      from: 32, fromState: 'previous candidate schema 029–032 with R05 data (bound Work, classification, published template, object WorkType)', applied: [33],
      ledger: ledger33, checksumMatchesFile: true, rowsUnchanged: Object.keys(PROTECTED), digests: before, checkValidated: true, rerunNoop: true, additiveScan: []
    };

    // ================================================================ B01
    const b01: Record<string, unknown> = {};
    const workRow = 'SELECT row_to_json(w)::text AS r FROM works w WHERE id=$1';
    const scopeOf = async (o: string) => (await pool.query('SELECT scope_version::text AS v FROM work_scope_state WHERE tenant_id=$1 AND object_id=$2', [pm.tenantId, o])).rows[0]?.v ?? '0';
    const boundBefore = (await one(pool, workRow, [bound])).r, scopeBefore = await scopeOf(object.id);
    await refused('unit', "UPDATE works SET unit='м³' WHERE id=$1", [bound], /GPR2_R05:IDENTITY_IMMUTABLE/, b01);
    await refused('workType', 'UPDATE works SET work_type_id=$2 WHERE id=$1', [bound, T.paint], /GPR2_R05:IDENTITY_IMMUTABLE/, b01);
    await refused('workTypeAndUnitTogether', "UPDATE works SET work_type_id=$2, unit='м³' WHERE id=$1", [bound, T.screed], /GPR2_R05:IDENTITY_IMMUTABLE/, b01);
    await refused('objectSameTenantCorporateType', 'UPDATE works SET object_id=$2 WHERE id=$1', [bound, other.id], /GPR2_R05:IDENTITY_IMMUTABLE/, b01);
    await refused('tenant', 'UPDATE works SET tenant_id=$2 WHERE id=$1', [bound, randomUUID()], /GPR2_R05:IDENTITY_IMMUTABLE|23503/, b01);
    await refused('classifiedWorkObject', 'UPDATE works SET object_id=$2 WHERE id=$1', [historical.id, other.id], /GPR2_R05:IDENTITY_IMMUTABLE/, b01);
    assert.equal((await one(pool, workRow, [bound])).r, boundBefore, 'the bound Work is unchanged');
    assert.equal(await scopeOf(object.id), scopeBefore, 'a refused change moved no scope version');
    // not over-blocking: an unbound, unclassified Work may still change identity — and that moves both objects' scope versions
    const freshWork = async (wt = T.plaster, unit = 'м²') => (await one(pool, "INSERT INTO works(tenant_id,object_id,work_type_id,name,unit,planned_quantity) VALUES($1,$2,$3,'корр','" + unit + "',1) RETURNING id", [pm.tenantId, object.id, wt])).id as string;
    {
      const w = await freshWork();
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const s0 = [await scopeOf(object.id), await scopeOf(other.id)];
        await c.query('UPDATE works SET object_id=$2 WHERE id=$1', [w, other.id]);
        const s1 = (await c.query('SELECT object_id::text AS o, scope_version::text AS v FROM work_scope_state WHERE tenant_id=$1 AND object_id = ANY($2::uuid[])', [pm.tenantId, [object.id, other.id]])).rows;
        await c.query('ROLLBACK');
        const v = (o: string) => s1.find((r: any) => r.o === o)?.v;
        assert.equal(BigInt(v(object.id)), BigInt(s0[0]) + 1n); assert.equal(BigInt(v(other.id)), BigInt(s0[1]) + 1n);
        b01.unboundWorkMayMove = { allowed: true, scopeVersionsMoved: { from: [s0[0], v(object.id)], to: [s0[1], v(other.id)] } };
      } finally { c.release(); }
    }
    // R04 planning completion and start still run on a bound Work (no identity column written → no guard fires)
    {
      const contractor = await one(pool, 'SELECT contractor_id FROM object_contractors_active WHERE tenant_id=$1 AND object_id=$2 LIMIT 1', [pm.tenantId, object.id]);
      const row = await one(pool, 'SELECT * FROM works WHERE id=$1', [bound]);
      const scopeBeforePlanning = await scopeOf(object.id); // (freshWork() above inserted a Work: an INSERT moves the scope version, as since 032)
      const svc = new ProductionService();
      const planned = await svc.completeWorkPlanning(pm, bound, { contractorId: contractor.contractorId, responsibleUserId: pm.id, version: row.version, idempotencyKey: randomUUID() });
      assert.equal(planned.id, bound);
      const started = await svc.start(pm, bound, planned.version);
      assert.equal(started.status, 'ACTIVE');
      assert.equal(await count('SELECT count(*)::int AS n FROM work_scope_bindings WHERE work_id=$1', [bound]), 1, 'the binding is unchanged');
      assert.equal(await scopeOf(object.id), scopeBeforePlanning, 'planning and start are not identity changes');
      b01.r04PlanningAndStartOnBoundWork = { planned: true, started: started.status, bindingUnchanged: true, scopeVersionUnchanged: true };
    }
    // the bind ↔ update races
    const occId = (await one(pool, "SELECT id FROM finish_stage_occurrences WHERE system_version_id=$1 AND occurrence_key='PLASTER'", [sv])).id;
    const bindSql = `INSERT INTO work_scope_bindings(tenant_id,object_id,work_id,finish_type_id,system_version_id,occurrence_id,occurrence_key,area_scope_id,measure_scope,basis_quantity,command_id,created_by)
      VALUES($1,$2,$3,$4,$5,$6,'PLASTER',$7,'MAIN',1,$8,$9)`;
    let zone = 0;
    const freshArea = async () => area({ kind: 'ZONE', code: 'C-Z' + (++zone), name: 'Зона ' + zone, measureQuantity: '5', measureUnit: 'м²' });
    const bindArgs = (work: string, areaId: string) => [pm.tenantId, object.id, work, ft, sv, occId, areaId, randomUUID(), pm.id];
    const describe = (r: any) => r.ok ? 'OK' : (r.error.code + ' ' + String(r.error.message).slice(0, 90));
    const race = async (label: string, opts: { first: 'bind' | 'update' | 'classify'; firstOutcome: 'commit' | 'rollback'; isolation?: string; update: [string, (w: string) => any[]]; expect: RegExp | null }) => {
      const w = await freshWork(), a = await freshArea();
      const s1 = await Session.open(db.url, 'r05c-' + label + '-1'), s2 = await Session.open(db.url, 'r05c-' + label + '-2');
      try {
        const iso = opts.isolation ?? 'READ COMMITTED';
        await s2.begin(iso);
        await s2.query('SELECT count(*) FROM works'); // the second session's snapshot exists BEFORE the first one commits (matters for REPEATABLE READ)
        await s1.begin();
        let second: Promise<any>;
        if (opts.first === 'bind' || opts.first === 'classify') {
          if (opts.first === 'bind') await s1.query(bindSql, bindArgs(w, a)); else await s1.query(classifySql, [pm.tenantId, object.id, w, pm.id]);
          second = settle(s2.query(opts.update[0], opts.update[1](w)));
        } else {
          await s1.query(opts.update[0], opts.update[1](w));
          second = settle(s2.query(bindSql, bindArgs(w, a)));
        }
        await waitUntilBlocked(observer.client, s2.pid, label + ': the second session');
        if (opts.firstOutcome === 'commit') await s1.commit(); else await s1.rollback();
        const r = await second;
        if (opts.expect) { assert.equal(r.ok, false, label + ' must be refused'); assert.match(r.error.code + ' ' + r.error.message, opts.expect, label); await s2.rollback(); }
        else { assert.equal(r.ok, true, label + ': ' + describe(r)); await s2.commit(); }
        const bindings = await count('SELECT count(*)::int AS n FROM work_scope_bindings WHERE work_id=$1', [w]);
        const work = await one(pool, 'SELECT object_id, work_type_id, unit FROM works WHERE id=$1', [w]);
        return { label, isolation: iso, first: opts.first, firstOutcome: opts.firstOutcome, secondObservedBlocked: true, second: describe(r), bindingsAfter: bindings, workAfter: work };
      } finally { await s1.close(); await s2.close(); }
    };
    const toCubic: [string, (w: string) => any[]] = ["UPDATE works SET unit='м³' WHERE id=$1", w => [w]];
    const toPaint: [string, (w: string) => any[]] = ['UPDATE works SET work_type_id=$2 WHERE id=$1', w => [w, T.paint]];
    const toOther: [string, (w: string) => any[]] = ['UPDATE works SET object_id=$2 WHERE id=$1', w => [w, other.id]];
    const races: any[] = [];
    races.push(await race('update-first-commit', { first: 'update', firstOutcome: 'commit', update: toCubic, expect: /GPR2_R05:INVALID_MEASUREMENT/ }));
    races.push(await race('update-first-rollback', { first: 'update', firstOutcome: 'rollback', update: toCubic, expect: null }));
    races.push(await race('update-first-object-commit', { first: 'update', firstOutcome: 'commit', update: toOther, expect: /GPR2_R05:CROSS_SCOPE_REFERENCE/ }));
    races.push(await race('bind-first-commit', { first: 'bind', firstOutcome: 'commit', update: toPaint, expect: /GPR2_R05:IDENTITY_IMMUTABLE/ }));
    races.push(await race('bind-first-rollback', { first: 'bind', firstOutcome: 'rollback', update: toPaint, expect: null }));
    races.push(await race('bind-first-repeatable-read', { first: 'bind', firstOutcome: 'commit', isolation: 'REPEATABLE READ', update: toCubic, expect: /^40001 / }));
    races.push(await race('update-first-repeatable-read', { first: 'update', firstOutcome: 'commit', isolation: 'REPEATABLE READ', update: toCubic, expect: /^40001 |GPR2_R05:INVALID_MEASUREMENT/ }));
    races.push(await race('classify-first-commit', { first: 'classify', firstOutcome: 'commit', update: toOther, expect: /GPR2_R05:IDENTITY_IMMUTABLE/ }));
    races.push(await race('classify-first-repeatable-read', { first: 'classify', firstOutcome: 'commit', isolation: 'REPEATABLE READ', update: toOther, expect: /^40001 / }));
    for (const r of races) {
      const refusedSecond = r.second !== 'OK';
      if (r.first === 'update' && refusedSecond) assert.equal(r.bindingsAfter, 0, r.label + ': no binding to a changed Work');
      if (r.first === 'bind' && refusedSecond) { assert.equal(r.bindingsAfter, 1); assert.deepEqual([r.workAfter.workTypeId, r.workAfter.unit], [T.plaster, 'м²'], r.label + ': the bound Work kept its identity'); }
      if (r.first === 'classify' && refusedSecond) assert.equal(r.workAfter.objectId, object.id, r.label);
    }
    b01.races = races;
    // a refused identity change aborts the whole transaction: the binding made earlier in it is gone too
    {
      const w = await freshWork(), a = await freshArea();
      const s0 = await scopeOf(object.id);
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query(bindSql, bindArgs(w, a));
        await assert.rejects(c.query("UPDATE works SET unit='м³' WHERE id=$1", [w]), /GPR2_R05:IDENTITY_IMMUTABLE/);
        await c.query('ROLLBACK');
      } finally { c.release(); }
      assert.equal(await count('SELECT count(*)::int AS n FROM work_scope_bindings WHERE work_id=$1', [w]), 0);
      assert.equal(await scopeOf(object.id), s0);
      b01.fullRollback = { bindingGone: true, scopeVersionUnchanged: true };
    }
    evidence.B01 = b01;

    // ================================================================ B02
    const b02: Record<string, unknown> = {};
    const tpl2 = await run('finish-template.draft', {}, { payload: { code: 'C-TPL2', name: 'Шаблон 2', stages: [st('PAINT', 1, T.paint)] } }, randomUUID(), admin);
    const [tpl2Id, tv2] = tpl2.resultIds as string[];
    const emptyTpl = (await one(pool, "INSERT INTO finish_templates(tenant_id,code,name,created_by) VALUES($1,'C-TPL-EMPTY','Пустой',$2) RETURNING id", [pm.tenantId, admin.id])).id;
    const publishTv = "UPDATE finish_template_versions SET state='PUBLISHED', content_hash=repeat('a',64), published_by=$2, published_at=now()";
    await refused('templatePublishRetargetTemplateId', publishTv + ', template_id=$3 WHERE id=$1', [tv2, admin.id, emptyTpl], /GPR2_R05:VERSION_IMMUTABLE/, b02);
    await refused('templateDraftRetargetTemplateId', 'UPDATE finish_template_versions SET template_id=$2 WHERE id=$1', [tv2, emptyTpl], /GPR2_R05:VERSION_IMMUTABLE/, b02);
    await refused('templateInsertPublished', "INSERT INTO finish_template_versions(tenant_id,template_id,version_number,state,content_hash,published_by,published_at,created_by) VALUES($1,$2,9,'PUBLISHED',repeat('b',64),$3,now(),$3)", [pm.tenantId, tpl2Id, admin.id], /GPR2_R05:VERSION_IMMUTABLE/, b02);
    await refused('templatePublishedRemodify', "UPDATE finish_template_versions SET content_hash=repeat('d',64) WHERE id=$1", [tv1], /GPR2_R05:VERSION_IMMUTABLE/, b02);
    await refused('templatePublishedStageInsert', "INSERT INTO finish_template_stages(tenant_id,template_version_id,occurrence_key,position,work_type_id,required,measure_scope,measure_unit) VALUES($1,$2,'LATE',9,$3,true,'MAIN','м²')", [pm.tenantId, tv1, T.paint], /GPR2_R05:VERSION_IMMUTABLE/, b02);
    await refused('templatePublishedRemove', 'DELETE FROM finish_template_versions WHERE id=$1', [tv1], /GPR2_R05:VERSION_IMMUTABLE/, b02);
    await run('finish-template.publish', { id: tpl2Id }, { expectedVersion: '1', payload: { templateVersionId: tv2 } }, randomUUID(), admin);
    b02.templateNormalPublication = 'OK';
    // an object draft from tv1 (PLASTER, PAINT) that inherits PLASTER only
    const newFt = async (code: string, o = object.id) => (await one(pool, "INSERT INTO object_finish_types(tenant_id,object_id,code,name,created_by) VALUES($1,$2,$3,'x',$4) RETURNING id", [pm.tenantId, o, code, pm.id])).id as string;
    const ft2 = await newFt('C-T2'), ft3 = await newFt('C-T3'), ftOther = await newFt('C-T-OTHER', other.id);
    const draft = (await one(pool, 'INSERT INTO object_finish_system_versions(tenant_id,object_id,finish_type_id,version_number,source_template_version_id,created_by) VALUES($1,$2,$3,1,$4,$5) RETURNING id', [pm.tenantId, object.id, ft2, tv1, pm.id])).id;
    const stageOf = async (tv: string, k: string) => one(pool, 'SELECT * FROM finish_template_stages WHERE template_version_id=$1 AND occurrence_key=$2', [tv, k]);
    const plasterStage = await stageOf(tv1, 'PLASTER'), paintStage = await stageOf(tv1, 'PAINT'), tv2Paint = await stageOf(tv2, 'PAINT');
    const occSql = `INSERT INTO finish_stage_occurrences(tenant_id,object_id,system_version_id,occurrence_key,position,work_type_id,required,measure_scope,measure_unit,source_template_version_id,source_template_stage_id,override_kind,override_reason)
      VALUES($1,$2,$3,$4,$5,$6,true,'MAIN','м²',$7,$8,$9,$10)`;
    await pool.query(occSql, [pm.tenantId, object.id, draft, 'PLASTER', 1, T.plaster, tv1, plasterStage.id, 'INHERITED', null]);
    const publishSv = "UPDATE object_finish_system_versions SET state='PUBLISHED', content_hash=repeat('c',64), published_by=$2, published_at=now()";
    await refused('systemPublishIncompleteCoverageControl', publishSv + ' WHERE id=$1', [draft, pm.id], /GPR2_R05:MISSING_REQUIRED_DATA/, b02);
    // coverage completed by an explicit exclusion: from here the draft WOULD publish, so each refusal below is the identity guard's
    await pool.query('INSERT INTO finish_stage_exclusions(tenant_id,object_id,system_version_id,source_template_version_id,template_stage_id,reason) VALUES($1,$2,$3,$4,$5,$6)', [pm.tenantId, object.id, draft, tv1, paintStage.id, 'покраска не нужна']);
    await refused('systemPublishNullingSource', publishSv + ', source_template_version_id=NULL WHERE id=$1', [draft, pm.id], /GPR2_R05:VERSION_IMMUTABLE/, b02);
    // (031's coverage check fires before 033's identity guard — triggers run in name order — so a swap to an uncovered source is refused as
    // MISSING_REQUIRED_DATA; either way the statement is refused, and the identity guard refuses it whatever the new source's coverage)
    await refused('systemPublishSwappingSource', publishSv + ', source_template_version_id=$3 WHERE id=$1', [draft, pm.id, tv2], /GPR2_R05:(VERSION_IMMUTABLE|MISSING_REQUIRED_DATA)/, b02);
    await refused('systemDraftSwappingSourceOnly', 'UPDATE object_finish_system_versions SET source_template_version_id=$2 WHERE id=$1', [draft, tv2], /GPR2_R05:VERSION_IMMUTABLE/, b02);
    await refused('systemDraftNullingSourceOnly', 'UPDATE object_finish_system_versions SET source_template_version_id=NULL WHERE id=$1', [draft], /GPR2_R05:VERSION_IMMUTABLE/, b02);
    await refused('systemPublishRetargetFinishType', publishSv + ', finish_type_id=$3, source_template_version_id=NULL WHERE id=$1', [draft, pm.id, ft3], /GPR2_R05:VERSION_IMMUTABLE/, b02);
    await refused('systemPublishRetargetObject', publishSv + ', object_id=$3, finish_type_id=$4 WHERE id=$1', [draft, pm.id, other.id, ftOther], /GPR2_R05:VERSION_IMMUTABLE/, b02);
    await refused('systemInsertPublished', "INSERT INTO object_finish_system_versions(tenant_id,object_id,finish_type_id,version_number,state,content_hash,published_by,published_at,created_by) VALUES($1,$2,$3,5,'PUBLISHED',repeat('e',64),$4,now(),$4)", [pm.tenantId, object.id, ft3, pm.id], /GPR2_R05:VERSION_IMMUTABLE/, b02);
    // provenance broken behind the triggers' back is still refused at publication
    const behindTriggers = async (label: string, tamper: (s: Session) => Promise<unknown>) => {
      const s = await Session.open(db.url, 'r05c-' + label);
      try {
        await s.begin();
        await s.query("SET LOCAL session_replication_role = 'replica'"); await tamper(s); await s.query("SET LOCAL session_replication_role = 'origin'");
        const r = await settle(s.query(publishSv + ' WHERE id=$1', [draft, pm.id]));
        await s.rollback();
        assert.equal(r.ok, false, label); assert.match((r as any).error.message, /GPR2_R05:PROVENANCE_MISMATCH/, label);
        b02[label] = { refused: 'PROVENANCE_MISMATCH', message: String((r as any).error.message).slice(0, 120) };
      } finally { await s.close(); }
    };
    await behindTriggers('brokenProvenanceForeignSource', s => s.query(occSql, [pm.tenantId, object.id, draft, 'EXTRA', 5, T.paint, tv2, tv2Paint.id, 'OVERRIDDEN', 'чужой источник']));
    await behindTriggers('brokenProvenanceInheritedNotACopy', s => s.query("UPDATE finish_stage_occurrences SET position=7 WHERE system_version_id=$1 AND occurrence_key='PLASTER'", [draft]));
    const okPublish = await attempt(publishSv + ' WHERE id=$1', [draft, pm.id]);
    assert.equal(okPublish.ok, true, 'a correct draft still publishes: ' + JSON.stringify(okPublish));
    await pool.query(publishSv + ' WHERE id=$1', [draft, pm.id]);
    await refused('systemPublishedRemodify', "UPDATE object_finish_system_versions SET content_hash=repeat('f',64) WHERE id=$1", [draft], /GPR2_R05:VERSION_IMMUTABLE/, b02);
    await refused('systemPublishedOccurrenceInsert', occSql, [pm.tenantId, object.id, draft, 'LATE', 9, T.paint, null, null, 'ADDED_LOCAL', null], /GPR2_R05:VERSION_IMMUTABLE/, b02);
    // publication races a late child insert (template stage, object occurrence): the insert waits, then sees PUBLISHED and is refused
    const publishRace = async (label: string, publishSql: string, publishArgs: any[], insertSql: string, insertArgs: any[]) => {
      const s1 = await Session.open(db.url, 'r05c-' + label + '-pub'), s2 = await Session.open(db.url, 'r05c-' + label + '-ins');
      try {
        await s1.begin(); await s1.query(publishSql, publishArgs);
        await s2.begin();
        const late = settle(s2.query(insertSql, insertArgs));
        await waitUntilBlocked(observer.client, s2.pid, label + ': the late insert');
        await s1.commit();
        const r = await late; await s2.rollback();
        assert.equal(r.ok, false, label); assert.match((r as any).error.message, /GPR2_R05:VERSION_IMMUTABLE/, label);
        return { lateInsertObservedBlocked: true, lateInsertRefused: 'VERSION_IMMUTABLE' };
      } finally { await s1.close(); await s2.close(); }
    };
    const tpl3 = await run('finish-template.draft', {}, { payload: { code: 'C-TPL3', name: 'Шаблон 3', stages: [st('PAINT', 1, T.paint)] } }, randomUUID(), admin);
    b02.templatePublicationRace = await publishRace('tpl-race', publishTv + ' WHERE id=$1', [tpl3.resultIds[1], admin.id],
      "INSERT INTO finish_template_stages(tenant_id,template_version_id,occurrence_key,position,work_type_id,required,measure_scope,measure_unit) VALUES($1,$2,'LATE',2,$3,true,'MAIN','м²')", [pm.tenantId, tpl3.resultIds[1], T.paint]);
    const ft4 = await newFt('C-T4');
    const draft4 = (await one(pool, 'INSERT INTO object_finish_system_versions(tenant_id,object_id,finish_type_id,version_number,created_by) VALUES($1,$2,$3,1,$4) RETURNING id', [pm.tenantId, object.id, ft4, pm.id])).id;
    await pool.query(occSql, [pm.tenantId, object.id, draft4, 'PAINT', 1, T.paint, null, null, 'ADDED_LOCAL', null]);
    b02.systemPublicationRace = await publishRace('sys-race', publishSv + ' WHERE id=$1', [draft4, pm.id], occSql, [pm.tenantId, object.id, draft4, 'LATE', 2, T.paint, null, null, 'ADDED_LOCAL', null]);
    evidence.B02 = b02;

    // ================================================================ B03
    const b03: Record<string, unknown> = {};
    await refused('insertObjectTypeWithoutOrigin', "INSERT INTO work_types(tenant_id,category_id,name,unit,scope,object_id,origin_object_id) VALUES($1,$2,'x','м²','OBJECT',$3,NULL)", [pm.tenantId, category.id, object.id], /23514 work_types_object_origin_required/, b03);
    await refused('insertObjectTypeForeignOrigin', "INSERT INTO work_types(tenant_id,category_id,name,unit,scope,object_id,origin_object_id) VALUES($1,$2,'x','м²','OBJECT',$3,$4)", [pm.tenantId, category.id, object.id, other.id], /23514/, b03);
    await refused('updateNullingOrigin', 'UPDATE work_types SET origin_object_id=NULL WHERE id=$1', [objType], /GPR2_R05:IDENTITY_IMMUTABLE|23514/, b03);
    {
      // the CHECK alone, with 029's identity trigger switched off for this one transaction (rolled back)
      const s = await Session.open(db.url, 'r05c-b03-check-only');
      try {
        await s.begin(); await s.query('ALTER TABLE work_types DISABLE TRIGGER gpr2_work_type_scope_guard');
        const r = await settle(s.query('UPDATE work_types SET origin_object_id=NULL WHERE id=$1', [objType]));
        await s.rollback();
        assert.equal(r.ok, false); assert.equal((r as any).error.code, '23514'); assert.equal((r as any).error.constraint, 'work_types_object_origin_required');
        b03.updateNullingOriginCheckAlone = { sqlstate: '23514', constraint: 'work_types_object_origin_required' };
      } finally { await s.close(); }
    }
    const valid = await attempt("INSERT INTO work_types(tenant_id,category_id,name,unit,scope,object_id,origin_object_id) VALUES($1,$2,'x','м²','OBJECT',$3,$3)", [pm.tenantId, category.id, object.id]);
    assert.equal(valid.ok, true); b03.validObjectTypeSql = 'OK';
    const t = await one(pool, 'SELECT scope, object_id, origin_object_id FROM work_types WHERE id=$1', [objType]);
    assert.deepEqual([t.scope, t.objectId, t.originObjectId], ['OBJECT', object.id, object.id]); b03.validObjectTypeApi = t;
    const req = (await run('work-type.publication.request', { id: objType }, { expectedVersion: '1', payload: { justification: 'для всех объектов' } })).resultIds[0];
    await runGpr2Command(endpointById('work-type.publication.approve')!, { actor: admin, params: { id: req }, headers: { 'idempotency-key': randomUUID() }, body: { expectedVersion: '1', payload: {} } }, R05_HOOKS);
    const promoted = await one(pool, 'SELECT scope, object_id, origin_object_id FROM work_types WHERE id=$1', [objType]);
    assert.deepEqual([promoted.scope, promoted.objectId, promoted.originObjectId], ['CORPORATE', null, object.id], 'promotion keeps the origin');
    b03.promotionKeepsProvenance = promoted;
    b03.existingCorporateTypesUnchanged = 'upgrade.digests.workTypes (every work_types row byte-identical across 033)';
    evidence.B03 = b03;

    // ================================================================ B04
    const b04: Record<string, unknown> = {};
    const writes = async () => [await count('SELECT count(*)::int AS n FROM works'), await count('SELECT count(*)::int AS n FROM work_scope_bindings'), await count("SELECT count(*)::int AS n FROM gpr2_command_ledger WHERE command_kind='finish-system.confirm'")];
    const X = await area({ kind: 'SECTION', code: 'C-X', name: 'Секция X', measureQuantity: '1000', measureUnit: 'м²' });
    const X1 = await area({ parentId: X, kind: 'FLOOR', code: 'C-X1', name: 'Этаж X1', measureQuantity: '600', measureUnit: 'м²' });
    const px = await previewOf([X]);
    assert.equal(px.canConfirm, false);
    assert.deepEqual(px.blockers.map((b: any) => [b.error, b.rule, b.areaScopeId]), [['MISSING_REQUIRED_DATA', 'AREA_COVERAGE_INCOMPLETE', X]]);
    assert.deepEqual(px.missingInputs, [{ kind: 'AREA_COVERAGE', occurrenceKey: 'PLASTER', areaScopeId: X, quantity: '400.0000', unit: 'м²' }]);
    assert.equal((await previewOf([X])).previewFingerprint, px.previewFingerprint, 'the same inputs → the same fingerprint');
    const w0 = await writes();
    const cx = await settle(run('finish-system.confirm', { id: ft }, confirmBody(px, [X])));
    assert.equal(cx.ok, false); assert.equal((cx as any).error.code, 'MISSING_REQUIRED_DATA');
    assert.deepEqual(await writes(), w0, 'the refused confirm wrote nothing');
    b04.parent1000Child600 = { preview: { canConfirm: false, blockers: px.blockers, missingInputs: px.missingInputs }, confirm: (cx as any).error.code, wroteNothing: true };
    const over = await settle(area({ parentId: X, kind: 'FLOOR', code: 'C-X2-500', name: 'Этаж 500', measureQuantity: '500', measureUnit: 'м²' }));
    assert.equal(over.ok, false); assert.equal((over as any).error.code, 'AREA_SCOPE_CONFLICT');
    b04.children600plus500 = { secondChildRefused: 'AREA_SCOPE_CONFLICT' };
    await area({ parentId: X, kind: 'FLOOR', code: 'C-X2', name: 'Этаж X2', measureQuantity: '400', measureUnit: 'м²' });
    const stale = await settle(run('finish-system.confirm', { id: ft }, confirmBody(px, [X])));
    assert.equal(stale.ok, false); assert.equal((stale as any).error.code, 'STALE_PREVIEW', 'the coverage changed → the old fingerprint is stale');
    const pxFull = await previewOf([X]);
    assert.deepEqual(pxFull.blockers, []); assert.notEqual(pxFull.previewFingerprint, px.previewFingerprint);
    assert.deepEqual(pxFull.proposedWorks.map((w: any) => w.quantity), ['1000.0000']);
    const done = await run('finish-system.confirm', { id: ft }, confirmBody(pxFull, [X]));
    assert.equal(done.resultIds.length, 1);
    b04.children600plus400 = { staleFingerprintRefused: 'STALE_PREVIEW', confirmed: done.resultIds, quantity: '1000.0000' };
    // two concurrent confirms of an incompletely covered parent: both proved waiting on the coordination lock, both refused, nothing written
    {
      const Y = await area({ kind: 'SECTION', code: 'C-Y', name: 'Секция Y', measureQuantity: '1000', measureUnit: 'м²' });
      await area({ parentId: Y, kind: 'FLOOR', code: 'C-Y1', name: 'Этаж Y1', measureQuantity: '600', measureUnit: 'м²' });
      const py = await previewOf([Y]);
      const key = coordinationKey(pm.tenantId, object.id);
      const waitingExclusive = async () => Number((await observer.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND mode='ExclusiveLock' AND NOT granted")).rows[0].n);
      const w1 = await writes();
      const blocker = await Session.open(db.url, 'r05c-shared-writer');
      await blocker.begin(); await blocker.query('SELECT pg_advisory_xact_lock_shared($1::bigint)', [key.toString()]);
      const a = settle(run('finish-system.confirm', { id: ft }, confirmBody(py, [Y])));
      const b = settle(run('finish-system.confirm', { id: ft }, confirmBody(py, [Y])));
      try { await until(async () => (await waitingExclusive()) >= 2, 'both confirms waiting for the EXCLUSIVE coordination lock'); }
      finally { await blocker.rollback(); await blocker.close(); }
      const rs = await Promise.all([a, b]);
      assert.deepEqual(rs.map((r: any) => r.ok ? 'OK' : r.error.code), ['MISSING_REQUIRED_DATA', 'MISSING_REQUIRED_DATA']);
      assert.deepEqual(await writes(), w1, 'neither confirm wrote a Work, a binding or a ledger row');
      assert.deepEqual(await advisoryHolders(observer.client, key), [], 'no coordination lock left held');
      b04.concurrentConfirmsIncompleteCoverage = { bothObservedWaiting: true, results: ['MISSING_REQUIRED_DATA', 'MISSING_REQUIRED_DATA'], wroteNothing: true };
    }
    evidence.B04 = b04;
    evidence.result = 'PASS';
  } finally {
    recordEvidence('r05-corrective-native-summary', evidence);
    await observer.close(); await pool.end(); await db.drop();
  }
});
