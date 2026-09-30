import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * F12-QTY-06 (LOCKED DECISION 2) re-verification, corrected for FINAL-R01/
 * FINAL-R02 (independent review of the first candidate, 424afaf).
 *
 * createExecutionUnit()/createQuantityPortion() are creates with no target
 * row to version-check against — a network retry, a timeout after the first
 * request already committed, or a double click can resubmit the exact same
 * logical command. FINAL-R01: the first candidate's SELECT-then-INSERT was
 * only *sequentially* idempotent — two genuinely concurrent same-key
 * transactions could both observe "not found" and both attempt to insert.
 * Sequential retry-safety (this file, PGlite-adequate) and concurrent
 * same-key convergence (tests/f12-final-corrective-postgres-concurrency.test.ts,
 * real PostgreSQL only) are both required; this file proves the former.
 *
 * FINAL-R02: recordPortionFact()/requestPortionInspection() were previously
 * (mis)classified "already retry-safe" because their existing version-gate
 * turns a retry into 409 instead of a duplicate row — true, but a 409 only
 * proves duplication was prevented, not that the client got back what its
 * first, possibly-unacknowledged call actually produced (LOCKED DECISION 2,
 * Option A). Both now accept an idempotencyKey: a retry carrying the same
 * key and payload returns/references the original response; a stale command
 * with no matching key (or a fresh one) still hits the exact same
 * version-gated 409 as before — that half of the original test is kept
 * un-weakened below, just no longer mislabelled as the whole story.
 */
test('F12-QTY-06: createExecutionUnit/createQuantityPortion are retry-safe with an idempotency key; recordPortionFact/requestPortionInspection are already retry-safe via version-gating', async () => {
  if (!process.env.E2E_DATABASE_URL) delete process.env.DATABASE_URL;
  process.env.AUTH_MODE = 'mock';
  process.env.MOCK_LOGIN_KEY = 'f12-qty-06-key';
  process.env.DB_MODE = process.env.E2E_DATABASE_URL ? 'postgres' : 'pglite';
  process.env.PGLITE_DIR = 'memory://';
  if (process.env.E2E_DATABASE_URL) process.env.DATABASE_URL = process.env.E2E_DATABASE_URL;

  const { pool } = await import('../apps/backend/src/db');
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
  async function req(path: string, body?: any, expected = body === undefined ? 200 : 201) {
    const r = await fetch(base + '/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data: any = await r.json();
    assert.equal(r.status, expected, path + ': ' + JSON.stringify(data));
    return data;
  }
  async function asDeputy<T>(fn: () => Promise<T>): Promise<T> { const prev = token; await login('DEPUTY_DIRECTOR'); try { return await fn(); } finally { token = prev; } } // OBJ-1: object creation is Deputy/Admin authority; fixture only, the test's subject role is restored
  async function login(role: string) {
    const d = await req('auth/mock', { role, key: 'f12-qty-06-key' });
    token = d.token;
    return d.user;
  }
  const dt = (delta: number) => new Date(Date.now() + delta * 86400000).toISOString().slice(0, 10);
  const countRows = async (table: string, tenantId: string) => Number((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id=$1`, [tenantId])).rows[0].n);

  try {
    const pm = await login('PROJECT_MANAGER');
    const contractors = await req('contractors'), dict = await req('dictionaries');
    const c = contractors[0], workTypeId = dict.workTypes[0].id;
    const o = await asDeputy(() => req('objects', { externalCode: 'F12-QTY06-' + randomUUID(), name: 'F12-QTY-06', address: 'Тест, 1', organizationName: 'ООО СЗ «Гор-Строй»', projectManagerId: pm.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [c.id] }));
    const w = await req('works', { objectId: o.id, workTypeId, contractorId: c.id, responsibleUserId: pm.id, name: 'Работа', unit: 'м²', plannedQuantity: 100, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '10000' });

    // ---- createExecutionUnit(): retry with the same key resolves to the same row ----
    const tenantId = (await req('me')).tenantId;
    const unitBody = { objectWorkId: w.id, workTypeId, contractorId: c.id, unit: 'м²', plannedQuantity: 50 };
    const unitKey = randomUUID();
    const before = await countRows('work_execution_units', tenantId);
    const unit1 = await req('execution-units', { ...unitBody, idempotencyKey: unitKey });
    const unit2 = await req('execution-units', { ...unitBody, idempotencyKey: unitKey });
    assert.equal(unit2.id, unit1.id, 'retry with the same idempotency key must return the same execution unit');
    assert.equal(await countRows('work_execution_units', tenantId), before + 1, 'retry must not insert a second execution unit row');
    // Reusing the same key with a materially different payload is rejected, not silently accepted as the same command.
    const unitConflict = await req('execution-units', { ...unitBody, plannedQuantity: 51, idempotencyKey: unitKey }, 400);
    assert.match(unitConflict.message, /Idempotency key/);
    assert.equal(await countRows('work_execution_units', tenantId), before + 1, 'a rejected mismatched-payload retry must not insert anything either');
    // A caller that never sends a key at all keeps the pre-existing (unprotected) behaviour — no regression for existing call sites.
    const unitNoKey = await req('execution-units', unitBody);
    assert.notEqual(unitNoKey.id, unit1.id);

    // ---- createQuantityPortion(): same pattern ----
    const portionBody = { label: 'Секция 1', plannedQuantity: 10 };
    const portionKey = randomUUID();
    const portionsBefore = await countRows('quantity_portions', tenantId);
    const portion1 = await req(`execution-units/${unit1.id}/portions`, { ...portionBody, idempotencyKey: portionKey });
    const portion2 = await req(`execution-units/${unit1.id}/portions`, { ...portionBody, idempotencyKey: portionKey });
    assert.equal(portion2.id, portion1.id, 'retry with the same idempotency key must return the same portion');
    assert.equal(await countRows('quantity_portions', tenantId), portionsBefore + 1, 'retry must not insert a second portion row');
    const portionConflict = await req(`execution-units/${unit1.id}/portions`, { ...portionBody, plannedQuantity: 11, idempotencyKey: portionKey }, 400);
    assert.match(portionConflict.message, /Idempotency key/);
    assert.equal(await countRows('quantity_portions', tenantId), portionsBefore + 1);

    // ---- recordPortionFact(): FINAL-R02 — true idempotency, not just duplicate prevention ----
    // recordPortionFact() returns the new confirmation row, not the portion —
    // the portion's own version (checked/bumped in the same transaction) is
    // tracked here independently: portion1.version, then +1 after one
    // successful fact, +2 after one successful inspection-request below.
    const confirmationsBefore = await countRows('portion_quantity_confirmations', tenantId);
    const factKey = randomUUID();
    const fact1 = await req(`portions/${portion1.id}/fact`, { quantity: 10, version: portion1.version, comment: 'Факт', idempotencyKey: factKey });
    assert.equal(await countRows('portion_quantity_confirmations', tenantId), confirmationsBefore + 1);
    // Retry with the SAME key/payload (the first call's version is now stale
    // — that is exactly the "client never saw the success response" case
    // Option A targets): must return the SAME confirmation, not a 409, and
    // must not insert a second row.
    const fact1Retry = await req(`portions/${portion1.id}/fact`, { quantity: 10, version: portion1.version, comment: 'Факт', idempotencyKey: factKey });
    assert.equal(fact1Retry.id, fact1.id, 'a same-key retry must return/reference the original confirmation, not 409');
    assert.equal(await countRows('portion_quantity_confirmations', tenantId), confirmationsBefore + 1, 'a same-key retry must not insert a second confirmation row');
    // Same key, materially different payload: rejected, not silently treated as the same command.
    const factConflict = await req(`portions/${portion1.id}/fact`, { quantity: 20, version: portion1.version, comment: 'Факт', idempotencyKey: factKey }, 400);
    assert.match(factConflict.message, /Idempotency key/);
    assert.equal(await countRows('portion_quantity_confirmations', tenantId), confirmationsBefore + 1);
    const portionVersionAfterFact = portion1.version + 1;
    // A genuinely new command (no key) with a stale version still hits the
    // exact same version guard as before this pass — idempotency handling
    // never converts a stale, unrelated command into success.
    await req(`portions/${portion1.id}/fact`, { quantity: 10, version: portion1.version, comment: 'Другая попытка' }, 409);
    assert.equal(await countRows('portion_quantity_confirmations', tenantId), confirmationsBefore + 1, 'a stale-version request with no matching key must still fail normally');

    // ---- requestPortionInspection(): FINAL-R02 — same true-idempotency fix ----
    const inspectionsBefore = await countRows('inspections', tenantId);
    const inspectionKey = randomUUID();
    const inspection1 = await req(`portions/${portion1.id}/inspection-request`, { inspectionType: 'INTERNAL_SC', version: portionVersionAfterFact, idempotencyKey: inspectionKey });
    assert.equal(await countRows('inspections', tenantId), inspectionsBefore + 1);
    const inspection1Retry = await req(`portions/${portion1.id}/inspection-request`, { inspectionType: 'INTERNAL_SC', version: portionVersionAfterFact, idempotencyKey: inspectionKey });
    assert.equal(inspection1Retry.id, inspection1.id, 'a same-key retry must return/reference the original inspection, not 409');
    assert.equal(await countRows('inspections', tenantId), inspectionsBefore + 1, 'a same-key retry must not insert a second inspection row');
    const inspectionConflict = await req(`portions/${portion1.id}/inspection-request`, { inspectionType: 'CUSTOMER_SC', version: portionVersionAfterFact, idempotencyKey: inspectionKey }, 400);
    assert.match(inspectionConflict.message, /Idempotency key/);
    // A genuinely new command (no key) with a stale version still 409s.
    await req(`portions/${portion1.id}/inspection-request`, { inspectionType: 'INTERNAL_SC', version: portionVersionAfterFact }, 409);
    assert.equal(await countRows('inspections', tenantId), inspectionsBefore + 1, 'a stale-version request with no matching key must still fail normally');
    assert.ok(inspection1.id);

    console.log('F12-QTY-06 VERIFIED: createExecutionUnit/createQuantityPortion retry-safe with idempotency key; recordPortionFact/requestPortionInspection now truly idempotent (same-result retry), stale unrelated commands still fail normally');
  } finally {
    await app.close();
  }
});
