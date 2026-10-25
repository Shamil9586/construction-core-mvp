import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createIsolatedDatabase, scrubConnectionEnvironment, recordEvidence, settle, until, Session } from './helpers/gpr2-native-pg';

/**
 * GPR-2 R05 preview corrective — R05-IND3-01 and R05-IND3-02 of the independent native acceptance of 7a838ca, through the REAL command guard
 * (runGpr2Command + R05_HOOKS) on NATIVE PostgreSQL (isolated cluster `gpr2-p1-isolated`, a fresh `gpr2_p1_*` database; never LIVE). No SQL changed.
 *   IND3-01  `localQuantities` naming one obligation twice — new LOCAL [10,20] / [20,10] / [20,20], existing producer 20 with [30,20] / [20,30] / [20,20]:
 *            preview AND confirm 422 VALIDATION_FAILED / DUPLICATE_VALUE at the repeat, in every order; the same idempotency key again → the same refusal;
 *            no Work / binding / ledger / audit row written; another role / another РП is refused BEFORE any payload rule (authorization first).
 *            Distinct obligations (other key, other AreaScope, one statement, 20.0000) stay valid.
 *   IND3-02  one MAIN Work 1000 over A 600 + B 400 and one LOCAL Work 30 over A 20 + B 10: a compatible version's preview shows EXISTING per binding
 *            (600 / 400, 20 / 10; a subset shows only its own binding) with the Work total as `workPlannedQuantity`; the confirm of that preview (same
 *            fingerprint, recomputed under the lock) creates only the new stage and no binding for the EXISTING obligation.
 */
scrubConnectionEnvironment();

test('R05 preview corrective on native PostgreSQL: IND3-01 duplicate LOCAL quantities refused; IND3-02 EXISTING per binding', async () => {
  const db = await createIsolatedDatabase('r05ind3');
  process.env.DATABASE_URL = db.url;
  const { pool, one } = await import('../apps/backend/src/db');
  const { migrate } = await import('../scripts/migrate') as any;
  const { seed } = await import('../scripts/seed');
  const { runGpr2Command } = await import('../apps/backend/src/gpr2-command-guard');
  const { R05_HOOKS } = await import('../apps/backend/src/gpr2-r05-hooks');
  const { endpointById } = await import('../packages/domain/gpr2');
  const observer = await Session.open(db.url, 'r05ind3-observer');
  const evidence: Record<string, any> = { cluster: db.evidence, database: db.name };
  const count = async (sql: string, args: any[] = []) => Number((await pool.query(sql, args)).rows[0].n);
  try {
    await migrate(); await seed();
    const pm = await one(pool, "SELECT * FROM users WHERE role='PROJECT_MANAGER' AND is_active=true ORDER BY created_at LIMIT 1");
    const otherPm = await one(pool, "SELECT * FROM users WHERE role='PROJECT_MANAGER' AND is_active=true AND id<>$1 ORDER BY created_at LIMIT 1", [pm.id]);
    const admin = await one(pool, "SELECT * FROM users WHERE role='ADMIN' AND is_active=true LIMIT 1");
    const object = await one(pool, 'SELECT * FROM objects WHERE project_manager_id=$1 ORDER BY created_at LIMIT 1', [pm.id]);
    const category = await one(pool, 'SELECT id FROM work_categories WHERE tenant_id=$1 LIMIT 1', [pm.tenantId]);
    const T = pm.tenantId, O = object.id;
    let seq = 0;
    const code = (p: string) => p + '-' + (++seq);
    const type = async () => (await one(pool, "INSERT INTO work_types(tenant_id,category_id,name,unit) VALUES($1,$2,$3,'м²') RETURNING id", [T, category.id, code('IND3 тип')])).id as string;
    const X = await type(), Y = await type();
    // the actor as the HTTP layer would authenticate it: the CURRENT user row
    const run = async (who: any, id: string, params: Record<string, string>, body: unknown, key: string | null = randomUUID()) =>
      runGpr2Command(endpointById(id)!, { actor: await one(pool, 'SELECT * FROM users WHERE id=$1', [who.id]), params: { objectId: O, ...params }, headers: key ? { 'idempotency-key': key } : {}, body }, R05_HOOKS) as Promise<any>;
    const area = async (q: string) => (await run(pm, 'area-scope.create', {}, { payload: { kind: 'ZONE', code: code('Z'), name: 'Зона', measureQuantity: q, measureUnit: 'м²' } })).resultIds[0] as string;
    const st = (k: string, scope: string, pos: number, wt = X) => ({ occurrenceKey: k, position: pos, workTypeId: wt, required: true, measureScope: scope, measureUnit: 'м²' });
    type Sel = { areas: string[]; local?: [string, string, string][] };
    const payloadOf = (sv: string, s: Sel) => ({ systemVersionId: sv, areaScopeIds: s.areas, ...(s.local ? { localQuantities: s.local.map(([occurrenceKey, areaScopeId, quantity]) => ({ occurrenceKey, areaScopeId, quantity })) } : {}) });
    const preview = (ft: string, sv: string, s: Sel, who = pm) => run(who, 'finish-system.preview', { id: ft }, { expectedVersion: '1', payload: payloadOf(sv, s) }, null).then((r: any) => r.preview);
    const confirmBody = (sv: string, s: Sel, scope: string, fp: string) => ({ expectedVersion: '1', expectedScopeVersion: scope, payload: { ...payloadOf(sv, s), previewFingerprint: fp, expectedSourceVersions: { systemVersion: sv } } });
    const confirm = (ft: string, sv: string, s: Sel, scope: string, fp: string, key = randomUUID(), who = pm) => settle(run(who, 'finish-system.confirm', { id: ft }, confirmBody(sv, s, scope, fp), key));
    const scopeVersion = async () => (await one(pool, 'SELECT scope_version::text AS v FROM work_scope_state WHERE tenant_id=$1 AND object_id=$2', [T, O]))?.v ?? '0';
    const writes = async () => [await count('SELECT count(*)::int AS n FROM works'), await count('SELECT count(*)::int AS n FROM work_scope_bindings'),
      await count("SELECT count(*)::int AS n FROM gpr2_command_ledger WHERE command_kind='finish-system.confirm'"), await count('SELECT count(*)::int AS n FROM audit_logs')];
    const dupError = (r: any) => r.ok ? 'OK' : [r.error.code, r.error.status, JSON.stringify(r.error.details?.violations)];
    const DUP = ['VALIDATION_FAILED', 422, JSON.stringify([{ path: 'localQuantities.1', rule: 'DUPLICATE_VALUE' }])];

    // ================================================================ IND3-01 — a new LOCAL obligation stated twice
    {
      const res: Record<string, any> = {};
      const R = await area('50');
      const v = await run(pm, 'finish-system.upsert', {}, { payload: { finishType: { code: code('FTD'), name: 'IND3 new' }, stages: [st('LK', 'LOCAL', 1)] } });
      const [ft, sv] = v.resultIds as string[];
      const valid = await preview(ft, sv, { areas: [R], local: [['LK', R, '10']] });   // a real fingerprint / scope to send with the repeated confirm
      const w0 = await writes();
      for (const [label, a, b] of [['10_then_20', '10', '20'], ['20_then_10', '20', '10'], ['20_and_20', '20', '20']]) {
        const sel: Sel = { areas: [R], local: [['LK', R, a], ['LK', R, b]] };
        const key = randomUUID();
        const p = await settle(preview(ft, sv, sel));
        const c1 = await confirm(ft, sv, sel, valid.scopeVersion, valid.previewFingerprint, key), c2 = await confirm(ft, sv, sel, valid.scopeVersion, valid.previewFingerprint, key);
        assert.deepEqual(dupError(p), DUP, label + ' preview'); assert.deepEqual(dupError(c1), DUP, label + ' confirm'); assert.deepEqual(dupError(c2), DUP, label + ' same key again');
        assert.equal(await count('SELECT count(*)::int AS n FROM gpr2_command_ledger WHERE idempotency_key=$1', [key]), 0, label + ': no ledger row');
        res[label] = { preview: dupError(p), confirm: dupError(c1), sameKeyAgain: dupError(c2) };
      }
      assert.deepEqual(await writes(), w0, 'no Work, binding, ledger or audit row');
      // authorization comes before the payload rule: a role without the grant / a РП without the object never learns about the duplicate
      const sel: Sel = { areas: [R], local: [['LK', R, '10'], ['LK', R, '20']] };
      const asAdmin: any = await confirm(ft, sv, sel, valid.scopeVersion, valid.previewFingerprint, randomUUID(), admin);
      const asOtherPm: any = await confirm(ft, sv, sel, valid.scopeVersion, valid.previewFingerprint, randomUUID(), otherPm);
      assert.deepEqual([asAdmin.ok ? 'OK' : asAdmin.error.code, asOtherPm.ok ? 'OK' : asOtherPm.error.code], ['PERMISSION_DENIED', 'RESOURCE_NOT_FOUND']);
      // distinct obligations stay valid: other AreaScope, a single statement, 20.0000
      const R2 = await area('50');
      for (const s of [{ areas: [R, R2], local: [['LK', R, '10'], ['LK', R2, '10']] }, { areas: [R], local: [['LK', R, '20']] }, { areas: [R], local: [['LK', R, '20.0000']] }] as Sel[]) {
        const p = await preview(ft, sv, s);
        assert.equal(p.canConfirm, true, JSON.stringify(s.local)); assert.deepEqual(p.blockers, []);
      }
      // and a valid confirm still writes exactly one Work with exactly the stated quantity
      const one20 = await preview(ft, sv, { areas: [R], local: [['LK', R, '20']] });
      const made = await confirm(ft, sv, { areas: [R], local: [['LK', R, '20']] }, one20.scopeVersion, one20.previewFingerprint);
      assert.ok(made.ok);
      assert.equal((await one(pool, 'SELECT planned_quantity::text AS q FROM works WHERE id=$1', [made.value.resultIds[0]])).q, '20.0000');
      evidence.newObligation = { ...res, authorization: { admin: 'PERMISSION_DENIED', otherPm: 'RESOURCE_NOT_FOUND' }, wroteNothing: true, distinctValid: true, validConfirmQuantity: '20.0000' };
    }

    // ================================================================ IND3-01 — existing LOCAL producer 20, the obligation restated twice
    {
      const res: Record<string, any> = {};
      const R = await area('50');
      const v1 = await run(pm, 'finish-system.upsert', {}, { payload: { finishType: { code: code('FTE'), name: 'IND3 existing' }, stages: [st('SAME_KEY', 'LOCAL', 1)] } });
      const [ft, sv1] = v1.resultIds as string[];
      const p1 = await preview(ft, sv1, { areas: [R], local: [['SAME_KEY', R, '20']] });
      const W = (await run(pm, 'finish-system.confirm', { id: ft }, confirmBody(sv1, { areas: [R], local: [['SAME_KEY', R, '20']] }, p1.scopeVersion, p1.previewFingerprint))).resultIds[0];
      const sv2 = (await run(pm, 'finish-system.upsert', {}, { payload: { finishTypeId: ft, stages: [st('SAME_KEY', 'LOCAL', 1), st('NEW_STAGE', 'MAIN', 2, Y)] } })).resultIds[1] as string;
      const valid = await preview(ft, sv2, { areas: [R], local: [['SAME_KEY', R, '20']] });
      assert.equal(valid.canConfirm, true);
      const producer = async () => (await pool.query("SELECT md5(string_agg(row_to_json(x)::text, '|' ORDER BY x.id)) AS d FROM (SELECT b.id, b.basis_quantity, w.planned_quantity, w.version FROM work_scope_bindings b JOIN works w ON w.id=b.work_id WHERE b.work_id=$1) x", [W])).rows[0].d;
      const h0 = await producer(), w0 = await writes();
      for (const [label, a, b] of [['30_then_20', '30', '20'], ['20_then_30', '20', '30'], ['20_and_20', '20', '20']]) {
        const sel: Sel = { areas: [R], local: [['SAME_KEY', R, a], ['SAME_KEY', R, b]] };
        const key = randomUUID();
        const p = await settle(preview(ft, sv2, sel));
        const c1 = await confirm(ft, sv2, sel, valid.scopeVersion, valid.previewFingerprint, key), c2 = await confirm(ft, sv2, sel, valid.scopeVersion, valid.previewFingerprint, key);
        assert.deepEqual(dupError(p), DUP, label + ' preview'); assert.deepEqual(dupError(c1), DUP, label + ' confirm'); assert.deepEqual(dupError(c2), DUP, label + ' same key again');
        res[label] = { preview: dupError(p), confirm: dupError(c1), sameKeyAgain: dupError(c2) };
      }
      assert.deepEqual(await writes(), w0, 'NEW_STAGE was not generated by any repeated request');
      assert.equal(await producer(), h0, 'the 20 producer is unchanged');
      evidence.existingProducer = { ...res, wroteNothing: true, producerUnchanged: true };
    }

    // ================================================================ IND3-02 — EXISTING per binding over several AreaScopes (MAIN and LOCAL)
    {
      const res: Record<string, any> = {};
      for (const scope of ['MAIN', 'LOCAL'] as const) {
        const A = await area(scope === 'MAIN' ? '600' : '50'), B = await area(scope === 'MAIN' ? '400' : '50');
        const local1: [string, string, string][] | undefined = scope === 'LOCAL' ? [['K', A, '20'], ['K', B, '10']] : undefined;
        const v1 = await run(pm, 'finish-system.upsert', {}, { payload: { finishType: { code: code('FTM'), name: 'IND3 multi ' + scope }, stages: [st('K', scope, 1)] } });
        const [ft, sv1] = v1.resultIds as string[];
        const p1 = await preview(ft, sv1, { areas: [A, B], local: local1 });
        const W = (await run(pm, 'finish-system.confirm', { id: ft }, confirmBody(sv1, { areas: [A, B], local: local1 }, p1.scopeVersion, p1.previewFingerprint))).resultIds[0];
        const total = scope === 'MAIN' ? '1000.0000' : '30.0000', [qa, qb] = scope === 'MAIN' ? ['600.0000', '400.0000'] : ['20.0000', '10.0000'];
        assert.equal((await one(pool, 'SELECT planned_quantity::text AS q FROM works WHERE id=$1', [W])).q, total);
        const sv2 = (await run(pm, 'finish-system.upsert', {}, { payload: { finishTypeId: ft, stages: [st('K', scope, 1), st('NEW', 'MAIN', 2, Y)] } })).resultIds[1] as string;
        const sel: Sel = { areas: [A, B] };
        const both = await preview(ft, sv2, sel), onlyA = await preview(ft, sv2, { areas: [A] });
        const k = (p: any) => p.items.filter((i: any) => i.occurrenceKey === 'K').map((i: any) => [i.areaScopeId === A ? 'A' : 'B', i.status, i.quantity]).sort();
        const ex = (p: any) => p.existingWorks.map((w: any) => [w.areaScopeId === A ? 'A' : 'B', w.workId === W, w.quantity, w.workPlannedQuantity]).sort();
        assert.deepEqual(k(both), [['A', 'EXISTING', qa], ['B', 'EXISTING', qb]], scope);
        assert.deepEqual(ex(both), [['A', true, qa, total], ['B', true, qb, total]], scope);
        assert.equal(both.existingWorks.reduce((t: number, w: any) => t + Number(w.quantity), 0), Number(total), scope + ': the rows of the one Work add up to the Work');
        assert.deepEqual(k(onlyA), [['A', 'EXISTING', qa]], scope + ' subset');
        assert.deepEqual(ex(onlyA), [['A', true, qa, total]], scope + ' subset');
        // preview -> confirm consistency: the confirm recomputes the same per-binding projection (same fingerprint) and creates only NEW
        const bindingsBefore = await count('SELECT count(*)::int AS n FROM work_scope_bindings WHERE work_id=$1', [W]);
        const kBindingsBefore = await count("SELECT count(*)::int AS n FROM work_scope_bindings WHERE finish_type_id=$1 AND occurrence_key='K'", [ft]);
        const c: any = await confirm(ft, sv2, sel, both.scopeVersion, both.previewFingerprint);
        assert.ok(c.ok, scope + ' confirm: ' + JSON.stringify(c.ok ? null : c.error?.code));
        assert.equal(c.value.resultIds.length, 1);
        assert.deepEqual((await pool.query('SELECT w.planned_quantity::text AS q, (SELECT count(*)::int FROM work_scope_bindings b WHERE b.work_id=w.id) AS n, (SELECT min(occurrence_key) FROM work_scope_bindings b WHERE b.work_id=w.id) AS k FROM works w WHERE w.id=$1', [c.value.resultIds[0]])).rows,
          [{ q: scope === 'MAIN' ? '1000.0000' : '100.0000', n: 2, k: 'NEW' }]);
        assert.equal(await count('SELECT count(*)::int AS n FROM work_scope_bindings WHERE work_id=$1', [W]), bindingsBefore, scope + ': the EXISTING Work got no binding');
        assert.equal(await count("SELECT count(*)::int AS n FROM work_scope_bindings WHERE finish_type_id=$1 AND occurrence_key='K'", [ft]), kBindingsBefore, scope + ': no new producer of K');
        assert.equal((await one(pool, 'SELECT planned_quantity::text AS q FROM works WHERE id=$1', [W])).q, total, scope + ': the Work quantity is unchanged');
        res[scope] = { work: total, previewAB: { items: k(both), existingWorks: ex(both) }, previewA: { items: k(onlyA), existingWorks: ex(onlyA) }, confirmCreatedOnly: 'NEW', existingWorkUnchanged: true };
      }
      evidence.multiArea = res;
    }

    assert.equal(await count("SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname=current_database() AND NOT l.granted"), 0, 'nobody is left waiting');
    evidence.scopeVersionAtEnd = await scopeVersion();
    evidence.result = 'PASS';
  } finally {
    await pool.end();
    await until(async () => Number((await observer.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()')).rows[0].n) === 0,
      'the pool backends to leave the test database').catch(() => undefined);
    recordEvidence('r05-ind3-native-summary', evidence);
    await observer.close(); await db.drop();
  }
});
