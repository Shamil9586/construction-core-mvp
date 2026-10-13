import { StorageProviderCode, STORAGE_LOCAL, STORAGE_BITRIX_DISK, storageNotConfigured } from './types';

/**
 * Deployment configuration of the file storage. It selects the provider for NEW files only; reading an existing file always
 * follows that file's own `attachments.file_provider`, so flipping this back to LOCAL never strands Disk-backed records.
 *
 *   FILE_STORAGE_PROVIDER         LOCAL (default) | BITRIX_DISK
 *   BITRIX_DISK_STORAGE_ID        optional numeric Disk storage id to hold the tree; unset => the application's own storage
 *                                 (disk.storage.getforapp)
 *   BITRIX_DISK_ROOT_FOLDER_NAME  optional, default "Construction Core"
 */
export interface StorageConfig { provider: StorageProviderCode; bitrixStorageId: string | null; bitrixRootFolderName: string }

export function readStorageConfig(env: NodeJS.ProcessEnv = process.env): StorageConfig {
    const raw = env.FILE_STORAGE_PROVIDER?.trim();
    const provider = raw === undefined || raw === '' ? STORAGE_LOCAL : raw;
    if (provider !== STORAGE_LOCAL && provider !== STORAGE_BITRIX_DISK)
        throw storageNotConfigured(`FILE_STORAGE_PROVIDER должен быть LOCAL или BITRIX_DISK`);
    const storageId = env.BITRIX_DISK_STORAGE_ID?.trim() || null;
    if (storageId !== null && !/^[1-9][0-9]{0,11}$/.test(storageId)) throw storageNotConfigured('BITRIX_DISK_STORAGE_ID должен быть положительным целым числом');
    const rootName = env.BITRIX_DISK_ROOT_FOLDER_NAME?.trim() || 'Construction Core';
    if (rootName.length > 100 || /[\\/:*?"<>|\u0000-\u001f]/.test(rootName)) throw storageNotConfigured('BITRIX_DISK_ROOT_FOLDER_NAME содержит недопустимые символы');
    return { provider, bitrixStorageId: storageId, bitrixRootFolderName: rootName };
}

/** Startup check (createApp): a misspelled provider must stop the process, never silently fall back to another store. */
export function assertFileStorageConfig(env: NodeJS.ProcessEnv = process.env, hasTransportOverride = false) {
    const cfg = readStorageConfig(env);
    if (cfg.provider === STORAGE_BITRIX_DISK && !hasTransportOverride) {
        if (env.AUTH_MODE !== 'bitrix') throw storageNotConfigured('BITRIX_DISK требует AUTH_MODE=bitrix (установленное приложение Bitrix24)');
        if (!env.BITRIX_PORTAL) throw storageNotConfigured('BITRIX_DISK требует BITRIX_PORTAL');
        // PGlite serves one connection at a time; a Disk call inside a transaction needs a second one (installation lookup) and would hang.
        if (env.DB_MODE === 'pglite' && !env.DATABASE_URL) throw storageNotConfigured('BITRIX_DISK не поддерживается с локальной PGlite (нужен PostgreSQL)');
    }
    return cfg;
}
