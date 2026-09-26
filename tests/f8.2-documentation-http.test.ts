import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * F8.2 PTO / Executive Documentation Foundation — HTTP-level. Step 3
 * ("Backend: implement API. Verify: authentication; permissions; object
 * scope"), over the real backend, PGlite. The domain/service-level rules
 * themselves (create, link, BR-01..04, version history, status history) are
 * already covered in tests/documentation-foundation.test.ts; this file's job
 * is only to prove the controllers/routes/DTOs and the snapshot's own
 * per-role visibility are wired correctly.
 */

const dt = (delta: number) => new Date(Date.now() + delta * 86400000).toISOString().slice(0, 10);

async function harness() {
  if (!process.env.E2E_DATABASE_URL) delete process.env.DATABASE_URL;
  process.env.AUTH_MODE = 'mock';
  process.env.MOCK_LOGIN_KEY = 'f8-2-http-key';
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
    const d = await req('auth/mock', { role, key: 'f8-2-http-key' });
    token = d.token;
    return d.user;
  }
  return { app, req, login, base };
}

test('F8.2 HTTP: authentication is required on every documentation route', async () => {
  const { app, base } = await harness();
  try {
    const r1 = await fetch(base + '/documentation-packages');
    assert.equal(r1.status, 401);
    const r2 = await fetch(base + '/documentation-packages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r2.status, 401);
  } finally {
    await app.close();
  }
});

test('F8.2 HTTP: full round trip — PTO creates a package, links portions, creates a document and versions, changes status; visible on snapshot and the dedicated list route', async () => {
  const { app, req, login } = await harness();
  try {
    const pm = await login('PROJECT_MANAGER');
    const dict = await req('dictionaries');
    const contractors = await req('contractors');
    await login('TECHNICAL_DIRECTOR');
    const o = await req('objects', { externalCode: 'F82-HTTP-' + Date.now(), name: 'F8.2 HTTP round trip', address: 'Тест, 1', organizationName: 'ООО СЗ «Гор-Строй»', projectManagerId: pm.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [contractors[0].id] });
    await login('PROJECT_MANAGER');
    const work = await req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, responsibleUserId: pm.id, name: 'Работа под ИД', unit: 'м²', plannedQuantity: 500, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '100000' });
    const unit = await req('execution-units', { objectWorkId: work.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, unit: 'м²', plannedQuantity: 500 });
    const portion = await req(`execution-units/${unit.id}/portions`, { label: 'Секция A', plannedQuantity: 200 });

    // RP (read-only per the Foundation contract) must be refused.
    await req('documentation-packages', { objectWorkId: work.id, responsibleUserId: pm.id }, 403);

    const pto = await login('PTO');
    const pkg = await req('documentation-packages', { objectWorkId: work.id, responsibleUserId: pto.id });
    assert.equal(pkg.status, 'DRAFT');
    assert.equal(pkg.objectWorkId, work.id);

    const link = await req(`documentation-packages/${pkg.id}/portions`, { quantityPortionId: portion.id });
    assert.equal(link.quantityPortionId, portion.id);

    const doc = await req(`documentation-packages/${pkg.id}/documents`, { type: 'AOSR' });
    assert.equal(doc.type, 'AOSR');

    const v1 = await req(`documentation-documents/${doc.id}/versions`, { storageProvider: 'NONE' });
    assert.equal(v1.versionNumber, 1);
    const v2 = await req(`documentation-documents/${doc.id}/versions`, { storageProvider: 'EXTERNAL_REFERENCE', storageReference: 'https://disk.example/aosr.pdf' });
    assert.equal(v2.versionNumber, 2);

    const statusChanged = await req(`documentation-packages/${pkg.id}/status`, { status: 'PREPARING', version: pkg.version });
    assert.equal(statusChanged.status, 'PREPARING');

    // --- dedicated list route, filterable by object ---
    const list = await req('documentation-packages');
    assert.ok(list.some((p: any) => p.id === pkg.id));
    const filtered = await req(`documentation-packages?objectId=${o.id}`);
    assert.ok(filtered.every((p: any) => p.objectId === o.id));
    assert.ok(filtered.some((p: any) => p.id === pkg.id));

    // --- snapshot carries the full documentation graph for PTO ---
    const snapshot = await req('snapshot');
    assert.ok(snapshot.documentationPackages.some((p: any) => p.id === pkg.id));
    assert.ok(snapshot.documentationPackagePortions.some((l: any) => l.documentationPackageId === pkg.id && l.quantityPortionId === portion.id));
    assert.ok(snapshot.documentationDocuments.some((d: any) => d.id === doc.id));
    assert.equal(snapshot.documentationVersions.filter((v: any) => v.documentationDocumentId === doc.id).length, 2);
    const history = snapshot.documentationStatusHistory.filter((h: any) => h.documentationPackageId === pkg.id);
    assert.equal(history.length, 1);
    assert.equal(history[0].fromStatus, 'DRAFT');
    assert.equal(history[0].toStatus, 'PREPARING');

    // --- RP and SC (read-only) see the same package on their own snapshot ---
    await login('PROJECT_MANAGER');
    const pmSnapshot = await req('snapshot');
    assert.ok(pmSnapshot.documentationPackages.some((p: any) => p.id === pkg.id), 'RP has read access per the Foundation contract');
    await login('CONSTRUCTION_CONTROL');
    const scSnapshot = await req('snapshot');
    assert.ok(scSnapshot.documentationPackages.some((p: any) => p.id === pkg.id), 'SC has read access per the Foundation contract');
  } finally {
    await app.close();
  }
});

test('F8.2 HTTP: SDO has no F8.2 access at all — snapshot omits it, the dedicated list route refuses it', async () => {
  const { app, req, login } = await harness();
  try {
    const pm = await login('PROJECT_MANAGER');
    const dict = await req('dictionaries');
    const contractors = await req('contractors');
    await login('TECHNICAL_DIRECTOR');
    const o = await req('objects', { externalCode: 'F82-SDO-' + Date.now(), name: 'F8.2 SDO exclusion', address: 'Тест, 1', organizationName: 'ООО СЗ «Гор-Строй»', projectManagerId: pm.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [contractors[0].id] });
    await login('PROJECT_MANAGER');
    const work = await req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, responsibleUserId: pm.id, name: 'Работа', unit: 'м²', plannedQuantity: 100, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '20000' });
    const pto = await login('PTO');
    await req('documentation-packages', { objectWorkId: work.id, responsibleUserId: pto.id });

    await login('SDO');
    const snapshot = await req('snapshot');
    assert.equal(snapshot.documentationPackages, undefined, 'SDO must not receive documentation data on the shared snapshot at all');
    await req('documentation-packages', undefined, 403);

    // SDO is also refused every mutation, same as any other non-PTO role.
    await req('documentation-packages', { objectWorkId: work.id, responsibleUserId: pto.id }, 403);
  } finally {
    await app.close();
  }
});

test('F8.2 HTTP: creating a package against a nonexistent work is a 404, not a 500', async () => {
  const { app, req, login } = await harness();
  try {
    const pto = await login('PTO');
    await req('documentation-packages', { objectWorkId: '00000000-0000-0000-0000-000000000000', responsibleUserId: pto.id }, 404);
  } finally {
    await app.close();
  }
});

test('F8.2 HTTP: an invalid document type is rejected by the DTO, before it ever reaches the database', async () => {
  const { app, req, login } = await harness();
  try {
    const pm = await login('PROJECT_MANAGER');
    const dict = await req('dictionaries');
    const contractors = await req('contractors');
    await login('TECHNICAL_DIRECTOR');
    const o = await req('objects', { externalCode: 'F82-TYPE-' + Date.now(), name: 'F8.2 invalid type', address: 'Тест, 1', organizationName: 'ООО СЗ «Гор-Строй»', projectManagerId: pm.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [contractors[0].id] });
    await login('PROJECT_MANAGER');
    const work = await req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, responsibleUserId: pm.id, name: 'Работа', unit: 'м²', plannedQuantity: 100, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '20000' });
    const pto = await login('PTO');
    const pkg = await req('documentation-packages', { objectWorkId: work.id, responsibleUserId: pto.id });
    await req(`documentation-packages/${pkg.id}/documents`, { type: 'GENERAL_WORK_LOG' }, 400);
  } finally {
    await app.close();
  }
});
