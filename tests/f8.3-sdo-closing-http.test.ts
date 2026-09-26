import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * F8.3 SDO / Closing — HTTP-level, over the real backend, PGlite. Same
 * harness shape tests/f8.2.1-pto-operations-http.test.ts already uses.
 *
 * Covers the F8.3 accepted contract's required backend/domain scenarios
 * 1-26. Pure-logic coverage of isSdoClosingStatusTransitionAllowed/
 * resolvePackageSdoReadiness/SdoClosingAllocationService lives in
 * tests/f8.3-domain.test.ts; this file proves the controllers/routes/DTOs/
 * permissions/locking are wired correctly end to end.
 */

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=';

const dt = (delta: number) => new Date(Date.now() + delta * 86400000).toISOString().slice(0, 10);

async function harness() {
  if (!process.env.E2E_DATABASE_URL) delete process.env.DATABASE_URL;
  process.env.AUTH_MODE = 'mock';
  process.env.MOCK_LOGIN_KEY = 'f8-3-http-key';
  process.env.DB_MODE = process.env.E2E_DATABASE_URL ? 'postgres' : 'pglite';
  process.env.PGLITE_DIR = 'memory://';
  if (process.env.E2E_DATABASE_URL) process.env.DATABASE_URL = process.env.E2E_DATABASE_URL;

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
    const d = await req('auth/mock', { role, key: 'f8-3-http-key' });
    token = d.token;
    return d.user;
  }
  return { app, req, login };
}

/**
 * Builds one object/work/execution-unit/portion, brings the portion to a
 * full RP fact + ACCEPTED Customer SC confirmation, and one Documentation
 * Package covering that portion through PRESENTED — i.e. readiness
 * criterion (a) satisfied, (b) not yet. Ends logged in as PTO.
 */
async function setUpPresentedPackage(req: any, login: any, code: string, name: string) {
  const pm = await login('PROJECT_MANAGER');
  const dict = await req('dictionaries');
  const contractors = await req('contractors');
  await login('TECHNICAL_DIRECTOR');
  const o = await req('objects', { externalCode: code, name, address: 'Тест, 1', organizationName: 'ООО СЗ «Гор-Строй»', projectManagerId: pm.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [contractors[0].id] });
  await login('PROJECT_MANAGER');
  const work = await req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, responsibleUserId: pm.id, name, unit: 'м²', plannedQuantity: 500, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '100000' });
  const unit = await req('execution-units', { objectWorkId: work.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, unit: 'м²', plannedQuantity: 500 });
  const portion = await req(`execution-units/${unit.id}/portions`, { label: 'Секция A', plannedQuantity: 200 });
  await req(`portions/${portion.id}/fact`, { quantity: 200, version: portion.version });
  const custRequest = await req(`portions/${portion.id}/inspection-request`, { inspectionType: 'CUSTOMER_SC', version: portion.version + 1 });

  const cc = await login('CONSTRUCTION_CONTROL');
  const attachment = await req('attachments', { fileName: 'sc.png', mimeType: 'image/png', base64: PNG_BASE64 });
  await req(`inspections/${custRequest.id}/photos`, { attachmentId: attachment.id });
  await req(`inspections/${custRequest.id}/accept`, { version: custRequest.version, comment: 'Подтверждено', quantity: 200 });

  const pto = await login('PTO');
  const pkg = await req('documentation-packages', { objectWorkId: work.id, responsibleUserId: pto.id });
  await req(`documentation-packages/${pkg.id}/portions`, { quantityPortionId: portion.id });
  const doc = await req(`documentation-packages/${pkg.id}/documents`, { type: 'AOSR' });
  await req(`documentation-documents/${doc.id}/versions`, { storageProvider: 'NONE' });
  let p = await req(`documentation-packages/${pkg.id}/status`, { status: 'PREPARING', version: pkg.version });
  p = await req(`documentation-packages/${pkg.id}/status`, { status: 'READY_FOR_PRESENTATION', version: p.version });
  p = await req(`documentation-packages/${pkg.id}/status`, { status: 'PRESENTED', version: p.version });

  return { pm, pto, cc, object: o, work, unit, portion, pkg: p, doc };
}

/** setUpPresentedPackage() + customer-acceptance registration (readiness true) + handoff. Ends logged in as PTO. */
async function setUpHandedOffCase(req: any, login: any, code: string, name: string) {
  const ctx = await setUpPresentedPackage(req, login, code, name);
  await login('PTO');
  const accepted = await req(`documentation-packages/${ctx.pkg.id}/customer-acceptance`, { version: ctx.pkg.version, acceptedDate: dt(0), reference: 'Акт-1' });
  const sdoCase = await req(`documentation-packages/${accepted.id}/handoff-to-sdo`, { version: accepted.version });
  return { ...ctx, pkg: accepted, sdoCase };
}

/* --------------------------------------------------------------------- *
 * 1-4: visibility and readiness                                          *
 * --------------------------------------------------------------------- */

test('F8.3 HTTP (1): an upcoming package is visible to SDO before it is ready — SDO still has no F8.2 access', async () => {
  const { app, req, login } = await harness();
  try {
    const pm = await login('PROJECT_MANAGER');
    const dict = await req('dictionaries');
    const contractors = await req('contractors');
    await login('TECHNICAL_DIRECTOR');
    const o = await req('objects', { externalCode: 'F83-UP-' + Date.now(), name: 'F8.3 очередь СДО', address: 'Тест, 1', organizationName: 'ООО СЗ «Гор-Строй»', projectManagerId: pm.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [contractors[0].id] });
    await login('PROJECT_MANAGER');
    const work = await req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, responsibleUserId: pm.id, name: 'Работа', unit: 'м²', plannedQuantity: 100, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '20000' });
    const pto = await login('PTO');
    const pkg = await req('documentation-packages', { objectWorkId: work.id, responsibleUserId: pto.id });

    await login('SDO');
    const snapshot = await req('snapshot');
    assert.equal(snapshot.documentationPackages, undefined, 'SDO still has no F8.2 access at all');
    const item = snapshot.sdoPackageReadiness.find((x: any) => x.documentationPackageId === pkg.id);
    assert.ok(item, 'DRAFT package with no portions is visible to SDO before readiness');
    assert.equal(item.ready, false);
    assert.equal(item.objectWorkId, work.id);
    assert.equal(item.handoffPending, false);
  } finally {
    await app.close();
  }
});

test('F8.3 HTTP (4): readiness is false while customer documentation acceptance is missing, even once Customer SC is confirmed', async () => {
  const { app, req, login } = await harness();
  try {
    const { pkg } = await setUpPresentedPackage(req, login, 'F83-READY-B-' + Date.now(), 'F8.3 готовность (б)');
    await login('SDO');
    const snapshot = await req('snapshot');
    const item = snapshot.sdoPackageReadiness.find((x: any) => x.documentationPackageId === pkg.id);
    assert.equal(item.ready, false);
    assert.ok(item.missingReasons.some((r: string) => /заказчика/.test(r)));
  } finally {
    await app.close();
  }
});

test('F8.3 HTTP (3): readiness is false when the Customer SC quantity confirmation is missing, even once documentation is accepted', async () => {
  const { app, req, login } = await harness();
  try {
    const pm = await login('PROJECT_MANAGER');
    const dict = await req('dictionaries');
    const contractors = await req('contractors');
    await login('TECHNICAL_DIRECTOR');
    const o = await req('objects', { externalCode: 'F83-READY-A-' + Date.now(), name: 'F8.3 готовность (а)', address: 'Тест, 1', organizationName: 'ООО СЗ «Гор-Строй»', projectManagerId: pm.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [contractors[0].id] });
    await login('PROJECT_MANAGER');
    const work = await req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, responsibleUserId: pm.id, name: 'Работа', unit: 'м²', plannedQuantity: 200, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '20000' });
    const unit = await req('execution-units', { objectWorkId: work.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, unit: 'м²', plannedQuantity: 200 });
    const portion = await req(`execution-units/${unit.id}/portions`, { label: 'Секция A', plannedQuantity: 200 });
    // No Customer SC confirmation recorded for this portion at all.
    const pto = await login('PTO');
    let pkg = await req('documentation-packages', { objectWorkId: work.id, responsibleUserId: pto.id });
    await req(`documentation-packages/${pkg.id}/portions`, { quantityPortionId: portion.id });
    const doc = await req(`documentation-packages/${pkg.id}/documents`, { type: 'AOSR' });
    await req(`documentation-documents/${doc.id}/versions`, { storageProvider: 'NONE' });
    pkg = await req(`documentation-packages/${pkg.id}/status`, { status: 'PREPARING', version: pkg.version });
    pkg = await req(`documentation-packages/${pkg.id}/status`, { status: 'READY_FOR_PRESENTATION', version: pkg.version });
    pkg = await req(`documentation-packages/${pkg.id}/status`, { status: 'PRESENTED', version: pkg.version });
    pkg = await req(`documentation-packages/${pkg.id}/customer-acceptance`, { version: pkg.version, acceptedDate: dt(0) });
    assert.equal(pkg.status, 'ACCEPTED_BY_CUSTOMER');

    await login('SDO');
    const snapshot = await req('snapshot');
    const item = snapshot.sdoPackageReadiness.find((x: any) => x.documentationPackageId === pkg.id);
    assert.equal(item.ready, false);
    assert.ok(item.missingReasons.some((r: string) => /СК заказчика/.test(r)));
  } finally {
    await app.close();
  }
});

/* --------------------------------------------------------------------- *
 * Source-of-truth: the audited acceptance record, never the status alone *
 * --------------------------------------------------------------------- */

test('F8.3 HTTP: readiness and handoff deny a package whose status was flipped to ACCEPTED_BY_CUSTOMER WITHOUT the dedicated registration operation — proves status alone is not the authoritative signal', async () => {
  const { app, req, login } = await harness();
  try {
    // Dynamically imported, and only after harness() has set DB_MODE/PGLITE_DIR
    // and already imported apps/backend/src/main (which imports ./db) — a
    // static top-level import in this file would construct its own `pool`
    // before those env vars exist, a different instance than the one the
    // app under test actually uses, and every test in this file would then
    // silently talk to two different databases.
    const { pool } = await import('../apps/backend/src/db');
    const { pkg } = await setUpPresentedPackage(req, login, 'F83-TRUST-STATUS-' + Date.now(), 'F8.3 доверие только статусу');

    // White-box: the ONLY legitimate path to ACCEPTED_BY_CUSTOMER is
    // registerDocumentationCustomerAcceptance(), which always inserts a row
    // into documentation_customer_acceptances in the same transaction as the
    // status flip (service.ts). This simulates a hypothetical bug or a
    // direct data edit that flips the status while skipping that insert —
    // bypassing the API entirely — to prove the readiness gate does not
    // merely trust the status column.
    await pool.query('UPDATE documentation_packages SET status=$3,version=version+1 WHERE tenant_id=$1 AND id=$2', [pkg.tenantId, pkg.id, 'ACCEPTED_BY_CUSTOMER']);
    const corrupted = await pool.query('SELECT version FROM documentation_packages WHERE tenant_id=$1 AND id=$2', [pkg.tenantId, pkg.id]);
    const corruptedVersion = corrupted.rows[0].version;
    const noAcceptanceRow = await pool.query('SELECT id FROM documentation_customer_acceptances WHERE tenant_id=$1 AND documentation_package_id=$2', [pkg.tenantId, pkg.id]);
    assert.equal(noAcceptanceRow.rows.length, 0, 'sanity check: no acceptance record exists for this corrupted package');

    await login('SDO');
    const snapshot = await req('snapshot');
    const item = snapshot.sdoPackageReadiness.find((x: any) => x.documentationPackageId === pkg.id);
    assert.equal(item.ready, false, 'status alone must not satisfy readiness');
    assert.ok(item.missingReasons.some((r: string) => /заказчика/.test(r)));

    await login('PTO');
    await req(`documentation-packages/${pkg.id}/handoff-to-sdo`, { version: corruptedVersion }, 400);
  } finally {
    await app.close();
  }
});

test('F8.3 HTTP: a customer documentation acceptance record from before a correction cycle does not, by itself, satisfy readiness after "Вернуть в ПТО" — the record must be current, not merely exist', async () => {
  const { app, req, login } = await harness();
  try {
    const { pool } = await import('../apps/backend/src/db');
    const { pkg, sdoCase } = await setUpHandedOffCase(req, login, 'F83-STALE-ACCEPT-' + Date.now(), 'F8.3 устаревшее согласие');

    await login('SDO');
    const returned = await req(`sdo-closing-cases/${sdoCase.id}/return-to-pto`, { version: sdoCase.version });
    assert.equal(returned.packageLocked, false);

    // The original acceptance record from before the correction still
    // exists (append-only, immutable — never deleted or edited), but the
    // package is no longer ACCEPTED_BY_CUSTOMER (return-to-PTO moved it to
    // CORRECTING), so that record must not count as current.
    const stillExists = await pool.query('SELECT id FROM documentation_customer_acceptances WHERE tenant_id=$1 AND documentation_package_id=$2', [pkg.tenantId, pkg.id]);
    assert.equal(stillExists.rows.length, 1, 'sanity check: the earlier acceptance record was never deleted');

    const snapshot = await req('snapshot');
    const item = snapshot.sdoPackageReadiness.find((x: any) => x.documentationPackageId === pkg.id);
    assert.equal(item.ready, false, 'a stale acceptance record from before the correction must not satisfy readiness');
    assert.ok(item.missingReasons.some((r: string) => /заказчика/.test(r)));

    await login('PTO');
    await req(`documentation-packages/${pkg.id}/handoff-to-sdo`, { version: pkg.version + 1 }, 400);
  } finally {
    await app.close();
  }
});

/* --------------------------------------------------------------------- *
 * F8.3-R02 corrective: acceptance bound to real document versions        *
 * --------------------------------------------------------------------- */

test('F8.3-R02 (1): customer-acceptance snapshots the actual documentation_document_versions id, never documentation_packages.version', async () => {
  const { app, req, login } = await harness();
  try {
    const { pkg, doc } = await setUpPresentedPackage(req, login, 'F83-R02-SNAP-' + Date.now(), 'F8.3 снимок версии документа');
    await login('PTO');
    const accepted = await req(`documentation-packages/${pkg.id}/customer-acceptance`, { version: pkg.version, acceptedDate: dt(0), reference: 'Акт-Снимок' });

    const snap = await req('snapshot');
    const actualVersion = snap.documentationVersions.find((v: any) => v.documentationDocumentId === doc.id);
    assert.ok(actualVersion, 'sanity check: the fixture document has a version');

    const acceptanceRecord = snap.documentationCustomerAcceptances.find((a: any) => a.documentationPackageId === accepted.id);
    assert.ok(acceptanceRecord, 'sanity check: the acceptance record itself exists');
    const versionLinks = snap.documentationCustomerAcceptanceVersions.filter((v: any) => v.customerAcceptanceId === acceptanceRecord.id);
    assert.equal(versionLinks.length, 1, 'one snapshot row for the package\'s one document');
    assert.equal(versionLinks[0].documentationDocumentVersionId, actualVersion.id, 'the snapshot records the real documentation_document_versions id — not documentation_packages.version, a package-row optimistic-lock counter in an entirely different id space');
  } finally {
    await app.close();
  }
});

test('F8.3-R02 (2): a document version added after the accepted presentation cannot silently remain covered by the old acceptance', async () => {
  const { app, req, login } = await harness();
  try {
    const { pkg, doc } = await setUpPresentedPackage(req, login, 'F83-R02-STALE-' + Date.now(), 'F8.3 версия после согласия');
    await login('PTO');
    const accepted = await req(`documentation-packages/${pkg.id}/customer-acceptance`, { version: pkg.version, acceptedDate: dt(0), reference: 'Акт-1' });

    let snap = await req('snapshot');
    let item = snap.sdoPackageReadiness.find((x: any) => x.documentationPackageId === accepted.id);
    assert.equal(item.ready, true, 'sanity check: ready immediately after a fresh, current acceptance');

    // Nothing in createDocumentationVersion() requires returning to PTO or
    // re-presenting first — the package stays ACCEPTED_BY_CUSTOMER and the
    // original acceptance row is untouched (append-only), but it no longer
    // represents what the customer actually saw.
    await req(`documentation-documents/${doc.id}/versions`, { storageProvider: 'EXTERNAL_REFERENCE', storageReference: 'https://example.test/v2' });

    snap = await req('snapshot');
    item = snap.sdoPackageReadiness.find((x: any) => x.documentationPackageId === accepted.id);
    assert.equal(item.ready, false, 'a new document version after acceptance must invalidate the now-stale snapshot');
    assert.ok(item.missingReasons.some((r: string) => /заказчика/.test(r)));

    await req(`documentation-packages/${accepted.id}/handoff-to-sdo`, { version: accepted.version }, 400);
  } finally {
    await app.close();
  }
});

test('F8.3-R02 (3): a new presentation/acceptance cycle creates a new immutable snapshot — the earlier one is preserved, never edited', async () => {
  const { app, req, login } = await harness();
  try {
    const { pkg, sdoCase, doc } = await setUpHandedOffCase(req, login, 'F83-R02-CYCLE-' + Date.now(), 'F8.3 повторное согласие: новый снимок');

    await login('SDO');
    await req(`sdo-closing-cases/${sdoCase.id}/return-to-pto`, { version: sdoCase.version });

    await login('PTO');
    await req(`documentation-documents/${doc.id}/versions`, { storageProvider: 'EXTERNAL_REFERENCE', storageReference: 'https://example.test/corrected' });
    const p = await req(`documentation-packages/${pkg.id}/status`, { status: 'PRESENTED', version: pkg.version + 1 });
    const reaccepted = await req(`documentation-packages/${p.id}/customer-acceptance`, { version: p.version, acceptedDate: dt(0), reference: 'Акт-2' });

    const snap = await req('snapshot');
    const acceptances = snap.documentationCustomerAcceptances.filter((a: any) => a.documentationPackageId === pkg.id);
    assert.equal(acceptances.length, 2, 'both the original and the new acceptance record are preserved — append-only, never overwritten');
    const [original, latest] = acceptances;
    assert.equal(latest.reference, 'Акт-2');

    const originalLinks = snap.documentationCustomerAcceptanceVersions.filter((v: any) => v.customerAcceptanceId === original.id);
    const latestLinks = snap.documentationCustomerAcceptanceVersions.filter((v: any) => v.customerAcceptanceId === latest.id);
    assert.equal(originalLinks.length, 1);
    assert.equal(latestLinks.length, 1);
    assert.notEqual(originalLinks[0].documentationDocumentVersionId, latestLinks[0].documentationDocumentVersionId, 'the new snapshot points at the corrected version, distinct from the original snapshot — neither row was edited in place');

    const currentVersion = snap.documentationVersions.filter((v: any) => v.documentationDocumentId === doc.id).slice(-1)[0];
    assert.equal(latestLinks[0].documentationDocumentVersionId, currentVersion.id);

    const item = snap.sdoPackageReadiness.find((x: any) => x.documentationPackageId === pkg.id);
    assert.equal(item.ready, true, 'readiness now uses the new, current snapshot');
    const relocked = await req(`documentation-packages/${reaccepted.id}/handoff-to-sdo`, { version: reaccepted.version });
    assert.equal(relocked.id, sdoCase.id, 'the same Case resumes');
  } finally {
    await app.close();
  }
});

test('F8.3-R02 (4): a Package with multiple Documentation Documents records every relevant accepted version in the snapshot', async () => {
  const { app, req, login } = await harness();
  try {
    const { pkg, doc } = await setUpPresentedPackage(req, login, 'F83-R02-MULTI-' + Date.now(), 'F8.3 несколько документов');
    await login('PTO');
    const doc2 = await req(`documentation-packages/${pkg.id}/documents`, { type: 'ACT_CERTIFICATE' });
    await req(`documentation-documents/${doc2.id}/versions`, { storageProvider: 'NONE' });

    const accepted = await req(`documentation-packages/${pkg.id}/customer-acceptance`, { version: pkg.version, acceptedDate: dt(0), reference: 'Акт-Мульти' });

    const snap = await req('snapshot');
    const acceptanceRecord = snap.documentationCustomerAcceptances.find((a: any) => a.documentationPackageId === accepted.id);
    const versionLinks = snap.documentationCustomerAcceptanceVersions.filter((v: any) => v.customerAcceptanceId === acceptanceRecord.id);
    assert.equal(versionLinks.length, 2, 'one snapshot row per Documentation Document in the Package');

    const doc1Version = snap.documentationVersions.find((v: any) => v.documentationDocumentId === doc.id);
    const doc2Version = snap.documentationVersions.find((v: any) => v.documentationDocumentId === doc2.id);
    const linkedIds = versionLinks.map((v: any) => v.documentationDocumentVersionId).sort();
    assert.deepEqual(linkedIds, [doc1Version.id, doc2Version.id].sort());
  } finally {
    await app.close();
  }
});

/* --------------------------------------------------------------------- *
 * 5-6: customer documentation acceptance registration                    *
 * --------------------------------------------------------------------- */

test('F8.3 HTTP (5): PTO registers external documentation acceptance, tied to the presented package version', async () => {
  const { app, req, login } = await harness();
  try {
    const { pkg } = await setUpPresentedPackage(req, login, 'F83-ACCEPT-' + Date.now(), 'F8.3 согласие заказчика');
    const before = pkg.version;
    const accepted = await req(`documentation-packages/${pkg.id}/customer-acceptance`, { version: pkg.version, acceptedDate: dt(-1), reference: 'Акт №12' });
    assert.equal(accepted.status, 'ACCEPTED_BY_CUSTOMER');
    assert.equal(accepted.version, before + 1);
    const history = (await req('snapshot')).documentationStatusHistory.filter((h: any) => h.documentationPackageId === pkg.id);
    assert.ok(history.some((h: any) => h.fromStatus === 'PRESENTED' && h.toStatus === 'ACCEPTED_BY_CUSTOMER'));
  } finally {
    await app.close();
  }
});

test('F8.3 HTTP: customer-acceptance is refused before PRESENTED (still an ordinary status, not free-floating)', async () => {
  const { app, req, login } = await harness();
  try {
    const pm = await login('PROJECT_MANAGER');
    const dict = await req('dictionaries');
    const contractors = await req('contractors');
    await login('TECHNICAL_DIRECTOR');
    const o = await req('objects', { externalCode: 'F83-ACCEPT-EARLY-' + Date.now(), name: 'F8.3 раннее согласие', address: 'Тест, 1', organizationName: 'ООО СЗ «Гор-Строй»', projectManagerId: pm.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [contractors[0].id] });
    await login('PROJECT_MANAGER');
    const work = await req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, responsibleUserId: pm.id, name: 'Работа', unit: 'м²', plannedQuantity: 100, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '20000' });
    const pto = await login('PTO');
    const pkg = await req('documentation-packages', { objectWorkId: work.id, responsibleUserId: pto.id });
    await req(`documentation-packages/${pkg.id}/customer-acceptance`, { version: pkg.version, acceptedDate: dt(0) }, 400);
  } finally {
    await app.close();
  }
});

test('F8.3 HTTP (6): non-PTO cannot register customer documentation acceptance', async () => {
  const { app, req, login } = await harness();
  try {
    const { pkg } = await setUpPresentedPackage(req, login, 'F83-ACCEPT-ROLE-' + Date.now(), 'F8.3 согласие: роли');
    // F8.3-R01 corrective: ADMIN is included here too — DOCUMENTATION_MANAGE
    // alone (which ADMIN holds as part of its blanket superuser grant) is not
    // enough; the accepted contract reserves this specific action to PTO.
    for (const role of ['PROJECT_MANAGER', 'CONSTRUCTION_CONTROL', 'SDO', 'TECHNICAL_DIRECTOR', 'ADMIN']) {
      await login(role);
      await req(`documentation-packages/${pkg.id}/customer-acceptance`, { version: pkg.version, acceptedDate: dt(0) }, 403);
    }
  } finally {
    await app.close();
  }
});

test('F8.3-R01: ADMIN is refused at both PTO-only operations despite holding DOCUMENTATION_MANAGE — PTO succeeds at both', async () => {
  const { app, req, login } = await harness();
  try {
    const { pkg } = await setUpPresentedPackage(req, login, 'F83-R01-' + Date.now(), 'F8.3 только ПТО: согласие и передача');

    // ADMIN => 403 on customer-acceptance, even though ADMIN is the
    // superuser role and holds every permission bit, including
    // DOCUMENTATION_MANAGE.
    await login('ADMIN');
    await req(`documentation-packages/${pkg.id}/customer-acceptance`, { version: pkg.version, acceptedDate: dt(0) }, 403);

    // PTO => success on customer-acceptance.
    await login('PTO');
    const accepted = await req(`documentation-packages/${pkg.id}/customer-acceptance`, { version: pkg.version, acceptedDate: dt(0), reference: 'Акт-R01' });
    assert.equal(accepted.status, 'ACCEPTED_BY_CUSTOMER');

    // ADMIN => 403 on handoff-to-sdo too, on the now-ready, accepted package.
    await login('ADMIN');
    await req(`documentation-packages/${accepted.id}/handoff-to-sdo`, { version: accepted.version }, 403);

    // PTO => success on handoff-to-sdo.
    await login('PTO');
    const sdoCase = await req(`documentation-packages/${accepted.id}/handoff-to-sdo`, { version: accepted.version });
    assert.equal(sdoCase.documentationPackageId, accepted.id);
    assert.equal(sdoCase.status, 'ON_RECONCILIATION');
  } finally {
    await app.close();
  }
});

/* --------------------------------------------------------------------- *
 * 2,7-9: handoff                                                         *
 * --------------------------------------------------------------------- */

test('F8.3 HTTP (2,7): handoff (and so every operational SDO action) is refused before readiness — a ready package still requires the explicit action', async () => {
  const { app, req, login } = await harness();
  try {
    const { pkg } = await setUpPresentedPackage(req, login, 'F83-GATE-' + Date.now(), 'F8.3 блокировка до готовности');
    // Not yet ACCEPTED_BY_CUSTOMER: handoff must be refused.
    await req(`documentation-packages/${pkg.id}/handoff-to-sdo`, { version: pkg.version }, 400);

    const accepted = await req(`documentation-packages/${pkg.id}/customer-acceptance`, { version: pkg.version, acceptedDate: dt(0) });
    // Now ready — but no case exists until PTO explicitly hands off.
    const snapshotBefore = await req('snapshot');
    assert.equal((snapshotBefore.sdoClosingCases ?? []).filter((c: any) => c.documentationPackageId === accepted.id).length, 0);

    const sdoCase = await req(`documentation-packages/${accepted.id}/handoff-to-sdo`, { version: accepted.version });
    assert.equal(sdoCase.documentationPackageId, accepted.id);
    assert.equal(sdoCase.status, 'ON_RECONCILIATION');
  } finally {
    await app.close();
  }
});

test('F8.3 HTTP (8,9): handoff creates exactly one SDO Case, and a second handoff attempt for the same package is rejected', async () => {
  const { app, req, login } = await harness();
  try {
    const { pkg, sdoCase } = await setUpHandedOffCase(req, login, 'F83-ONE-CASE-' + Date.now(), 'F8.3 одно дело на пакет');
    const snapshot = await req('snapshot');
    const own = (snapshot.sdoClosingCases ?? []).filter((c: any) => c.documentationPackageId === pkg.id);
    assert.equal(own.length, 1);
    assert.equal(own[0].id, sdoCase.id);

    await req(`documentation-packages/${pkg.id}/handoff-to-sdo`, { version: pkg.version }, 400);
    const after = await req('snapshot');
    assert.equal((after.sdoClosingCases ?? []).filter((c: any) => c.documentationPackageId === pkg.id).length, 1, 'still exactly one case — no second was created');
  } finally {
    await app.close();
  }
});

test('F8.3 HTTP: SDO can see which Quantity Portions its own case covers, without ever receiving documentationPackagePortions at all', async () => {
  const { app, req, login } = await harness();
  try {
    const { portion, sdoCase } = await setUpHandedOffCase(req, login, 'F83-COVERAGE-' + Date.now(), 'F8.3 видимость участков СДО');
    await login('SDO');
    const snapshot = await req('snapshot');
    assert.equal(snapshot.documentationPackagePortions, undefined, 'SDO still has no F8.2 access at all');
    const ownCase = snapshot.sdoClosingCases.find((c: any) => c.id === sdoCase.id);
    assert.deepEqual(ownCase.coveredQuantityPortionIds, [portion.id]);
  } finally {
    await app.close();
  }
});

/* --------------------------------------------------------------------- *
 * 10-13: locking, return-to-PTO, re-handoff                              *
 * --------------------------------------------------------------------- */

test('F8.3 HTTP (10,11): handoff locks Package Portion composition — linking a further portion is refused by the backend', async () => {
  const { app, req, login } = await harness();
  try {
    const { work, pkg } = await setUpHandedOffCase(req, login, 'F83-LOCK-' + Date.now(), 'F8.3 блокировка состава');
    await login('PROJECT_MANAGER');
    const dict = await req('dictionaries');
    const contractors = await req('contractors');
    const unit2 = await req('execution-units', { objectWorkId: work.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, unit: 'м²', plannedQuantity: 100 });
    const portion2 = await req(`execution-units/${unit2.id}/portions`, { label: 'Секция B', plannedQuantity: 50 });

    await login('PTO');
    await req(`documentation-packages/${pkg.id}/portions`, { quantityPortionId: portion2.id }, 400);

    const snapshot = await req('snapshot');
    const item = snapshot.sdoPackageReadiness.find((x: any) => x.documentationPackageId === pkg.id);
    assert.equal(item.packageLocked, true);
  } finally {
    await app.close();
  }
});

test('F8.3 HTTP (12): SDO "Вернуть в ПТО" unlocks the Package and retains the same Case', async () => {
  const { app, req, login } = await harness();
  try {
    const { pkg, sdoCase } = await setUpHandedOffCase(req, login, 'F83-RETURN-' + Date.now(), 'F8.3 возврат в ПТО');
    await login('SDO');
    const returned = await req(`sdo-closing-cases/${sdoCase.id}/return-to-pto`, { version: sdoCase.version, comment: 'Неверный состав' });
    assert.equal(returned.id, sdoCase.id, 'same case retained');
    assert.equal(returned.packageLocked, false);

    const sdoSnapshot = await req('snapshot');
    const item = sdoSnapshot.sdoPackageReadiness.find((x: any) => x.documentationPackageId === pkg.id);
    assert.equal(item.packageLocked, false);
    const handoffHistory = sdoSnapshot.sdoClosingHandoffHistory.filter((h: any) => h.sdoClosingCaseId === sdoCase.id);
    assert.deepEqual(handoffHistory.map((h: any) => h.event), ['HANDED_OFF', 'RETURNED_TO_PTO']);

    // SDO itself has no F8.2 access — documentationStatusHistory is read
    // through PTO instead (Package Detail's own audience).
    await login('PTO');
    const history = (await req('snapshot')).documentationStatusHistory.filter((h: any) => h.documentationPackageId === pkg.id);
    assert.ok(history.some((h: any) => h.fromStatus === 'ACCEPTED_BY_CUSTOMER' && h.toStatus === 'CORRECTING'));
  } finally {
    await app.close();
  }
});

test('F8.3 HTTP (13): re-handoff relocks the Package and resumes the same Case, unchanged status', async () => {
  const { app, req, login } = await harness();
  try {
    const { pkg, sdoCase } = await setUpHandedOffCase(req, login, 'F83-RESUME-' + Date.now(), 'F8.3 повторная передача');

    // Advance the case's own reconciliation status before returning the
    // package, to prove "resumes" — the case is not reset by the round trip.
    await login('SDO');
    const verified = await req(`sdo-closing-cases/${sdoCase.id}/status`, { version: sdoCase.version, status: 'VERIFICATION_PASSED' });
    const returned = await req(`sdo-closing-cases/${sdoCase.id}/return-to-pto`, { version: verified.version });
    assert.equal(returned.packageLocked, false);

    // Package is now CORRECTING and unlocked (its own version bumped once,
    // by returnSdoCaseToPto's own status change) — PTO re-presents and
    // re-registers customer acceptance exactly as the first time.
    await login('PTO');
    let p = await req(`documentation-packages/${pkg.id}/status`, { status: 'PRESENTED', version: pkg.version + 1 });
    p = await req(`documentation-packages/${p.id}/customer-acceptance`, { version: p.version, acceptedDate: dt(0) });

    const relocked = await req(`documentation-packages/${p.id}/handoff-to-sdo`, { version: p.version });
    assert.equal(relocked.id, sdoCase.id, 'the same case resumes — never a second case');
    assert.equal(relocked.packageLocked, true);
    assert.equal(relocked.status, 'VERIFICATION_PASSED', "the case's own status is untouched by the return/re-handoff round trip");

    const handoffHistory = (await req('snapshot')).sdoClosingHandoffHistory.filter((h: any) => h.sdoClosingCaseId === sdoCase.id);
    assert.deepEqual(handoffHistory.map((h: any) => h.event), ['HANDED_OFF', 'RETURNED_TO_PTO', 'HANDED_OFF']);
  } finally {
    await app.close();
  }
});

test('F8.3-R03: while custody is with PTO (package_locked=false), status/amount/allocation mutations are all rejected — re-handoff restores them', async () => {
  const { app, req, login } = await harness();
  try {
    const { pkg, sdoCase, portion } = await setUpHandedOffCase(req, login, 'F83-R03-' + Date.now(), 'F8.3 приостановка при возврате в ПТО');
    await login('SDO');
    const returned = await req(`sdo-closing-cases/${sdoCase.id}/return-to-pto`, { version: sdoCase.version });
    assert.equal(returned.packageLocked, false);

    await req(`sdo-closing-cases/${returned.id}/status`, { version: returned.version, status: 'VERIFICATION_PASSED' }, 400);
    await req(`sdo-closing-cases/${returned.id}/amount`, { version: returned.version, amount: '500.00' }, 400);
    await req(`sdo-closing-cases/${returned.id}/allocations`, { quantityPortionId: portion.id, amount: '100.00' }, 400);

    // PTO corrects and re-presents, re-registers acceptance, and re-hands off
    // — the same Case resumes and relocks (F8.3 HTTP (13) already proves "same
    // Case"; this proves the paused operations are available again).
    await login('PTO');
    let p = await req(`documentation-packages/${pkg.id}/status`, { status: 'PRESENTED', version: pkg.version + 1 });
    p = await req(`documentation-packages/${p.id}/customer-acceptance`, { version: p.version, acceptedDate: dt(0), reference: 'Акт-2' });
    const relocked = await req(`documentation-packages/${p.id}/handoff-to-sdo`, { version: p.version });
    assert.equal(relocked.id, sdoCase.id, 'same Case resumes');
    assert.equal(relocked.packageLocked, true);

    await login('SDO');
    const afterStatus = await req(`sdo-closing-cases/${relocked.id}/status`, { version: relocked.version, status: 'VERIFICATION_PASSED' });
    assert.equal(afterStatus.status, 'VERIFICATION_PASSED');
    const afterAmount = await req(`sdo-closing-cases/${afterStatus.id}/amount`, { version: afterStatus.version, amount: '500.00' });
    assert.equal(afterAmount.totalAmount, '500.00');
    const afterAlloc = await req(`sdo-closing-cases/${afterAmount.id}/allocations`, { quantityPortionId: portion.id, amount: '500.00' });
    assert.equal(afterAlloc.amount, '500.00');
  } finally {
    await app.close();
  }
});

/* --------------------------------------------------------------------- *
 * 14-16: SDO status workflow                                             *
 * --------------------------------------------------------------------- */

test('F8.3 HTTP (14): the full allowed status chain succeeds end to end', async () => {
  const { app, req, login } = await harness();
  try {
    const { sdoCase } = await setUpHandedOffCase(req, login, 'F83-CHAIN-' + Date.now(), 'F8.3 цепочка статусов');
    await login('SDO');
    let c = await req(`sdo-closing-cases/${sdoCase.id}/status`, { version: sdoCase.version, status: 'VERIFICATION_PASSED' });
    assert.equal(c.status, 'VERIFICATION_PASSED');
    c = await req(`sdo-closing-cases/${c.id}/amount`, { version: c.version, amount: '500000.00' });
    c = await req(`sdo-closing-cases/${c.id}/status`, { version: c.version, status: 'CLOSED' });
    assert.equal(c.status, 'CLOSED');
    assert.ok(c.closedAt);
    c = await req(`sdo-closing-cases/${c.id}/status`, { version: c.version, status: 'ON_CORRECTION', reason: 'Найдена ошибка в сумме' });
    assert.equal(c.status, 'ON_CORRECTION');
    assert.equal(c.closedAt, null);
    c = await req(`sdo-closing-cases/${c.id}/status`, { version: c.version, status: 'ON_RECONCILIATION' });
    assert.equal(c.status, 'ON_RECONCILIATION');
  } finally {
    await app.close();
  }
});

test('F8.3 HTTP (15): representative forbidden SDO status transitions are refused', async () => {
  const { app, req, login } = await harness();
  try {
    const { sdoCase } = await setUpHandedOffCase(req, login, 'F83-FORBID-' + Date.now(), 'F8.3 запрещённые переходы');
    await login('SDO');
    await req(`sdo-closing-cases/${sdoCase.id}/status`, { version: sdoCase.version, status: 'CLOSED' }, 400);
    const corrected = await req(`sdo-closing-cases/${sdoCase.id}/status`, { version: sdoCase.version, status: 'ON_CORRECTION' });
    await req(`sdo-closing-cases/${corrected.id}/status`, { version: corrected.version, status: 'CLOSED' }, 400);
    await req(`sdo-closing-cases/${corrected.id}/status`, { version: corrected.version, status: 'VERIFICATION_PASSED' }, 400);
    const back = await req(`sdo-closing-cases/${corrected.id}/status`, { version: corrected.version, status: 'ON_RECONCILIATION' });
    await req(`sdo-closing-cases/${back.id}/status`, { version: back.version, status: 'ON_RECONCILIATION' }, 400);
  } finally {
    await app.close();
  }
});

test('F8.3 HTTP (16): CLOSED -> ON_CORRECTION requires a non-empty reason, recorded in status history', async () => {
  const { app, req, login } = await harness();
  try {
    const { sdoCase } = await setUpHandedOffCase(req, login, 'F83-REASON-' + Date.now(), 'F8.3 причина возврата');
    await login('SDO');
    let c = await req(`sdo-closing-cases/${sdoCase.id}/status`, { version: sdoCase.version, status: 'VERIFICATION_PASSED' });
    c = await req(`sdo-closing-cases/${c.id}/amount`, { version: c.version, amount: '100.00' });
    c = await req(`sdo-closing-cases/${c.id}/status`, { version: c.version, status: 'CLOSED' });
    await req(`sdo-closing-cases/${c.id}/status`, { version: c.version, status: 'ON_CORRECTION' }, 400);
    await req(`sdo-closing-cases/${c.id}/status`, { version: c.version, status: 'ON_CORRECTION', reason: '   ' }, 400);
    c = await req(`sdo-closing-cases/${c.id}/status`, { version: c.version, status: 'ON_CORRECTION', reason: 'Сумма указана неверно' });
    const history = (await req('snapshot')).sdoClosingStatusHistory.filter((h: any) => h.sdoClosingCaseId === sdoCase.id);
    const last = history[history.length - 1];
    assert.equal(last.fromStatus, 'CLOSED');
    assert.equal(last.toStatus, 'ON_CORRECTION');
    assert.equal(last.reason, 'Сумма указана неверно');
  } finally {
    await app.close();
  }
});

test('F8.3-R04: a CLOSED Case cannot be returned to PTO directly — must go through ON_CORRECTION (with reason) first, audit histories preserved', async () => {
  const { app, req, login } = await harness();
  try {
    const { sdoCase } = await setUpHandedOffCase(req, login, 'F83-R04-' + Date.now(), 'F8.3 защита возврата закрытого дела');
    await login('SDO');
    let c = await req(`sdo-closing-cases/${sdoCase.id}/status`, { version: sdoCase.version, status: 'VERIFICATION_PASSED' });
    c = await req(`sdo-closing-cases/${c.id}/amount`, { version: c.version, amount: '500.00' });
    c = await req(`sdo-closing-cases/${c.id}/status`, { version: c.version, status: 'CLOSED' });
    assert.equal(c.status, 'CLOSED');

    // Direct return-to-PTO from CLOSED bypasses the required correction step
    // — rejected outright, package_locked is untouched.
    await req(`sdo-closing-cases/${c.id}/return-to-pto`, { version: c.version }, 400);

    // The pre-existing reason requirement (F8.3 HTTP (16)) still guards the
    // only legal route out of CLOSED.
    await req(`sdo-closing-cases/${c.id}/status`, { version: c.version, status: 'ON_CORRECTION' }, 400);
    const corrected = await req(`sdo-closing-cases/${c.id}/status`, { version: c.version, status: 'ON_CORRECTION', reason: 'Ошибка в сумме закрытия' });
    assert.equal(corrected.status, 'ON_CORRECTION');

    // Only now can the Case be returned to PTO.
    const returned = await req(`sdo-closing-cases/${c.id}/return-to-pto`, { version: corrected.version });
    assert.equal(returned.packageLocked, false);

    const snap = await req('snapshot');
    const statusHistory = snap.sdoClosingStatusHistory.filter((h: any) => h.sdoClosingCaseId === sdoCase.id);
    assert.ok(statusHistory.some((h: any) => h.fromStatus === 'CLOSED' && h.toStatus === 'ON_CORRECTION' && h.reason === 'Ошибка в сумме закрытия'), 'status history preserved');
    const handoffHistory = snap.sdoClosingHandoffHistory.filter((h: any) => h.sdoClosingCaseId === sdoCase.id);
    assert.deepEqual(handoffHistory.map((h: any) => h.event), ['HANDED_OFF', 'RETURNED_TO_PTO'], 'handoff history preserved');
  } finally {
    await app.close();
  }
});

/* --------------------------------------------------------------------- *
 * 17: amount history                                                     *
 * --------------------------------------------------------------------- */

test('F8.3 HTTP (17): total closing amount history is append-only and audited', async () => {
  const { app, req, login } = await harness();
  try {
    const { sdoCase } = await setUpHandedOffCase(req, login, 'F83-AMOUNT-HIST-' + Date.now(), 'F8.3 история суммы');
    await login('SDO');
    const first = await req(`sdo-closing-cases/${sdoCase.id}/amount`, { version: sdoCase.version, amount: '1840000.00' });
    assert.equal(first.totalAmount, '1840000.00');
    const second = await req(`sdo-closing-cases/${first.id}/amount`, { version: first.version, amount: '1790000.00' });
    assert.equal(second.totalAmount, '1790000.00');

    const history = (await req('snapshot')).sdoClosingAmountHistory.filter((h: any) => h.sdoClosingCaseId === sdoCase.id);
    assert.equal(history.length, 2, 'both changes recorded — the first is never overwritten');
    assert.equal(history[0].previousAmount, null);
    assert.equal(history[0].newAmount, '1840000.00');
    assert.equal(history[1].previousAmount, '1840000.00');
    assert.equal(history[1].newAmount, '1790000.00');
    assert.ok(history[1].changedBy);
    assert.ok(history[1].changedAt);
  } finally {
    await app.close();
  }
});

test('F8.3 HTTP: a CLOSED case refuses silent amount editing — must go through ON_CORRECTION first', async () => {
  const { app, req, login } = await harness();
  try {
    const { sdoCase } = await setUpHandedOffCase(req, login, 'F83-CLOSED-AMOUNT-' + Date.now(), 'F8.3 закрытое дело');
    await login('SDO');
    let c = await req(`sdo-closing-cases/${sdoCase.id}/status`, { version: sdoCase.version, status: 'VERIFICATION_PASSED' });
    c = await req(`sdo-closing-cases/${c.id}/amount`, { version: c.version, amount: '100.00' });
    c = await req(`sdo-closing-cases/${c.id}/status`, { version: c.version, status: 'CLOSED' });
    await req(`sdo-closing-cases/${c.id}/amount`, { version: c.version, amount: '200.00' }, 400);
  } finally {
    await app.close();
  }
});

/* --------------------------------------------------------------------- *
 * 18-22: optional Portion allocations                                    *
 * --------------------------------------------------------------------- */

test('F8.3 HTTP (18,19): optional Portion allocation works; a partial allocation sum blocks CLOSED', async () => {
  const { app, req, login } = await harness();
  try {
    const { sdoCase, portion } = await setUpHandedOffCase(req, login, 'F83-ALLOC-' + Date.now(), 'F8.3 распределение суммы');
    await login('SDO');
    let c = await req(`sdo-closing-cases/${sdoCase.id}/status`, { version: sdoCase.version, status: 'VERIFICATION_PASSED' });
    c = await req(`sdo-closing-cases/${c.id}/amount`, { version: c.version, amount: '1000.00' });

    const allocation = await req(`sdo-closing-cases/${c.id}/allocations`, { quantityPortionId: portion.id, amount: '400.00' });
    assert.equal(allocation.quantityPortionId, portion.id);
    assert.equal(allocation.amount, '400.00');

    const refreshed = (await req('snapshot')).sdoClosingCases.find((x: any) => x.id === c.id);
    await req(`sdo-closing-cases/${c.id}/status`, { version: refreshed.version, status: 'CLOSED' }, 400);
  } finally {
    await app.close();
  }
});

test('F8.3 HTTP (20): exact allocation sum across covered portions allows CLOSED', async () => {
  const { app, req, login } = await harness();
  try {
    const { sdoCase, portion } = await setUpHandedOffCase(req, login, 'F83-ALLOC-EXACT-' + Date.now(), 'F8.3 точная сумма');
    await login('SDO');
    let c = await req(`sdo-closing-cases/${sdoCase.id}/status`, { version: sdoCase.version, status: 'VERIFICATION_PASSED' });
    c = await req(`sdo-closing-cases/${c.id}/amount`, { version: c.version, amount: '750.00' });
    await req(`sdo-closing-cases/${c.id}/allocations`, { quantityPortionId: portion.id, amount: '750.00' });
    const refreshed = (await req('snapshot')).sdoClosingCases.find((x: any) => x.id === c.id);
    const closed = await req(`sdo-closing-cases/${c.id}/status`, { version: refreshed.version, status: 'CLOSED' });
    assert.equal(closed.status, 'CLOSED');
  } finally {
    await app.close();
  }
});

// F8.3-R05 corrective: a second write to the same Quantity Portion is no
// longer a flat "duplicate" rejection — it is a correction. Omitting the
// current version is refused as an optimistic-concurrency conflict (the same
// treatment every other mutable row in this schema already gets), never a
// silent second row: sdo_closing_portion_allocations_unique still guarantees
// at most one *current* row per Portion.
test('F8.3-R05 (was 21): a second write to the same Quantity Portion without its current version is refused as a conflict, not silently accepted', async () => {
  const { app, req, login } = await harness();
  try {
    const { sdoCase, portion } = await setUpHandedOffCase(req, login, 'F83-ALLOC-DUP-' + Date.now(), 'F8.3 коррекция распределения: версия');
    await login('SDO');
    const first = await req(`sdo-closing-cases/${sdoCase.id}/allocations`, { quantityPortionId: portion.id, amount: '100.00' });
    assert.equal(first.amount, '100.00');
    await req(`sdo-closing-cases/${sdoCase.id}/allocations`, { quantityPortionId: portion.id, amount: '50.00' }, 409);
  } finally {
    await app.close();
  }
});

test('F8.3-R05: an existing Portion allocation can be corrected by supplying its current version — the prior and new amount are both recorded in history', async () => {
  const { app, req, login } = await harness();
  try {
    const { sdoCase, portion } = await setUpHandedOffCase(req, login, 'F83-R05-CORRECT-' + Date.now(), 'F8.3 коррекция распределения');
    await login('SDO');
    const first = await req(`sdo-closing-cases/${sdoCase.id}/allocations`, { quantityPortionId: portion.id, amount: '100.00' });
    const corrected = await req(`sdo-closing-cases/${sdoCase.id}/allocations`, { quantityPortionId: portion.id, amount: '175.00', version: first.version });
    assert.equal(corrected.id, first.id, 'same allocation row, corrected in place — never a second row');
    assert.equal(corrected.amount, '175.00');

    const history = (await req('snapshot')).sdoClosingPortionAllocationHistory.filter((h: any) => h.sdoClosingCaseId === sdoCase.id && h.quantityPortionId === portion.id);
    assert.equal(history.length, 2, 'one history row for the first set, one for the correction — append-only');
    assert.equal(history[0].previousAmount, null, 'previous_amount is NULL exactly the first time');
    assert.equal(history[0].newAmount, '100.00');
    assert.equal(history[1].previousAmount, '100.00', 'the prior value is preserved, never overwritten');
    assert.equal(history[1].newAmount, '175.00');
  } finally {
    await app.close();
  }
});

test('F8.3-R05: a corrected allocation sum can close — the original wrong sum could not', async () => {
  const { app, req, login } = await harness();
  try {
    const { sdoCase, portion } = await setUpHandedOffCase(req, login, 'F83-R05-CLOSE-' + Date.now(), 'F8.3 закрытие после коррекции распределения');
    await login('SDO');
    let c = await req(`sdo-closing-cases/${sdoCase.id}/status`, { version: sdoCase.version, status: 'VERIFICATION_PASSED' });
    c = await req(`sdo-closing-cases/${c.id}/amount`, { version: c.version, amount: '750.00' });
    const wrong = await req(`sdo-closing-cases/${c.id}/allocations`, { quantityPortionId: portion.id, amount: '500.00' });

    let refreshed = (await req('snapshot')).sdoClosingCases.find((x: any) => x.id === c.id);
    await req(`sdo-closing-cases/${c.id}/status`, { version: refreshed.version, status: 'CLOSED' }, 400);

    await req(`sdo-closing-cases/${c.id}/allocations`, { quantityPortionId: portion.id, amount: '750.00', version: wrong.version });
    refreshed = (await req('snapshot')).sdoClosingCases.find((x: any) => x.id === c.id);
    const closed = await req(`sdo-closing-cases/${c.id}/status`, { version: refreshed.version, status: 'CLOSED' });
    assert.equal(closed.status, 'CLOSED');
  } finally {
    await app.close();
  }
});

test('F8.3-R05: a CLOSED Case refuses allocation correction — only after CLOSED -> ON_CORRECTION does correction succeed again', async () => {
  const { app, req, login } = await harness();
  try {
    const { sdoCase, portion } = await setUpHandedOffCase(req, login, 'F83-R05-CLOSED-' + Date.now(), 'F8.3 распределение закрытого дела');
    await login('SDO');
    let c = await req(`sdo-closing-cases/${sdoCase.id}/status`, { version: sdoCase.version, status: 'VERIFICATION_PASSED' });
    c = await req(`sdo-closing-cases/${c.id}/amount`, { version: c.version, amount: '750.00' });
    const allocation = await req(`sdo-closing-cases/${c.id}/allocations`, { quantityPortionId: portion.id, amount: '750.00' });

    const refreshed = (await req('snapshot')).sdoClosingCases.find((x: any) => x.id === c.id);
    c = await req(`sdo-closing-cases/${c.id}/status`, { version: refreshed.version, status: 'CLOSED' });
    assert.equal(c.status, 'CLOSED');

    await req(`sdo-closing-cases/${c.id}/allocations`, { quantityPortionId: portion.id, amount: '700.00', version: allocation.version }, 400);

    const corrected = await req(`sdo-closing-cases/${c.id}/status`, { version: c.version, status: 'ON_CORRECTION', reason: 'Ошибка в распределении по участку' });
    const recorrected = await req(`sdo-closing-cases/${corrected.id}/allocations`, { quantityPortionId: portion.id, amount: '700.00', version: allocation.version });
    assert.equal(recorrected.amount, '700.00');
  } finally {
    await app.close();
  }
});

test('F8.3-R05: returned-to-PTO also rejects correcting an EXISTING Portion allocation, not just creating a new one', async () => {
  const { app, req, login } = await harness();
  try {
    const { sdoCase, portion } = await setUpHandedOffCase(req, login, 'F83-R05-RETURNED-' + Date.now(), 'F8.3 коррекция распределения при возврате в ПТО');
    await login('SDO');
    const allocation = await req(`sdo-closing-cases/${sdoCase.id}/allocations`, { quantityPortionId: portion.id, amount: '100.00' });
    const returned = await req(`sdo-closing-cases/${sdoCase.id}/return-to-pto`, { version: sdoCase.version });
    assert.equal(returned.packageLocked, false);

    await req(`sdo-closing-cases/${sdoCase.id}/allocations`, { quantityPortionId: portion.id, amount: '150.00', version: allocation.version }, 400);
  } finally {
    await app.close();
  }
});

test("F8.3 HTTP (22): an allocation for a Portion outside the Package's own coverage is rejected", async () => {
  const { app, req, login } = await harness();
  try {
    const { work, sdoCase } = await setUpHandedOffCase(req, login, 'F83-ALLOC-OUTSIDE-' + Date.now(), 'F8.3 участок вне пакета');
    await login('PROJECT_MANAGER');
    const dict = await req('dictionaries');
    const contractors = await req('contractors');
    const unit2 = await req('execution-units', { objectWorkId: work.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, unit: 'м²', plannedQuantity: 100 });
    const outsidePortion = await req(`execution-units/${unit2.id}/portions`, { label: 'Секция вне пакета', plannedQuantity: 50 });

    await login('SDO');
    await req(`sdo-closing-cases/${sdoCase.id}/allocations`, { quantityPortionId: outsidePortion.id, amount: '10.00' }, 400);
  } finally {
    await app.close();
  }
});

/* --------------------------------------------------------------------- *
 * 23: responsible SDO assignment                                         *
 * --------------------------------------------------------------------- */

test('F8.3 HTTP (23): responsible SDO assignment — SDO/ADMIN allowed, PTO forbidden, responsible must be an active SDO user', async () => {
  const { app, req, login } = await harness();
  try {
    const { sdoCase } = await setUpHandedOffCase(req, login, 'F83-RESP-' + Date.now(), 'F8.3 ответственный СДО');
    const sdoUser = await login('SDO');

    await login('PTO');
    await req(`sdo-closing-cases/${sdoCase.id}/responsible`, { version: sdoCase.version, responsibleUserId: sdoUser.id }, 403);

    await login('SDO');
    const assigned = await req(`sdo-closing-cases/${sdoCase.id}/responsible`, { version: sdoCase.version, responsibleUserId: sdoUser.id });
    assert.equal(assigned.responsibleUserId, sdoUser.id, 'SDO can assign an active SDO user');

    const pm = await login('PROJECT_MANAGER');
    await login('ADMIN');
    const reassigned = await req(`sdo-closing-cases/${sdoCase.id}/responsible`, { version: assigned.version, responsibleUserId: sdoUser.id });
    assert.equal(reassigned.responsibleUserId, sdoUser.id, 'ADMIN can also assign');
    await req(`sdo-closing-cases/${sdoCase.id}/responsible`, { version: reassigned.version, responsibleUserId: pm.id }, 400);
  } finally {
    await app.close();
  }
});

/* --------------------------------------------------------------------- *
 * 24-25: workspace permission and read-only visibility elsewhere         *
 * --------------------------------------------------------------------- */

test('F8.3 HTTP (24): every SDO Case mutation requires SDO_CASE_MANAGE — PTO, PM and TD are all refused', async () => {
  const { app, req, login } = await harness();
  try {
    const { sdoCase } = await setUpHandedOffCase(req, login, 'F83-PERM-' + Date.now(), 'F8.3 права на мутации');
    for (const role of ['PTO', 'PROJECT_MANAGER', 'TECHNICAL_DIRECTOR', 'CONSTRUCTION_CONTROL']) {
      await login(role);
      await req(`sdo-closing-cases/${sdoCase.id}/status`, { version: sdoCase.version, status: 'VERIFICATION_PASSED' }, 403);
      await req(`sdo-closing-cases/${sdoCase.id}/amount`, { version: sdoCase.version, amount: '1.00' }, 403);
      await req(`sdo-closing-cases/${sdoCase.id}/return-to-pto`, { version: sdoCase.version }, 403);
    }
  } finally {
    await app.close();
  }
});

test('F8.3 HTTP (25): Management/RP/PTO see SDO Case state read-only outside /sdo (on the shared snapshot and the dedicated list route)', async () => {
  const { app, req, login } = await harness();
  try {
    const { sdoCase } = await setUpHandedOffCase(req, login, 'F83-READONLY-' + Date.now(), 'F8.3 доступ на чтение');
    for (const role of ['GENERAL_DIRECTOR', 'TECHNICAL_DIRECTOR', 'PROJECT_MANAGER', 'PTO', 'CONSTRUCTION_CONTROL', 'DEPARTMENT_HEAD']) {
      await login(role);
      const snapshot = await req('snapshot');
      assert.ok((snapshot.sdoClosingCases ?? []).some((c: any) => c.id === sdoCase.id), role + ' must read SDO Case state');
      const list = await req('sdo-closing-cases');
      assert.ok(list.some((c: any) => c.id === sdoCase.id), role + ' must read the dedicated list route too');
    }
    await login('CONTRACTOR_VIEWER');
    const contractorSnapshot = await req('snapshot');
    assert.equal(contractorSnapshot.sdoClosingCases, undefined, 'CONTRACTOR_VIEWER gets none of this, same as every other F8.x table');
    await req('sdo-closing-cases', undefined, 403);
  } finally {
    await app.close();
  }
});

/* --------------------------------------------------------------------- *
 * 26: production invariants                                              *
 * --------------------------------------------------------------------- */

test('F8.3 HTTP (26): SDO Case mutations never change production quantity, schedule status or SC confirmations', async () => {
  const { app, req, login } = await harness();
  try {
    const { work, portion, sdoCase } = await setUpHandedOffCase(req, login, 'F83-INVARIANT-' + Date.now(), 'F8.3 неизменность производства');
    await login('PROJECT_MANAGER');
    const before = await req('snapshot');
    const workBefore = before.works.find((w: any) => w.id === work.id);
    const portionBefore = before.portions.find((p: any) => p.id === portion.id);

    await login('SDO');
    let c = await req(`sdo-closing-cases/${sdoCase.id}/status`, { version: sdoCase.version, status: 'VERIFICATION_PASSED' });
    c = await req(`sdo-closing-cases/${c.id}/amount`, { version: c.version, amount: '999999.00' });
    await req(`sdo-closing-cases/${c.id}/allocations`, { quantityPortionId: portion.id, amount: '999999.00' });
    await req(`sdo-closing-cases/${c.id}/status`, { version: (await req('snapshot')).sdoClosingCases.find((x: any) => x.id === c.id).version, status: 'CLOSED' });

    await login('PROJECT_MANAGER');
    const after = await req('snapshot');
    const workAfter = after.works.find((w: any) => w.id === work.id);
    const portionAfter = after.portions.find((p: any) => p.id === portion.id);

    assert.equal(workAfter.actualQuantity, workBefore.actualQuantity);
    assert.equal(workAfter.scheduleStatus, workBefore.scheduleStatus);
    assert.equal(workAfter.accepted, workBefore.accepted);
    assert.equal(workAfter.customerScAccepted, workBefore.customerScAccepted);
    assert.equal(portionAfter.rpFactQuantity, portionBefore.rpFactQuantity);
    assert.equal(portionAfter.customerScConfirmedQuantity, portionBefore.customerScConfirmedQuantity);
    assert.equal(portionAfter.internalScConfirmedQuantity, portionBefore.internalScConfirmedQuantity);
    assert.equal(portionAfter.version, portionBefore.version, 'SDO closing activity never bumps a production row\'s own version');
  } finally {
    await app.close();
  }
});
