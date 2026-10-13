import { HttpException } from '@nestjs/common';

/**
 * BITRIX-DISK-1 — file storage foundation.
 *
 * Construction Core stays authoritative for WHAT a file is (object / package / document / version / type / creator /
 * permissions). A storage provider only decides WHERE the bytes physically live. The Core file record is the
 * `attachments` row; `attachments.file_provider` is the infrastructure discriminator:
 *   LOCAL        — bytes in `attachments.content` (every record created before BITRIX-DISK-1)
 *   BITRIX_DISK  — bytes in Bitrix24 Disk, addressed by `attachments.external_file_id`
 * Documentation versions keep `storage_provider='CORE_FILE'` either way: "a file Core manages". The physical provider is
 * never a business choice and never part of a document version's identity.
 */
export const STORAGE_LOCAL = 'LOCAL' as const;
export const STORAGE_BITRIX_DISK = 'BITRIX_DISK' as const;
export type StorageProviderCode = typeof STORAGE_LOCAL | typeof STORAGE_BITRIX_DISK;
export const isStorageProviderCode = (v: unknown): v is StorageProviderCode => v === STORAGE_LOCAL || v === STORAGE_BITRIX_DISK;

/** Where a file belongs in the Core domain; the Disk folder tree is derived from this, never from client input. */
export type FileCategory = 'AOSR' | 'EXECUTIVE_SCHEME';
export interface FilePlacement { objectId: string; category: FileCategory }

/** Identifiers that make a storage failure diagnosable (logged, never secrets). */
export interface FileLogContext { documentId?: string; packageId?: string; aosrId?: string; documentVersionId?: string; versionNumber?: number }

/** A Core file record as loaded from `attachments`. */
export interface StoredFile {
    id: string;
    tenantId: string;
    provider: string;
    externalFileId: string | null;
    externalFolderId: string | null;
    fileName: string;
    mimeType: string;
    sizeBytes: number | null;
    checksumSha256: string | null;
    content: Buffer | null;
}

export interface PutInput {
    /** Transaction client of the caller. Folder mappings are written through it (PGlite cannot run a second connection inside a transaction). */
    db: any;
    tenantId: string;
    /** Pre-allocated Core file id (the future `attachments.id`); stable across retries of the same put. */
    fileId: string;
    fileName: string;
    mimeType: string;
    bytes: Buffer;
    placement: FilePlacement;
    log: FileLogContext;
}
export interface PutOutput {
    externalFileId: string | null;
    externalFolderId: string | null;
    /** LOCAL only: the bytes to persist in `attachments.content`. */
    inlineContent: Buffer | null;
}
export interface FileStat { exists: boolean; sizeBytes: number | null }

/** The smallest useful provider contract: put / get / stat / delete. */
export interface StorageProvider {
    readonly code: StorageProviderCode;
    put(input: PutInput): Promise<PutOutput>;
    get(file: StoredFile, log: FileLogContext): Promise<Buffer>;
    stat(file: StoredFile, log: FileLogContext): Promise<FileStat>;
    /** Physical removal. Core only calls it to compensate an upload whose database record never committed. */
    delete(file: StoredFile, log: FileLogContext): Promise<void>;
}

export type StorageErrorCode =
    | 'STORAGE_NOT_CONFIGURED'     // operator error: provider selected but not usable
    | 'STORAGE_PROVIDER_UNSUPPORTED' // a record names a provider this build cannot read
    | 'STORAGE_AUTH'               // Bitrix OAuth state unusable (expired / refresh failed / portal mismatch)
    | 'STORAGE_REJECTED'           // Bitrix refused (scope / rights / bad request) — retrying will not help
    | 'STORAGE_UNAVAILABLE'        // transient (network, timeout, 5xx, rate limit) — retry later
    | 'STORAGE_NOT_FOUND'          // the physical file is gone
    | 'STORAGE_INTEGRITY';         // size / checksum does not match the Core record

/**
 * A storage failure surfaced through the normal HTTP error filter: the message is a safe Russian business sentence,
 * the code and `retryable` are for logs/tests. No Bitrix response body, URL or token is ever carried in it.
 */
export class StorageError extends HttpException {
    constructor(readonly code: StorageErrorCode, message: string, status: number, readonly retryable: boolean) { super(message, status); }
}
export const storageNotConfigured = (detail: string) => new StorageError('STORAGE_NOT_CONFIGURED', 'Хранилище файлов не настроено: ' + detail, 503, false);
export const storageUnavailable = () => new StorageError('STORAGE_UNAVAILABLE', 'Хранилище файлов временно недоступно. Повторите попытку позже', 503, true);
export const storageAuth = () => new StorageError('STORAGE_AUTH', 'Нет доступа к Bitrix24 Диску: требуется обновить авторизацию приложения', 503, false);
export const storageRejected = () => new StorageError('STORAGE_REJECTED', 'Bitrix24 Диск отклонил операцию (проверьте права и scope приложения)', 502, false);
export const storageNotFound = () => new StorageError('STORAGE_NOT_FOUND', 'Файл не найден в хранилище', 502, false);
export const storageIntegrity = () => new StorageError('STORAGE_INTEGRITY', 'Файл в хранилище не совпадает с учётной записью Core и не будет выдан', 502, false);
export const storageUnsupported = () => new StorageError('STORAGE_PROVIDER_UNSUPPORTED', 'Хранилище этого файла не поддерживается в текущей конфигурации', 503, false);
