import { NotFoundException } from '@nestjs/common';
import { one, rows } from '../db';
import { BitrixDiskClient, classifyDiskError, DiskObject } from './bitrix-disk-client';
import { StorageConfig } from './config';
import { FilePlacement, STORAGE_BITRIX_DISK } from './types';
import { storageLog, describeError } from './log';

/**
 * Deterministic Disk folder strategy.
 *
 *   <storage root>
 *     Construction Core                       ← scope ROOT          (BITRIX_DISK_ROOT_FOLDER_NAME)
 *       <Object name> [<id8>]                 ← scope OBJECT:<objectId>
 *         ПТО                                 ← scope OBJECT:<objectId>/PTO
 *           Исполнительная документация       ← scope OBJECT:<objectId>/PTO/ID
 *             АОСР                            ← scope OBJECT:<objectId>/PTO/ID/AOSR
 *             Исполнительные схемы            ← scope OBJECT:<objectId>/PTO/ID/EXECUTIVE_SCHEME
 *
 * Why this shape:
 *  - The folder is addressed by a Core scope key stored in `storage_folder_mappings` (tenant, provider, scope_key → Disk
 *    folder id). The Disk NAME is only a label: renaming an Object (or a human renaming the folder in Disk) never orphans files —
 *    the id in the mapping is what uploads use, and the label of the Object folder is refreshed on the next upload.
 *  - `[id8]` (first 8 hex of the Object UUID) keeps the stable Core id visible in Disk, makes two Objects with the same name
 *    distinct folders, and lets a lost mapping be re-discovered from the tree instead of creating a second tree.
 *  - Creation is serialized per (tenant, scope) with an advisory lock and is find-before-create, so repeated or concurrent first
 *    uploads converge on one folder, never on parallel trees.
 */
const SEGMENT_NAMES: Record<string, string> = { PTO: 'ПТО', ID: 'Исполнительная документация', AOSR: 'АОСР', EXECUTIVE_SCHEME: 'Исполнительные схемы' };

/** A Disk-safe label: no path/reserved characters, collapsed whitespace, bounded length. */
export function safeDiskName(raw: string, max = 100): string {
    const cleaned = raw.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').trim();
    return (cleaned.length > max ? cleaned.slice(0, max).trim() : cleaned) || '_';
}
export const shortId = (uuid: string) => uuid.replace(/-/g, '').slice(0, 8).toLowerCase();
export const objectFolderName = (objectName: string, objectId: string) => `${safeDiskName(objectName, 80)} [${shortId(objectId)}]`;

interface Level { key: string; name: string; token?: string; isRoot?: boolean; isObject?: boolean }
interface Mapping { externalFolderId: string; folderName: string }

export function folderChain(placement: FilePlacement, objectName: string, rootName: string): Level[] {
    const o = `OBJECT:${placement.objectId}`;
    return [
        { key: 'ROOT', name: safeDiskName(rootName), isRoot: true },
        { key: o, name: objectFolderName(objectName, placement.objectId), token: shortId(placement.objectId), isObject: true },
        { key: `${o}/PTO`, name: SEGMENT_NAMES.PTO },
        { key: `${o}/PTO/ID`, name: SEGMENT_NAMES.ID },
        { key: `${o}/PTO/ID/${placement.category}`, name: SEGMENT_NAMES[placement.category] },
    ];
}

export class BitrixDiskFolders {
    constructor(private readonly client: BitrixDiskClient, private readonly config: () => StorageConfig) {}

    private async mappings(db: any, tenantId: string, keys: string[]): Promise<Map<string, Mapping>> {
        const list = await rows(db, 'SELECT scope_key,external_folder_id,folder_name FROM storage_folder_mappings WHERE tenant_id=$1 AND provider=$2 AND scope_key=ANY($3::text[])', [tenantId, STORAGE_BITRIX_DISK, keys]);
        return new Map(list.map((r: any) => [r.scopeKey, { externalFolderId: r.externalFolderId, folderName: r.folderName }]));
    }

    /** Find a folder by exact label, else (object folders) by its `[id8]` token so a renamed folder is re-adopted rather than duplicated. */
    private async findFolder(tenantId: string, parentId: string, name: string, token?: string): Promise<DiskObject | undefined> {
        const byId = (a: DiskObject, b: DiskObject) => a.id.localeCompare(b.id, undefined, { numeric: true }); // deterministic pick if the portal ever holds twins
        const isFolder = (o: DiskObject) => o.type === 'folder' && !o.deleted;
        const exact = (await this.client.children(tenantId, parentId, { NAME: name })).filter(o => isFolder(o) && o.name === name).sort(byId)[0];
        if (exact || !token) return exact;
        return (await this.client.children(tenantId, parentId)).filter(o => isFolder(o) && o.name.endsWith(` [${token}]`)).sort(byId)[0];
    }

    private async ensureFolder(tenantId: string, parentId: string, name: string, token?: string): Promise<DiskObject> {
        const found = await this.findFolder(tenantId, parentId, name, token);
        if (found) return found;
        try { return await this.client.addSubfolder(tenantId, parentId, name); }
        catch (e) {
            // A concurrent creator (another process) may have won; adopt its folder instead of failing.
            const again = await this.findFolder(tenantId, parentId, name, token).catch(() => undefined);
            if (again) return again;
            throw e;
        }
    }

    private async createLevel(db: any, tenantId: string, level: Level, parentId: string | null, objectId: string | null): Promise<Mapping> {
        // Serialize creators of this exact scope; the lock is released with the caller's transaction.
        await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`bitrix-disk-folder:${tenantId}:${level.key}`]);
        const existing = (await this.mappings(db, tenantId, [level.key])).get(level.key);
        if (existing) return existing;
        const parent = level.isRoot ? await this.client.storageRoot(tenantId, this.config().bitrixStorageId) : parentId!;
        const folder = await this.ensureFolder(tenantId, parent, level.name, level.token);
        // An adopted folder may still carry an older label (the Object was renamed while its mapping was missing): refresh it in place.
        if (folder.name !== level.name) await this.refreshObjectLabel(db, tenantId, level, { externalFolderId: folder.id, folderName: folder.name }, false);
        await db.query('INSERT INTO storage_folder_mappings(tenant_id,provider,scope_key,object_id,external_folder_id,folder_name) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id,provider,scope_key) DO NOTHING', [tenantId, STORAGE_BITRIX_DISK, level.key, objectId, folder.id, level.name]);
        const stored = (await this.mappings(db, tenantId, [level.key])).get(level.key)!;
        storageLog('info', 'storage.folder.mapped', { provider: STORAGE_BITRIX_DISK, tenantId, scope: level.key, externalFolderId: stored.externalFolderId });
        return stored;
    }

    /** Disk folder id for a placement, creating (once) whatever part of the tree is missing. */
    async resolve(db: any, tenantId: string, placement: FilePlacement): Promise<string> {
        const object = await one(db, 'SELECT name FROM objects WHERE tenant_id=$1 AND id=$2', [tenantId, placement.objectId]);
        if (!object) throw new NotFoundException('Объект не найден');
        const chain = folderChain(placement, object.name, this.config().bitrixRootFolderName);
        const have = await this.mappings(db, tenantId, chain.map(l => l.key));
        let parent: string | null = null;
        for (const level of chain) {
            let m = have.get(level.key);
            if (!m) m = await this.createLevel(db, tenantId, level, parent, level.isRoot ? null : placement.objectId);
            else if (level.isObject && m.folderName !== level.name) await this.refreshObjectLabel(db, tenantId, level, m);
            parent = m.externalFolderId;
        }
        return parent!;
    }

    /** The Object was renamed in Core: refresh the Disk label in place (same folder id, nothing moves). Best effort. */
    private async refreshObjectLabel(db: any, tenantId: string, level: Level, m: Mapping, persist = true) {
        try {
            await this.client.renameFolder(tenantId, m.externalFolderId, level.name);
            if (persist) await db.query('UPDATE storage_folder_mappings SET folder_name=$4,updated_at=now(),version=version+1 WHERE tenant_id=$1 AND provider=$2 AND scope_key=$3', [tenantId, STORAGE_BITRIX_DISK, level.key, level.name]);
            storageLog('info', 'storage.folder.renamed', { provider: STORAGE_BITRIX_DISK, tenantId, scope: level.key, externalFolderId: m.externalFolderId });
        } catch (e) {
            storageLog('warn', 'storage.folder.rename_failed', { provider: STORAGE_BITRIX_DISK, tenantId, scope: level.key, externalFolderId: m.externalFolderId, ...describeError(e) });
        }
    }

    /**
     * After an upload failed: if a mapped folder no longer exists in Disk (deleted by a human), drop its mapping so the next
     * resolve() recreates it. Returns true when something was dropped. A probe that cannot decide (network, auth) drops nothing.
     */
    async dropMissing(db: any, tenantId: string, placement: FilePlacement): Promise<boolean> {
        const object = await one(db, 'SELECT name FROM objects WHERE tenant_id=$1 AND id=$2', [tenantId, placement.objectId]);
        if (!object) return false;
        const chain = folderChain(placement, object.name, this.config().bitrixRootFolderName);
        const have = await this.mappings(db, tenantId, chain.map(l => l.key));
        let dropped = false;
        for (const level of [...chain].reverse()) {
            const m = have.get(level.key);
            if (!m) continue;
            let missing = false;
            try { missing = (await this.client.getFolder(tenantId, m.externalFolderId)).deleted; }
            catch (e) { if (classifyDiskError(e).error.code !== 'STORAGE_NOT_FOUND') return dropped; missing = true; }
            if (!missing) break;
            await db.query('DELETE FROM storage_folder_mappings WHERE tenant_id=$1 AND provider=$2 AND scope_key=$3', [tenantId, STORAGE_BITRIX_DISK, level.key]);
            storageLog('warn', 'storage.folder.mapping_dropped', { provider: STORAGE_BITRIX_DISK, tenantId, scope: level.key, externalFolderId: m.externalFolderId });
            dropped = true;
        }
        return dropped;
    }
}
