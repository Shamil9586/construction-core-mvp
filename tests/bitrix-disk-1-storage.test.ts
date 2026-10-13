import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import { MockBitrixDisk, captureLogs, MOCK_PORTAL, URL_SECRET } from './helpers/mock-bitrix-disk';

/**
 * BITRIX-DISK-1 — storage foundation, service level (PGlite). No Bitrix call is ever made: the Disk REST surface is the
 * in-memory sandbox in helpers/mock-bitrix-disk.ts, plugged into the same `installedCall` seam the notification outbox uses.
 * Real-portal behaviour is NOT claimed (REQUIRES BITRIX24 TEST PORTAL VERIFICATION, docs/bitrix-disk-1-storage.md).
 */
let ctx: any;
let disk: MockBitrixDisk;
let logs: ReturnType<typeof captureLogs>;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

before(async () => {
  delete process.env.DATABASE_URL;
  process.env.AUTH_MODE = 'mock';
  process.env.MOCK_LOGIN_KEY = 'bitrix-disk-1-key';
  process.env.DB_MODE = 'pglite';
  process.env.PGLITE_DIR = 'memory://';
  const { migrate } = await import('../scripts/migrate');
  const { seed } = await import('../scripts/seed');
  const db = await import('../apps/backend/src/db');
  await migrate();
  const tenant = await seed();
  const fsm = await import('../apps/backend/src/file-storage/file-store');
  const cfg = await import('../apps/backend/src/file-storage/config');
  const types = await import('../apps/backend/src/file-storage/types');
  const folders = await import('../apps/backend/src/file-storage/bitrix-disk-folders');
  const provider = await import('../apps/backend/src/file-storage/bitrix-disk-provider');
  const sql = await import('../apps/backend/src/file-storage/sql');
  const objects = await db.rows(db.pool, 'SELECT id,name FROM objects WHERE tenant_id=$1 ORDER BY external_code', [tenant.id]);
  const user = await db.one(db.pool, "SELECT * FROM users WHERE tenant_id=$1 AND role='PTO' AND is_active=true ORDER BY created_at LIMIT 1", [tenant.id]);
  ctx = { db, tenant, fsm, cfg, types, folders, provider, sql, objects, actor: { id: user.id, tenantId: tenant.id } };
});

beforeEach(async () => {
  disk = new MockBitrixDisk();
  ctx.fsm.setBitrixDiskTestHooks({ transport: disk, downloader: disk.download });
  process.env.FILE_STORAGE_PROVIDER = 'BITRIX_DISK';
  await ctx.db.pool.query('DELETE FROM storage_folder_mappings');
  logs = captureLogs();
});
afterEach(() => { logs.restore(); delete process.env.FILE_STORAGE_PROVIDER; ctx.fsm.resetBitrixDiskTestHooks(); });

const store = () => ctx.fsm.getFileStore();
const attachmentCount = async () => Number((await ctx.db.pool.query('SELECT count(*)::int n FROM attachments')).rows[0].n);
const rowOf = (id: string) => ctx.db.one(ctx.db.pool, 'SELECT * FROM attachments WHERE id=$1', [id]);
/** One Core put in its own unit of work (the same wrapper the AOSR service uses). */
const put = (o: { bytes?: Buffer; fileName?: string; category?: 'AOSR' | 'EXECUTIVE_SCHEME'; objectIndex?: number; actor?: any; after?: () => void } = {}) =>
  store().transaction(async (c: any, files: any) => {
    const row = await store().put(c, o.actor ?? ctx.actor, { fileName: o.fileName ?? 'scheme.pdf', mimeType: 'application/pdf', bytes: o.bytes ?? PDF, placement: { objectId: ctx.objects[o.objectIndex ?? 0].id, category: o.category ?? 'EXECUTIVE_SCHEME' }, log: { documentId: 'doc-1', packageId: 'pkg-1', versionNumber: 1 } }, files);
    o.after?.();
    return row;
  });
const rejectsWith = async (p: Promise<unknown>, code: string) => { try { await p; } catch (e: any) { assert.equal(e.code, code, 'got ' + e.code + ': ' + e.message); return e; } assert.fail('expected ' + code); };
const id8 = (uuid: string) => uuid.replace(/-/g, '').slice(0, 8);

test('configuration fails closed: a misspelled or incomplete provider never silently falls back', () => {
  const { readStorageConfig, assertFileStorageConfig } = ctx.cfg;
  assert.equal(readStorageConfig({} as any).provider, 'LOCAL', 'default is the legacy store');
  assert.equal(readStorageConfig({ FILE_STORAGE_PROVIDER: 'BITRIX_DISK' } as any).bitrixRootFolderName, 'Construction Core');
  for (const bad of ['bitrix_disk', 'S3', 'LOCAL ,']) assert.throws(() => readStorageConfig({ FILE_STORAGE_PROVIDER: bad } as any), (e: any) => e.code === 'STORAGE_NOT_CONFIGURED');
  assert.throws(() => readStorageConfig({ FILE_STORAGE_PROVIDER: 'BITRIX_DISK', BITRIX_DISK_STORAGE_ID: 'abc' } as any), (e: any) => e.code === 'STORAGE_NOT_CONFIGURED');
  assert.throws(() => readStorageConfig({ FILE_STORAGE_PROVIDER: 'BITRIX_DISK', BITRIX_DISK_ROOT_FOLDER_NAME: 'a/b' } as any), (e: any) => e.code === 'STORAGE_NOT_CONFIGURED');
  assert.throws(() => assertFileStorageConfig({ FILE_STORAGE_PROVIDER: 'BITRIX_DISK', AUTH_MODE: 'mock', BITRIX_PORTAL: MOCK_PORTAL } as any), /AUTH_MODE=bitrix/);
  assert.throws(() => assertFileStorageConfig({ FILE_STORAGE_PROVIDER: 'BITRIX_DISK', AUTH_MODE: 'bitrix' } as any), /BITRIX_PORTAL/);
  assert.doesNotThrow(() => assertFileStorageConfig({ FILE_STORAGE_PROVIDER: 'BITRIX_DISK', AUTH_MODE: 'bitrix', BITRIX_PORTAL: MOCK_PORTAL } as any));
  assert.doesNotThrow(() => assertFileStorageConfig({ FILE_STORAGE_PROVIDER: 'LOCAL', AUTH_MODE: 'mock' } as any));
});

test('provider abstraction: LOCAL keeps bytes in Core, BITRIX_DISK keeps only a pointer, an unknown provider is refused', async () => {
  process.env.FILE_STORAGE_PROVIDER = 'LOCAL';
  const local = await put();
  assert.equal(local.fileProvider, 'LOCAL');
  assert.deepEqual(Buffer.from(local.content), PDF);
  assert.equal(local.externalFileId, null);
  assert.equal(Number(local.sizeBytes), PDF.length);
  assert.equal(local.checksumSha256, sha(PDF));
  assert.equal(disk.calls.length, 0, 'LOCAL never touches Bitrix');

  process.env.FILE_STORAGE_PROVIDER = 'BITRIX_DISK';
  const remote = await put();
  assert.equal(remote.fileProvider, 'BITRIX_DISK');
  assert.equal(remote.content, null, 'no bytes in the Core database');
  assert.ok(remote.externalFileId && remote.externalFolderId);
  assert.notEqual(remote.id, remote.externalFileId, 'Core identity is its own uuid, never the Bitrix file id');
  assert.match(remote.id, /^[0-9a-f-]{36}$/);

  assert.throws(() => store().providerFor('DROPBOX'), (e: any) => e.code === 'STORAGE_PROVIDER_UNSUPPORTED');
  await ctx.db.pool.query("INSERT INTO attachments(tenant_id,file_provider,external_file_id,file_name,mime_type,size_bytes,checksum_sha256,uploaded_by) VALUES($1,'DROPBOX','x1','f.pdf','application/pdf',3,$2,$3)", [ctx.tenant.id, 'a'.repeat(64), ctx.actor.id]);
  const foreign = await ctx.db.one(ctx.db.pool, "SELECT id FROM attachments WHERE file_provider='DROPBOX'");
  await rejectsWith(store().read(ctx.tenant.id, foreign.id), 'STORAGE_PROVIDER_UNSUPPORTED');
});

test('successful Bitrix upload: documented REST contract, deterministic Disk name, Core record is authoritative', async () => {
  const row = await put({ fileName: 'Схема ES-001.pdf' });
  const uploads = disk.callsOf('disk.folder.uploadfile');
  assert.equal(uploads.length, 1);
  const p = uploads[0].params;
  const expectedName = `Схема ES-001 [${id8(row.id)}].pdf`;
  assert.equal(p.data.NAME, expectedName);
  assert.deepEqual(p.fileContent, [expectedName, PDF.toString('base64')], 'fileContent = [name, base64]');
  assert.equal(p.generateUniqueName, false, 'a name clash must fail loudly, never become "name (1).pdf"');
  assert.equal(p.id, row.externalFolderId);
  assert.equal(uploads[0].tenantId, ctx.tenant.id, 'goes through the tenant OAuth installation, no per-user token');
  // Only documented Disk methods; never an external/public link.
  const allowed = new Set(['disk.storage.getforapp', 'disk.storage.get', 'disk.folder.get', 'disk.folder.getchildren', 'disk.folder.addsubfolder', 'disk.folder.rename', 'disk.folder.uploadfile', 'disk.file.get', 'disk.file.delete']);
  for (const c of disk.calls) assert.ok(allowed.has(c.method), 'unexpected REST method ' + c.method);
  assert.ok(!disk.calls.some(c => /external|link/i.test(c.method)));
  // Metadata mapping.
  const db = await rowOf(row.id);
  assert.equal(db.fileName, 'Схема ES-001.pdf', 'Core keeps the original file name');
  assert.equal(db.mimeType, 'application/pdf');
  assert.equal(Number(db.sizeBytes), PDF.length);
  assert.equal(db.checksumSha256, sha(PDF));
  assert.equal(db.uploadedBy, ctx.actor.id);
  assert.equal(disk.bytesOf(db.externalFileId).equals(PDF), true);
});

test('successful retrieval: exact bytes through Core-controlled server-side download; size + checksum verified; no public link used', async () => {
  const row = await put({ fileName: 'АОСР_1_Штукатурка.docx', bytes: Buffer.from('PK-docx-bytes-1234') });
  disk.reset();
  const f = await store().read(ctx.tenant.id, row.id, { documentId: 'd1' });
  assert.equal(f.content.toString(), 'PK-docx-bytes-1234');
  assert.equal(f.fileName, 'АОСР_1_Штукатурка.docx', 'the Core file name is returned, not the Disk label');
  assert.equal(f.mimeType, 'application/pdf');
  assert.equal(f.provider, 'BITRIX_DISK');
  assert.deepEqual(disk.calls.map(c => c.method), ['disk.file.get']);
  assert.equal(disk.downloads.length, 1);
  assert.deepEqual(await store().verify(ctx.tenant.id, row.id), { exists: true, sizeMatches: true });
});

test('folder strategy: deterministic tree per Object, repeated upload reuses it, same-named Objects never mix', async () => {
  const a = ctx.objects[0], b = ctx.objects[1];
  const first = await put({ category: 'EXECUTIVE_SCHEME' });
  const aosr = await put({ category: 'AOSR', fileName: 'АОСР_1.docx' });
  const base = `Construction Core/${a.name} [${id8(a.id)}]/ПТО/Исполнительная документация`;
  assert.deepEqual(disk.folderPaths(), ['Construction Core', `Construction Core/${a.name} [${id8(a.id)}]`, `Construction Core/${a.name} [${id8(a.id)}]/ПТО`, base, `${base}/АОСР`, `${base}/Исполнительные схемы`].sort());
  assert.equal(disk.pathOf(first.externalFileId).startsWith(`${base}/Исполнительные схемы/scheme [${id8(first.id)}].pdf`), true);
  assert.equal(disk.pathOf(aosr.externalFileId), `${base}/АОСР/АОСР_1 [${id8(aosr.id)}].docx`);

  // Repeated upload: no new folder, not even a listing — the Core mapping is the source of truth.
  disk.reset();
  const again = await put();
  assert.equal(disk.callsOf('disk.folder.addsubfolder').length, 0);
  assert.equal(disk.callsOf('disk.folder.getchildren').length, 0);
  assert.equal(again.externalFolderId, first.externalFolderId);
  assert.equal(disk.folderPaths().length, 6, 'one tree');

  // A different Object gets its own branch even if the name were identical (the [id8] token), never the first one's folder.
  await ctx.db.pool.query('UPDATE objects SET name=$2 WHERE id=$1', [b.id, a.name]);
  const other = await put({ objectIndex: 1 });
  assert.notEqual(other.externalFolderId, first.externalFolderId);
  assert.ok(disk.pathOf(other.externalFileId).startsWith(`Construction Core/${a.name} [${id8(b.id)}]/`));
  await ctx.db.pool.query('UPDATE objects SET name=$2 WHERE id=$1', [b.id, b.name]);
});

test('folder strategy: unsafe Object names are sanitized, and renaming an Object refreshes the label in place without orphaning anything', async () => {
  const { safeDiskName, objectFolderName } = ctx.folders;
  assert.equal(safeDiskName('ЖК "Север" / корпус 1: секция <А>?'), 'ЖК _Север_ _ корпус 1_ секция _А_');
  assert.equal(safeDiskName('...'), '_');
  assert.ok(safeDiskName('я'.repeat(500)).length <= 100);
  assert.match(objectFolderName('Дом', '12345678-aaaa-bbbb-cccc-dddddddddddd'), /^Дом \[12345678\]$/);

  const a = ctx.objects[0];
  const first = await put();
  const folderBefore = disk.byPath(`Construction Core/${a.name} [${id8(a.id)}]`)!;
  await ctx.db.pool.query('UPDATE objects SET name=$2 WHERE id=$1', [a.id, 'Новое имя объекта']);
  disk.reset();
  const second = await put();
  assert.equal(second.externalFolderId, first.externalFolderId, 'same leaf folder: the rename did not fork a second tree');
  assert.equal(disk.callsOf('disk.folder.addsubfolder').length, 0);
  assert.equal(disk.callsOf('disk.folder.rename').length, 1);
  assert.equal(disk.byPath(`Construction Core/Новое имя объекта [${id8(a.id)}]`)!.id, folderBefore.id, 'same Disk folder, new label');
  assert.equal(disk.files().length, 2, 'both files still in the one tree');
  // A label that cannot be refreshed never blocks an upload.
  await ctx.db.pool.query('UPDATE objects SET name=$2 WHERE id=$1', [a.id, 'Ещё одно имя']);
  disk.fail('disk.folder.rename', new Error('portal says no'));
  assert.ok((await put()).externalFileId);
  await ctx.db.pool.query('UPDATE objects SET name=$2 WHERE id=$1', [a.id, a.name]);
});

test('folder strategy: a lost mapping is re-discovered from the tree (no duplicate tree); a folder deleted in Disk is recreated', async () => {
  const a = ctx.objects[0];
  const first = await put();
  const folders = disk.folderPaths().length;
  await ctx.db.pool.query('DELETE FROM storage_folder_mappings');
  const second = await put();
  assert.equal(second.externalFolderId, first.externalFolderId, 'found again by exact name');
  assert.equal(disk.folderPaths().length, folders, 'no parallel tree');
  assert.equal(disk.callsOf('disk.folder.addsubfolder').length, 5, 'only the first-ever creation (5 levels)');

  // Renamed in Core while the mapping was lost: found by the [id8] token, adopted, label refreshed.
  await ctx.db.pool.query('DELETE FROM storage_folder_mappings');
  await ctx.db.pool.query('UPDATE objects SET name=$2 WHERE id=$1', [a.id, 'Переименован']);
  const third = await put();
  assert.equal(third.externalFolderId, first.externalFolderId);
  assert.equal(disk.folderPaths().length, folders);
  assert.ok(disk.byPath(`Construction Core/Переименован [${id8(a.id)}]`));
  await ctx.db.pool.query('UPDATE objects SET name=$2 WHERE id=$1', [a.id, a.name]);

  // A human deletes the leaf folder in Disk: the next upload heals it instead of failing forever.
  disk.remove(first.externalFolderId);
  const healed = await put();
  assert.notEqual(healed.externalFolderId, first.externalFolderId);
  assert.ok(disk.pathOf(healed.externalFileId).includes('/Исполнительные схемы/'));
  assert.ok(logs.events().some(e => e.event === 'storage.folder.mapping_dropped'));
});

test('upload failure: nothing is recorded, the error is classified and safe, and a later retry succeeds cleanly', async () => {
  const before = await attachmentCount();
  disk.fail('disk.folder.uploadfile'); // 500, nothing stored
  const transient = await rejectsWith(put(), 'STORAGE_UNAVAILABLE');
  assert.equal(transient.retryable, true);
  assert.equal(transient.getStatus(), 503);
  assert.equal(await attachmentCount(), before, 'no Core record for a failed upload');
  assert.equal(disk.files().length, 0);

  const { BitrixRestError } = await import('../apps/backend/src/bitrix');
  disk.reset();
  disk.fail('disk.folder.uploadfile', new BitrixRestError('insufficient_scope', 403));
  const permanent = await rejectsWith(put(), 'STORAGE_REJECTED');
  assert.equal(permanent.retryable, false);
  assert.equal(disk.callsOf('disk.folder.uploadfile').length, 1, 'a permanent refusal is not retried or reconciled');
  assert.doesNotMatch(permanent.message, /insufficient_scope|403/, 'no Bitrix detail leaks into the user-facing message');

  disk.fail('disk.folder.uploadfile', new UnauthorizedException('OAuth refresh failed'));
  await rejectsWith(put(), 'STORAGE_AUTH');
  assert.equal(await attachmentCount(), before);

  const ok = await put();
  assert.equal(await attachmentCount(), before + 1);
  assert.equal(disk.files().length, 1);
  assert.equal((await store().read(ctx.tenant.id, ok.id)).content.equals(PDF), true);
});

test('retry/idempotency: an upload whose answer was lost (timeout after the portal stored it) is adopted, never duplicated', async () => {
  disk.fail('disk.folder.uploadfile', Object.assign(new Error('aborted'), { name: 'TimeoutError' }), { applyFirst: true });
  const row = await put();
  assert.equal(disk.files().length, 1, 'exactly one Disk file');
  assert.equal(disk.callsOf('disk.folder.uploadfile').length, 1, 'no second upload was attempted');
  assert.equal(disk.pathOf(row.externalFileId).endsWith(`scheme [${id8(row.id)}].pdf`), true);
  assert.ok(logs.events().some(e => e.event === 'storage.put.adopted' && e.fileId === row.id && e.externalFileId === row.externalFileId));
  assert.equal((await store().read(ctx.tenant.id, row.id)).content.equals(PDF), true);

  // Same bytes submitted twice by a user: two Core file records, two distinct Disk files, nothing overwritten.
  disk.reset();
  const one = await put(), two = await put();
  assert.notEqual(one.id, two.id);
  assert.notEqual(one.externalFileId, two.externalFileId);
  assert.notEqual(disk.pathOf(one.externalFileId), disk.pathOf(two.externalFileId));
  assert.equal(disk.files().length, 3);
});

test('orphan prevention: a database failure AFTER the upload removes the uploaded file again', async () => {
  const before = await attachmentCount();
  // 1) a later statement of the business transaction fails
  await assert.rejects(put({ after: () => { throw new Error('business step failed'); } }), /business step failed/);
  assert.equal(disk.files().length, 0, 'uploaded file compensated');
  assert.equal(disk.callsOf('disk.file.delete').length, 1);
  assert.ok(logs.events().some(e => e.event === 'storage.compensated'));
  // 2) the attachments INSERT itself fails (FK: unknown uploader) after the bytes are already in Disk
  const e: any = await put({ actor: { id: randomUUID(), tenantId: ctx.tenant.id } }).then(() => null, (x: any) => x);
  assert.ok(e, 'the Core record could not be written');
  assert.equal(disk.files().length, 0);
  assert.equal(await attachmentCount(), before);
});

test('orphan prevention: when even the compensation fails, the orphan is logged loudly with every identifier', async () => {
  const { BitrixRestError } = await import('../apps/backend/src/bitrix');
  disk.fail('disk.file.delete', new BitrixRestError('INTERNAL_SERVER_ERROR', 500));
  await assert.rejects(put({ after: () => { throw new Error('business step failed'); } }), /business step failed/, 'the ORIGINAL error still surfaces');
  const orphan = logs.events().find(e => e.event === 'storage.orphan_possible');
  assert.ok(orphan, 'orphan logged');
  assert.equal(orphan.level, 'error');
  assert.equal(orphan.provider, 'BITRIX_DISK');
  assert.ok(orphan.fileId && orphan.externalFileId && orphan.externalFolderId && orphan.tenantId);
  assert.equal(orphan.documentId, 'doc-1');
  assert.equal(disk.files().length, 1, 'the file really is still in Disk — the log is how it gets found');
  assert.ok(disk.pathOf(orphan.externalFileId).includes(`[${id8(orphan.fileId)}]`), 'the Disk name carries the Core file id');
});

test('integrity at upload: a stored size that differs from what was sent never becomes a Core record; a missing SIZE is re-read from Disk', async () => {
  const before = await attachmentCount();
  const lying = { installedCall: async (t: string, m: string, p: any) => { const r = await disk.installedCall(t, m, p); if (m === 'disk.folder.uploadfile') r.SIZE = '1'; return r; } };
  ctx.fsm.setBitrixDiskTestHooks({ transport: lying, downloader: disk.download });
  await rejectsWith(put(), 'STORAGE_INTEGRITY');
  assert.equal(await attachmentCount(), before);
  assert.equal(disk.files().length, 0, 'the mismatching file was removed');

  const silent = { installedCall: async (t: string, m: string, p: any) => { const r = await disk.installedCall(t, m, p); if (m === 'disk.folder.uploadfile') delete r.SIZE; return r; } };
  ctx.fsm.setBitrixDiskTestHooks({ transport: silent, downloader: disk.download });
  disk.reset();
  const row = await put();
  assert.equal(disk.callsOf('disk.file.get').length, 1, 'metadata fetched to confirm the stored size');
  assert.equal(Number(row.sizeBytes), PDF.length);
});

test('integrity at read: bytes that do not match Core are never served (out-of-band edit, truncation, trash, missing, outage)', async () => {
  const row = await put();
  disk.tamper(row.externalFileId, Buffer.from('X'.repeat(PDF.length)));
  await rejectsWith(store().read(ctx.tenant.id, row.id), 'STORAGE_INTEGRITY');
  disk.tamper(row.externalFileId, Buffer.from('short'));
  disk.reset();
  await rejectsWith(store().read(ctx.tenant.id, row.id), 'STORAGE_INTEGRITY');
  assert.equal(disk.downloads.length, 0, 'size mismatch is caught from metadata before any bytes are pulled');
  assert.ok(logs.events().some(e => e.event.startsWith('storage.get') && e.fileId === row.id));

  const trashed = await put();
  disk.trash(trashed.externalFileId);
  await rejectsWith(store().read(ctx.tenant.id, trashed.id), 'STORAGE_NOT_FOUND');
  assert.deepEqual(await store().verify(ctx.tenant.id, trashed.id), { exists: false, sizeMatches: false });
  const gone = await put();
  disk.remove(gone.externalFileId);
  await rejectsWith(store().read(ctx.tenant.id, gone.id), 'STORAGE_NOT_FOUND');
  const fine = await put();
  disk.fail('disk.file.get', new Error('ECONNRESET'));
  const down = await rejectsWith(store().read(ctx.tenant.id, fine.id), 'STORAGE_UNAVAILABLE');
  assert.equal(down.retryable, true);
  assert.equal((await store().read(ctx.tenant.id, fine.id)).content.equals(PDF), true, 'and it recovers');
});

test('download guard: the tokenised DOWNLOAD_URL is only ever fetched over https from the portal host, with bounded redirects and size', async () => {
  const { guardedDiskDownload } = ctx.provider;
  const file = {} as any;
  const calls: string[] = [];
  const respond = (status: number, init: { location?: string; body?: string; length?: string } = {}) => async (url: string) => {
    calls.push(url);
    return new Response(status >= 300 && status < 400 ? null : (init.body ?? 'ok'), { status, headers: { ...(init.location ? { location: init.location } : {}), ...(init.length ? { 'content-length': init.length } : {}) } });
  };
  const dl = (f: any) => guardedDiskDownload(MOCK_PORTAL, f);
  const good = `https://${MOCK_PORTAL}/rest/download.json?auth=${URL_SECRET}&token=x`;
  assert.equal((await dl(respond(200, { body: 'bytes' }))(good, file)).toString(), 'bytes');
  for (const bad of ['http://' + MOCK_PORTAL + '/x', 'https://evil.example/x', `https://${MOCK_PORTAL}.evil.example/x`, `https://${MOCK_PORTAL}@evil.example/x`, 'ftp://' + MOCK_PORTAL + '/x', 'not a url']) {
    calls.length = 0;
    await rejectsWith(dl(respond(200))(bad, file), 'STORAGE_REJECTED');
    assert.equal(calls.length, 0, 'never fetched: ' + bad);
  }
  calls.length = 0;
  assert.equal((await dl(async (u: string) => (calls.push(u), calls.length === 1 ? new Response(null, { status: 302, headers: { location: '/disk/file/9' } }) : new Response('moved')))(good, file)).toString(), 'moved');
  await rejectsWith(dl(respond(302, { location: 'https://evil.example/steal' }))(good, file), 'STORAGE_REJECTED');
  await rejectsWith(dl(respond(302, { location: `https://${MOCK_PORTAL}/loop` }))(good, file), 'STORAGE_UNAVAILABLE'); // endless same-host redirects are bounded
  await rejectsWith(dl(respond(404))(good, file), 'STORAGE_NOT_FOUND');
  await rejectsWith(dl(respond(403))(good, file), 'STORAGE_REJECTED');
  await rejectsWith(dl(respond(502))(good, file), 'STORAGE_UNAVAILABLE');
  await rejectsWith(dl(respond(200, { length: String(26 * 1024 * 1024) }))(good, file), 'STORAGE_REJECTED');
});

test('observability: storage events carry Core + Bitrix identifiers and never a token, a tokenised URL or a Bitrix message', async () => {
  const row = await put();
  await store().read(ctx.tenant.id, row.id, { documentId: 'doc-1', versionNumber: 1 });
  disk.fail('disk.folder.uploadfile', new (await import('../apps/backend/src/bitrix')).BitrixRestError('insufficient_scope', 403));
  await put().catch(() => undefined);
  const events = logs.events();
  const ok = events.find(e => e.event === 'storage.put.ok')!;
  assert.deepEqual({ provider: ok.provider, operation: ok.operation, fileId: ok.fileId, externalFileId: ok.externalFileId, documentId: ok.documentId, versionNumber: ok.versionNumber }, { provider: 'BITRIX_DISK', operation: 'put', fileId: row.id, externalFileId: row.externalFileId, documentId: 'doc-1', versionNumber: 1 });
  const failed = events.find(e => e.event === 'storage.put.failed')!;
  assert.equal(failed.level, 'error');
  assert.equal(failed.code, 'STORAGE_REJECTED');
  assert.equal(failed.causeCode, 'insufficient_scope', 'the structured Bitrix code is kept');
  const all = logs.lines.join('\n');
  assert.doesNotMatch(all, new RegExp(`${URL_SECRET}|auth=|download\\.json|Bearer|access_token|refresh_token`));
  assert.doesNotMatch(all, /JVBER|%PDF/, 'file bytes are never logged');
});

test('historical records: LOCAL files created before BITRIX-DISK-1 stay readable whatever is configured, with no Bitrix call', async () => {
  const { insert } = ctx.db;
  // Exactly what the pre-BITRIX-DISK-1 code wrote: provider default, no size, no checksum.
  const legacy = await insert(ctx.db.pool, 'attachments', ctx.tenant.id, { fileProvider: 'LOCAL', fileName: 'старая схема.pdf', mimeType: 'application/pdf', content: PDF, uploadedBy: ctx.actor.id });
  assert.equal(legacy.sizeBytes, null);
  assert.equal(legacy.checksumSha256, null);
  for (const provider of ['BITRIX_DISK', 'LOCAL']) {
    process.env.FILE_STORAGE_PROVIDER = provider;
    const f = await store().read(ctx.tenant.id, legacy.id);
    assert.equal(f.content.equals(PDF), true);
    assert.equal(f.fileName, 'старая схема.pdf');
    assert.equal(f.provider, 'LOCAL');
  }
  assert.equal(disk.calls.length, 0);
  // And the other direction: a Disk-backed record stays readable after the deployment is switched back to LOCAL.
  process.env.FILE_STORAGE_PROVIDER = 'BITRIX_DISK';
  const remote = await put();
  process.env.FILE_STORAGE_PROVIDER = 'LOCAL';
  assert.equal((await store().read(ctx.tenant.id, remote.id)).content.equals(PDF), true);
  // A new LOCAL record is verified against its own checksum too.
  const checked = await put();
  await ctx.db.pool.query('UPDATE attachments SET content=$2 WHERE id=$1', [checked.id, Buffer.from('%PDF-corrupted-in-database')]);
  await rejectsWith(store().read(ctx.tenant.id, checked.id), 'STORAGE_INTEGRITY');
});

test('non-empty requirement: zero-byte input is refused, and the database cannot hold an external record without verified content', async () => {
  await assert.rejects(put({ bytes: Buffer.alloc(0) }), (e: any) => e.getStatus?.() === 400);
  assert.equal(disk.calls.length, 0, 'refused before any storage call');

  const pool = ctx.db.pool;
  const ins = (vals: { provider?: string; ext?: string | null; size?: number | null; sum?: string | null; content?: Buffer | null }) => pool.query(
    'INSERT INTO attachments(tenant_id,file_provider,external_file_id,file_name,mime_type,content,size_bytes,checksum_sha256,uploaded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
    [ctx.tenant.id, vals.provider ?? 'BITRIX_DISK', vals.ext === undefined ? '42' : vals.ext, 'f.pdf', 'application/pdf', vals.content ?? null, vals.size === undefined ? 10 : vals.size, vals.sum === undefined ? 'a'.repeat(64) : vals.sum, ctx.actor.id]);
  await assert.rejects(ins({ size: 0 }));
  await assert.rejects(ins({ size: null }));
  await assert.rejects(ins({ ext: null }));
  await assert.rejects(ins({ ext: '  ' }));
  await assert.rejects(ins({ sum: null }));
  await assert.rejects(ins({ sum: 'abc' }));
  await assert.rejects(ins({ content: PDF }), undefined, 'an external record holds no inline bytes');
  const good = (await ins({})).rows[0].id;

  // The evidence predicate (documentation-evidence.ts) agrees, for every provider.
  const predicate = (id: string) => ctx.db.one(pool, `SELECT ${ctx.sql.attachmentHasContentSql('a')} AS ok FROM attachments a WHERE a.id=$1`, [id]).then((r: any) => r.ok);
  assert.equal(await predicate(good), true);
  const mk = async (content: Buffer | null) => (await pool.query("INSERT INTO attachments(tenant_id,file_provider,file_name,mime_type,content,uploaded_by) VALUES($1,'LOCAL','x','application/pdf',$2,$3) RETURNING id", [ctx.tenant.id, content, ctx.actor.id])).rows[0].id;
  assert.equal(await predicate(await mk(PDF)), true);
  assert.equal(await predicate(await mk(Buffer.alloc(0))), false, 'an empty LOCAL blob is not evidence');
  assert.equal(await predicate(await mk(null)), false, 'metadata-only is not evidence');
});

test('migration SQL is idempotent and additive (safe if renumbered or applied twice)', async () => {
  const file = fs.readdirSync('infra').find(f => /bitrix_disk_1_file_storage/.test(f))!;
  const sql = fs.readFileSync('infra/' + file, 'utf8');
  assert.match(file, /PROVISIONAL/, 'must be renamed to a real number at integration');
  await ctx.db.pool.query(sql);
  await ctx.db.pool.query(sql);
  assert.doesNotMatch(sql, /DROP |DELETE |TRUNCATE |UPDATE attachments|INSERT INTO attachments/i, 'no destructive or backfilling statement');
  const cols = (await ctx.db.pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='attachments'")).rows.map((r: any) => r.column_name);
  for (const c of ['size_bytes', 'checksum_sha256', 'external_folder_id', 'file_provider', 'external_file_id']) assert.ok(cols.includes(c), c);
});
