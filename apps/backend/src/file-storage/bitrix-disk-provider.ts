import { BitrixDiskClient, classifyDiskError, DiskObject, DiskTransport } from './bitrix-disk-client';
import { BitrixDiskFolders, safeDiskName, shortId } from './bitrix-disk-folders';
import { StorageConfig } from './config';
import { describeError, storageLog } from './log';
import { FileLogContext, FileStat, PutInput, PutOutput, STORAGE_BITRIX_DISK, StorageError, StorageProvider, StoredFile, storageIntegrity, storageNotFound, storageRejected, storageUnavailable } from './types';

/** Fetches the bytes behind a tokenised DOWNLOAD_URL. Injectable so tests never touch the network. */
export type DiskDownloader = (url: string, file: StoredFile) => Promise<Buffer>;

const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const MAX_REDIRECTS = 3;

/**
 * Server-side fetch of a Disk DOWNLOAD_URL. The URL carries the app's token, so it is never logged, never returned to a
 * browser, and is only followed while it stays on https and on the configured portal host (SSRF / token-leak guard).
 */
export function guardedDiskDownload(portal: string, fetchImpl: typeof fetch = fetch): DiskDownloader {
    const allowed = (u: URL) => u.protocol === 'https:' && u.hostname.toLowerCase() === portal.toLowerCase() && !u.username && !u.password;
    return async (url) => {
        let current: URL;
        try { current = new URL(url); } catch { throw storageRejected(); }
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
            if (!allowed(current)) throw storageRejected();
            const r = await fetchImpl(current.toString(), { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(30000) });
            if (r.status >= 300 && r.status < 400) {
                const location = r.headers.get('location');
                if (!location) throw storageUnavailable();
                current = new URL(location, current);
                continue;
            }
            if (r.status === 404) throw storageNotFound();
            if (r.status === 401 || r.status === 403) throw storageRejected();
            if (!r.ok) throw storageUnavailable();
            const declared = Number(r.headers.get('content-length'));
            if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) throw storageRejected();
            const bytes = Buffer.from(await r.arrayBuffer());
            if (bytes.length > MAX_DOWNLOAD_BYTES) throw storageRejected();
            return bytes;
        }
        throw storageUnavailable();
    };
}

/**
 * The Disk file name: the human-readable Core file name plus `[<id8>]` of the Core file id, before the extension. The id
 * makes every Core version its own Disk file (a regenerated AOSR never overwrites or "versions over" the previous DOCX),
 * keeps the Core id visible for reconciliation, and makes the name deterministic so an ambiguous upload can be re-found.
 */
export function diskFileName(fileName: string, fileId: string): string {
    const cleaned = safeDiskName(fileName, 150);
    const dot = cleaned.lastIndexOf('.');
    const [base, ext] = dot > 0 && cleaned.length - dot <= 10 ? [cleaned.slice(0, dot), cleaned.slice(dot)] : [cleaned, ''];
    return `${base} [${shortId(fileId)}]${ext}`;
}

/**
 * Bitrix24 Disk as a file store. Core's database stays authoritative: this class only moves bytes. Authorization happens before
 * any call here (the callers resolve the file id from a Core-authorized record), and no public/external link is ever created.
 */
export class BitrixDiskProvider implements StorageProvider {
    readonly code = STORAGE_BITRIX_DISK;
    private readonly client: BitrixDiskClient;
    private readonly folders: BitrixDiskFolders;
    constructor(transport: DiskTransport, config: () => StorageConfig, private readonly downloader: () => DiskDownloader) {
        this.client = new BitrixDiskClient(transport);
        this.folders = new BitrixDiskFolders(this.client, config);
    }

    async put(input: PutInput): Promise<PutOutput> {
        const { tenantId, fileId, bytes } = input;
        const name = diskFileName(input.fileName, fileId);
        let folderId = await this.folders.resolve(input.db, tenantId, input.placement);
        let uploaded: DiskObject;
        try { uploaded = await this.uploadOnce(tenantId, folderId, name, bytes, input); }
        catch (first) {
            // The folder mapped in Core may have been deleted in Disk by a human: heal once, then retry the upload once.
            if (await this.folders.dropMissing(input.db, tenantId, input.placement).catch(() => false)) {
                folderId = await this.folders.resolve(input.db, tenantId, input.placement);
                uploaded = await this.uploadOnce(tenantId, folderId, name, bytes, input);
            } else throw first;
        }
        // Verify before Core records anything: id present and the stored size is exactly what we sent. (If the upload answer carries no
        // SIZE, ask Disk for the object's metadata — the same call that proves the file exists.)
        if (uploaded.sizeBytes === null) uploaded = await this.client.getFile(tenantId, uploaded.id).catch(() => uploaded);
        if (uploaded.sizeBytes === null || uploaded.sizeBytes !== bytes.length || bytes.length === 0) {
            await this.client.deleteFile(tenantId, uploaded.id).catch(e => storageLog('error', 'storage.orphan_possible', { provider: this.code, operation: 'verify-delete', tenantId, fileId, externalFileId: uploaded.id, externalFolderId: folderId, ...input.log, ...describeError(e) }));
            storageLog('error', 'storage.put.integrity', { provider: this.code, operation: 'put', tenantId, fileId, externalFileId: uploaded.id, sizeBytes: bytes.length, ...input.log });
            throw storageIntegrity();
        }
        return { externalFileId: uploaded.id, externalFolderId: folderId, inlineContent: null };
    }

    /** One upload. An ambiguous failure (timeout / 5xx / unknown code) is reconciled by the deterministic name before giving up. */
    private async uploadOnce(tenantId: string, folderId: string, name: string, bytes: Buffer, input: PutInput): Promise<DiskObject> {
        try { return await this.client.uploadFile(tenantId, folderId, name, bytes); }
        catch (e) {
            const { error, ambiguous } = classifyDiskError(e);
            if (ambiguous) {
                const stored = await this.client.children(tenantId, folderId, { NAME: name }).then(list => list.find(o => o.type === 'file' && !o.deleted && o.name === name && o.sizeBytes === bytes.length), () => undefined);
                if (stored) {
                    storageLog('warn', 'storage.put.adopted', { provider: this.code, operation: 'put', tenantId, fileId: input.fileId, externalFileId: stored.id, externalFolderId: folderId, ...input.log, ...describeError(e) });
                    return stored;
                }
            }
            storageLog('error', 'storage.put.failed', { provider: this.code, operation: 'put', tenantId, fileId: input.fileId, externalFolderId: folderId, ...input.log, ...describeError(error), causeCode: describeError(e).code });
            throw error;
        }
    }

    async get(file: StoredFile, log: FileLogContext): Promise<Buffer> {
        const meta = await this.meta(file, log, 'get');
        if (!meta.downloadUrl) throw this.fail(file, log, 'get', storageUnavailable());
        // Cheap pre-check against Core's own record before pulling bytes.
        if (file.sizeBytes !== null && meta.sizeBytes !== null && meta.sizeBytes !== file.sizeBytes) throw this.fail(file, log, 'get', storageIntegrity());
        try { return await this.downloader()(meta.downloadUrl, file); }
        catch (e) { throw this.fail(file, log, 'get', classifyDiskError(e).error, e); }
    }

    async stat(file: StoredFile, log: FileLogContext): Promise<FileStat> {
        try { const meta = await this.meta(file, log, 'stat'); return { exists: true, sizeBytes: meta.sizeBytes }; }
        catch (e) { if (e instanceof StorageError && e.code === 'STORAGE_NOT_FOUND') return { exists: false, sizeBytes: null }; throw e; }
    }

    /** Permanent removal; used only to compensate an upload whose Core record never committed. A file that is already gone is success. */
    async delete(file: StoredFile, log: FileLogContext): Promise<void> {
        if (!file.externalFileId) return;
        try { await this.client.deleteFile(file.tenantId, file.externalFileId); }
        catch (e) {
            const { error } = classifyDiskError(e);
            if (error.code === 'STORAGE_NOT_FOUND') return;
            throw this.fail(file, log, 'delete', error);
        }
    }

    private async meta(file: StoredFile, log: FileLogContext, operation: string): Promise<DiskObject> {
        if (!file.externalFileId) throw this.fail(file, log, operation, storageNotFound());
        let meta: DiskObject;
        try { meta = await this.client.getFile(file.tenantId, file.externalFileId); }
        catch (e) { throw this.fail(file, log, operation, classifyDiskError(e).error, e); }
        if (meta.deleted) throw this.fail(file, log, operation, storageNotFound());
        return meta;
    }

    private fail(file: StoredFile, log: FileLogContext, operation: string, error: StorageError, cause?: unknown): StorageError {
        storageLog('error', `storage.${operation}.failed`, { provider: this.code, operation, tenantId: file.tenantId, fileId: file.id, externalFileId: file.externalFileId, ...log, ...describeError(error), causeCode: cause === undefined ? undefined : describeError(cause).code });
        return error;
    }
}
