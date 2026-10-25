import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createIsolatedDatabase, scrubConnectionEnvironment, Session, until, waitUntilBlocked, recordEvidence, settle, advisoryHolders } from './helpers/gpr2-native-pg';

/**
 * GPR-2 R05 third corrective — R05-GPT-R3-B01 and the LOCAL-quantity case of GPT_REVIEW_20261025_R05_INDEPENDENT_CORRECTIVE, on NATIVE PostgreSQL
 * (isolated cluster `gpr2-p1-isolated`, a fresh `gpr2_p1_*` database; never LIVE).
 *   upgrade   034 schema with R05 data → 035; a database already holding a Work with MAIN and LOCAL bindings makes 035 fail and leave nothing behind;
 *   R3-B01    the reviewer's exact fixture by direct SQL: one Work, the same finish type / occurrence key / WorkType / unit, disjoint AreaScopes, version
 *             1 MAIN and version 2 LOCAL (and the reverse) — refused with SQLSTATE 23514 GPR2_R05:ONE_PRODUCER_CONFLICT; the SAME compatible operation
 *             over other AreaScopes, under the same or a later version, stays allowed; two-session races at READ COMMITTED and REPEATABLE READ, both
 *             orders, commit and rollback, each second session PROVED blocked;
 *   quantity  version 1 SAME_KEY LOCAL 20 → version 2 SAME_KEY LOCAL stated as 30 (same WorkType / unit): the 20 producer is NOT shown as satisfying 30 —
 *             blocker PRODUCER_QUANTITY_CHANGED, confirm 422, nothing written; stated as 20 → EXISTING; through the real command guard.
 */
scrubConnectionEnvironment();

test('R05 third corrective on native PostgreSQL: 035 upgrade, R3-B01 measure-scope operation identity (direct SQL + races), LOCAL quantity restatement', async () => {
  const db = await createIsolatedDatabase('r05r3');
  process.env.DATABASE_URL = db.url;
  const { pool, one } = await import('../apps/backend/src/db');
  const { migrate } = await import('../scripts/migrate') as any;
  const { checksumOf, destructiveStatements } = await import('../scripts/migration-runner');
  const { seed } = await import('../scripts/seed');
  const { runGpr2Command } = await import('../apps/backend/src/gpr2-command-guard');
  const { R05_HOOKS } = await import('../apps/backend/src/gpr2-r05-hooks');
  const { coordinationKey } = await import('../apps/backend/src/coordination-lock');
  const { endpointById } = await import('../packages/domain/gpr2');
  const observer = await Session.open(db.url, 'r05r3-observer');
  const evidence: Record<string, any> = { cluster: db.evidence, database: db.name };
  const count = async (sql: string, args: any[] = []) => Number((await pool.query(sql, args)).rows[0].n);
  const errText = (e: any) => (e?.code ?? '') + ' ' + String(e?.message ?? '').slice(0, 110);
  try {
    await migrate({ through: 34 }); await seed();
    const pm = await one(pool, "SELECT * FROM users WHERE role='PROJECT_MANAGER' AND is_active=true ORDER BY created_at LIMIT 1");
    const object = await one(pool, 'SELECT * FROM objects WHERE project_manager_id=$1 ORDER BY created_at LIMIT 1', [pm.id]);
    const category = await one(pool, 'SELECT id FROM work_categories WHERE tenant_id=$1 LIMIT 1', [pm.tenantId]);
    const T = pm.tenantId, O = object.id;
    let seq = 0;
    const code = (p: string) => p + '-' + (++seq);
    const X = (await one(pool, "INSERT INTO work_types(tenant_id,category_id,name,unit) VALUES($1,$2,'Тип X','м²') RETURNING id", [T, category.id])).id as string;
    const run = (id: string, params: Record<string, string>, body: unknown, key: string | null = randomUUID()) =>
      runGpr2Command(endpointById(id)!, { actor: pm, params: { objectId: O, ...params }, headers: key ? { 'idempotency-key': key } : {}, body }, R05_HOOKS) as Promise<any>;
    const area = async () => (await run('area-scope.create', {}, { payload: { kind: 'ZONE', code: code('Z'), name: 'Зона', measureQuantity: '50', measureUnit: 'м²' } })).resultIds[0] as string;
    const st = (scope: string, k = 'SAME_KEY', pos = 1) => ({ occurrenceKey: k, position: pos, workTypeId: X, required: true, measureScope: scope, measureUnit: 'м²' });
    const localOf = (a: string, q?: string) => q ? { localQuantities: [{ occurrenceKey: 'SAME_KEY', areaScopeId: a, quantity: q }] } : {};
    const preview = async (ft: string, sv: string, a: string, q?: string) => (await run('finish-system.preview', { id: ft }, { expectedVersion: '1', payload: { systemVersionId: sv, areaScopeIds: [a], ...localOf(a, q) } }, null)).preview;
    const confirmBody = (p: any, a: string, q?: string) => ({ expectedVersion: '1', expectedScopeVersion: p.scopeVersion,
      payload: { systemVersionId: p.systemVersionId, areaScopeIds: [a], ...localOf(a, q), previewFingerprint: p.previewFingerprint, expectedSourceVersions: { systemVersion: p.systemVersionId } } });
    /** version 1 with SAME_KEY in scope s1 confirmed over A (a real Early Work W); version 2 of the same finish type with SAME_KEY in scope s2. */
    const twoVersions = async (s1: string, s2: string, confirm = true) => {
      const A = await area();
      const v1 = await run('finish-system.upsert', {}, { payload: { finishType: { code: code('FT'), name: 'R3' }, stages: [st(s1)] } });
      const [ft, sv1] = v1.resultIds as string[];
      let W: string | null = null;
      if (confirm) {
        const q = s1 === 'LOCAL' ? '20' : undefined;
        const p1 = await preview(ft, sv1, A, q);
        W = (await run('finish-system.confirm', { id: ft }, confirmBody(p1, A, q))).resultIds[0];
      }
      const v2 = await run('finish-system.upsert', {}, { payload: { finishTypeId: ft, stages: [st(s2)] } });
      const sv2 = v2.resultIds[1] as string;
      const occOf = async (sv: string) => (await one(pool, "SELECT id FROM finish_stage_occurrences WHERE system_version_id=$1 AND occurrence_key='SAME_KEY'", [sv])).id as string;
      return { A, ft, sv1, sv2, occ1: await occOf(sv1), occ2: await occOf(sv2), W };
    };
    const bindSql = `INSERT INTO work_scope_bindings(tenant_id,object_id,work_id,finish_type_id,system_version_id,occurrence_id,occurrence_key,area_scope_id,measure_scope,basis_quantity,command_id,created_by)
      VALUES($1,$2,$3,$4,$5,$6,'SAME_KEY',$7,$8,10,$9,$10)`;
    const bind = (w: string, ft: string, sv: string, occ: string, a: string, scope: string): [string, any[]] => [bindSql, [T, O, w, ft, sv, occ, a, scope, randomUUID(), pm.id]];
    const attempt = async (q: [string, any[]]) => {
      const c = await pool.connect();
      try { await c.query('BEGIN'); try { await c.query(q[0], q[1]); return { ok: true as const }; } catch (e: any) { return { ok: false as const, sqlstate: e.code as string, message: String(e.message).slice(0, 140) }; } finally { await c.query('ROLLBACK'); } }
      finally { c.release(); }
    };

    // ================================================================ 034 (the previous candidate's schema) with R05 data → 035
    {
      const TABLES = ['works', 'work_execution_units', 'quantity_portions', 'portion_quantity_confirmations', 'work_progress', 'work_types', 'object_area_scopes', 'work_scope_bindings', 'work_scope_state',
        'work_scope_operations', 'work_type_reference_state', 'object_area_scope_child_revisions', 'finish_template_stages', 'finish_stage_occurrences', 'object_finish_system_versions', 'gpr2_command_ledger'];
      const snap = async () => Object.fromEntries(await Promise.all(TABLES.map(async t => [t, (await pool.query(`SELECT md5(coalesce(string_agg(row_to_json(x)::text, '|' ORDER BY row_to_json(x)::text), '')) AS d, count(*)::int AS n FROM ${t} x`)).rows[0]])));
      const objects035 = async () => ({ ledger: await count('SELECT count(*)::int AS n FROM schema_migrations WHERE version=35'),
        trigger: await count("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname='gpr2_binding_operation_semantics'"), fn: await count("SELECT count(*)::int AS n FROM pg_proc WHERE proname='gpr2_binding_operation_semantics'") });
      const file035 = fs.readFileSync('infra/035_gpr2_r05_operation_semantics.sql', 'utf8');
      assert.deepEqual(destructiveStatements(file035), [], '035 passes the additive scan');
      const sc = await twoVersions('MAIN', 'LOCAL');
      const B = await area();
      const before = await snap();
      // a database the gap let into the forbidden state (written with the triggers off): 035 refuses to apply and leaves nothing behind
      const tamper = await Session.open(db.url, 'r05r3-tamper');
      const bad = bind(sc.W!, sc.ft, sc.sv2, sc.occ2, B, 'LOCAL');
      await tamper.begin(); await tamper.query("SET LOCAL session_replication_role = 'replica'"); await tamper.query(bad[0], bad[1]); await tamper.commit();
      const failed: any = await settle(migrate());
      assert.equal(failed.ok, false); assert.match(failed.error.message, /GPR2_R05:PRECONDITION .*R3-B01/);
      assert.deepEqual(await objects035(), { ledger: 0, trigger: 0, fn: 0 }, 'the failed run left nothing');
      await tamper.begin(); await tamper.query("SET LOCAL session_replication_role = 'replica'");
      await tamper.query('DELETE FROM work_scope_bindings WHERE work_id=$1 AND area_scope_id=$2', [sc.W, B]); await tamper.commit(); await tamper.close(); // undo the fixture (test only)
      const applied = await migrate();
      assert.deepEqual(applied.applied.map((x: any) => x.version), [35]);
      const after = await snap();
      for (const t of TABLES) assert.deepEqual(after[t], before[t], t + ' unchanged by 035 (the tampered fixture row was removed again)');
      const ledger35 = await one(pool, 'SELECT version, checksum, migration_class FROM schema_migrations WHERE version=35');
      assert.equal(ledger35.checksum, checksumOf(file035)); assert.equal(ledger35.migrationClass, 'additive');
      assert.deepEqual(await objects035(), { ledger: 1, trigger: 1, fn: 1 });
      assert.equal((await migrate()).applied.length, 0, 're-run is a no-op');
      evidence.upgrade = { from: 34, fromState: 'previous candidate schema 029–034 with R05 data (two published versions, a confirmed Work)', applied: [35],
        preconditionRefusal: String(failed.error.message).slice(0, 160), failedRunLeftNothing: true, ledger: ledger35, checksumMatchesFile: true, unchanged: TABLES, rerunNoop: true, additiveScan: [] };
      // the bound Work of this upgrade scenario was bound under 034 (it HAS a claim row): the reviewer's second binding is now refused
      const r = await attempt(bind(sc.W!, sc.ft, sc.sv2, sc.occ2, await area(), 'LOCAL'));
      assert.equal(r.ok, false); assert.equal((r as any).sqlstate, '23514');
      evidence.upgrade.boundUnder034SecondScopeRefused = r;
    }

    // ================================================================ R3-B01 — the reviewer's exact fixture by direct SQL
    {
      const res: Record<string, unknown> = {};
      for (const [label, s1, s2] of [['mainThenLocal', 'MAIN', 'LOCAL'], ['localThenMain', 'LOCAL', 'MAIN']]) {
        const sc = await twoVersions(s1, s2);
        const before = await count('SELECT count(*)::int AS n FROM work_scope_bindings WHERE work_id=$1', [sc.W]);
        const r = await attempt(bind(sc.W!, sc.ft, sc.sv2, sc.occ2, await area(), s2));
        assert.equal(r.ok, false, label); assert.equal((r as any).sqlstate, '23514', label); assert.match((r as any).message, /GPR2_R05:ONE_PRODUCER_CONFLICT/);
        // controls: the SAME operation over another disjoint AreaScope stays allowed — under version 1, and under a later compatible version
        const same = await attempt(bind(sc.W!, sc.ft, sc.sv1, sc.occ1, await area(), s1));
        assert.equal(same.ok, true, label + ' same operation, other area: ' + JSON.stringify(same));
        const v3 = await run('finish-system.upsert', {}, { payload: { finishTypeId: sc.ft, stages: [st(s1)] } });
        const occ3 = (await one(pool, "SELECT id FROM finish_stage_occurrences WHERE system_version_id=$1 AND occurrence_key='SAME_KEY'", [v3.resultIds[1]])).id;
        const compatibleLater = await attempt(bind(sc.W!, sc.ft, v3.resultIds[1], occ3, await area(), s1));
        assert.equal(compatibleLater.ok, true, label + ' compatible later version, other area: ' + JSON.stringify(compatibleLater));
        assert.equal(await count('SELECT count(*)::int AS n FROM work_scope_bindings WHERE work_id=$1', [sc.W]), before, 'the probes were rolled back');
        res[label] = { secondScope: r, sameOperationOtherArea: 'ALLOWED', compatibleLaterVersionOtherArea: 'ALLOWED' };
      }
      evidence.R3B01_directSql = res;
    }

    // ================================================================ R3-B01 — two-session races on a Work's first bindings
    {
      const runs: any[] = [];
      const lockState = async (pid: number) => {
        const a = (await observer.query('SELECT wait_event_type, wait_event, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0];
        return { waitEventType: a.wait_event_type, waitEvent: a.wait_event, blockerCount: a.blockers.length };
      };
      for (const isolation of ['READ COMMITTED', 'REPEATABLE READ']) for (const firstOutcome of ['commit', 'rollback']) for (const [s1, s2] of [['MAIN', 'LOCAL'], ['LOCAL', 'MAIN'], ['MAIN', 'MAIN']]) {
        const sc = await twoVersions(s1, s2, false);
        const W = (await one(pool, "INSERT INTO works(tenant_id,object_id,work_type_id,name,unit,planned_quantity) VALUES($1,$2,$3,'R3','м²',10) RETURNING id", [T, O, X])).id;
        const A = await area(), B = await area();
        const label = `r3-${s1}-then-${s2}`;
        const a = await Session.open(db.url, label + '-a'), b = await Session.open(db.url, label + '-b');
        try {
          await a.begin(isolation); await b.begin(isolation); await b.query('SELECT count(*) FROM work_scope_bindings');
          await a.query(...bind(W, sc.ft, sc.sv1, sc.occ1, A, s1));
          const pending = settle(b.query(...bind(W, sc.ft, sc.sv2, sc.occ2, B, s2)));
          await waitUntilBlocked(observer.client, b.pid, label + ': B');
          const wait = await lockState(b.pid);
          if (firstOutcome === 'commit') await a.commit(); else await a.rollback();
          const r: any = await pending;
          let retry: string | undefined;
          if (r.ok) await b.commit();
          else { await b.rollback(); if (r.error.code === '40001') { await b.begin(isolation); const x: any = await settle(b.query(...bind(W, sc.ft, sc.sv2, sc.occ2, B, s2))); if (x.ok) await b.commit(); else await b.rollback(); retry = x.ok ? 'OK' : errText(x.error); } }
          const scopes = (await pool.query("SELECT DISTINCT measure_scope FROM work_scope_bindings WHERE work_id=$1 AND binding_state='ACTIVE'", [W])).rows.map((x: any) => x.measure_scope);
          const final = r.ok ? 'OK' : r.error.code === '40001' ? retry! : errText(r.error);
          assert.ok(scopes.length <= 1, label + ' ' + isolation + ': one Work with two measure scopes');
          if (s1 !== s2 && firstOutcome === 'commit') assert.match(final, /GPR2_R05:ONE_PRODUCER_CONFLICT/, label + ' ' + isolation);
          else assert.equal(final, 'OK', label + ' ' + isolation + ' ' + firstOutcome);
          if (isolation === 'REPEATABLE READ' && firstOutcome === 'commit') assert.equal(r.ok ? null : r.error.code, '40001');
          runs.push({ label, isolation, firstOutcome, wait, second: r.ok ? 'OK' : errText(r.error), sqlstate: r.ok ? null : r.error.code, retry, scopes });
        } finally { await a.close(); await b.close(); }
      }
      assert.equal(await count("SELECT count(*)::int AS n FROM (SELECT b.work_id FROM work_scope_bindings b JOIN finish_stage_occurrences o ON o.id=b.occurrence_id WHERE b.binding_state='ACTIVE' GROUP BY b.work_id HAVING count(DISTINCT (b.measure_scope, o.work_type_id, o.measure_unit)) > 1) x"), 0, 'no Work with two operations anywhere');
      evidence.R3B01_races = runs;
    }

    // ================================================================ LOCAL quantity restated across versions (command guard)
    {
      const res: Record<string, any> = {};
      const R = await area();
      const v1 = await run('finish-system.upsert', {}, { payload: { finishType: { code: code('FTQ'), name: 'R3 quantity' }, stages: [st('LOCAL')] } });
      const [ft, sv1] = v1.resultIds as string[];
      const p1 = await preview(ft, sv1, R, '20');
      const W = (await run('finish-system.confirm', { id: ft }, confirmBody(p1, R, '20'))).resultIds[0];
      const v2 = await run('finish-system.upsert', {}, { payload: { finishTypeId: ft, stages: [st('LOCAL'), st('MAIN', 'NEW_STAGE', 2)] } });
      const sv2 = v2.resultIds[1];
      const history = async () => (await pool.query("SELECT md5(string_agg(row_to_json(x)::text, '|' ORDER BY x.id)) AS d FROM (SELECT b.id, b.basis_quantity, w.planned_quantity, w.version FROM work_scope_bindings b JOIN works w ON w.id=b.work_id WHERE b.finish_type_id=$1) x", [ft])).rows[0].d;
      const writes = async () => [await count('SELECT count(*)::int AS n FROM works'), await count('SELECT count(*)::int AS n FROM work_scope_bindings'), await count("SELECT count(*)::int AS n FROM gpr2_command_ledger WHERE command_kind='finish-system.confirm'")];
      const h0 = await history(), w0 = await writes();
      // stated 30: blocker, refusal, idempotent refusal, nothing written
      const p30 = await preview(ft, sv2, R, '30');
      assert.equal(p30.canConfirm, false);
      assert.deepEqual(p30.blockers.map((b: any) => [b.error, b.rule, b.occurrenceKey, b.areaScopeId]), [['ONE_PRODUCER_CONFLICT', 'PRODUCER_QUANTITY_CHANGED', 'SAME_KEY', R]]);
      assert.deepEqual(p30.existingWorks, [], 'the 20 producer is not shown as satisfying 30');
      const k = randomUUID();
      const c30: any = await settle(run('finish-system.confirm', { id: ft }, confirmBody(p30, R, '30'), k));
      const c30again: any = await settle(run('finish-system.confirm', { id: ft }, confirmBody(p30, R, '30'), k));
      assert.equal(c30.ok, false); assert.equal(c30.error.code, 'ONE_PRODUCER_CONFLICT'); assert.equal(c30again.error?.code, 'ONE_PRODUCER_CONFLICT');
      assert.ok(c30.error.details.violations.some((v: any) => v.rule === 'PRODUCER_QUANTITY_CHANGED'));
      assert.deepEqual(await writes(), w0); assert.equal(await history(), h0, 'the 20 producer is not rewritten');
      res.restated30 = { preview: { canConfirm: false, blockers: p30.blockers }, confirm: c30.error.code, idempotentRetry: c30again.error.code, wroteNothing: true, producerUnchanged: true };
      // two concurrent confirms of the 30 preview: both proved waiting on the EXCLUSIVE lock, both refused
      {
        const key = coordinationKey(T, O);
        const waitingExclusive = async () => Number((await observer.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND mode='ExclusiveLock' AND NOT granted")).rows[0].n);
        const blocker = await Session.open(db.url, 'r05r3-shared-writer');
        await blocker.begin(); await blocker.query('SELECT pg_advisory_xact_lock_shared($1::bigint)', [key.toString()]);
        const a = settle(run('finish-system.confirm', { id: ft }, confirmBody(p30, R, '30')));
        const b = settle(run('finish-system.confirm', { id: ft }, confirmBody(p30, R, '30')));
        try { await until(async () => (await waitingExclusive()) >= 2, 'both confirms waiting'); } finally { await blocker.rollback(); await blocker.close(); }
        const rs = await Promise.all([a, b]);
        assert.deepEqual(rs.map((r: any) => r.ok ? 'OK' : r.error.code), ['ONE_PRODUCER_CONFLICT', 'ONE_PRODUCER_CONFLICT']);
        assert.deepEqual(await writes(), w0);
        assert.deepEqual(await advisoryHolders(observer.client, key), []);
        res.concurrentConfirms30 = { bothObservedWaiting: true, results: ['ONE_PRODUCER_CONFLICT', 'ONE_PRODUCER_CONFLICT'], wroteNothing: true };
      }
      // stated 20 (the producer's own quantity): EXISTING; confirm creates only NEW_STAGE
      const p20 = await preview(ft, sv2, R, '20');
      assert.deepEqual(p20.blockers, []);
      assert.deepEqual(p20.existingWorks.map((w: any) => [w.workId, w.quantity]), [[W, '20.0000']]);
      const c20 = await run('finish-system.confirm', { id: ft }, confirmBody(p20, R, '20'));
      assert.equal(c20.resultIds.length, 1, 'only NEW_STAGE is generated');
      res.restated20 = { existing: p20.existingWorks.map((w: any) => [w.workId, w.quantity]), created: c20.resultIds };
      evidence.localQuantity = res;
    }

    assert.equal(await count("SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname=current_database() AND NOT l.granted"), 0, 'nobody is left waiting');
    evidence.result = 'PASS';
  } finally {
    await pool.end();
    await until(async () => Number((await observer.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()')).rows[0].n) === 0,
      'the pool backends to leave the test database').catch(() => undefined);
    recordEvidence('r05-r3-native-summary', evidence);
    await observer.close(); await db.drop();
  }
});
