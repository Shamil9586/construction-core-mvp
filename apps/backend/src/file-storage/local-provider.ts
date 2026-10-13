import { StorageProvider, STORAGE_LOCAL, StoredFile, PutInput, PutOutput, FileStat, storageNotFound } from './types';

/**
 * LOCAL — the pre-existing store: bytes live in `attachments.content` and are written by the same INSERT that creates the
 * Core file record, so there is nothing to upload, nothing to compensate and nothing external to delete.
 */
export class LocalProvider implements StorageProvider {
    readonly code = STORAGE_LOCAL;
    async put(input: PutInput): Promise<PutOutput> { return { externalFileId: null, externalFolderId: null, inlineContent: input.bytes }; }
    async get(file: StoredFile): Promise<Buffer> {
        if (file.content === null || file.content === undefined) throw storageNotFound();
        return Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content);
    }
    async stat(file: StoredFile): Promise<FileStat> {
        const size = file.content ? (Buffer.isBuffer(file.content) ? file.content.length : Buffer.from(file.content).length) : null;
        return { exists: size !== null && size > 0, sizeBytes: size };
    }
    async delete(): Promise<void> { /* rows are immutable history; an uncommitted LOCAL insert disappears with its rolled-back transaction */ }
}
