import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * F12-SDO-03 re-verification, corrected for FINAL-R02 (independent review of
 * the first candidate, 424afaf): current F8.3 handoff/return/status-
 * transition paths only (handoffDocumentationPackageToSdo(),
 * returnSdoCaseToPto(), changeSdoClosingStatus() — service.ts). The legacy
 * pre-F8.3 pipeline (executive_packages/sdo_cases/financial_closings) is
 * untouched.
 *
 * All three already lock and version-check (or, for the Case's own
 * creation, DB-uniqueness-check) the exact row they mutate, inside the same
 * transaction as the write — that was, and remains, correct: it prevents a
 * second Case/history row from ever being written. What the first
 * candidate mislabelled is what a retry gets back once that guard fires:
 * 400 ("уже передан")/409 only prove duplication was prevented, never that
 * the caller received what its own first, possibly-unacknowledged call
 * actually produced (LOCKED DECISION 2, Option A). All three now accept an
 * idempotencyKey: a retry carrying the same key and payload returns/
 * references the original response instead of that error; a stale command
 * with no matching key (or a fresh one) still hits the exact same guard as
 * before — proven below, not merely asserted away.
 */
test('F12-SDO-03: handoff/return/status-change are already retry-safe via Package-first locking, version-gating and sdo_closing_cases_unique', async () => {
  if (!process.env.E2E_DATABASE_URL) delete process.env.DATABASE_URL;
  process.env.AUTH_MODE = 'mock';
  process.env.MOCK_LOGIN_KEY = 'f12-sdo-03-key';
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
  async function login(role: string) {
    const d = await req('auth/mock', { role, key: 'f12-sdo-03-key' });
    token = d.token;
    return d.user;
  }
  const dt = (delta: number) => new Date(Date.now() + delta * 86400000).toISOString().slice(0, 10);
  const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=';
  const countRows = async (table: string, tenantId: string) => Number((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id=$1`, [tenantId])).rows[0].n);

  try {
    const pm = await login('PROJECT_MANAGER');
    const dict = await req('dictionaries'), contractors = await req('contractors');
    const tenantId = pm.tenantId;
    const o = await req('objects', { externalCode: 'F12-SDO03-' + randomUUID(), name: 'F12-SDO-03', address: 'Тест, 1', organizationName: 'ООО СЗ «Гор-Строй»', projectManagerId: pm.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [contractors[0].id] });
    const work = await req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, responsibleUserId: pm.id, name: 'Работа', unit: 'м²', plannedQuantity: 200, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '100000' });
    const unit = await req('execution-units', { objectWorkId: work.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, unit: 'м²', plannedQuantity: 200 });
    const portion = await req(`execution-units/${unit.id}/portions`, { label: 'Секция A', plannedQuantity: 200 });
    await req(`portions/${portion.id}/fact`, { quantity: 200, version: portion.version });
    const custRequest = await req(`portions/${portion.id}/inspection-request`, { inspectionType: 'CUSTOMER_SC', version: portion.version + 1 });

    await login('CONSTRUCTION_CONTROL');
    const attachment = await req('attachments', { fileName: 'sc.png', mimeType: 'image/png', base64: PNG_BASE64 });
    await req(`inspections/${custRequest.id}/photos`, { attachmentId: attachment.id });
    await req(`inspections/${custRequest.id}/accept`, { version: custRequest.version, comment: 'Подтверждено', quantity: 200 });

    const pto = await login('PTO');
    let pkg = await req('documentation-packages', { objectWorkId: work.id, responsibleUserId: pto.id });
    await req(`documentation-packages/${pkg.id}/portions`, { quantityPortionId: portion.id });
    const doc = await req(`documentation-packages/${pkg.id}/documents`, { type: 'AOSR' });
    await req(`documentation-documents/${doc.id}/versions`, { storageProvider: 'NONE' });
    pkg = await req(`documentation-packages/${pkg.id}/status`, { status: 'PREPARING', version: pkg.version });
    pkg = await req(`documentation-packages/${pkg.id}/status`, { status: 'READY_FOR_PRESENTATION', version: pkg.version });
    pkg = await req(`documentation-packages/${pkg.id}/status`, { status: 'PRESENTED', version: pkg.version });
    pkg = await req(`documentation-packages/${pkg.id}/customer-acceptance`, { version: pkg.version, acceptedDate: dt(0), reference: 'Акт-1' });

    // ---- handoffDocumentationPackageToSdo(): FINAL-R02 — true idempotency ----
    const casesBefore = await countRows('sdo_closing_cases', tenantId);
    const historyBefore = await countRows('sdo_closing_handoff_history', tenantId);
    const handoffKey = randomUUID();
    const sdoCase1 = await req(`documentation-packages/${pkg.id}/handoff-to-sdo`, { version: pkg.version, idempotencyKey: handoffKey });
    assert.equal(await countRows('sdo_closing_cases', tenantId), casesBefore + 1);
    assert.equal(await countRows('sdo_closing_handoff_history', tenantId), historyBefore + 1);
    // Retry with the SAME key/payload (this operation never bumps the
    // Package's own version, so a real retry is byte-identical): must
    // return/reference the same Case, not the packageLocked-guard error.
    const handoffRetry = await req(`documentation-packages/${pkg.id}/handoff-to-sdo`, { version: pkg.version, idempotencyKey: handoffKey });
    assert.equal(handoffRetry.id, sdoCase1.id, 'a same-key retry must return/reference the original Case, not "уже передан"');
    assert.equal(await countRows('sdo_closing_cases', tenantId), casesBefore + 1, 'retry must not create a second SDO Case');
    assert.equal(await countRows('sdo_closing_handoff_history', tenantId), historyBefore + 1, 'retry must not create a second handoff-history row');
    // A genuinely new command (no key) hits the exact same packageLocked guard as before this pass.
    const noKeyRetry = await req(`documentation-packages/${pkg.id}/handoff-to-sdo`, { version: pkg.version }, 400);
    assert.match(noKeyRetry.message, /уже передан/);
    assert.equal(await countRows('sdo_closing_cases', tenantId), casesBefore + 1);

    // ---- returnSdoCaseToPto(): FINAL-R02 — true idempotency ----
    await login('SDO');
    const returnKey = randomUUID();
    const returned = await req(`sdo-closing-cases/${sdoCase1.id}/return-to-pto`, { version: sdoCase1.version, idempotencyKey: returnKey });
    assert.equal(await countRows('sdo_closing_handoff_history', tenantId), historyBefore + 2);
    // Retry with the SAME key/payload (the first call's version is now
    // stale — exactly the "client never saw success" case): must return the
    // same result, not 409, and must not insert a second history row.
    const returnRetry = await req(`sdo-closing-cases/${sdoCase1.id}/return-to-pto`, { version: sdoCase1.version, idempotencyKey: returnKey });
    assert.equal(returnRetry.id, returned.id, 'a same-key retry must return/reference the original result, not 409');
    assert.equal(await countRows('sdo_closing_handoff_history', tenantId), historyBefore + 2, 'a same-key retry must not insert a second handoff-history row');
    // A genuinely new command (no key) with the same stale version still 409s, exactly as before this pass.
    await req(`sdo-closing-cases/${sdoCase1.id}/return-to-pto`, { version: sdoCase1.version }, 409);
    assert.equal(await countRows('sdo_closing_handoff_history', tenantId), historyBefore + 2, 'a stale-version request with no matching key must still fail normally');

    // ---- re-handoff shares the identical existing/packageLocked guard proven above ----
    // returnSdoCaseToPto() already moved the Package straight to CORRECTING
    // as part of its own transaction (no separate "correction" call needed —
    // that dedicated endpoint is the *pre-handoff* correction start, and
    // refuses outright once any SDO Case exists at all). CORRECTING ->
    // PRESENTED is a direct edge (isDocumentationStatusTransitionAllowed).
    // A fresh idempotency key here proves first-handoff and re-handoff stay
    // semantically distinct commands — this is never treated as a replay of
    // the earlier handoffKey attempt above.
    await login('PTO');
    pkg = (await req('documentation-packages')).find((x: any) => x.id === pkg.id);
    assert.equal(pkg.status, 'CORRECTING');
    pkg = await req(`documentation-packages/${pkg.id}/status`, { status: 'PRESENTED', version: pkg.version });
    pkg = await req(`documentation-packages/${pkg.id}/customer-acceptance`, { version: pkg.version, acceptedDate: dt(1), reference: 'Акт-2' });
    const sdoCase2 = await req(`documentation-packages/${pkg.id}/handoff-to-sdo`, { version: pkg.version, idempotencyKey: randomUUID() });
    assert.equal(sdoCase2.id, sdoCase1.id, 're-handoff must resume the same Case, never create a second one');
    assert.equal(await countRows('sdo_closing_cases', tenantId), casesBefore + 1, 're-handoff must not create a second SDO Case');

    // ---- changeSdoClosingStatus(): FINAL-R02 — true idempotency ----
    await login('SDO');
    const statusHistoryBefore = await countRows('sdo_closing_status_history', tenantId);
    const statusKey = randomUUID();
    const passed = await req(`sdo-closing-cases/${sdoCase2.id}/status`, { status: 'VERIFICATION_PASSED', version: sdoCase2.version, idempotencyKey: statusKey });
    assert.equal(await countRows('sdo_closing_status_history', tenantId), statusHistoryBefore + 1);
    // Retry with the SAME key/payload: must return the same result, not 409.
    const passedRetry = await req(`sdo-closing-cases/${sdoCase2.id}/status`, { status: 'VERIFICATION_PASSED', version: sdoCase2.version, idempotencyKey: statusKey });
    assert.equal(passedRetry.id, passed.id, 'a same-key retry must return/reference the original result, not 409');
    assert.equal(await countRows('sdo_closing_status_history', tenantId), statusHistoryBefore + 1, 'a same-key retry must not insert a second status-history row');
    // Same key, a different target status: rejected as a different command, never silently applied.
    const statusConflict = await req(`sdo-closing-cases/${sdoCase2.id}/status`, { status: 'ON_CORRECTION', version: sdoCase2.version, reason: 'x', idempotencyKey: statusKey }, 400);
    assert.match(statusConflict.message, /Idempotency key/);
    // A genuinely new command (no key) with the same stale version still 409s.
    await req(`sdo-closing-cases/${sdoCase2.id}/status`, { status: 'VERIFICATION_PASSED', version: sdoCase2.version }, 409);
    assert.equal(await countRows('sdo_closing_status_history', tenantId), statusHistoryBefore + 1, 'a stale-version request with no matching key must still fail normally');
    assert.ok(passed.id);

    console.log('F12-SDO-03 VERIFIED: handoff/re-handoff/return/status-change now truly idempotent (same-result retry) without weakening version-gating for genuinely new/stale commands');
  } finally {
    await app.close();
  }
});
