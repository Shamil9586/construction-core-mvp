import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * F12-SDO-03 re-verification: current F8.3 handoff/return/status-transition
 * paths only (handoffDocumentationPackageToSdo(), returnSdoCaseToPto(),
 * changeSdoClosingStatus() — service.ts). The legacy pre-F8.3 pipeline
 * (executive_packages/sdo_cases/financial_closings) is untouched.
 *
 * NOT A DEFECT, confirmed by re-inspection: every one of these already locks
 * and version-checks (or, for the Case's own creation, DB-uniqueness-checks)
 * the exact row it is about to mutate, inside the same transaction as the
 * write:
 *  - handoffDocumentationPackageToSdo() locks the Package FOR UPDATE, then
 *    checks `!existing || !existing.packageLocked` against the Case it is
 *    about to create/re-lock — a retry after a successful first call always
 *    finds packageLocked=true and is refused before any second Case or
 *    handoff-history row could be written. sdo_closing_cases_unique
 *    (infra/008_sdo_closing.sql, tenant_id+documentation_package_id) is a
 *    second, DB-level backstop for the same rule.
 *  - returnSdoCaseToPto()/changeSdoClosingStatus() both call checkVersion()
 *    on the Case, locked FOR UPDATE, before any write — a retry with the
 *    same (necessarily stale, since the first call already bumped it)
 *    version is rejected with 409 before a second history row can be
 *    written.
 * This test proves both hold, rather than adding unneeded idempotency-key
 * infrastructure to operations that already have correct retry semantics.
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

    // ---- handoffDocumentationPackageToSdo(): first call creates the one Case ----
    const casesBefore = await countRows('sdo_closing_cases', tenantId);
    const historyBefore = await countRows('sdo_closing_handoff_history', tenantId);
    const sdoCase1 = await req(`documentation-packages/${pkg.id}/handoff-to-sdo`, { version: pkg.version });
    assert.equal(await countRows('sdo_closing_cases', tenantId), casesBefore + 1);
    assert.equal(await countRows('sdo_closing_handoff_history', tenantId), historyBefore + 1);
    // Retry with the identical (still-valid — this operation never bumps the
    // Package's own version) request: refused via the packageLocked guard,
    // not a second Case or a second handoff-history row.
    const retryHandoff = await req(`documentation-packages/${pkg.id}/handoff-to-sdo`, { version: pkg.version }, 400);
    assert.match(retryHandoff.message, /уже передан/);
    assert.equal(await countRows('sdo_closing_cases', tenantId), casesBefore + 1, 'retry must not create a second SDO Case');
    assert.equal(await countRows('sdo_closing_handoff_history', tenantId), historyBefore + 1, 'retry must not create a second handoff-history row');

    // ---- returnSdoCaseToPto(): version-gated on the Case itself ----
    await login('SDO');
    const returned = await req(`sdo-closing-cases/${sdoCase1.id}/return-to-pto`, { version: sdoCase1.version });
    assert.equal(await countRows('sdo_closing_handoff_history', tenantId), historyBefore + 2);
    // Retry with the same (now stale) Case version: 409, not a second RETURNED_TO_PTO row.
    await req(`sdo-closing-cases/${sdoCase1.id}/return-to-pto`, { version: sdoCase1.version }, 409);
    assert.equal(await countRows('sdo_closing_handoff_history', tenantId), historyBefore + 2, 'a stale-version retry must not insert a second handoff-history row');

    // ---- re-handoff shares the identical existing/packageLocked guard proven above ----
    // returnSdoCaseToPto() already moved the Package straight to CORRECTING
    // as part of its own transaction (no separate "correction" call needed —
    // that dedicated endpoint is the *pre-handoff* correction start, and
    // refuses outright once any SDO Case exists at all). CORRECTING ->
    // PRESENTED is a direct edge (isDocumentationStatusTransitionAllowed).
    await login('PTO');
    pkg = (await req('documentation-packages')).find((x: any) => x.id === pkg.id);
    assert.equal(pkg.status, 'CORRECTING');
    pkg = await req(`documentation-packages/${pkg.id}/status`, { status: 'PRESENTED', version: pkg.version });
    pkg = await req(`documentation-packages/${pkg.id}/customer-acceptance`, { version: pkg.version, acceptedDate: dt(1), reference: 'Акт-2' });
    const sdoCase2 = await req(`documentation-packages/${pkg.id}/handoff-to-sdo`, { version: pkg.version });
    assert.equal(sdoCase2.id, sdoCase1.id, 're-handoff must resume the same Case, never create a second one');
    assert.equal(await countRows('sdo_closing_cases', tenantId), casesBefore + 1, 're-handoff must not create a second SDO Case');

    // ---- changeSdoClosingStatus(): version-gated on the Case itself ----
    await login('SDO');
    const statusHistoryBefore = await countRows('sdo_closing_status_history', tenantId);
    const passed = await req(`sdo-closing-cases/${sdoCase2.id}/status`, { status: 'VERIFICATION_PASSED', version: sdoCase2.version });
    assert.equal(await countRows('sdo_closing_status_history', tenantId), statusHistoryBefore + 1);
    // Retry with the same (now stale) Case version: 409, not a second status-history row.
    await req(`sdo-closing-cases/${sdoCase2.id}/status`, { status: 'VERIFICATION_PASSED', version: sdoCase2.version }, 409);
    assert.equal(await countRows('sdo_closing_status_history', tenantId), statusHistoryBefore + 1, 'a stale-version retry must not insert a second status-history row');
    assert.ok(passed.id);

    console.log('F12-SDO-03 VERIFIED: handoff/re-handoff/return/status-change all already retry-safe — no code change required');
  } finally {
    await app.close();
  }
});
