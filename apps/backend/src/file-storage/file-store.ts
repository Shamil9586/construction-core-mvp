import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { pool, one, transaction } from '../db';
import { RealBitrixAdapter } from '../bitrix';
import { BitrixDiskProvider, DiskDownloader, guardedDiskDownload } from './bitrix-disk-provider';
import { DiskTransport } from './bitrix-disk-client';
import { LocalProvider } from './local-provider';
import { readStorageConfig, StorageConfig } from './config';
import { describeError, storageLog } from './log';
import { FileLogContext, FilePlacement, isStorageProviderCode, StorageProvider, StorageProviderCode, STORAGE_BITRIX_DISK, STORAGE_LOCAL, StoredFile, storageIntegrity, storageNotConfigured, storageUnsupported } from './types';

export const sha256Hex = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Row of `attachments` → the provider-neutral descriptor. */
export function toStoredFile(row: any): StoredFile {
    return {
        id: row.id, tenantId: row.tenantId, provider: row.fileProvider ?? STORAGE_LOCAL, externalFileId: row.externalFileId ?? null, externalFolderId: row.externalFolderId ?? null,
        fileName: row.fileName, mimeType: row.mimeType, sizeBytes: row.sizeBytes === null || row.sizeBytes === undefined ? null : Number(row.sizeBytes),
        checksumSha256: row.checksumSha256 ?? null, content: row.content ?? null,
    };
}

/**
 * Physical uploads made inside one database transaction. If the transaction fails for ANY reason after an upload (a later
 * statement, a constraint, the COMMIT itself) the uploaded files are removed again, so a failed Core operation does not leave
 * uncontrolled storage behind. A removal that itself fails is logged as `storage.orphan_possible` with every identifier needed
 * to find the file (its Disk name carries the Core file id) — it is never silent.
 */
export class FileUnitOfWork {
    private uploaded: { file: StoredFile; log: FileLogContext }[] = [];
    constructor(private readonly store: FileStore) {}
    track(file: StoredFile, log: FileLogContext) { this.uploaded.push({ file, log }); }
    get count() { return this.uploaded.length; }
    async compensate(): Promise<void> {
        const pending = this.uploaded.splice(0);
        for (const { file, log } of pending.reverse()) {
            try {
                await this.store.providerFor(file.provider).delete(file, log);
                storageLog('warn', 'storage.compensated', { provider: file.provider, operation: 'compensate', tenantId: file.tenantId, fileId: file.id, externalFileId: file.externalFileId, ...log });
            } catch (e) {
                storageLog('error', 'storage.orphan_possible', { provider: file.provider, operation: 'compensate', tenantId: file.tenantId, fileId: file.id, externalFileId: file.externalFileId, externalFolderId: file.externalFolderId, ...log, ...describeError(e) });
            }
        }
    }
}

/**
 * Bounded concurrency for transactions that call an external store. Such a transaction holds one database connection while
 * RealBitrixAdapter.installedCall needs a SECOND one (installation lookup / token refresh); unbounded, enough simultaneous uploads
 * could hold every pooled connection while each waits for another. Waiting happens BEFORE a connection is taken.
 */
export class Gate {
    private active = 0;
    private waiting: (() => void)[] = [];
    constructor(readonly limit: number) {}
    async run<T>(fn: () => Promise<T>): Promise<T> {
        if (this.active < this.limit) this.active++;
        else await new Promise<void>(resolve => this.waiting.push(resolve)); // the finishing task hands its slot over
        try { return await fn(); }
        finally { const next = this.waiting.shift(); if (next) next(); else this.active--; }
    }
}
export const EXTERNAL_WRITE_CONCURRENCY = 4;

export interface PutFileInput { fileName: string; mimeType: string; bytes: Buffer; placement: FilePlacement; log?: FileLogContext }
export interface ReadFile { fileName: string; mimeType: string; content: Buffer; sizeBytes: number; provider: string }

/**
 * The domain-facing storage service. The domain asks it to put or read a Core file and never sees a Bitrix call.
 *
 *  put   — writes the bytes through the CONFIGURED provider, VERIFIES them, and only then inserts the Core `attachments` row
 *          (so a database record never points at a missing/failed upload). New immutable versions are simply new put()s.
 *  read  — loads the Core record (tenant-scoped), follows the record's OWN provider (so records created before BITRIX-DISK-1
 *          stay readable whatever is configured today), and refuses bytes that do not match Core's size / checksum.
 *
 * AUTHORIZATION IS NOT HERE. Callers authorize the actor against the Core document first and pass an attachment id taken from
 * that authorized Core record; a Bitrix file id is not accepted anywhere and possession of one grants nothing.
 */
export class FileStore {
    constructor(private readonly registry: Record<StorageProviderCode, () => StorageProvider>, private readonly config: () => StorageConfig = readStorageConfig) {}
    private instances = new Map<string, StorageProvider>();

    providerFor(code: string): StorageProvider {
        if (!isStorageProviderCode(code)) throw storageUnsupported();
        let p = this.instances.get(code);
        if (!p) this.instances.set(code, p = this.registry[code]());
        return p;
    }
    /** Provider that NEW files go to (deployment configuration). */
    get writeProvider(): StorageProviderCode { return this.config().provider; }

    private readonly gate = new Gate(EXTERNAL_WRITE_CONCURRENCY);
    async transaction<T>(fn: (c: any, files: FileUnitOfWork) => Promise<T>): Promise<T> {
        const files = new FileUnitOfWork(this);
        const run = () => transaction((c) => fn(c, files));
        try { return await (this.writeProvider === STORAGE_LOCAL ? run() : this.gate.run(run)); }
        catch (e) { await files.compensate(); throw e; }
    }

    async put(c: any, actor: { id: string; tenantId: string }, input: PutFileInput, files: FileUnitOfWork): Promise<any> {
        if (!Buffer.isBuffer(input.bytes) || input.bytes.length === 0) throw new BadRequestException('Файл пустой');
        const code = this.writeProvider;
        const provider = this.providerFor(code);
        const fileId = randomUUID();
        const log = input.log ?? {};
        const sizeBytes = input.bytes.length, checksumSha256 = sha256Hex(input.bytes);
        const started = Date.now();
        const out = await provider.put({ db: c, tenantId: actor.tenantId, fileId, fileName: input.fileName, mimeType: input.mimeType, bytes: input.bytes, placement: input.placement, log });
        if (out.externalFileId) files.track({ id: fileId, tenantId: actor.tenantId, provider: code, externalFileId: out.externalFileId, externalFolderId: out.externalFolderId, fileName: input.fileName, mimeType: input.mimeType, sizeBytes, checksumSha256, content: null }, log);
        // The Core record. Its identity is `fileId`; the Disk file id is only a pointer stored next to it.
        // Plain INSERT: the shared insert() helper whitelists column names without digits (checksum_sha256).
        const row = await one(c, 'INSERT INTO attachments(id,tenant_id,file_provider,external_file_id,external_folder_id,file_name,mime_type,content,size_bytes,checksum_sha256,uploaded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
            [fileId, actor.tenantId, code, out.externalFileId, out.externalFolderId, input.fileName, input.mimeType, out.inlineContent, sizeBytes, checksumSha256, actor.id]);
        storageLog('info', 'storage.put.ok', { provider: code, operation: 'put', tenantId: actor.tenantId, fileId, externalFileId: out.externalFileId, externalFolderId: out.externalFolderId, sizeBytes, ...log, outcome: `${Date.now() - started}ms` });
        return row;
    }

    async load(tenantId: string, attachmentId: string, db: any = pool): Promise<StoredFile> {
        const row = await one(db, 'SELECT * FROM attachments WHERE tenant_id=$1 AND id=$2', [tenantId, attachmentId]);
        if (!row) throw new NotFoundException('Запись не найдена');
        return toStoredFile(row);
    }

    async read(tenantId: string, attachmentId: string, log: FileLogContext = {}, db: any = pool): Promise<ReadFile> {
        const file = await this.load(tenantId, attachmentId, db);
        const bytes = await this.providerFor(file.provider).get(file, log);
        if ((file.sizeBytes !== null && bytes.length !== file.sizeBytes) || (file.checksumSha256 !== null && sha256Hex(bytes) !== file.checksumSha256)) {
            storageLog('error', 'storage.get.integrity', { provider: file.provider, operation: 'get', tenantId, fileId: file.id, externalFileId: file.externalFileId, sizeBytes: bytes.length, ...log });
            throw storageIntegrity();
        }
        return { fileName: file.fileName, mimeType: file.mimeType, content: bytes, sizeBytes: bytes.length, provider: file.provider };
    }

    /** Existence + size check against the physical store (no bytes transferred for Disk). */
    async verify(tenantId: string, attachmentId: string, log: FileLogContext = {}, db: any = pool): Promise<{ exists: boolean; sizeMatches: boolean }> {
        const file = await this.load(tenantId, attachmentId, db);
        const stat = await this.providerFor(file.provider).stat(file, log);
        return { exists: stat.exists, sizeMatches: stat.exists && (file.sizeBytes === null || stat.sizeBytes === file.sizeBytes) };
    }
}

// ---------------------------------------------------------------------------------------------------------
// Process-wide instance (same module-singleton style as db.ts / the notification outbox transport).
// ---------------------------------------------------------------------------------------------------------
interface Hooks { transport?: DiskTransport; downloader?: DiskDownloader }
let hooks: Hooks = {};
let store: FileStore | undefined;

/** Real OAuth path (RealBitrixAdapter.installedCall) unless a test supplies a sandboxed transport. */
function diskTransport(): DiskTransport {
    if (hooks.transport) return hooks.transport;
    try { return new RealBitrixAdapter(); }
    catch { throw storageNotConfigured('BITRIX_PORTAL не настроен для Bitrix24 Диска'); }
}
function diskDownloader(): DiskDownloader {
    if (hooks.downloader) return hooks.downloader;
    try { return guardedDiskDownload(new RealBitrixAdapter().portal); }
    catch { throw storageNotConfigured('BITRIX_PORTAL не настроен для Bitrix24 Диска'); }
}
export function getFileStore(): FileStore {
    return store ??= new FileStore({
        [STORAGE_LOCAL]: () => new LocalProvider(),
        [STORAGE_BITRIX_DISK]: () => new BitrixDiskProvider(diskTransport(), readStorageConfig, diskDownloader),
    });
}
export const hasDiskTransportOverride = () => !!hooks.transport;
/** Test seam: sandbox the Bitrix REST transport / download. Providers are rebuilt on the next use. */
export function setBitrixDiskTestHooks(next: Hooks) { hooks = next; store = undefined; }
export function resetBitrixDiskTestHooks() { hooks = {}; store = undefined; }
