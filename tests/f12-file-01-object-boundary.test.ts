import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * F12-FILE-01 (LOCKED DECISION 3): an ordinary object file belongs to one
 * object. `attachments` itself carries no object_id at all — a bare
 * tenant-scoped blob store — so before this pass, `scoped(c,'attachments',id,a)`
 * proved only that a file existed *somewhere in the tenant*, never that it
 * belonged to the object a caller was linking it into. Any tenant member
 * could take an attachment first uploaded for Object A and point a brand new
 * executive document, or an inspection photo, at it under a completely
 * unrelated Object B — a live cross-object data-integrity gap this test
 * proves is now closed for both live linking paths, while confirming
 * same-object reuse and the locked material-passport/certificate exception
 * (a genuine company-level shared library) are both untouched.
 *
 * Against baseline 9ce729b99014c0e39817f1acf5a31cdcc326444b this test's two
 * "must be rejected" assertions below fail (both cross-object links succeed
 * with 201) — see F12.3 hardening report for the stash-verified RED/GREEN
 * evidence.
 */
test('F12-FILE-01: ordinary object files cannot cross objects; same-object reuse and the material-passport exception both keep working', async () => {
  if (!process.env.E2E_DATABASE_URL) delete process.env.DATABASE_URL;
  process.env.AUTH_MODE = 'mock';
  process.env.MOCK_LOGIN_KEY = 'f12-file-01-key';
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
    if (path === 'objects' && body !== undefined && r.status === 201) await (await import('./helpers/pbx3-fixtures')).assignPtoToObject(data.id); // PBX-3A: PTO works only on assigned objects
    assert.equal(r.status, expected, path + ': ' + JSON.stringify(data));
    return data;
  }
  async function login(role: string) {
    const d = await req('auth/mock', { role, key: 'f12-file-01-key' });
    token = d.token;
    return d.user;
  }
  const dt = (delta: number) => new Date(Date.now() + delta * 86400000).toISOString().slice(0, 10);
  const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=';
  const PDF_BASE64 = Buffer.from('%PDF-1.4\n% Test certificate\n%%EOF').toString('base64');

  try {
    const pm = await login('PROJECT_MANAGER');
    const contractors = await req('contractors'), dict = await req('dictionaries');
    const c = contractors[0], workTypeId = dict.workTypes[0].id;

    // A whole-work inspection requires the work at full planned quantity
    // ("Для MVP предъявляется полный объём работы") — each work is brought to
    // 100% before its inspection is requested.
    async function makeObjectAndWork(label: string) {
      const o = await req('objects', { externalCode: 'F12-FILE01-' + label + '-' + randomUUID(), name: 'F12-FILE-01 ' + label, address: 'Тест, ' + label, organizationName: 'ООО СЗ «Гор-Строй»', projectManagerId: pm.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [c.id] });
      let w = await req('works', { objectId: o.id, workTypeId, contractorId: c.id, responsibleUserId: pm.id, name: 'Работа ' + label, unit: 'м²', plannedQuantity: 10, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '10000' });
      w = await req(`works/${w.id}/progress`, { totalQuantity: 10, version: w.version, comment: 'Готово' });
      return { o, w };
    }
    const A = await makeObjectAndWork('A');
    const B = await makeObjectAndWork('B');
    // A second, independent work under Object A, for the same-object-reuse proof.
    let A2 = await req('works', { objectId: A.o.id, workTypeId, contractorId: c.id, responsibleUserId: pm.id, name: 'Работа A2', unit: 'м²', plannedQuantity: 10, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '10000' });
    A2 = await req(`works/${A2.id}/progress`, { totalQuantity: 10, version: A2.version, comment: 'Готово' });

    // ---- inspection_photos path ----
    const inspectionA = await req(`works/${A.w.id}/inspection-request`, { version: A.w.version });
    const inspectionB = await req(`works/${B.w.id}/inspection-request`, { version: B.w.version });
    const inspectionA2 = await req(`works/${A2.id}/inspection-request`, { version: A2.version });

    await login('CONSTRUCTION_CONTROL');
    const photo = await req('attachments', { fileName: 'evidence.png', mimeType: 'image/png', base64: PNG_BASE64 });
    // First use: establishes this attachment's home object as A.
    await req(`inspections/${inspectionA.id}/photos`, { attachmentId: photo.id });
    // Same object, different inspection: must keep working (Locked Decision 3 —
    // "may be reused between works/inspections... inside that SAME object").
    await req(`inspections/${inspectionA2.id}/photos`, { attachmentId: photo.id });
    // Cross-object: Object A's photo must not be linkable under Object B.
    const crossPhoto = await req(`inspections/${inspectionB.id}/photos`, { attachmentId: photo.id }, 400);
    assert.match(crossPhoto.message, /другом объекте/);

    // ---- executive_documents path ----
    await login('PTO');
    const packageA = await req('executive-packages', { objectWorkId: A.w.id });
    const packageA2 = await req('executive-packages', { objectWorkId: A2.id });
    const packageB = await req('executive-packages', { objectWorkId: B.w.id });
    const doc = await req('attachments', { fileName: 'aosr.pdf', mimeType: 'application/pdf', base64: PDF_BASE64 });
    // First use: establishes this attachment's home object as A.
    await req('executive-documents', { packageId: packageA.id, type: 'AOSR', number: 'AOSR-1', documentDate: dt(0), fileId: doc.id });
    // Same object, different package: must keep working.
    await req('executive-documents', { packageId: packageA2.id, type: 'AOSR', number: 'AOSR-2', documentDate: dt(0), fileId: doc.id });
    // Cross-object: Object A's document file must not be linkable under Object B.
    const crossDoc = await req('executive-documents', { packageId: packageB.id, type: 'AOSR', number: 'AOSR-3', documentDate: dt(0), fileId: doc.id }, 400);
    assert.match(crossDoc.message, /другом объекте/);

    // ---- material_documents: locked company-level shared-library exception ----
    // Material passports/certificates are explicitly exempt — the same
    // physical certificate legitimately covers batches delivered to more
    // than one object in the same tenant. This must keep working exactly as
    // before, proving the FILE-01 fix did not become a general tenant-wide
    // attachment lock.
    const passport = await req('attachments', { fileName: 'passport.pdf', mimeType: 'application/pdf', base64: PDF_BASE64 });
    await req('materials/bind', { objectWorkId: A.w.id, name: 'Арматура А500С', manufacturer: 'Завод', batchNumber: 'П-А', quantity: 5, documentNumber: 'ПС-А', fileId: passport.id, validUntil: dt(365) });
    // Same passport file, reused under the UNRELATED Object B: must succeed.
    await req('materials/bind', { objectWorkId: B.w.id, name: 'Арматура А500С', manufacturer: 'Завод', batchNumber: 'П-Б', quantity: 5, documentNumber: 'ПС-Б', fileId: passport.id, validUntil: dt(365) });

    console.log('F12-FILE-01 VERIFIED: cross-object attachment reuse rejected for executive documents and inspection photos; same-object reuse and material-passport shared-library exception unaffected');
  } finally {
    await app.close();
  }
});
