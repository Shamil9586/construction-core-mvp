import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MockBitrixDisk, captureLogs, URL_SECRET } from './helpers/mock-bitrix-disk';

// The harness chooses the database from env when it first runs; the Bitrix sandbox must be registered before the app starts
// (a BITRIX_DISK deployment without a portal would refuse to boot — see the startup check in AttachmentsModule).
delete process.env.DATABASE_URL;
process.env.DB_MODE = 'pglite';
process.env.PGLITE_DIR = 'memory://';
process.env.FILE_STORAGE_PROVIDER = 'BITRIX_DISK';

let H: typeof import('./helpers/aosr-harness');
let fsm: typeof import('../apps/backend/src/file-storage/file-store');
let disk: MockBitrixDisk;
let logs: ReturnType<typeof captureLogs>;

/**
 * BITRIX-DISK-1 vertical slice over HTTP: executive scheme and generated AOSR DOCX stored in (sandboxed) Bitrix24 Disk, through
 * the real Nest app on PGlite with mock Core auth. Bitrix is never contacted. What is proven here is Core behaviour; the real
 * portal contract is listed in docs/bitrix-disk-1-storage.md as REQUIRES BITRIX24 TEST PORTAL VERIFICATION.
 */
before(async () => {
  H = await import('./helpers/aosr-harness');
  fsm = await import('../apps/backend/src/file-storage/file-store');
  disk = new MockBitrixDisk();
  fsm.setBitrixDiskTestHooks({ transport: disk, downloader: disk.download });
  await H.harness(); // boots the app (and migrates) with the sandbox registered
});
after(async () => { fsm.resetBitrixDiskTestHooks(); await H.closeHarness(); });
beforeEach(async () => {
  process.env.FILE_STORAGE_PROVIDER = 'BITRIX_DISK';
  disk = new MockBitrixDisk(); // a fresh portal per test; its folder ids are unknown to old mappings, so clear them (as a new portal would have none)
  fsm.setBitrixDiskTestHooks({ transport: disk, downloader: disk.download });
  await (await dbq()).pool.query('DELETE FROM storage_folder_mappings');
  logs = captureLogs();
});
afterEach(() => logs.restore());

const PDF2 = Buffer.from('%PDF-1.4\n% second version of the scheme\n%%EOF');
const pdfBody = (bytes: Buffer, fileName = 'scheme.pdf') => ({ fileName, mimeType: 'application/pdf', base64: bytes.toString('base64') });
const dbq = async () => (await import('../apps/backend/src/db'));
const idOf = (uuid: string) => uuid.replace(/-/g, '').slice(0, 8);
const versionsOf = async (docId: string) => { const { rows, pool } = await dbq(); return rows(pool, 'SELECT * FROM documentation_document_versions WHERE documentation_document_id=$1 ORDER BY version_number', [docId]); };
const attachmentOf = async (id: string) => { const { one, pool } = await dbq(); return one(pool, 'SELECT * FROM attachments WHERE id=$1', [id]); };
const count = async (sql: string, args: any[] = []) => Number((await (await dbq()).pool.query(sql, args)).rows[0].n);
const get = async (path: string, token?: string) => { const { base } = await H.harness(); return fetch(`${base}/${path}`, token ? { headers: { Authorization: 'Bearer ' + token } } : undefined); };

test('executive scheme: uploaded through the store into Disk, file-backed, downloadable with the original name and safe headers; Core versions stay CORE_FILE', async () => {
  const { req, raw } = await H.harness();
  const ctx = await H.setUp({ method: 'EXTERNAL' });
  const base = `documentation-packages/${ctx.pkg.id}`;
  const scheme = await req(`${base}/executive-schemes`, { title: 'ES-001', ...H.SCHEME_FILE });
  assert.equal(scheme.hasFile, true, 'a Disk-backed scheme counts as documentary evidence');
  assert.equal(scheme.fileName, 'scheme.pdf');
  assert.equal(scheme.fileVersion, 1);

  const [v] = await versionsOf(scheme.id);
  assert.equal(v.storageProvider, 'CORE_FILE', 'the document version does not know or care where the bytes live');
  const att = await attachmentOf(v.storageReference);
  assert.equal(att.fileProvider, 'BITRIX_DISK');
  assert.equal(att.content, null, 'no bytes in the Core database');
  assert.equal(att.uploadedBy, ctx.pto.id);
  const obj = ctx.object;
  assert.equal(disk.pathOf(att.externalFileId), `Construction Core/${obj.name} [${idOf(obj.id)}]/ПТО/Исполнительная документация/Исполнительные схемы/scheme [${idOf(att.id)}].pdf`);
  assert.notEqual(att.id, att.externalFileId);
  assert.notEqual(v.id, att.externalFileId, 'Core version identity is not a Bitrix id');

  const res = await raw(`${base}/executive-schemes/${scheme.id}/file`);
  assert.equal(res.status, 200);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(bytes.equals(Buffer.from(H.PDF_BASE64, 'base64')), true);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.equal(res.headers.get('content-disposition'), `attachment; filename="scheme.pdf"; filename*=UTF-8''scheme.pdf`);
  assert.equal(res.headers.get('cache-control'), 'private, no-store', 'never cacheable by a shared proxy');
  assert.equal(Number(res.headers.get('content-length')), bytes.length);
  assert.match(res.headers.get('content-security-policy') ?? '', /frame-ancestors/, 'Bitrix iframe embedding policy unchanged');
  assert.equal(res.headers.get('x-frame-options'), null);
  assert.equal(disk.downloads.length, 1, 'bytes were pulled server-side; the browser never sees a Disk URL');
  assert.equal((await get(`${base}/executive-schemes/${scheme.id}/file`)).status, 401, 'never public');
});

test('executive scheme versions: every upload is a new immutable Core version and a new Disk file; nothing is overwritten', async () => {
  const { req, raw } = await H.harness();
  const ctx = await H.setUp({ method: 'EXTERNAL' });
  const base = `documentation-packages/${ctx.pkg.id}`;
  const scheme = await H.uploadScheme(req, ctx.pkg.id, 'ES-002');
  const second = await req(`${base}/executive-schemes/${scheme.id}/file`, pdfBody(PDF2, 'scheme-v2.pdf'));
  assert.equal(second.fileVersion, 2);
  const [v1, v2] = await versionsOf(scheme.id);
  assert.deepEqual([v1.versionNumber, v2.versionNumber], [1, 2]);
  const [a1, a2] = [await attachmentOf(v1.storageReference), await attachmentOf(v2.storageReference)];
  assert.notEqual(a1.id, a2.id);
  assert.notEqual(a1.externalFileId, a2.externalFileId);
  assert.equal(disk.bytesOf(a1.externalFileId).equals(Buffer.from(H.PDF_BASE64, 'base64')), true, 'v1 is still intact in Disk');
  assert.equal(disk.bytesOf(a2.externalFileId).equals(PDF2), true);
  const res = await raw(`${base}/executive-schemes/${scheme.id}/file`);
  assert.equal(Buffer.from(await res.arrayBuffer()).equals(PDF2), true, 'the download is the latest Core version');
  assert.match(res.headers.get('content-disposition') ?? '', /filename\*=UTF-8''scheme-v2\.pdf/);
  assert.equal((await fsm.getFileStore().read(v1.tenantId, v1.storageReference)).content.equals(Buffer.from(H.PDF_BASE64, 'base64')), true, 'history stays readable');
  const { pool } = await dbq();
  await assert.rejects(pool.query('UPDATE documentation_document_versions SET storage_reference=$2 WHERE id=$1', [v1.id, v2.storageReference]), undefined, 'Core versions are append-only');
  // Provenance of the physical record is in the audit trail.
  const audit = await pool.query("SELECT new_value FROM audit_logs WHERE entity_type='DocumentationDocumentVersion' AND entity_id=$1 AND action='CREATE'", [v2.id]);
  const value = typeof audit.rows[0].new_value === 'string' ? JSON.parse(audit.rows[0].new_value) : audit.rows[0].new_value;
  assert.equal(value.attachment.provider, 'BITRIX_DISK');
  assert.equal(value.attachment.checksumSha256, createHash('sha256').update(PDF2).digest('hex'));
});

test('duplicate submit: two identical uploads are two Core versions and two Disk files, never one overwriting the other', async () => {
  const { req } = await H.harness();
  const ctx = await H.setUp({ method: 'EXTERNAL' });
  const base = `documentation-packages/${ctx.pkg.id}`;
  const scheme = await H.uploadScheme(req, ctx.pkg.id, 'ES-003');
  const body = pdfBody(PDF2);
  const { raw } = await H.harness();
  const [r1, r2] = await Promise.all([raw(`${base}/executive-schemes/${scheme.id}/file`, body), raw(`${base}/executive-schemes/${scheme.id}/file`, body)]);
  assert.deepEqual([r1.status, r2.status], [201, 201]);
  const versions = await versionsOf(scheme.id);
  assert.deepEqual(versions.map((v: any) => v.versionNumber), [1, 2, 3]);
  const atts = await Promise.all(versions.map((v: any) => attachmentOf(v.storageReference)));
  assert.equal(new Set(atts.map((a: any) => a.externalFileId)).size, 3);
  assert.equal(new Set(atts.map((a: any) => disk.pathOf(a.externalFileId))).size, 3);
});

test('generated AOSR DOCX: stored in Disk under the AOSR folder, downloaded with the generated name; regeneration is a new version, the old DOCX stays', async () => {
  const { req, raw } = await H.harness();
  const ctx = await H.setUp({ method: 'CORE' });
  const { aosr } = await H.generatedAosr(req, ctx);
  const detail = await req(`aosr/${aosr.id}`);
  assert.equal(detail.officialNumber, 1);
  const docId: string = (await (await dbq()).one((await dbq()).pool, 'SELECT documentation_document_id FROM aosr_documents WHERE id=$1', [aosr.id])).documentationDocumentId;
  const [v1] = await versionsOf(docId);
  const att1 = await attachmentOf(v1.storageReference);
  assert.equal(v1.storageProvider, 'CORE_FILE');
  assert.equal(att1.fileProvider, 'BITRIX_DISK');
  assert.match(att1.fileName, /^АОСР_1_.+\.docx$/, 'the generated Core file name is preserved');
  assert.equal(disk.pathOf(att1.externalFileId), `Construction Core/${ctx.object.name} [${idOf(ctx.object.id)}]/ПТО/Исполнительная документация/АОСР/${att1.fileName.replace(/\.docx$/, '')} [${idOf(att1.id)}].docx`);

  const res = await raw(`aosr/${aosr.id}/docx`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.match(res.headers.get('content-disposition') ?? '', /^attachment; filename="[\x20-\x7e]+\.docx"; filename\*=UTF-8''%D0%90%D0%9E%D0%A1%D0%A0_1_.+\.docx$/);
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  const bytes1 = Buffer.from(await res.arrayBuffer());
  const JSZip = (await import('jszip')).default;
  assert.ok((await JSZip.loadAsync(bytes1)).file('word/document.xml'), 'a real DOCX from Disk');

  // Regeneration: same official number, new immutable Core version, new Disk file.
  const edited = await req(`aosr/${aosr.id}/edit`, { workDescription: 'Устройство штукатурки стен (уточнено)', version: detail.version }, 201);
  const regenerated = await req(`aosr/${aosr.id}/generate`, { version: edited.version });
  assert.equal(regenerated.officialNumber, 1);
  assert.equal(regenerated.revisionCount, 2);
  const versions = await versionsOf(docId);
  assert.deepEqual(versions.map((v: any) => v.versionNumber), [1, 2]);
  const att2 = await attachmentOf(versions[1].storageReference);
  assert.notEqual(att2.externalFileId, att1.externalFileId);
  assert.equal(disk.bytesOf(att1.externalFileId).equals(bytes1), true, 'the previous DOCX is untouched in Disk');
  const bytes2 = Buffer.from(await (await raw(`aosr/${aosr.id}/docx`)).arrayBuffer());
  assert.equal(bytes2.equals(disk.bytesOf(att2.externalFileId)), true);
  assert.equal(bytes2.equals(bytes1), false, 'the download follows the current Core version');
  assert.deepEqual((await req(`aosr/${aosr.id}`)).revisions.map((r: any) => r.revisionNumber), [1, 2], 'Core revision history is its own');
  assert.equal(disk.files().filter(f => disk.pathOf(f.id).includes('/АОСР/')).length, 2);
});

test('executive-scheme readiness: a Disk-backed scheme satisfies the presentation gate; a metadata-only shell still does not', async () => {
  const { req, raw } = await H.harness();
  const ready = await H.setUp({ method: 'EXTERNAL' });
  await H.uploadScheme(req, ready.pkg.id, 'ES-READY');
  await H.presentPackage(req, ready.pkg.id, 201);

  const shellOnly = await H.setUp({ method: 'EXTERNAL' });
  const shell = await H.legacyDocumentShell(shellOnly.pkg.id, 'EXECUTIVE_SCHEME');
  const view = await req(`documentation-packages/${shellOnly.pkg.id}/aosr`);
  assert.equal(view.schemes.find((s: any) => s.id === shell.id).hasFile, false);
  const refused = await H.presentPackage(req, shellOnly.pkg.id, 400);
  assert.match(refused.message, /исполнительн/i);
  // A Disk row whose content was never verified cannot exist at all (CHECK), so it can never be mistaken for evidence.
  const { pool } = await dbq();
  await assert.rejects(pool.query("INSERT INTO attachments(tenant_id,file_provider,external_file_id,file_name,mime_type,size_bytes,checksum_sha256,uploaded_by) VALUES($1,'BITRIX_DISK','999','x.pdf','application/pdf',0,$2,$3)", [ready.pto.tenantId, 'b'.repeat(64), ready.pto.id]));
  void raw;
});

test('authorization precedes storage: an unauthorized Core user cannot reach a Disk-backed file by any id, and Bitrix is not even asked', async () => {
  const { req, raw, login, base: origin } = await H.harness();
  const ctx = await H.setUp({ method: 'CORE' });
  const { aosr, schemeId } = await H.generatedAosr(req, ctx);
  const pkgBase = `documentation-packages/${ctx.pkg.id}`;
  const snap = await req('snapshot');
  const version = snap.documentationVersions.find((v: any) => v.documentationDocumentId === schemeId);
  const attachmentId: string = version.storageReference;
  const att = await attachmentOf(attachmentId);
  const bitrixFileId: string = att.externalFileId;
  const schemeUrl = `${pkgBase}/executive-schemes/${schemeId}/file`, docxUrl = `aosr/${aosr.id}/docx`, genericUrl = `attachments/${attachmentId}`;

  // The browser-visible data never carries the Bitrix side.
  const exposed = JSON.stringify({ snap, view: await req(`${pkgBase}/aosr`), detail: await req(`aosr/${aosr.id}`) });
  assert.doesNotMatch(exposed, /externalFileId|externalFolderId|download\.json|SECRET-TOKEN|BITRIX_DISK|checksumSha256/);

  const before = disk.calls.length + disk.downloads.length;
  const denied = async (label: string, run: () => Promise<Response>, ...allowed: number[]) => { const r = await run(); assert.ok(allowed.includes(r.status), `${label}: ${r.status}`); };
  for (const role of ['SDO', 'CONTRACTOR_VIEWER']) {
    await login(role);
    await denied(`${role} scheme`, () => raw(schemeUrl), 403);
    await denied(`${role} docx`, () => raw(docxUrl), 403);
    await denied(`${role} generic by attachment id`, () => raw(genericUrl), 403);
  }
  const { makeUser, tokenFor } = await import('./helpers/pbx3-fixtures');
  const stranger = await tokenFor(await makeUser('Чужой ПТО', 'PTO'));
  await denied('PTO without access: scheme', () => get(schemeUrl, stranger), 403, 404);
  await denied('PTO without access: docx', () => get(docxUrl, stranger), 403, 404);
  await denied('PTO without access: generic by attachment id', () => get(genericUrl, stranger), 403, 404);
  await login('PROJECT_MANAGER');
  await denied('foreign PM generic', () => raw(genericUrl), 400, 403);
  assert.equal((await fetch(`${origin}/${genericUrl}`)).status, 401);
  // Possession of an identifier is not authorization: a Bitrix id is not even a valid Core id; a made-up Core id finds nothing.
  await login('PTO');
  await denied('bitrix id as attachment id', () => raw(`attachments/${bitrixFileId}`), 400);
  await denied('bitrix id as aosr id', () => raw(`aosr/${bitrixFileId}/docx`), 400);
  await denied('unknown uuid', () => raw('attachments/00000000-0000-4000-8000-000000000000'), 404);
  assert.equal(disk.calls.length + disk.downloads.length, before, 'every refusal happened before any Bitrix call');

  // Upload authorization is Core's too, and also precedes the store: roles without documentation rights, a PTO without an effective
  // assignment, and an archived/frozen package never reach Disk.
  const upload = (token?: string) => fetch(`${origin}/${pkgBase}/executive-schemes`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify({ title: 'Подмена', ...H.SCHEME_FILE }) });
  assert.equal((await upload()).status, 401);
  assert.ok([403, 404].includes((await upload(stranger)).status), 'stranger PTO cannot upload');
  for (const role of ['SDO', 'CONTRACTOR_VIEWER', 'PROJECT_MANAGER']) {
    await login(role);
    const r = await raw(`${pkgBase}/executive-schemes`, { title: 'Подмена', ...H.SCHEME_FILE });
    assert.equal(r.status, 403, role + ' upload');
  }
  assert.equal(disk.calls.length + disk.downloads.length, before, 'no refused upload touched Bitrix');
  assert.equal(await count("SELECT count(*)::int n FROM documentation_documents WHERE documentation_package_id=$1 AND title='Подмена'", [ctx.pkg.id]), 0);
  await login('PTO');

  // The authorized path works through the generic route too, provider-agnostically.
  const ok = await raw(genericUrl);
  assert.equal(ok.status, 200);
  assert.equal(Buffer.from(await ok.arrayBuffer()).equals(Buffer.from(H.PDF_BASE64, 'base64')), true);
  assert.ok(disk.downloads.length > 0);
});

test('external-user compatible: Bitrix is reached with the tenant installation only; no per-user Bitrix identity or token is involved', async () => {
  const { req, raw } = await H.harness();
  const ctx = await H.setUp({ method: 'EXTERNAL' });
  disk.reset();
  const scheme = await H.uploadScheme(req, ctx.pkg.id, 'ES-EXT');
  await raw(`documentation-packages/${ctx.pkg.id}/executive-schemes/${scheme.id}/file`);
  assert.ok(disk.calls.length > 0);
  const { pool, one } = await dbq();
  const tenantRow = await one(pool, 'SELECT tenant_id FROM users WHERE id=$1', [ctx.pto.id]);
  for (const c of disk.calls) {
    assert.equal(c.tenantId, tenantRow.tenantId, 'tenant-level call');
    assert.doesNotMatch(JSON.stringify(c.params), /USER_ID|auth|token|Bearer/i, `${c.method} carries no user identity or token`);
  }
  // The download is authorized by the Core session alone (a user with no portal account would be in the same position).
  assert.equal((await raw(`documentation-packages/${ctx.pkg.id}/executive-schemes/${scheme.id}/file`)).status, 200);
});

test('upload failure over HTTP: a Disk outage leaves no scheme shell, no version, no attachment; the retry then succeeds', async () => {
  const { req, raw } = await H.harness();
  const ctx = await H.setUp({ method: 'EXTERNAL' });
  const base = `documentation-packages/${ctx.pkg.id}`;
  const snapshot = async () => ({ docs: await count('SELECT count(*)::int n FROM documentation_documents WHERE documentation_package_id=$1', [ctx.pkg.id]), versions: await count('SELECT count(*)::int n FROM documentation_document_versions'), atts: await count('SELECT count(*)::int n FROM attachments') });
  const before = await snapshot();
  disk.fail('disk.folder.uploadfile');
  const r = await raw(`${base}/executive-schemes`, { title: 'ES-FAIL', ...pdfBody(PDF2) });
  assert.equal(r.status, 503);
  const body: any = await r.json();
  assert.match(body.message, /Хранилище файлов временно недоступно/);
  assert.ok(body.requestId);
  assert.deepEqual(await snapshot(), before, 'the whole transaction rolled back');
  assert.equal(disk.files().length, 0);
  // Not retried silently: the user sees the failure and decides. Retry works.
  const ok = await req(`${base}/executive-schemes`, { title: 'ES-FAIL', ...pdfBody(PDF2) });
  assert.equal(ok.hasFile, true);
  assert.equal((await snapshot()).docs, before.docs + 1);
});

test('AOSR generation over HTTP: an upload failure consumes no official number; the retry gets number 1', async () => {
  const { req, raw } = await H.harness();
  const ctx = await H.setUp({ method: 'CORE' });
  const base = `documentation-packages/${ctx.pkg.id}`;
  await H.fillParties(req, ctx.pkg.id);
  const material = await req(`${base}/aosr-materials`, { name: 'Смесь', qualityDocuments: [{ docType: 'CERTIFICATE', number: 'RU-9' }] });
  const scheme = await H.uploadScheme(req, ctx.pkg.id, 'ES-GEN');
  const a = await req(`${base}/aosr`, { title: 'Устройство штукатурки стен' });
  await H.fillAosr(req, ctx, a.id, material, { schemeId: scheme.id });
  const version = (await req(`aosr/${a.id}`)).version;
  disk.fail('disk.folder.uploadfile', undefined, { match: p => String(p.data?.NAME).endsWith('.docx') || /АОСР/.test(String(p.data?.NAME)) });
  const failed = await raw(`aosr/${a.id}/generate`, { version });
  assert.equal(failed.status, 503);
  const after = await req(`aosr/${a.id}`);
  assert.equal(after.officialNumber, null, 'no number consumed');
  assert.equal(after.revisionCount, 0);
  assert.equal(await count('SELECT coalesce(max(last_number),0)::int n FROM aosr_number_counters WHERE object_id=$1', [ctx.object.id]), 0);
  const generated = await req(`aosr/${a.id}/generate`, { version });
  assert.equal(generated.officialNumber, 1);
});

test('database failure AFTER the upload over HTTP: the uploaded Disk file is removed, nothing is committed, the retry succeeds', async () => {
  const { req, raw } = await H.harness();
  const ctx = await H.setUp({ method: 'EXTERNAL' });
  const base = `documentation-packages/${ctx.pkg.id}`;
  const { pool } = await dbq();
  await pool.query("CREATE OR REPLACE FUNCTION bd1_fail() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'simulated persistence failure'; END $$ LANGUAGE plpgsql");
  await pool.query('CREATE TRIGGER bd1_fail BEFORE INSERT ON documentation_document_versions FOR EACH ROW EXECUTE FUNCTION bd1_fail()');
  try {
    const attsBefore = await count('SELECT count(*)::int n FROM attachments');
    const r = await raw(`${base}/executive-schemes`, { title: 'ES-DB', ...pdfBody(PDF2) });
    assert.equal(r.status, 500);
    assert.equal(disk.callsOf('disk.folder.uploadfile').length, 1, 'the bytes DID reach Disk first');
    assert.equal(disk.files().length, 0, '…and were removed again when the database refused the version');
    assert.equal(disk.callsOf('disk.file.delete').length, 1);
    assert.equal(await count('SELECT count(*)::int n FROM attachments'), attsBefore);
    assert.equal(await count("SELECT count(*)::int n FROM documentation_documents WHERE documentation_package_id=$1 AND type='EXECUTIVE_SCHEME'", [ctx.pkg.id]), 0);
    assert.ok(logs.events().some(e => e.event === 'storage.compensated'));
  } finally { await pool.query('DROP TRIGGER bd1_fail ON documentation_document_versions'); await pool.query('DROP FUNCTION bd1_fail()'); }
  const ok = await req(`${base}/executive-schemes`, { title: 'ES-DB', ...pdfBody(PDF2) });
  assert.equal(ok.hasFile, true);
  assert.equal(disk.files().length, 1);
});

test('transition: LOCAL and Disk records coexist in one document history, and each is read through its own provider whatever is configured', async () => {
  const { req, raw } = await H.harness();
  const ctx = await H.setUp({ method: 'EXTERNAL' });
  const base = `documentation-packages/${ctx.pkg.id}`;
  process.env.FILE_STORAGE_PROVIDER = 'LOCAL';
  const scheme = await H.uploadScheme(req, ctx.pkg.id, 'ES-MIX');
  assert.equal(disk.calls.length, 0, 'LOCAL upload never touches Bitrix');
  const [local] = await versionsOf(scheme.id);
  assert.equal((await attachmentOf(local.storageReference)).fileProvider, 'LOCAL');

  process.env.FILE_STORAGE_PROVIDER = 'BITRIX_DISK';
  await req(`${base}/executive-schemes/${scheme.id}/file`, pdfBody(PDF2, 'v2.pdf'));
  const versions = await versionsOf(scheme.id);
  assert.deepEqual((await Promise.all(versions.map((v: any) => attachmentOf(v.storageReference)))).map((a: any) => a.fileProvider), ['LOCAL', 'BITRIX_DISK']);

  process.env.FILE_STORAGE_PROVIDER = 'LOCAL'; // rolled back: the Disk-backed v2 is still the current file and still readable
  const res = await raw(`${base}/executive-schemes/${scheme.id}/file`);
  assert.equal(Buffer.from(await res.arrayBuffer()).equals(PDF2), true);
  assert.equal((await fsm.getFileStore().read(local.tenantId, local.storageReference)).content.equals(Buffer.from(H.PDF_BASE64, 'base64')), true);
  assert.equal((await req(`${base}/aosr`)).schemes.find((s: any) => s.id === scheme.id).fileVersion, 2);
});

test('historical record written by the pre-BITRIX-DISK-1 code (no size, no checksum, provider default) is still evidence, readable and presentable', async () => {
  const { req, raw } = await H.harness();
  const ctx = await H.setUp({ method: 'EXTERNAL' });
  const { pool, insert } = await dbq();
  const doc = await insert(pool, 'documentation_documents', ctx.pto.tenantId, { documentationPackageId: ctx.pkg.id, type: 'EXECUTIVE_SCHEME', title: 'Историческая схема', createdBy: ctx.pto.id });
  const file = await insert(pool, 'attachments', ctx.pto.tenantId, { fileProvider: 'LOCAL', fileName: 'old.pdf', mimeType: 'application/pdf', content: Buffer.from(H.PDF_BASE64, 'base64'), uploadedBy: ctx.pto.id });
  await insert(pool, 'documentation_document_versions', ctx.pto.tenantId, { documentationDocumentId: doc.id, versionNumber: 1, storageProvider: 'CORE_FILE', storageReference: file.id, comment: 'old.pdf', createdBy: ctx.pto.id });
  assert.equal(file.sizeBytes, null);
  const view = await req(`documentation-packages/${ctx.pkg.id}/aosr`);
  assert.equal(view.schemes.find((s: any) => s.id === doc.id).hasFile, true);
  const res = await raw(`documentation-packages/${ctx.pkg.id}/executive-schemes/${doc.id}/file`);
  assert.equal(res.status, 200);
  assert.equal(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(H.PDF_BASE64, 'base64')), true);
  assert.equal(disk.calls.length, 0);
  await H.presentPackage(req, ctx.pkg.id, 201);
});

test('generic attachments route keeps working for ordinary (non-documentation) files and is no longer provider-blind', async () => {
  const { req, raw, login } = await H.harness();
  await login('CONSTRUCTION_CONTROL');
  const photo = await req('attachments', { fileName: 'sc.png', mimeType: 'image/png', base64: H.PNG_BASE64 });
  const res = await raw(`attachments/${photo.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  assert.equal(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(H.PNG_BASE64, 'base64')), true);
  assert.equal(disk.calls.length, 0, 'photos are outside this slice and stay LOCAL');
  void URL_SECRET;
});
