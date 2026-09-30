import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * FINAL-R06 — idempotency is retry safety, not an authorization mechanism.
 *
 * Against the previous corrective candidate (35d439a), createExecutionUnit()
 * and createQuantityPortion() checked their idempotency key BEFORE
 * objectAccess() — a caller who merely knew/reused another actor's
 * idempotency key could receive an existing row belonging to an object they
 * are not themselves authorized for, without ever having their own
 * authorization checked (FINAL-R06-A/B). recordPortionFact() and
 * requestPortionInspection() had the identical ordering problem against the
 * shared idempotent_commands ledger (FINAL-R06-D). Separately, that ledger's
 * own claimIdempotentCommand() never checked created_by at all, so a same-key
 * replay was not bound to the actor who first made it (FINAL-R06-C).
 *
 * This file proves the fix for all four operations named by FINAL-R06 using
 * two DIFFERENT PROJECT_MANAGER users in the same tenant — PM-A owns the
 * object under test, PM-B does not — since objectAccess() is what actually
 * restricts a PROJECT_MANAGER to their own assigned object. Sequential HTTP
 * calls only: this is an authorization-ordering property, not a concurrency
 * one, so PGlite is sufficient (a native-Postgres run below is redundant but
 * harmless — the harness supports both, matching this repo's other F12.3
 * dual-mode test files).
 */
test('FINAL-R06: an idempotency-key replay never bypasses the authorization the original operation requires — a PROJECT_MANAGER not assigned to the object cannot receive/replay another PM\'s Execution Unit, Portion, RP Fact confirmation or SC inspection request merely by reusing its key', async () => {
  if (!process.env.E2E_DATABASE_URL) delete process.env.DATABASE_URL;
  process.env.AUTH_MODE = 'mock';
  process.env.MOCK_LOGIN_KEY = 'f12-final-r06-key';
  process.env.DB_MODE = process.env.E2E_DATABASE_URL ? 'postgres' : 'pglite';
  process.env.PGLITE_DIR = 'memory://';
  if (process.env.E2E_DATABASE_URL) process.env.DATABASE_URL = process.env.E2E_DATABASE_URL;

  const { pool, one } = await import('../apps/backend/src/db');
  const { session } = await import('../apps/backend/src/security');
  const { migrate } = await import('../scripts/migrate');
  const { seed } = await import('../scripts/seed');
  const { createApp } = await import('../apps/backend/src/main');
  await migrate();
  await seed();
  const app = await createApp();
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  const base = `http://127.0.0.1:${address.port}`;
  let token = '';
  async function req(path: string, body?: any, expected = body === undefined ? 200 : 201, asToken = token) {
    const r = await fetch(base + '/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + asToken }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data: any = await r.json();
    assert.equal(r.status, expected, path + ': ' + JSON.stringify(data));
    return data;
  }
  async function asDeputy<T>(fn: () => Promise<T>): Promise<T> { const prev = token; await login('DEPUTY_DIRECTOR'); try { return await fn(); } finally { token = prev; } } // OBJ-1: object creation is Deputy/Admin authority; fixture only, the test's subject role is restored
  async function login(role: string) {
    const d = await req('auth/mock', { role, key: 'f12-final-r06-key' });
    token = d.token;
    return d.user;
  }
  const dt = (delta: number) => new Date(Date.now() + delta * 86400000).toISOString().slice(0, 10);
  const countRows = async (table: string, tenantId: string) => Number((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id=$1`, [tenantId])).rows[0].n);
  const countAudit = async (tenantId: string, entityType: string, entityId: string, action: string) => Number((await pool.query('SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id=$1 AND entity_type=$2 AND entity_id=$3 AND action=$4', [tenantId, entityType, entityId, action])).rows[0].n);
  const countLedger = async (tenantId: string, operation: string, idempotencyKey: string) => Number((await pool.query('SELECT count(*)::int AS n FROM idempotent_commands WHERE tenant_id=$1 AND operation=$2 AND idempotency_key=$3', [tenantId, operation, idempotencyKey])).rows[0].n);

  try {
    // ---- PM-A owns Object A; PM-B is a genuinely different PROJECT_MANAGER, not assigned to it ----
    const pmA = await login('PROJECT_MANAGER');
    const contractors = await req('contractors'), dict = await req('dictionaries');
    const tenantId = pmA.tenantId;
    const otherPmSummary = (await req('users')).find((u: any) => u.role === 'PROJECT_MANAGER' && u.id !== pmA.id);
    assert.ok(otherPmSummary, 'seed must carry at least two PROJECT_MANAGER users to prove cross-PM authorization');
    const pmBRow = await one(pool, 'SELECT * FROM users WHERE tenant_id=$1 AND id=$2', [tenantId, otherPmSummary.id]);
    const pmBGrant = await session(pmBRow, pool);
    const tokenB = pmBGrant.token;
    assert.notEqual(pmBRow.id, pmA.id);

    const c = contractors[0], workTypeId = dict.workTypes[0].id;
    const objectA = await asDeputy(() => req('objects', { externalCode: 'F12-R06-' + randomUUID(), name: 'FINAL-R06 Object A', address: 'Тест, 1', organizationName: 'ООО СЗ «Гор-Строй»', projectManagerId: pmA.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [c.id] }));
    const work = await req('works', { objectId: objectA.id, workTypeId, contractorId: c.id, responsibleUserId: pmA.id, name: 'Работа FINAL-R06', unit: 'м²', plannedQuantity: 100, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '10000' });

    /* ------------------------------------------------------------------- *
     * Scenario 1 — createExecutionUnit(): PM-B cannot replay PM-A's WEU    *
     * ------------------------------------------------------------------- */
    const unitBody = { objectWorkId: work.id, workTypeId, contractorId: c.id, unit: 'м²', plannedQuantity: 50 };
    const unitKey = randomUUID();
    const unitsBefore = await countRows('work_execution_units', tenantId);
    const weuA = await req('execution-units', { ...unitBody, idempotencyKey: unitKey }, 201, token);
    assert.equal(await countRows('work_execution_units', tenantId), unitsBefore + 1);
    // PM-B repeats the exact same endpoint, same key, same payload.
    const weuReplay = await req('execution-units', { ...unitBody, idempotencyKey: unitKey }, 403, tokenB);
    assert.match(weuReplay.message, /закреплён за другим РП/, 'PM-B must be rejected through authorization, not handed PM-A\'s Execution Unit');
    assert.equal(await countRows('work_execution_units', tenantId), unitsBefore + 1, 'PM-B\'s rejected replay must not create an extra row');
    assert.equal(await countAudit(tenantId, 'ExecutionUnit', weuA.id, 'CREATE'), 1, 'PM-B\'s rejected replay must not create an extra audit entry');

    /* ------------------------------------------------------------------- *
     * Scenario 2 — createQuantityPortion(): PM-B cannot replay PM-A's     *
     * Portion, through the parent Execution Unit's own object             *
     * ------------------------------------------------------------------- */
    const portionBody = { label: 'Секция FINAL-R06', plannedQuantity: 40 };
    const portionKey = randomUUID();
    const portionsBefore = await countRows('quantity_portions', tenantId);
    const portionA = await req(`execution-units/${weuA.id}/portions`, { ...portionBody, idempotencyKey: portionKey }, 201, token);
    assert.equal(await countRows('quantity_portions', tenantId), portionsBefore + 1);
    const portionReplay = await req(`execution-units/${weuA.id}/portions`, { ...portionBody, idempotencyKey: portionKey }, 403, tokenB);
    assert.match(portionReplay.message, /закреплён за другим РП/, 'PM-B must be rejected through authorization, not handed PM-A\'s Portion');
    assert.equal(await countRows('quantity_portions', tenantId), portionsBefore + 1, 'PM-B\'s rejected replay must not create an extra portion row');
    const sumAfterReplayAttempt = await one(pool, 'SELECT coalesce(sum(planned_quantity),0)::text AS total FROM quantity_portions WHERE tenant_id=$1 AND execution_unit_id=$2', [tenantId, weuA.id]);
    assert.equal(sumAfterReplayAttempt.total, '40.0000', 'the sum invariant must be unaffected by PM-B\'s rejected replay attempt');

    /* ------------------------------------------------------------------- *
     * Scenario 3 — recordPortionFact(): PM-B cannot replay PM-A's RP Fact *
     * confirmation. Also exercises the command-ledger's own behaviour:    *
     * same actor/same key/same payload replays; same actor/same key/     *
     * different payload is rejected; row/audit/ledger counts stay at one. *
     * ------------------------------------------------------------------- */
    const factKey = randomUUID();
    const confirmationsBefore = await countRows('portion_quantity_confirmations', tenantId);
    const factA = await req(`portions/${portionA.id}/fact`, { quantity: 40, version: portionA.version, comment: 'Факт PM-A', idempotencyKey: factKey }, 201, token);
    assert.equal(await countRows('portion_quantity_confirmations', tenantId), confirmationsBefore + 1);
    const portionVersionAfterFact = portionA.version + 1;
    const factBeforeReplayLedgerCount = await countLedger(tenantId, 'PORTION_FACT', factKey);
    assert.equal(factBeforeReplayLedgerCount, 1);

    // Different actor, same key, same payload: rejected — no replay, no new confirmation, no extra audit/event.
    const factReplayByB = await req(`portions/${portionA.id}/fact`, { quantity: 40, version: portionA.version, comment: 'Факт PM-A', idempotencyKey: factKey }, 403, tokenB);
    assert.match(factReplayByB.message, /закреплён за другим РП/, 'PM-B must be rejected through authorization, not handed PM-A\'s RP Fact confirmation');
    assert.equal(await countRows('portion_quantity_confirmations', tenantId), confirmationsBefore + 1, 'PM-B\'s rejected replay must not create an extra confirmation row');
    assert.equal(await countAudit(tenantId, 'QuantityPortion', portionA.id, 'RP_FACT'), 1, 'PM-B\'s rejected replay must not create an extra audit entry');
    assert.equal(await countLedger(tenantId, 'PORTION_FACT', factKey), 1, 'PM-B\'s rejected replay must not create a second ledger row for the same key');
    const portionAfterBAttempt = await one(pool, 'SELECT version FROM quantity_portions WHERE tenant_id=$1 AND id=$2', [tenantId, portionA.id]);
    assert.equal(portionAfterBAttempt.version, portionVersionAfterFact, 'PM-B\'s rejected replay must not bump the portion version');

    // Same actor (PM-A), same key, same payload: a genuine retry still replays the original response.
    const factReplayByA = await req(`portions/${portionA.id}/fact`, { quantity: 40, version: portionA.version, comment: 'Факт PM-A', idempotencyKey: factKey }, 201, token);
    assert.equal(factReplayByA.id, factA.id, 'PM-A\'s own retry with the same key/payload must replay the original confirmation');
    assert.equal(await countRows('portion_quantity_confirmations', tenantId), confirmationsBefore + 1, 'PM-A\'s own replay must not create an extra confirmation row');
    assert.equal(await countLedger(tenantId, 'PORTION_FACT', factKey), 1);

    // Same actor (PM-A), same key, DIFFERENT payload: rejected — a key is not reusable for a different command.
    const factConflictByA = await req(`portions/${portionA.id}/fact`, { quantity: 40, version: portionA.version, comment: 'Другой комментарий', idempotencyKey: factKey }, 400, token);
    assert.match(factConflictByA.message, /Idempotency key/);
    assert.equal(await countRows('portion_quantity_confirmations', tenantId), confirmationsBefore + 1);
    assert.equal(await countLedger(tenantId, 'PORTION_FACT', factKey), 1);

    /* ------------------------------------------------------------------- *
     * Scenario 4 — requestPortionInspection(): PM-B cannot replay PM-A's  *
     * inspection request                                                  *
     * ------------------------------------------------------------------- */
    const inspectionKey = randomUUID();
    const inspectionsBefore = await countRows('inspections', tenantId);
    const inspectionA = await req(`portions/${portionA.id}/inspection-request`, { inspectionType: 'INTERNAL_SC', version: portionVersionAfterFact, idempotencyKey: inspectionKey }, 201, token);
    assert.equal(await countRows('inspections', tenantId), inspectionsBefore + 1);
    const inspectionReplayByB = await req(`portions/${portionA.id}/inspection-request`, { inspectionType: 'INTERNAL_SC', version: portionVersionAfterFact, idempotencyKey: inspectionKey }, 403, tokenB);
    assert.match(inspectionReplayByB.message, /закреплён за другим РП/, 'PM-B must be rejected through authorization, not handed PM-A\'s inspection request');
    assert.equal(await countRows('inspections', tenantId), inspectionsBefore + 1, 'PM-B\'s rejected replay must not create an extra inspection row');
    assert.equal(await countAudit(tenantId, 'Inspection', inspectionA.id, 'REQUEST'), 1, 'PM-B\'s rejected replay must not create an extra audit entry');
    assert.equal(await countLedger(tenantId, 'PORTION_INSPECTION_REQUEST', inspectionKey), 1);

    console.log('FINAL-R06 VERIFIED: idempotency-key replay never bypasses objectAccess() for createExecutionUnit/createQuantityPortion/recordPortionFact/requestPortionInspection; the command ledger replays only for its originating actor');
  } finally {
    await app.close();
  }
});
