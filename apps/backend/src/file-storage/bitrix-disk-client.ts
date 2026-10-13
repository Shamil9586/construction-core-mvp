import { UnauthorizedException } from '@nestjs/common';
import { BitrixRestError } from '../bitrix';
import { StorageError, storageAuth, storageNotFound, storageRejected, storageUnavailable } from './types';

/**
 * Thin typed wrapper over the Bitrix24 Disk REST methods Core uses. It goes through the SAME OAuth path as every other
 * Bitrix call (RealBitrixAdapter.installedCall: installation lookup, token decryption, expired_token refresh) — there is no
 * second authentication system. Only these documented methods are used:
 *
 *   disk.storage.getforapp      application storage (root folder = ROOT_OBJECT_ID)
 *   disk.storage.get            a configured storage by id
 *   disk.folder.getchildren     list a folder (50 per page, `start` offset; optional filter)
 *   disk.folder.addsubfolder    create a folder
 *   disk.folder.rename          rename a folder
 *   disk.folder.get             folder metadata (health probe of a mapped folder)
 *   disk.folder.uploadfile      upload (fileContent = [name, base64]; generateUniqueName defaults to false)
 *   disk.file.get               file metadata + tokenised DOWNLOAD_URL
 *   disk.file.delete            permanent delete (compensation of an uncommitted upload only)
 *
 * Status: REQUIRES BITRIX24 TEST PORTAL VERIFICATION (see docs/bitrix-disk-1-storage.md). Public/external links
 * (disk.file.getExternalLink) are deliberately never used.
 */
export interface DiskTransport { installedCall(tenantId: string, method: string, params?: any): Promise<any> }

export const DISK_PAGE_SIZE = 50;
export const DISK_MAX_PAGES = 20;

export interface DiskObject { id: string; name: string; type: string; sizeBytes: number | null; parentId: string | null; deleted: boolean; downloadUrl: string | null }

const str = (v: any): string | null => (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.trim() !== '') ? String(v).trim() : null;
export function toDiskObject(raw: any): DiskObject {
    const id = str(raw?.ID);
    if (!raw || typeof raw !== 'object' || id === null) throw storageUnavailable(); // malformed answer: treat like ERROR_UNEXPECTED_ANSWER
    const size = raw.SIZE === undefined || raw.SIZE === null || raw.SIZE === '' ? null : Number(raw.SIZE);
    const deletedType = raw.DELETED_TYPE === undefined || raw.DELETED_TYPE === null ? 0 : Number(raw.DELETED_TYPE);
    return { id, name: typeof raw.NAME === 'string' ? raw.NAME : '', type: typeof raw.TYPE === 'string' ? raw.TYPE : '', sizeBytes: size !== null && Number.isFinite(size) ? size : null, parentId: str(raw.PARENT_ID), deleted: Number.isFinite(deletedType) && deletedType > 0, downloadUrl: typeof raw.DOWNLOAD_URL === 'string' && raw.DOWNLOAD_URL ? raw.DOWNLOAD_URL : null };
}

const AUTH_CODES = new Set(['expired_token', 'INVALID_CREDENTIALS', 'WRONG_AUTH_TYPE', 'NO_AUTH_FOUND', 'invalid_token']);
const REJECT_CODES = new Set(['insufficient_scope', 'ACCESS_DENIED', 'user_access_error', 'ERROR_ACCESS_DENIED', 'INVALID_REQUEST', 'ERROR_ARGUMENT']);
const TRANSIENT_CODES = new Set(['INTERNAL_SERVER_ERROR', 'ERROR_UNEXPECTED_ANSWER', 'QUERY_LIMIT_EXCEEDED', 'OPERATION_TIME_LIMIT', 'TIMEOUT', 'NETWORK_ERROR']);
const NOT_FOUND_CODES = new Set(['ERROR_NOT_FOUND', 'NOT_FOUND', 'DISK_OBJ_NOT_FOUND']);
/** What a REST failure means for the caller. `ambiguous` = the request may nevertheless have been applied (writes only). */
export function classifyDiskError(e: any): { error: StorageError; ambiguous: boolean } {
    if (e instanceof StorageError) return { error: e, ambiguous: false };
    if (e instanceof UnauthorizedException) return { error: storageAuth(), ambiguous: false };
    if (e instanceof BitrixRestError) {
        if (AUTH_CODES.has(e.code)) return { error: storageAuth(), ambiguous: false };
        if (NOT_FOUND_CODES.has(e.code) || e.httpStatus === 404) return { error: storageNotFound(), ambiguous: false };
        if (REJECT_CODES.has(e.code)) return { error: storageRejected(), ambiguous: false };
        if (TRANSIENT_CODES.has(e.code) || (e.httpStatus !== null && (e.httpStatus >= 500 || e.httpStatus === 429))) return { error: storageUnavailable(), ambiguous: true };
        // Unknown structured code (e.g. a name conflict whose exact code is not documented): not retryable as-is, but the write may have landed.
        return { error: storageRejected(), ambiguous: true };
    }
    // Network error / abort / timeout / anything that is not a Bitrix answer: the write may or may not have been applied.
    return { error: storageUnavailable(), ambiguous: true };
}

export class BitrixDiskClient {
    constructor(private readonly transport: DiskTransport) {}
    private call(tenantId: string, method: string, params: any): Promise<any> { return this.transport.installedCall(tenantId, method, params); }
    /** Root folder id of the storage that holds the Core tree. */
    async storageRoot(tenantId: string, storageId: string | null): Promise<string> {
        const r = await this.call(tenantId, storageId ? 'disk.storage.get' : 'disk.storage.getforapp', storageId ? { id: storageId } : {});
        const root = str(r?.ROOT_OBJECT_ID);
        if (root === null) throw storageUnavailable();
        return root;
    }
    async getFolder(tenantId: string, id: string): Promise<DiskObject> { return toDiskObject(await this.call(tenantId, 'disk.folder.get', { id })); }
    /** Children of a folder, paginated by `start` (50 per page, a short page ends the listing). `filter` is a hint; callers still match exactly. */
    async children(tenantId: string, folderId: string, filter?: Record<string, string>): Promise<DiskObject[]> {
        const out: DiskObject[] = [];
        for (let page = 0; page < DISK_MAX_PAGES; page++) {
            const r = await this.call(tenantId, 'disk.folder.getchildren', { id: folderId, ...(filter ? { filter } : {}), start: page * DISK_PAGE_SIZE });
            if (!Array.isArray(r)) throw storageUnavailable();
            out.push(...r.map(toDiskObject));
            if (r.length < DISK_PAGE_SIZE) break;
        }
        return out;
    }
    async addSubfolder(tenantId: string, parentId: string, name: string): Promise<DiskObject> { return toDiskObject(await this.call(tenantId, 'disk.folder.addsubfolder', { id: parentId, data: { NAME: name } })); }
    async renameFolder(tenantId: string, id: string, newName: string): Promise<void> { await this.call(tenantId, 'disk.folder.rename', { id, newName }); }
    /** Upload with generateUniqueName=false: Core names are unique by construction, and a clash must never silently become "name (1).ext". */
    async uploadFile(tenantId: string, folderId: string, name: string, bytes: Buffer): Promise<DiskObject> {
        return toDiskObject(await this.call(tenantId, 'disk.folder.uploadfile', { id: folderId, data: { NAME: name }, fileContent: [name, bytes.toString('base64')], generateUniqueName: false }));
    }
    async getFile(tenantId: string, id: string): Promise<DiskObject> { return toDiskObject(await this.call(tenantId, 'disk.file.get', { id })); }
    async deleteFile(tenantId: string, id: string): Promise<void> { await this.call(tenantId, 'disk.file.delete', { id }); }
}
