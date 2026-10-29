import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createIsolatedDatabase, scrubConnectionEnvironment, Session, until, waitUntilBlocked, recordEvidence, settle, advisoryHolders } from './helpers/gpr2-native-pg';

/**
 * GPR-2 R05 independent-acceptance corrective — R05-IND-NEW-01 … NEW-05 (INDEPENDENT_ACCEPTANCE_REPORT / FINDINGS_REGISTER, 24.10.2026) on NATIVE
 * PostgreSQL (isolated cluster `gpr2-p1-isolated`, a fresh `gpr2_p1_*` database; never LIVE, never an inherited DATABASE_URL).
 *
 * Every race is a two-session schedule: A runs its statement and stays open; B starts its competing statement and is PROVED waiting on a lock
 * (pg_stat_activity wait_event_type = 'Lock' with A among pg_blocking_pids) — never a sleep and never "no conflict observed". Then A commits or rolls
 * back, B's outcome and SQLSTATE are recorded, a 40001 is retried once in a fresh transaction of the same isolation level, and the postcondition of
 * the invariant is checked on the committed state. Each schedule runs at READ COMMITTED and REPEATABLE READ, with A committing and with A rolling back,
 * in both orders where the finding has two sides.
 *   NEW-01  sibling AreaScopes cannot measure more than their measured parent;
 *   NEW-02  one Work produces one operation (finish type, occurrence key) — several disjoint AreaScopes of the SAME operation stay possible;
 *   NEW-03  no RETIRED AreaScope with an ACTIVE producer, either order;
 *   NEW-04  a WorkType's unit cannot change under a first reference created concurrently (Work, WEU, template stage, occurrence), either order;
 *   NEW-05  an occurrence key reused by a later version with another operation is not satisfied by the old producer (real command guard).
 */
scrubConnectionEnvironment();

type Race = { label: string; isolation: string; firstOutcome: 'commit' | 'rollback'; wait: any; second: string; sqlstate: string | null; retry?: string; postcondition: any };

test('R05 independent corrective on native PostgreSQL: NEW-01 sibling measures, NEW-02 one operation per Work, NEW-03 retirement, NEW-04 WorkType unit, NEW-05 producer semantics', async () => {
  const db = await createIsolatedDatabase('r05ind');
  process.env.DATABASE_URL = db.url;
  const { pool, one } = await import('../apps/backend/src/db');
  const { migrate } = await import('../scripts/migrate') as any;
  const { seed } = await import('../scripts/seed');
  const { runGpr2Command } = await import('../apps/backend/src/gpr2-command-guard');
  const { R05_HOOKS } = await import('../apps/backend/src/gpr2-r05-hooks');
  const { coordinationKey } = await import('../apps/backend/src/coordination-lock');
  const { endpointById } = await import('../packages/domain/gpr2');
  const observer = await Session.open(db.url, 'r05i-observer');
  const evidence: Record<string, any> = { cluster: db.evidence, database: db.name };
  const count = async (sql: string, args: any[] = []) => Number((await pool.query(sql, args)).rows[0].n);
  const lockState = async (pid: number) => {
    const a = (await observer.query('SELECT wait_event_type, wait_event, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0];
    const waiting = (await observer.query('SELECT locktype, mode FROM pg_locks WHERE pid=$1 AND NOT granted', [pid])).rows;
    return { waitEventType: a.wait_event_type, waitEvent: a.wait_event, blockerCount: a.blockers.length, notGranted: waiting };
  };
  const errText = (e: any) => (e?.code ?? '') + ' ' + String(e?.message ?? '').slice(0, 110);
  /**
   * A two-session schedule. `first` runs in A and stays open; `second` (a single statement) runs in B and must be observed blocked by A. A commits or rolls
   * back; B commits if it succeeded. A 40001 in B is retried once in a fresh transaction of the same isolation level (the protocol's promise: a
   * serialization failure, never a silent pass, and the retry gets the business answer).
   */
  const race = async (label: string, isolation: string, firstOutcome: 'commit' | 'rollback', first: (s: Session) => Promise<unknown>,
                      second: [string, any[]], post: () => Promise<any>): Promise<Race> => {
    const a = await Session.open(db.url, 'r05i-' + label + '-a'), b = await Session.open(db.url, 'r05i-' + label + '-b');
    try {
      await a.begin(isolation); await b.begin(isolation);
      await b.query('SELECT count(*) FROM object_area_scopes'); // B's snapshot exists BEFORE A writes anything
      await first(a);
      const pending = settle(b.query(second[0], second[1]));
      await waitUntilBlocked(observer.client, b.pid, label + ': session B');
      const wait = await lockState(b.pid);
      assert.equal(wait.waitEventType, 'Lock'); assert.ok(wait.blockerCount >= 1);
      if (firstOutcome === 'commit') await a.commit(); else await a.rollback();
      const r: any = await pending;
      let retry: string | undefined;
      if (r.ok) await b.commit();
      else {
        await b.rollback();
        if (r.error.code === '40001') {
          await b.begin(isolation);
          const again: any = await settle(b.query(second[0], second[1]));
          if (again.ok) await b.commit(); else await b.rollback();
          retry = again.ok ? 'OK' : errText(again.error);
        }
      }
      return { label, isolation, firstOutcome, wait, second: r.ok ? 'OK' : errText(r.error), sqlstate: r.ok ? null : r.error.code, retry, postcondition: await post() };
    } finally { await a.close(); await b.close(); }
  };
  const ISOLATIONS = ['READ COMMITTED', 'REPEATABLE READ'] as const;
  const OUTCOMES = ['commit', 'rollback'] as const;
  /** After the schedule, the outcome of B (taking the retry into account): 'OK' or the refusal text. */
  const finalOf = (r: Race) => r.sqlstate === '40001' ? r.retry! : r.second;
  try {
    // ================================================================ 033 (the previous candidate's schema) with R05 data → 034
    await migrate({ through: 33 }); await seed();
    {
      const pm0 = await one(pool, "SELECT * FROM users WHERE role='PROJECT_MANAGER' AND is_active=true ORDER BY created_at LIMIT 1");
      const o0 = await one(pool, 'SELECT * FROM objects WHERE project_manager_id=$1 ORDER BY created_at LIMIT 1', [pm0.id]);
      const c0 = await one(pool, 'SELECT id FROM work_categories WHERE tenant_id=$1 LIMIT 1', [pm0.tenantId]);
      const wt0 = (await one(pool, "INSERT INTO work_types(tenant_id,category_id,name,unit) VALUES($1,$2,'До 034','м²') RETURNING id", [pm0.tenantId, c0.id])).id;
      const run0 = (id: string, params: any, body: any, key: string | null = randomUUID()) =>
        runGpr2Command(endpointById(id)!, { actor: pm0, params: { objectId: o0.id, ...params }, headers: key ? { 'idempotency-key': key } : {}, body }, R05_HOOKS) as Promise<any>;
      const parent0 = (await run0('area-scope.create', {}, { payload: { kind: 'SECTION', code: 'U-P', name: 'Секция', measureQuantity: '100', measureUnit: 'м²' } })).resultIds[0];
      const leaf0 = (await run0('area-scope.create', {}, { payload: { parentId: parent0, kind: 'ROOM', code: 'U-R', name: 'Комната', measureQuantity: '100', measureUnit: 'м²' } })).resultIds[0];
      const s0 = await run0('finish-system.upsert', {}, { payload: { finishType: { code: 'U-T', name: 'До 034' }, stages: [{ occurrenceKey: 'PLASTER', position: 1, workTypeId: wt0, required: true, measureScope: 'MAIN', measureUnit: 'м²' }] } });
      const p0 = (await run0('finish-system.preview', { id: s0.resultIds[0] }, { expectedVersion: '1', payload: { systemVersionId: s0.resultIds[1], areaScopeIds: [leaf0] } }, null)).preview;
      await run0('finish-system.confirm', { id: s0.resultIds[0] }, { expectedVersion: '1', expectedScopeVersion: p0.scopeVersion, payload: { systemVersionId: s0.resultIds[1], areaScopeIds: [leaf0], previewFingerprint: p0.previewFingerprint, expectedSourceVersions: { systemVersion: s0.resultIds[1] } } });
      const TABLES = ['works', 'work_execution_units', 'quantity_portions', 'portion_quantity_confirmations', 'work_progress', 'work_types', 'object_area_scopes', 'work_scope_bindings', 'work_scope_state',
        'finish_template_stages', 'finish_stage_occurrences', 'object_finish_system_versions', 'legacy_work_classifications', 'gpr2_command_ledger'];
      const snap = async () => Object.fromEntries(await Promise.all(TABLES.map(async t => [t, (await pool.query(`SELECT md5(coalesce(string_agg(row_to_json(x)::text, '|' ORDER BY row_to_json(x)::text), '')) AS d, count(*)::int AS n FROM ${t} x`)).rows[0]])));
      const objects034 = async () => ({
        ledger: await count('SELECT count(*)::int AS n FROM schema_migrations WHERE version=34'),
        tables: await count("SELECT count(*)::int AS n FROM pg_class WHERE relname IN ('object_area_scope_child_revisions','work_scope_operations','work_type_reference_state')"),
        triggers: await count("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname IN ('gpr2_area_scope_child_fence','gpr2_binding_operation_claim','gpr2_binding_area_lock','gpr2_area_scope_lifecycle_fence','gpr2_work_type_reference_fence','gpr2_work_type_reference_fence_change','gpr2_measured_reference_fence','gpr2_work_type_unit_fence','work_scope_operations_immutable')")
      });
      const { checksumOf, destructiveStatements } = await import('../scripts/migration-runner');
      const file034 = fs.readFileSync('infra/034_gpr2_r05_independent_corrective.sql', 'utf8');
      assert.deepEqual(destructiveStatements(file034), [], '034 passes the additive scan');
      const before = await snap();
      // a database an earlier candidate let into a forbidden state (here: a retired AreaScope with an active producer, written with the triggers off,
      // as the NEW-03 race did): 034 refuses to apply and leaves nothing behind
      const tamper = await Session.open(db.url, 'r05i-tamper');
      await tamper.begin(); await tamper.query("SET LOCAL session_replication_role = 'replica'");
      await tamper.query("UPDATE object_area_scopes SET lifecycle='RETIRED' WHERE id=$1", [leaf0]); await tamper.commit();
      const failed: any = await settle(migrate());
      assert.equal(failed.ok, false); assert.match(failed.error.message, /GPR2_R05:PRECONDITION .*NEW-03/);
      assert.deepEqual(await objects034(), { ledger: 0, tables: 0, triggers: 0 }, 'the failed run left no ledger row, table or trigger');
      await tamper.begin(); await tamper.query("SET LOCAL session_replication_role = 'replica'");
      await tamper.query("UPDATE object_area_scopes SET lifecycle='ACTIVE' WHERE id=$1", [leaf0]); await tamper.commit(); await tamper.close(); // undo the fixture
      const applied = await migrate();
      assert.deepEqual(applied.applied.map((x: any) => x.version), [34, 35]); // 035 (the third corrective) follows in the same run
      const after = await snap();
      for (const t of TABLES) assert.deepEqual(after[t], before[t], t + ' unchanged by 034 (the tampered fixture row was restored byte-for-byte)');
      const ledger34 = await one(pool, 'SELECT version, checksum, migration_class FROM schema_migrations WHERE version=34');
      assert.equal(ledger34.checksum, checksumOf(file034)); assert.equal(ledger34.migrationClass, 'additive');
      assert.deepEqual(await objects034(), { ledger: 1, tables: 3, triggers: 12 }); // 9 names; three of them on two tables each
      assert.equal(await count('SELECT ((SELECT count(*) FROM object_area_scope_child_revisions) + (SELECT count(*) FROM work_scope_operations) + (SELECT count(*) FROM work_type_reference_state))::int AS n'), 0, 'the new tables start empty: nothing is backfilled');
      assert.equal((await migrate()).applied.length, 0, 're-run is a no-op');
      evidence.upgrade = { from: 33, fromState: 'previous candidate schema 029–033 with R05 data (area tree, finish system, confirmed Work + binding)', applied: [34, 35],
        preconditionRefusal: String(failed.error.message).slice(0, 160), failedRunLeftNothing: true, ledger: ledger34, checksumMatchesFile: true, unchanged: TABLES, newTablesEmpty: true, rerunNoop: true, additiveScan: [] };
    }
    const pm = await one(pool, "SELECT * FROM users WHERE role='PROJECT_MANAGER' AND is_active=true ORDER BY created_at LIMIT 1");
    const object = await one(pool, 'SELECT * FROM objects WHERE project_manager_id=$1 ORDER BY created_at LIMIT 1', [pm.id]);
    const category = await one(pool, 'SELECT id FROM work_categories WHERE tenant_id=$1 LIMIT 1', [pm.tenantId]);
    const contractor = await one(pool, 'SELECT contractor_id FROM object_contractors_active WHERE tenant_id=$1 AND object_id=$2 LIMIT 1', [pm.tenantId, object.id]);
    const T = pm.tenantId, O = object.id;
    let seq = 0;
    const nextCode = (p: string) => p + '-' + (++seq);
    const newType = async (unit = 'м²') => (await one(pool, 'INSERT INTO work_types(tenant_id,category_id,name,unit) VALUES($1,$2,$3,$4) RETURNING id', [T, category.id, nextCode('Тип'), unit])).id as string;
    const PLASTER = await newType();
    const areaSql = "INSERT INTO object_area_scopes(tenant_id,object_id,parent_id,kind,code,name,measure_quantity,measure_unit,created_by) VALUES($1,$2,$3,'ZONE',$4,$4,$5,'м²',$6)";
    const area = async (q = '100', parent: string | null = null) => (await one(pool, areaSql + ' RETURNING id', [T, O, parent, nextCode('A'), q, pm.id])).id as string;
    const work = async (wt = PLASTER, unit = 'м²') => (await one(pool, "INSERT INTO works(tenant_id,object_id,work_type_id,name,unit,planned_quantity) VALUES($1,$2,$3,'Независимая','" + unit + "',100) RETURNING id", [T, O, wt])).id as string;
    /** A published object finish system of a new finish type with the given occurrence keys (all PLASTER, MAIN, м²). */
    const system = async (keys: string[] = ['PLASTER'], wt = PLASTER) => {
      const ft = (await one(pool, "INSERT INTO object_finish_types(tenant_id,object_id,code,name,created_by) VALUES($1,$2,$3,'x',$4) RETURNING id", [T, O, nextCode('FT'), pm.id])).id;
      const sv = (await one(pool, 'INSERT INTO object_finish_system_versions(tenant_id,object_id,finish_type_id,version_number,created_by) VALUES($1,$2,$3,1,$4) RETURNING id', [T, O, ft, pm.id])).id;
      const occ: Record<string, string> = {};
      for (const [i, k] of keys.entries())
        occ[k] = (await one(pool, "INSERT INTO finish_stage_occurrences(tenant_id,object_id,system_version_id,occurrence_key,position,work_type_id,required,measure_scope,measure_unit,override_kind) VALUES($1,$2,$3,$4,$5,$6,true,'MAIN','м²','ADDED_LOCAL') RETURNING id", [T, O, sv, k, i + 1, wt])).id;
      await pool.query("UPDATE object_finish_system_versions SET state='PUBLISHED', content_hash=repeat('a',64), published_by=$2, published_at=now() WHERE id=$1", [sv, pm.id]);
      return { ft, sv, occ };
    };
    const bindSql = `INSERT INTO work_scope_bindings(tenant_id,object_id,work_id,finish_type_id,system_version_id,occurrence_id,occurrence_key,area_scope_id,measure_scope,basis_quantity,command_id,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'MAIN',100,$9,$10)`;
    const bind = (w: string, s: { ft: string; sv: string; occ: Record<string, string> }, a: string, key = 'PLASTER'): [string, any[]] => [bindSql, [T, O, w, s.ft, s.sv, s.occ[key], key, a, randomUUID(), pm.id]];

    // ================================================================ NEW-01 — sibling AreaScopes under a measured parent
    {
      const runs: Race[] = [];
      for (const isolation of ISOLATIONS) for (const firstOutcome of OUTCOMES) for (const [qa, qb] of [['600', '500'], ['500', '600']]) {
        const parent = await area('1000');
        const post = async () => (await pool.query("SELECT p.measure_quantity::text AS parent, coalesce(sum(c.measure_quantity),0)::text AS children FROM object_area_scopes p LEFT JOIN object_area_scopes c ON c.parent_id=p.id AND c.lifecycle='ACTIVE' WHERE p.id=$1 GROUP BY p.id", [parent])).rows[0];
        const r = await race(`new01-${qa}-then-${qb}`, isolation, firstOutcome, s => s.query(areaSql, [T, O, parent, nextCode('C'), qa, pm.id]), [areaSql, [T, O, parent, nextCode('C'), qb, pm.id]], post);
        assert.ok(Number(r.postcondition.children) <= Number(r.postcondition.parent), r.label + ' ' + isolation + ': children ' + r.postcondition.children + ' > parent');
        if (firstOutcome === 'commit') {
          assert.match(finalOf(r), /GPR2_R05:AREA_SCOPE_CONFLICT/, r.label + ' ' + isolation);
          if (isolation === 'REPEATABLE READ') assert.equal(r.sqlstate, '40001', 'RR: a serialization failure, then the business refusal on retry');
          assert.equal(r.postcondition.children, qa + '.0000');
        } else { assert.equal(finalOf(r), 'OK'); assert.equal(r.postcondition.children, qb + '.0000'); }
        runs.push(r);
      }
      // no false double counting: 600 + 400 = 1000 concurrently — the second one commits (after a retry at RR)
      for (const isolation of ISOLATIONS) {
        const parent = await area('1000');
        const r = await race('new01-600-then-400', isolation, 'commit', s => s.query(areaSql, [T, O, parent, nextCode('C'), '600', pm.id]), [areaSql, [T, O, parent, nextCode('C'), '400', pm.id]],
          async () => (await pool.query("SELECT sum(measure_quantity)::text AS children FROM object_area_scopes WHERE parent_id=$1", [parent])).rows[0]);
        assert.equal(finalOf(r), 'OK'); assert.equal(r.postcondition.children, '1000.0000');
        runs.push(r);
      }
      evidence.NEW01 = runs;
    }

    // ================================================================ NEW-02 — one Work, one production operation
    {
      const runs: Race[] = [];
      const ops = async (w: string) => (await pool.query("SELECT DISTINCT finish_type_id::text AS ft, occurrence_key AS k FROM work_scope_bindings WHERE work_id=$1 AND binding_state='ACTIVE'", [w])).rows;
      for (const isolation of ISOLATIONS) for (const firstOutcome of OUTCOMES) {
        // different finish types
        { const w = await work(), s1 = await system(), s2 = await system(), a1 = await area(), a2 = await area();
          const r = await race('new02-other-finish-type', isolation, firstOutcome, s => s.query(...bind(w, s1, a1)), bind(w, s2, a2), () => ops(w));
          assert.equal(r.postcondition.length, 1, r.label + ' ' + isolation + ': one operation');
          if (firstOutcome === 'commit') assert.match(finalOf(r), /GPR2_R05:ONE_PRODUCER_CONFLICT/); else assert.equal(finalOf(r), 'OK');
          runs.push(r); }
        // the same finish type, different occurrence keys
        { const w = await work(), s = await system(['PLASTER', 'PLASTER_2']), a1 = await area(), a2 = await area();
          const r = await race('new02-other-occurrence-key', isolation, firstOutcome, x => x.query(...bind(w, s, a1, 'PLASTER')), bind(w, s, a2, 'PLASTER_2'), () => ops(w));
          assert.equal(r.postcondition.length, 1, r.label + ' ' + isolation);
          if (firstOutcome === 'commit') assert.match(finalOf(r), /GPR2_R05:ONE_PRODUCER_CONFLICT/); else assert.equal(finalOf(r), 'OK');
          runs.push(r); }
        // the SAME operation over two disjoint AreaScopes stays allowed (at RR after a retry)
        { const w = await work(), s = await system(), a1 = await area(), a2 = await area();
          const r = await race('new02-same-operation-two-areas', isolation, firstOutcome, x => x.query(...bind(w, s, a1)), bind(w, s, a2),
            async () => ({ operations: await ops(w), bindings: await count('SELECT count(*)::int AS n FROM work_scope_bindings WHERE work_id=$1', [w]) }));
          assert.equal(finalOf(r), 'OK', r.label + ' ' + isolation);
          assert.equal(r.postcondition.operations.length, 1); assert.equal(r.postcondition.bindings, firstOutcome === 'commit' ? 2 : 1);
          runs.push(r); }
      }
      // sequential: a Work bound before 034 had no operation claim — a second operation is still refused (the old bindings are compared directly)
      const w = await work(), s1 = await system(), s2 = await system(), a1 = await area(), a2 = await area();
      await pool.query(...bind(w, s1, a1));
      await assert.rejects(pool.query(...bind(w, s2, a2)), /GPR2_R05:ONE_PRODUCER_CONFLICT/);
      assert.equal(await count('SELECT count(*)::int AS n FROM work_scope_bindings b JOIN work_scope_bindings c ON c.tenant_id=b.tenant_id AND c.object_id=b.object_id AND c.finish_type_id=b.finish_type_id AND c.occurrence_key=b.occurrence_key AND c.area_scope_id=b.area_scope_id AND c.id<>b.id'), 0, 'no duplicate producer anywhere');
      assert.equal(await count("SELECT count(*)::int AS n FROM (SELECT work_id FROM work_scope_bindings GROUP BY work_id HAVING count(DISTINCT (finish_type_id, occurrence_key)) > 1) x"), 0, 'no Work with two operations anywhere');
      // a Work bound BEFORE 034 (no operation claim row): a second operation is refused, the same operation over another AreaScope is not
      const pre = await one(pool, "SELECT b.* FROM work_scope_bindings b JOIN object_finish_types f ON f.id=b.finish_type_id WHERE f.code='U-T'");
      assert.equal(await count('SELECT count(*)::int AS n FROM work_scope_operations WHERE work_id=$1', [pre.workId]), 0, 'bound before 034: no claim row');
      const preType = (await one(pool, 'SELECT work_type_id FROM works WHERE id=$1', [pre.workId])).workTypeId;
      await assert.rejects(pool.query(...bind(pre.workId, await system(['PLASTER'], preType), await area())), /GPR2_R05:ONE_PRODUCER_CONFLICT/);
      await pool.query(...bind(pre.workId, { ft: pre.finishTypeId, sv: pre.systemVersionId, occ: { PLASTER: pre.occurrenceId } }, await area()));
      assert.equal(await count('SELECT count(*)::int AS n FROM work_scope_bindings WHERE work_id=$1', [pre.workId]), 2);
      evidence.NEW02 = { runs, boundBefore034: { secondOperationRefused: 'ONE_PRODUCER_CONFLICT', sameOperationOtherArea: 'OK' } };
    }

    // ================================================================ NEW-03 — AreaScope retirement vs a producer binding
    {
      const runs: Race[] = [];
      const retireSql = "UPDATE object_area_scopes SET lifecycle='RETIRED' WHERE id=$1";
      const post = async (a: string) => (await pool.query("SELECT a.lifecycle, (SELECT count(*)::int FROM work_scope_bindings b WHERE b.area_scope_id=a.id AND b.binding_state='ACTIVE') AS active_bindings FROM object_area_scopes a WHERE a.id=$1", [a])).rows[0];
      const forbidden = (p: any) => p.lifecycle === 'RETIRED' && p.active_bindings > 0;
      for (const isolation of ISOLATIONS) for (const firstOutcome of OUTCOMES) {
        { const s = await system(), a = await area(), w = await work();
          const r = await race('new03-retire-first', isolation, firstOutcome, x => x.query(retireSql, [a]), bind(w, s, a), () => post(a));
          assert.equal(forbidden(r.postcondition), false, r.label + ' ' + isolation);
          if (firstOutcome === 'commit') { assert.match(finalOf(r), /GPR2_R05:AREA_SCOPE_CONFLICT/); assert.deepEqual(r.postcondition, { lifecycle: 'RETIRED', active_bindings: 0 }); }
          else { assert.equal(finalOf(r), 'OK'); assert.deepEqual(r.postcondition, { lifecycle: 'ACTIVE', active_bindings: 1 }); }
          runs.push(r); }
        { const s = await system(), a = await area(), w = await work();
          const r = await race('new03-binding-first', isolation, firstOutcome, x => x.query(...bind(w, s, a)), [retireSql, [a]], () => post(a));
          assert.equal(forbidden(r.postcondition), false, r.label + ' ' + isolation);
          if (firstOutcome === 'commit') { assert.match(finalOf(r), /GPR2_R05:AREA_SCOPE_CONFLICT/); assert.deepEqual(r.postcondition, { lifecycle: 'ACTIVE', active_bindings: 1 }); }
          else { assert.equal(finalOf(r), 'OK'); assert.deepEqual(r.postcondition, { lifecycle: 'RETIRED', active_bindings: 0 }); }
          runs.push(r); }
      }
      assert.equal(await count("SELECT count(*)::int AS n FROM work_scope_bindings b JOIN object_area_scopes a ON a.id=b.area_scope_id WHERE b.binding_state='ACTIVE' AND a.lifecycle<>'ACTIVE'"), 0, 'no retired AreaScope with an active producer anywhere');
      evidence.NEW03 = runs;
    }

    // ================================================================ NEW-04 — WorkType unit vs the first reference
    {
      const runs: Race[] = [];
      const unitSql = "UPDATE work_types SET unit='м³' WHERE id=$1";
      const tplVersion = async () => {
        const tpl = (await one(pool, "INSERT INTO finish_templates(tenant_id,code,name,created_by) VALUES($1,$2,'x',$3) RETURNING id", [T, nextCode('TPL'), pm.id])).id;
        return (await one(pool, 'INSERT INTO finish_template_versions(tenant_id,template_id,version_number,created_by) VALUES($1,$2,1,$3) RETURNING id', [T, tpl, pm.id])).id as string;
      };
      const draftSystem = async () => {
        const ft = (await one(pool, "INSERT INTO object_finish_types(tenant_id,object_id,code,name,created_by) VALUES($1,$2,$3,'x',$4) RETURNING id", [T, O, nextCode('FT'), pm.id])).id;
        return (await one(pool, 'INSERT INTO object_finish_system_versions(tenant_id,object_id,finish_type_id,version_number,created_by) VALUES($1,$2,$3,1,$4) RETURNING id', [T, O, ft, pm.id])).id as string;
      };
      const hostWork = await work();
      const REFS: Record<string, (type: string) => Promise<[string, any[]]>> = {
        stage: async type => ["INSERT INTO finish_template_stages(tenant_id,template_version_id,occurrence_key,position,work_type_id,required,measure_scope,measure_unit) VALUES($1,$2,'S',1,$3,true,'MAIN','м²')", [T, await tplVersion(), type]],
        occurrence: async type => ["INSERT INTO finish_stage_occurrences(tenant_id,object_id,system_version_id,occurrence_key,position,work_type_id,required,measure_scope,measure_unit,override_kind) VALUES($1,$2,$3,'S',1,$4,true,'MAIN','м²','ADDED_LOCAL')", [T, O, await draftSystem(), type]],
        work: async type => ["INSERT INTO works(tenant_id,object_id,work_type_id,name,unit,planned_quantity) VALUES($1,$2,$3,'Первая ссылка','м²',10)", [T, O, type]],
        weu: async type => ['INSERT INTO work_execution_units(tenant_id,object_work_id,work_type_id,contractor_id,unit,planned_quantity) VALUES($1,$2,$3,$4,$5,10)', [T, hostWork, type, contractor.contractorId, 'м²']]
      };
      const post = async (type: string) => {
        const t = await one(pool, 'SELECT unit FROM work_types WHERE id=$1', [type]);
        const measured = (await pool.query('SELECT measure_unit FROM finish_template_stages WHERE work_type_id=$1 UNION ALL SELECT measure_unit FROM finish_stage_occurrences WHERE work_type_id=$1', [type])).rows.map((r: any) => r.measure_unit);
        const refs = await count('SELECT ((SELECT count(*) FROM works WHERE work_type_id=$1) + (SELECT count(*) FROM work_execution_units WHERE work_type_id=$1) + (SELECT count(*) FROM finish_template_stages WHERE work_type_id=$1) + (SELECT count(*) FROM finish_stage_occurrences WHERE work_type_id=$1))::int AS n', [type]);
        return { unit: t.unit, measuredUnits: measured, references: refs };
      };
      for (const [kind, mk] of Object.entries(REFS)) for (const isolation of ISOLATIONS) for (const firstOutcome of OUTCOMES) {
        // reference first, unit change second
        { const type = await newType(); const ref = await mk(type);
          const r = await race(`new04-${kind}-first`, isolation, firstOutcome, s => s.query(ref[0], ref[1]), [unitSql, [type]], () => post(type));
          assert.ok(r.postcondition.measuredUnits.every((u: string) => u === r.postcondition.unit), r.label + ' ' + isolation + ': a measure unit drifted from its WorkType');
          if (firstOutcome === 'commit') { assert.match(finalOf(r), /GPR2_R05:UNIT_IMMUTABLE/); assert.equal(r.postcondition.unit, 'м²'); assert.equal(r.postcondition.references, 1); }
          else { assert.equal(finalOf(r), 'OK'); assert.equal(r.postcondition.unit, 'м³'); assert.equal(r.postcondition.references, 0); }
          runs.push(r); }
        // unit change first, reference second
        { const type = await newType(); const ref = await mk(type);
          const r = await race(`new04-unit-first-${kind}`, isolation, firstOutcome, s => s.query(unitSql, [type]), ref, () => post(type));
          assert.ok(r.postcondition.measuredUnits.every((u: string) => u === r.postcondition.unit), r.label + ' ' + isolation + ': a measure unit drifted from its WorkType');
          if (firstOutcome === 'rollback') { assert.equal(finalOf(r), 'OK'); assert.equal(r.postcondition.unit, 'м²'); }
          else if (kind === 'stage' || kind === 'occurrence') { assert.match(finalOf(r), /GPR2_R05:INVALID_MEASUREMENT/); assert.equal(r.postcondition.references, 0); }
          else { assert.equal(finalOf(r), 'OK', 'a Work / WEU created after the unit change references the changed type (its own unit is its own — no conversion)'); assert.equal(r.postcondition.unit, 'м³'); }
          runs.push(r); }
      }
      // an existing (legacy) reference: the unit of a seeded WorkType used by seeded Works cannot change; nothing is rewritten
      const legacy = await one(pool, 'SELECT t.id, t.unit FROM work_types t WHERE t.tenant_id=$1 AND EXISTS (SELECT 1 FROM works w WHERE w.work_type_id=t.id) ORDER BY t.created_at LIMIT 1', [T]);
      await assert.rejects(pool.query("UPDATE work_types SET unit='шт' WHERE id=$1", [legacy.id]), /GPR2_R05:UNIT_IMMUTABLE/);
      assert.equal((await one(pool, 'SELECT unit FROM work_types WHERE id=$1', [legacy.id])).unit, legacy.unit);
      assert.equal(await count('SELECT count(*)::int AS n FROM (SELECT s.id FROM finish_template_stages s JOIN work_types t ON t.id=s.work_type_id WHERE s.measure_unit<>t.unit UNION ALL SELECT o.id FROM finish_stage_occurrences o JOIN work_types t ON t.id=o.work_type_id WHERE o.measure_unit<>t.unit) x'), 0, 'no stage / occurrence measures in another unit than its WorkType anywhere');
      evidence.NEW04 = { runs, legacyReferenceUnitChange: 'UNIT_IMMUTABLE, unit unchanged' };
    }

    // ================================================================ NEW-05 — producer semantics across versions, through the real command guard
    {
      const res: Record<string, any> = {};
      const run = (id: string, params: Record<string, string>, body: unknown, key: string | null = randomUUID()) =>
        runGpr2Command(endpointById(id)!, { actor: pm, params: { objectId: O, ...params }, headers: key ? { 'idempotency-key': key } : {}, body }, R05_HOOKS) as Promise<any>;
      const PAINT = await newType(), SCREED = await newType('м³');
      const stg = (k: string, wt: string, pos: number, x: any = {}) => ({ occurrenceKey: k, position: pos, workTypeId: wt, required: true, measureScope: 'MAIN', measureUnit: 'м²', ...x });
      const areaApi = async () => (await run('area-scope.create', {}, { payload: { kind: 'ZONE', code: nextCode('V'), name: 'Зона', measureQuantity: '50', measureUnit: 'м²' } })).resultIds[0] as string;
      const previewOf = async (ft: string, sv: string, a: string, local?: string) =>
        (await run('finish-system.preview', { id: ft }, { expectedVersion: '1', payload: { systemVersionId: sv, areaScopeIds: [a], ...(local ? { localQuantities: [{ occurrenceKey: 'SAME_KEY', areaScopeId: a, quantity: local }] } : {}) } }, null)).preview;
      const confirmBody = (p: any, a: string, local?: string) => ({ expectedVersion: '1', expectedScopeVersion: p.scopeVersion, payload: { systemVersionId: p.systemVersionId, areaScopeIds: [a],
        ...(local ? { localQuantities: [{ occurrenceKey: 'SAME_KEY', areaScopeId: a, quantity: local }] } : {}), previewFingerprint: p.previewFingerprint, expectedSourceVersions: { systemVersion: p.systemVersionId } } });
      const historyOf = async (ft: string) => (await pool.query("SELECT md5(string_agg(row_to_json(x)::text, '|' ORDER BY x.id)) AS d FROM (SELECT w.* FROM works w WHERE w.id IN (SELECT work_id FROM work_scope_bindings WHERE finish_type_id=$1)) x", [ft])).rows[0].d
        + '/' + (await pool.query("SELECT md5(string_agg(row_to_json(b)::text, '|' ORDER BY b.id)) AS d FROM work_scope_bindings b WHERE finish_type_id=$1", [ft])).rows[0].d;
      /** v1: SAME_KEY as `v1`; confirmed. v2: SAME_KEY as `v2` + NEW_STAGE (PLASTER). Preview v2 and try to confirm it. */
      const scenario = async (name: string, v1: any, v2: any, opts: { v1Local?: string; v2Local?: string } = {}) => {
        const a = await areaApi();
        const s1 = await run('finish-system.upsert', {}, { payload: { finishType: { code: nextCode('NV'), name: 'Версии ' + name }, stages: [v1] } });
        const [ft, sv1] = s1.resultIds;
        const p1 = await previewOf(ft, sv1, a, opts.v1Local);
        assert.equal(p1.canConfirm, true, name + ' v1: ' + JSON.stringify(p1.blockers));
        const c1 = await run('finish-system.confirm', { id: ft }, confirmBody(p1, a, opts.v1Local));
        const s2 = await run('finish-system.upsert', {}, { payload: { finishTypeId: ft, stages: [v2, stg('NEW_STAGE', PLASTER, 2)] } });
        const sv2 = s2.resultIds[1];
        const history = await historyOf(ft);
        const p2 = await previewOf(ft, sv2, a, opts.v2Local);
        return { a, ft, sv1, sv2, oldWork: c1.resultIds[0], history, p2 };
      };
      const writes = async () => [await count('SELECT count(*)::int AS n FROM works'), await count('SELECT count(*)::int AS n FROM work_scope_bindings'), await count("SELECT count(*)::int AS n FROM gpr2_command_ledger WHERE command_kind='finish-system.confirm'")];
      const incompatible = async (name: string, v1: any, v2: any, opts: { v1Local?: string; v2Local?: string } = {}) => {
        const sc = await scenario(name, v1, v2, opts);
        assert.equal(sc.p2.canConfirm, false, name);
        assert.ok(sc.p2.blockers.some((b: any) => b.error === 'ONE_PRODUCER_CONFLICT' && b.rule === 'PRODUCER_INCOMPATIBLE' && b.occurrenceKey === 'SAME_KEY' && b.areaScopeId === sc.a), name + ': ' + JSON.stringify(sc.p2.blockers));
        assert.ok(!sc.p2.existingWorks.some((w: any) => w.workId === sc.oldWork), name + ': the old Work is not offered as the producer of the changed operation');
        const w0 = await writes();
        const k = randomUUID();
        const c = await settle(run('finish-system.confirm', { id: sc.ft }, confirmBody(sc.p2, sc.a, opts.v2Local), k));
        assert.equal(c.ok, false, name); assert.equal((c as any).error.code, 'ONE_PRODUCER_CONFLICT', name);
        assert.deepEqual((c as any).error.details?.violations?.find((v: any) => v.rule === 'PRODUCER_INCOMPATIBLE'), { path: 'areaScopeIds', rule: 'PRODUCER_INCOMPATIBLE' });
        const retry = await settle(run('finish-system.confirm', { id: sc.ft }, confirmBody(sc.p2, sc.a, opts.v2Local), k));
        assert.equal((retry as any).error?.code, 'ONE_PRODUCER_CONFLICT', name + ': the idempotent retry gets the same answer');
        assert.deepEqual(await writes(), w0, name + ': nothing written — no duplicate producer, no new NEW_STAGE Work either');
        assert.equal(await historyOf(sc.ft), sc.history, name + ': the historical Work and its bindings are byte-identical');
        res[name] = { preview: { canConfirm: false, blockers: sc.p2.blockers, existingWorks: sc.p2.existingWorks }, confirm: (c as any).error.code, retry: (retry as any).error.code, wroteNothing: true, historyUnchanged: true };
        return sc;
      };
      // 1 / 6 / 8: same key, same operation → the producer of version 1 is EXISTING for version 2 (compatible transition), confirm creates only NEW_STAGE
      {
        const sc = await scenario('sameWorkType', stg('SAME_KEY', PLASTER, 1), stg('SAME_KEY', PLASTER, 1, { proposedHoldHours: '12' }));
        assert.equal(sc.p2.canConfirm, true, JSON.stringify(sc.p2.blockers));
        assert.deepEqual(sc.p2.existingWorks.map((w: any) => [w.workId, w.occurrenceKey, w.systemVersionId]), [[sc.oldWork, 'SAME_KEY', sc.sv1]]);
        assert.ok(sc.p2.warnings.some((w: any) => w.code === 'EXISTING_FROM_OTHER_VERSION'));
        assert.deepEqual(sc.p2.proposedWorks.map((w: any) => w.occurrenceKey), ['NEW_STAGE']);
        const k = randomUUID();
        const c = await run('finish-system.confirm', { id: sc.ft }, confirmBody(sc.p2, sc.a), k);
        const again = await run('finish-system.confirm', { id: sc.ft }, confirmBody(sc.p2, sc.a), k);
        assert.deepEqual(again, c, 'idempotent retry: the same result');
        assert.equal(c.resultIds.length, 1);
        assert.equal(await historyOf(sc.ft) !== sc.history, true); // a NEW_STAGE Work was added …
        assert.equal((await one(pool, 'SELECT row_to_json(w)::text AS r FROM works w WHERE id=$1', [sc.oldWork])).r.includes(PLASTER), true); // … the old Work is the same Work
        res.sameWorkType = { existing: sc.p2.existingWorks, created: c.resultIds, retrySameResult: true, compatibleTransition: true, existingFromOtherVersion: true };
      }
      // 2 / 7: same key, another WorkType
      await incompatible('changedWorkType', stg('SAME_KEY', PLASTER, 1), stg('SAME_KEY', PAINT, 1));
      // 3: same key, another unit (necessarily another WorkType: the unit of a referenced WorkType itself cannot change — NEW-04)
      await incompatible('changedUnit', stg('SAME_KEY', PLASTER, 1), stg('SAME_KEY', SCREED, 1, { measureUnit: 'м³' }));
      // 4: MAIN → LOCAL
      await incompatible('mainToLocal', stg('SAME_KEY', PLASTER, 1), stg('SAME_KEY', PLASTER, 1, { measureScope: 'LOCAL' }), { v2Local: '20' });
      // 5: a changed measurement rule the other way: LOCAL → MAIN (the quantity basis changes from a stated local quantity to the area's measure)
      await incompatible('localToMain', stg('SAME_KEY', PLASTER, 1, { measureScope: 'LOCAL' }), stg('SAME_KEY', PLASTER, 1), { v1Local: '20' });
      // 11: two concurrent confirms of an incompatible transition — both proved waiting on the object's EXCLUSIVE lock, both refused, nothing written
      {
        const sc = await scenario('concurrent', stg('SAME_KEY', PLASTER, 1), stg('SAME_KEY', PAINT, 1));
        const key = coordinationKey(T, O);
        const waitingExclusive = async () => Number((await observer.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND mode='ExclusiveLock' AND NOT granted")).rows[0].n);
        const w0 = await writes();
        const blocker = await Session.open(db.url, 'r05i-shared-writer');
        await blocker.begin(); await blocker.query('SELECT pg_advisory_xact_lock_shared($1::bigint)', [key.toString()]);
        const a = settle(run('finish-system.confirm', { id: sc.ft }, confirmBody(sc.p2, sc.a)));
        const b = settle(run('finish-system.confirm', { id: sc.ft }, confirmBody(sc.p2, sc.a)));
        try { await until(async () => (await waitingExclusive()) >= 2, 'both confirms waiting for the EXCLUSIVE coordination lock'); }
        finally { await blocker.rollback(); await blocker.close(); }
        const rs = await Promise.all([a, b]);
        assert.deepEqual(rs.map((r: any) => r.ok ? 'OK' : r.error.code), ['ONE_PRODUCER_CONFLICT', 'ONE_PRODUCER_CONFLICT']);
        assert.deepEqual(await writes(), w0);
        assert.equal(await historyOf(sc.ft), sc.history);
        assert.deepEqual(await advisoryHolders(observer.client, key), []);
        res.concurrentConfirmsIncompatible = { bothObservedWaiting: true, results: ['ONE_PRODUCER_CONFLICT', 'ONE_PRODUCER_CONFLICT'], wroteNothing: true, historyUnchanged: true };
      }
      evidence.NEW05 = res;
    }

    // ================================================================ no lock left behind; no invariant broken anywhere in the database
    assert.equal(await count("SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname=current_database() AND NOT l.granted"), 0, 'nobody is left waiting');
    evidence.result = 'PASS';
  } finally {
    await pool.end();
    await until(async () => Number((await observer.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()')).rows[0].n) === 0,
      'the pool backends to leave the test database').catch(() => undefined);
    recordEvidence('r05-independent-native-summary', evidence);
    await observer.close(); await db.drop();
  }
});
