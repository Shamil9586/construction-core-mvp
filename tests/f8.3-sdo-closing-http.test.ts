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
async function setUpPresentedPackage(req: any, login: any, code: string, name: string, extraDocumentTypes: string[] = []) {
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
  // F8.3-17: any further document must be added here, before PRESENTED —
  // content is frozen from PRESENTED onward, so a caller wanting more than
  // one document in the accepted snapshot cannot add it afterwards.
  const extraDocs = [];
  for (const type of extraDocumentTypes) {
    const extraDoc = await req(`documentation-packages/${pkg.id}/documents`, { type });
    await req(`documentation-documents/${extraDoc.id}/versions`, { storageProvider: 'NONE' });
    extraDocs.push(extraDoc);
  }
  let p = await req(`documentation-packages/${pkg.id}/status`, { status: 'PREPARING', version: pkg.version });
  p = await req(`documentation-packages/${pkg.id}/status`, { status: 'READY_FOR_PRESENTATION', version: p.version });
  p = await req(`documentation-packages/${pkg.id}/status`, { status: 'PRESENTED', version: p.version });

  return { pm, pto, cc, object: o, work, unit, portion, pkg: p, doc, extraDocs };
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

test('F8.3-R02/F8.3-17: a document version cannot be added directly to an ACCEPTED_BY_CUSTOMER package — content is frozen once accepted; only the correction flow can change it', async () => {
  const { app, req, login } = await harness();
  try {
    const { pkg, doc } = await setUpPresentedPackage(req, login, 'F83-R02-STALE-' + Date.now(), 'F8.3 версия после согласия');
    await login('PTO');
    const accepted = await req(`documentation-packages/${pkg.id}/customer-acceptance`, { version: pkg.version, acceptedDate: dt(0), reference: 'Акт-1' });

    const snap = await req('snapshot');
    const item = snap.sdoPackageReadiness.find((x: any) => x.documentationPackageId === accepted.id);
    assert.equal(item.ready, true, 'sanity check: ready immediately after a fresh, current acceptance');

    // F8.3-17 corrective: content (a new document version) is frozen the
    // moment the Package reaches ACCEPTED_BY_CUSTOMER — the backend now
    // refuses this outright, rather than accepting it and letting
    // readiness/handoff merely notice the mismatch afterwards (the weaker
    // guarantee this test proved before F8.3-17 existed; see F8.3-R02 (3)
    // for the correction flow this is now the only legal route to the same
    // outcome).
    await req(`documentation-documents/${doc.id}/versions`, { storageProvider: 'EXTERNAL_REFERENCE', storageReference: 'https://example.test/v2' }, 400);
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
    // F8.3-17: the second document must exist before PRESENTED — content is
    // frozen from PRESENTED onward (setUpPresentedPackage's own extraDocumentTypes
    // parameter adds it at the right point, before the final status pushes).
    const { pkg, doc, extraDocs } = await setUpPresentedPackage(req, login, 'F83-R02-MULTI-' + Date.now(), 'F8.3 несколько документов', ['ACT_CERTIFICATE']);
    const doc2 = extraDocs[0];
    await login('PTO');
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
 * F8.3-R02b corrective: every current document must have a version       *
 * --------------------------------------------------------------------- */

test('F8.3-R02b (1): customer-acceptance is refused when a Documentation Document has no version at all', async () => {
  const { app, req, login } = await harness();
  try {
    const pm = await login('PROJECT_MANAGER');
    const dict = await req('dictionaries');
    const contractors = await req('contractors');
    await login('TECHNICAL_DIRECTOR');
    const o = await req('objects', { externalCode: 'F83-R02B-NOVER-' + Date.now(), name: 'F8.3 документ без версии', address: 'Тест, 1', organizationName: 'ООО СЗ «Гор-Строй»', projectManagerId: pm.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [contractors[0].id] });
    await login('PROJECT_MANAGER');
    const work = await req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, responsibleUserId: pm.id, name: 'Работа', unit: 'м²', plannedQuantity: 100, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '20000' });
    const pto = await login('PTO');
    const pkg = await req('documentation-packages', { objectWorkId: work.id, responsibleUserId: pto.id });
    // Document A is created but never given a version — the exact Case A
    // from the corrective report.
    await req(`documentation-packages/${pkg.id}/documents`, { type: 'AOSR' });
    let p = await req(`documentation-packages/${pkg.id}/status`, { status: 'PREPARING', version: pkg.version });
    p = await req(`documentation-packages/${p.id}/status`, { status: 'READY_FOR_PRESENTATION', version: p.version });
    p = await req(`documentation-packages/${p.id}/status`, { status: 'PRESENTED', version: p.version });

    await req(`documentation-packages/${p.id}/customer-acceptance`, { version: p.version, acceptedDate: dt(0) }, 400);
  } finally {
    await app.close();
  }
});

test('F8.3-R02b (2): customer-acceptance is refused when the Package has zero Documentation Documents', async () => {
  const { app, req, login } = await harness();
  try {
    const pm = await login('PROJECT_MANAGER');
    const dict = await req('dictionaries');
    const contractors = await req('contractors');
    await login('TECHNICAL_DIRECTOR');
    const o = await req('objects', { externalCode: 'F83-R02B-NODOC-' + Date.now(), name: 'F8.3 пакет без документов', address: 'Тест, 1', organizationName: 'ООО СЗ «Гор-Строй»', projectManagerId: pm.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [contractors[0].id] });
    await login('PROJECT_MANAGER');
    const work = await req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, responsibleUserId: pm.id, name: 'Работа', unit: 'м²', plannedQuantity: 100, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '20000' });
    const pto = await login('PTO');
    const pkg = await req('documentation-packages', { objectWorkId: work.id, responsibleUserId: pto.id });
    let p = await req(`documentation-packages/${pkg.id}/status`, { status: 'PREPARING', version: pkg.version });
    p = await req(`documentation-packages/${p.id}/status`, { status: 'READY_FOR_PRESENTATION', version: p.version });
    p = await req(`documentation-packages/${p.id}/status`, { status: 'PRESENTED', version: p.version });

    await req(`documentation-packages/${p.id}/customer-acceptance`, { version: p.version, acceptedDate: dt(0) }, 400);
  } finally {
    await app.close();
  }
});

test('F8.3-R02b (3): a Package where every document has a version accepts normally — the coverage guard does not block the valid case', async () => {
  const { app, req, login } = await harness();
  try {
    const { pkg } = await setUpPresentedPackage(req, login, 'F83-R02B-VALID-' + Date.now(), 'F8.3 валидный пакет (полное покрытие)');
    const accepted = await req(`documentation-packages/${pkg.id}/customer-acceptance`, { version: pkg.version, acceptedDate: dt(0), reference: 'Акт-Валид' });
    assert.equal(accepted.status, 'ACCEPTED_BY_CUSTOMER');
  } finally {
    await app.close();
  }
});

test('F8.3-17/F8.3-R02b: content is frozen after handoff — adding a Document requires the correction flow first; a fresh acceptance then covers every current document', async () => {
  const { app, req, login } = await harness();
  try {
    // Baseline: Document A/v1, accepted, handed off — the ordinary, fully
    // current case (mirrors setUpHandedOffCase).
    const { pkg, sdoCase } = await setUpHandedOffCase(req, login, 'F83-R02B-FLOW-' + Date.now(), 'F8.3 версия после передачи в СДО');
    await login('PTO');

    // F8.3-17: content is frozen while ACCEPTED_BY_CUSTOMER and the Case
    // holds the Package locked — adding a Document is refused outright,
    // never silently accepted for readiness/handoff to notice afterwards.
    await req(`documentation-packages/${pkg.id}/documents`, { type: 'ACT_CERTIFICATE' }, 400);

    // The only correction-start route once a Case exists is SDO's own
    // "Вернуть в ПТО" (F8.3-17.2's own PTO pre-handoff correction is refused
    // once any Case exists — proven separately elsewhere in this file).
    await login('SDO');
    const returned = await req(`sdo-closing-cases/${sdoCase.id}/return-to-pto`, { version: sdoCase.version });
    assert.equal(returned.packageLocked, false);

    // Now CORRECTING — content is editable again: add Document B with no
    // version yet. (4)
    await login('PTO');
    const docB = await req(`documentation-packages/${pkg.id}/documents`, { type: 'ACT_CERTIFICATE' });
    let snap = await req('snapshot');
    let item = snap.sdoPackageReadiness.find((x: any) => x.documentationPackageId === pkg.id);
    assert.equal(item.ready, false, '(4) a versionless Document B breaks readiness — the Package also left ACCEPTED_BY_CUSTOMER, so the old A-only acceptance is stale on both counts');

    // (5) Give B a version — still CORRECTING (content-editable), no fresh
    // acceptance registered yet, so readiness stays false.
    await req(`documentation-documents/${docB.id}/versions`, { storageProvider: 'NONE' });
    snap = await req('snapshot');
    item = snap.sdoPackageReadiness.find((x: any) => x.documentationPackageId === pkg.id);
    assert.equal(item.ready, false, '(5) readiness remains false until a fresh acceptance actually covers both documents');

    // Re-present (content freezes again) and confirm handoff is still
    // refused before the fresh acceptance exists.
    const p = await req(`documentation-packages/${pkg.id}/status`, { status: 'PRESENTED', version: pkg.version + 1 });
    await req(`documentation-packages/${p.id}/handoff-to-sdo`, { version: p.version }, 400);

    // Register the fresh acceptance — now resolved against BOTH current documents.
    const reaccepted = await req(`documentation-packages/${p.id}/customer-acceptance`, { version: p.version, acceptedDate: dt(0), reference: 'Акт-Полное-Покрытие' });

    snap = await req('snapshot');
    const acceptanceRecord = snap.documentationCustomerAcceptances.find((a: any) => a.documentationPackageId === pkg.id && a.reference === 'Акт-Полное-Покрытие');
    const versionLinks = snap.documentationCustomerAcceptanceVersions.filter((v: any) => v.customerAcceptanceId === acceptanceRecord.id);
    const docAVersion = snap.documentationDocuments.find((d: any) => d.documentationPackageId === pkg.id && d.id !== docB.id);
    const aVersion = snap.documentationVersions.find((v: any) => v.documentationDocumentId === docAVersion.id);
    const bVersion = snap.documentationVersions.find((v: any) => v.documentationDocumentId === docB.id);
    assert.deepEqual(versionLinks.map((v: any) => v.documentationDocumentVersionId).sort(), [aVersion.id, bVersion.id].sort(), '(6) the new snapshot names both A-v1 and B-v1');

    item = snap.sdoPackageReadiness.find((x: any) => x.documentationPackageId === pkg.id);
    assert.equal(item.ready, true, '(6) readiness is true once the fresh acceptance covers every current document');
    const relocked = await req(`documentation-packages/${reaccepted.id}/handoff-to-sdo`, { version: reaccepted.version });
    assert.equal(relocked.id, sdoCase.id, '(6) the same Case resumes');
  } finally {
    await app.close();
  }
});

/* --------------------------------------------------------------------- *
 * F8.3-17: Documentation Package content lifecycle                       *
 * --------------------------------------------------------------------- */

test('F8.3-17 (1,2,3): PRESENTED freezes Package content — create document, create version, link Portion are all rejected', async () => {
  const { app, req, login } = await harness();
  try {
    const { pkg, doc, unit } = await setUpPresentedPackage(req, login, 'F83-17-PRESENTED-' + Date.now(), 'F8.3 заморозка: предъявлено');
    await login('PROJECT_MANAGER');
    const portion2 = await req(`execution-units/${unit.id}/portions`, { label: 'Секция B', plannedQuantity: 100 });
    await login('PTO');
    await req(`documentation-packages/${pkg.id}/documents`, { type: 'ACT_CERTIFICATE' }, 400);
    await req(`documentation-documents/${doc.id}/versions`, { storageProvider: 'NONE' }, 400);
    await req(`documentation-packages/${pkg.id}/portions`, { quantityPortionId: portion2.id }, 400);
  } finally {
    await app.close();
  }
});

test('F8.3-17 (4,5,6): ACCEPTED_BY_CUSTOMER freezes Package content — create document, create version, link Portion are all rejected (no SDO Case involved yet)', async () => {
  const { app, req, login } = await harness();
  try {
    const { pkg, doc, unit } = await setUpPresentedPackage(req, login, 'F83-17-ACCEPTED-' + Date.now(), 'F8.3 заморозка: принято заказчиком');
    await login('PROJECT_MANAGER');
    const portion2 = await req(`execution-units/${unit.id}/portions`, { label: 'Секция B', plannedQuantity: 100 });
    await login('PTO');
    const accepted = await req(`documentation-packages/${pkg.id}/customer-acceptance`, { version: pkg.version, acceptedDate: dt(0) });
    assert.equal(accepted.status, 'ACCEPTED_BY_CUSTOMER');
    await req(`documentation-packages/${accepted.id}/documents`, { type: 'ACT_CERTIFICATE' }, 400);
    await req(`documentation-documents/${doc.id}/versions`, { storageProvider: 'NONE' }, 400);
    await req(`documentation-packages/${accepted.id}/portions`, { quantityPortionId: portion2.id }, 400);
  } finally {
    await app.close();
  }
});

test('F8.3-17 (7): RETURNED freezes Package content — create document is rejected', async () => {
  const { app, req, login } = await harness();
  try {
    const { pkg } = await setUpPresentedPackage(req, login, 'F83-17-RETURNED-' + Date.now(), 'F8.3 заморозка: возвращено заказчиком');
    await login('PTO');
    const returned = await req(`documentation-packages/${pkg.id}/status`, { status: 'RETURNED', version: pkg.version });
    assert.equal(returned.status, 'RETURNED');
    await req(`documentation-packages/${returned.id}/documents`, { type: 'ACT_CERTIFICATE' }, 400);
  } finally {
    await app.close();
  }
});

test('F8.3-17.2 (8,9,10,11): PTO-only pre-handoff correction — ACCEPTED_BY_CUSTOMER -> CORRECTING; ADMIN/PM/SDO/SC all refused; old acceptance/snapshot preserved', async () => {
  const { app, req, login } = await harness();
  try {
    const { pkg, doc } = await setUpPresentedPackage(req, login, 'F83-17-PREHANDOFF-' + Date.now(), 'F8.3 корректировка до передачи');
    await login('PTO');
    const accepted = await req(`documentation-packages/${pkg.id}/customer-acceptance`, { version: pkg.version, acceptedDate: dt(0), reference: 'Акт-До-Передачи' });

    // (9,10) non-PTO refused, Package untouched.
    for (const role of ['ADMIN', 'PROJECT_MANAGER', 'SDO', 'CONSTRUCTION_CONTROL']) {
      await login(role);
      await req(`documentation-packages/${accepted.id}/correction`, { version: accepted.version }, 403);
    }

    // (8) PTO succeeds.
    await login('PTO');
    const corrected = await req(`documentation-packages/${accepted.id}/correction`, { version: accepted.version, comment: 'Ошибка в документе' });
    assert.equal(corrected.status, 'CORRECTING');

    // (11) the original acceptance record and its version snapshot are untouched.
    const snap = await req('snapshot');
    const acceptanceRecord = snap.documentationCustomerAcceptances.find((a: any) => a.documentationPackageId === pkg.id);
    assert.equal(acceptanceRecord.reference, 'Акт-До-Передачи');
    const versionLinks = snap.documentationCustomerAcceptanceVersions.filter((v: any) => v.customerAcceptanceId === acceptanceRecord.id);
    assert.equal(versionLinks.length, 1);
    const docVersion = snap.documentationVersions.find((v: any) => v.documentationDocumentId === doc.id);
    assert.equal(versionLinks[0].documentationDocumentVersionId, docVersion.id);

    const history = snap.documentationStatusHistory.filter((h: any) => h.documentationPackageId === pkg.id);
    assert.ok(history.some((h: any) => h.fromStatus === 'ACCEPTED_BY_CUSTOMER' && h.toStatus === 'CORRECTING'));
  } finally {
    await app.close();
  }
});

test('F8.3-17 (12,13,14): CORRECTING (via pre-handoff correction) allows content editing; re-presenting and a new acceptance create a new independent snapshot and restore readiness', async () => {
  const { app, req, login } = await harness();
  try {
    const { pkg, doc } = await setUpPresentedPackage(req, login, 'F83-17-EDIT-' + Date.now(), 'F8.3 редактирование на корректировке');
    await login('PTO');
    const accepted = await req(`documentation-packages/${pkg.id}/customer-acceptance`, { version: pkg.version, acceptedDate: dt(0), reference: 'Акт-1' });
    const corrected = await req(`documentation-packages/${accepted.id}/correction`, { version: accepted.version });
    assert.equal(corrected.status, 'CORRECTING');

    // (12) content is editable again.
    const version2 = await req(`documentation-documents/${doc.id}/versions`, { storageProvider: 'EXTERNAL_REFERENCE', storageReference: 'https://example.test/v2' });
    assert.equal(version2.versionNumber, 2);

    // (13) re-present, register a new acceptance.
    const presented = await req(`documentation-packages/${corrected.id}/status`, { status: 'PRESENTED', version: corrected.version });
    const reaccepted = await req(`documentation-packages/${presented.id}/customer-acceptance`, { version: presented.version, acceptedDate: dt(0), reference: 'Акт-2' });

    const snap = await req('snapshot');
    const acceptances = snap.documentationCustomerAcceptances.filter((a: any) => a.documentationPackageId === pkg.id);
    assert.equal(acceptances.length, 2, 'the earlier acceptance is preserved, a new independent one is created');
    const latestAcceptance = acceptances[acceptances.length - 1];
    const latestLinks = snap.documentationCustomerAcceptanceVersions.filter((v: any) => v.customerAcceptanceId === latestAcceptance.id);
    assert.equal(latestLinks.length, 1);
    assert.equal(latestLinks[0].documentationDocumentVersionId, version2.id, 'the new snapshot names the corrected version');

    // (14) readiness is valid again.
    const item = snap.sdoPackageReadiness.find((x: any) => x.documentationPackageId === pkg.id);
    assert.equal(item.ready, true);
    assert.equal(reaccepted.status, 'ACCEPTED_BY_CUSTOMER');
  } finally {
    await app.close();
  }
});

test('F8.3-17.2 (15): once an SDO Case exists for the Package, PTO pre-handoff correction is refused — only "Вернуть в ПТО" from the Case can start a correction from then on', async () => {
  const { app, req, login } = await harness();
  try {
    const { pkg } = await setUpHandedOffCase(req, login, 'F83-17-CASEEXISTS-' + Date.now(), 'F8.3 дело уже существует');
    await login('PTO');
    // The Package's status is only ever ACCEPTED_BY_CUSTOMER simultaneously
    // with a Case existing while that Case is locked — returnSdoCaseToPto
    // always moves the Package to CORRECTING in the same transaction as
    // unlocking, so "case exists but unlocked, Package still ACCEPTED_BY_CUSTOMER"
    // is unreachable by construction. This is the one reachable state, and
    // it must reject.
    await req(`documentation-packages/${pkg.id}/correction`, { version: pkg.version }, 400);
  } finally {
    await app.close();
  }
});

test('F8.3-17 (18): a CLOSED Case\'s Package content cannot be changed — create document, create version and link Portion are all rejected', async () => {
  const { app, req, login } = await harness();
  try {
    const { pkg, doc, unit, sdoCase } = await setUpHandedOffCase(req, login, 'F83-17-CLOSEDCONTENT-' + Date.now(), 'F8.3 контент закрытого дела');
    await login('PROJECT_MANAGER');
    const portion2 = await req(`execution-units/${unit.id}/portions`, { label: 'Секция B', plannedQuantity: 100 });
    await login('SDO');
    let c = await req(`sdo-closing-cases/${sdoCase.id}/status`, { version: sdoCase.version, status: 'VERIFICATION_PASSED' });
    c = await req(`sdo-closing-cases/${c.id}/amount`, { version: c.version, amount: '500.00' });
    c = await req(`sdo-closing-cases/${c.id}/status`, { version: c.version, status: 'CLOSED' });
    assert.equal(c.status, 'CLOSED');

    await login('PTO');
    await req(`documentation-packages/${pkg.id}/documents`, { type: 'ACT_CERTIFICATE' }, 400);
    await req(`documentation-documents/${doc.id}/versions`, { storageProvider: 'NONE' }, 400);
    await req(`documentation-packages/${pkg.id}/portions`, { quantityPortionId: portion2.id }, 400);
  } finally {
    await app.close();
  }
});

test('F8.3-17.3 (19): a deliberately stale/inconsistent acceptance state cannot reach CLOSED — revalidated at the CLOSED transition itself', async () => {
  const { app, req, login } = await harness();
  try {
    // Dynamically imported, and only after harness() has set DB_MODE/PGLITE_DIR
    // — see the other white-box tests in this file for why a static
    // top-level import would break every test.
    const { pool } = await import('../apps/backend/src/db');
    const { pkg, doc, sdoCase } = await setUpHandedOffCase(req, login, 'F83-17-STALECLOSE-' + Date.now(), 'F8.3 закрытие при устаревшем согласии');

    // White-box: simulate a hypothetical bug that adds a new document
    // version directly at the database layer, bypassing the (now correctly
    // enforced) content freeze — the only way to reach the state F8.3-17.3
    // exists to guard against, since the ordinary API can no longer produce
    // it at all (proven by F8.3-17 (18) above).
    await pool.query("INSERT INTO documentation_document_versions(tenant_id,documentation_document_id,version_number,storage_provider,created_by) VALUES ($1,$2,2,'NONE',$3)", [pkg.tenantId, doc.id, doc.createdBy]);

    await login('SDO');
    let c = await req(`sdo-closing-cases/${sdoCase.id}/status`, { version: sdoCase.version, status: 'VERIFICATION_PASSED' });
    c = await req(`sdo-closing-cases/${c.id}/amount`, { version: c.version, amount: '500.00' });
    await req(`sdo-closing-cases/${c.id}/status`, { version: c.version, status: 'CLOSED' }, 400);
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

/* --------------------------------------------------------------------- *
 * F8.3-19: reversible Portion allocation (explicit cancellation)         *
 * --------------------------------------------------------------------- */

test('F8.3-19 (32,33,34,35): cancelling the only active allocation lets closing use the total amount alone, without deleting the allocation or its history', async () => {
  const { app, req, login } = await harness();
  try {
    const { sdoCase, portion } = await setUpHandedOffCase(req, login, 'F83-19-CANCEL-' + Date.now(), 'F8.3 отмена распределения');
    await login('SDO');
    let c = await req(`sdo-closing-cases/${sdoCase.id}/status`, { version: sdoCase.version, status: 'VERIFICATION_PASSED' });
    c = await req(`sdo-closing-cases/${c.id}/amount`, { version: c.version, amount: '1000.00' });
    const allocation = await req(`sdo-closing-cases/${c.id}/allocations`, { quantityPortionId: portion.id, amount: '200.00' });

    // (32) cancel it.
    const cancelled = await req(`sdo-closing-cases/${c.id}/allocations/${portion.id}/cancel`, { version: allocation.version });
    assert.ok(cancelled.cancelledAt, 'the row is marked cancelled, not deleted');
    assert.ok(cancelled.cancelledBy);

    // (33,35) closing now uses the total amount alone — the cancelled
    // allocation no longer counts, where the un-cancelled 200 would have
    // blocked CLOSED against a 1000 total.
    const refreshed = (await req('snapshot')).sdoClosingCases.find((x: any) => x.id === c.id);
    const closed = await req(`sdo-closing-cases/${c.id}/status`, { version: refreshed.version, status: 'CLOSED' });
    assert.equal(closed.status, 'CLOSED');

    // (34) the allocation row and its full CREATE->CANCEL history remain
    // readable — never deleted.
    const snap = await req('snapshot');
    const stillThere = snap.sdoClosingPortionAllocations.find((a: any) => a.id === allocation.id);
    assert.ok(stillThere, 'the allocation row itself is preserved, not deleted');
    assert.ok(stillThere.cancelledAt);
    const history = snap.sdoClosingPortionAllocationHistory.filter((h: any) => h.sdoClosingCaseId === c.id && h.quantityPortionId === portion.id);
    assert.deepEqual(history.map((h: any) => h.operation), ['CREATE', 'CANCEL']);
    assert.equal(history[0].previousAmount, null);
    assert.equal(history[0].newAmount, '200.00');
    assert.equal(history[1].previousAmount, '200.00');
    assert.equal(history[1].newAmount, null);
  } finally {
    await app.close();
  }
});

test('F8.3-19 (36): a zero total amount may also close after cancelling the only erroneous allocation', async () => {
  const { app, req, login } = await harness();
  try {
    const { sdoCase, portion } = await setUpHandedOffCase(req, login, 'F83-19-ZERO-' + Date.now(), 'F8.3 нулевая сумма после отмены');
    await login('SDO');
    let c = await req(`sdo-closing-cases/${sdoCase.id}/status`, { version: sdoCase.version, status: 'VERIFICATION_PASSED' });
    c = await req(`sdo-closing-cases/${c.id}/amount`, { version: c.version, amount: '0.00' });
    const allocation = await req(`sdo-closing-cases/${c.id}/allocations`, { quantityPortionId: portion.id, amount: '50.00' });
    await req(`sdo-closing-cases/${c.id}/allocations/${portion.id}/cancel`, { version: allocation.version });

    const refreshed = (await req('snapshot')).sdoClosingCases.find((x: any) => x.id === c.id);
    const closed = await req(`sdo-closing-cases/${c.id}/status`, { version: refreshed.version, status: 'CLOSED' });
    assert.equal(closed.status, 'CLOSED');
  } finally {
    await app.close();
  }
});

test('F8.3-19 (37): a restored (previously cancelled) allocation is active again and still participates in the exact-sum rule', async () => {
  const { app, req, login } = await harness();
  try {
    const { sdoCase, portion } = await setUpHandedOffCase(req, login, 'F83-19-RESTORE-' + Date.now(), 'F8.3 восстановленное распределение');
    await login('SDO');
    let c = await req(`sdo-closing-cases/${sdoCase.id}/status`, { version: sdoCase.version, status: 'VERIFICATION_PASSED' });
    c = await req(`sdo-closing-cases/${c.id}/amount`, { version: c.version, amount: '1000.00' });
    const allocation = await req(`sdo-closing-cases/${c.id}/allocations`, { quantityPortionId: portion.id, amount: '200.00' });
    const cancelled = await req(`sdo-closing-cases/${c.id}/allocations/${portion.id}/cancel`, { version: allocation.version });

    // Restore it with a still-mismatched amount (400, not 1000).
    const restored = await req(`sdo-closing-cases/${c.id}/allocations`, { quantityPortionId: portion.id, amount: '400.00', version: cancelled.version });
    assert.equal(restored.cancelledAt, null, 'restoring clears the cancelled state');

    const refreshed = (await req('snapshot')).sdoClosingCases.find((x: any) => x.id === c.id);
    await req(`sdo-closing-cases/${c.id}/status`, { version: refreshed.version, status: 'CLOSED' }, 400);

    const history = (await req('snapshot')).sdoClosingPortionAllocationHistory.filter((h: any) => h.sdoClosingCaseId === c.id && h.quantityPortionId === portion.id);
    assert.deepEqual(history.map((h: any) => h.operation), ['CREATE', 'CANCEL', 'RESTORE']);
  } finally {
    await app.close();
  }
});

test('F8.3-19 (38): a CLOSED Case refuses allocation cancellation — only after CLOSED -> ON_CORRECTION does cancellation succeed', async () => {
  const { app, req, login } = await harness();
  try {
    const { sdoCase, portion } = await setUpHandedOffCase(req, login, 'F83-19-CLOSEDCANCEL-' + Date.now(), 'F8.3 отмена распределения закрытого дела');
    await login('SDO');
    let c = await req(`sdo-closing-cases/${sdoCase.id}/status`, { version: sdoCase.version, status: 'VERIFICATION_PASSED' });
    c = await req(`sdo-closing-cases/${c.id}/amount`, { version: c.version, amount: '750.00' });
    const allocation = await req(`sdo-closing-cases/${c.id}/allocations`, { quantityPortionId: portion.id, amount: '750.00' });

    const refreshed = (await req('snapshot')).sdoClosingCases.find((x: any) => x.id === c.id);
    c = await req(`sdo-closing-cases/${c.id}/status`, { version: refreshed.version, status: 'CLOSED' });
    assert.equal(c.status, 'CLOSED');

    await req(`sdo-closing-cases/${c.id}/allocations/${portion.id}/cancel`, { version: allocation.version }, 400);

    const corrected = await req(`sdo-closing-cases/${c.id}/status`, { version: c.version, status: 'ON_CORRECTION', reason: 'Ошибка в распределении' });
    const cancelled = await req(`sdo-closing-cases/${corrected.id}/allocations/${portion.id}/cancel`, { version: allocation.version });
    assert.ok(cancelled.cancelledAt);
  } finally {
    await app.close();
  }
});

test('F8.3-19 (39): returned-to-PTO also rejects cancelling an existing allocation', async () => {
  const { app, req, login } = await harness();
  try {
    const { sdoCase, portion } = await setUpHandedOffCase(req, login, 'F83-19-RETURNEDCANCEL-' + Date.now(), 'F8.3 отмена при возврате в ПТО');
    await login('SDO');
    const allocation = await req(`sdo-closing-cases/${sdoCase.id}/allocations`, { quantityPortionId: portion.id, amount: '100.00' });
    const returned = await req(`sdo-closing-cases/${sdoCase.id}/return-to-pto`, { version: sdoCase.version });
    assert.equal(returned.packageLocked, false);

    await req(`sdo-closing-cases/${sdoCase.id}/allocations/${portion.id}/cancel`, { version: allocation.version }, 400);
  } finally {
    await app.close();
  }
});

test('F8.3-19: cancelling requires an existing, still-active allocation', async () => {
  const { app, req, login } = await harness();
  try {
    const { sdoCase, portion } = await setUpHandedOffCase(req, login, 'F83-19-CANCELGUARDS-' + Date.now(), 'F8.3 отмена: защитные проверки');
    await login('SDO');
    // No allocation exists yet for this portion.
    await req(`sdo-closing-cases/${sdoCase.id}/allocations/${portion.id}/cancel`, { version: 1 }, 400);

    const allocation = await req(`sdo-closing-cases/${sdoCase.id}/allocations`, { quantityPortionId: portion.id, amount: '100.00' });
    const cancelled = await req(`sdo-closing-cases/${sdoCase.id}/allocations/${portion.id}/cancel`, { version: allocation.version });
    // Already cancelled.
    await req(`sdo-closing-cases/${sdoCase.id}/allocations/${portion.id}/cancel`, { version: cancelled.version }, 400);
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
