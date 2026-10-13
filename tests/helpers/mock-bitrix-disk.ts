// Lazy: importing the backend loads db.ts, whose pool is chosen from env at import time — tests set DB_MODE first.
const rest = (code: string, status: number) => { const { BitrixRestError } = require('../../apps/backend/src/bitrix'); return new BitrixRestError(code, status); };

/**
 * In-memory sandbox of the Bitrix24 Disk REST surface Core uses (BITRIX-DISK-1). It plugs into the same seam the notification
 * outbox uses — `installedCall(tenantId, method, params)` — so no network is ever touched and no OAuth token exists in tests.
 * It models: storages, folders/files with per-folder unique names, 50-per-page listings, tokenised DOWNLOAD_URLs, trash, and
 * fault injection (fail, or "apply then fail" to simulate a timeout after the portal already stored the file).
 *
 * Error codes for conflicts are mock-only (the exact Bitrix code is part of what needs a real portal); Core must not depend on them.
 */
export const MOCK_PORTAL = 'portal.bitrix24.ru';
export const URL_SECRET = 'SECRET-TOKEN-IN-DOWNLOAD-URL';
type Obj = { id: string; type: 'folder' | 'file'; name: string; parentId: string | null; bytes?: Buffer; deleted: number };
type Fault = { method: string; error: any; applyFirst: boolean; times: number; match?: (params: any) => boolean };

export class MockBitrixDisk {
    objects = new Map<string, Obj>();
    calls: { method: string; tenantId: string; params: any }[] = [];
    downloads: string[] = [];
    faults: Fault[] = [];
    private seq = 100;
    readonly storageId = '7';
    readonly rootId: string;
    constructor() { this.rootId = this.add('folder', 'storage-root', null).id; }

    private add(type: 'folder' | 'file', name: string, parentId: string | null, bytes?: Buffer): Obj {
        const o: Obj = { id: String(++this.seq), type, name, parentId, bytes, deleted: 0 };
        this.objects.set(o.id, o);
        return o;
    }
    private view(o: Obj, withUrl = false) {
        return { ID: o.id, NAME: o.name, TYPE: o.type, PARENT_ID: o.parentId, DELETED_TYPE: String(o.deleted), STORAGE_ID: this.storageId, ...(o.type === 'file' ? { SIZE: String(o.bytes!.length), ...(withUrl ? { DOWNLOAD_URL: `https://${MOCK_PORTAL}/rest/download.json?auth=${URL_SECRET}&token=disk%7C${o.id}` } : {}) } : {}) };
    }
    private siblings(parentId: string) { return [...this.objects.values()].filter(o => o.parentId === parentId && !o.deleted); }
    private need(id: string, type?: 'folder' | 'file'): Obj {
        const o = this.objects.get(String(id));
        if (!o || (type && o.type !== type)) throw rest('ERROR_NOT_FOUND', 400);
        return o;
    }

    /** Fail the next `times` calls to `method`. `applyFirst` performs the operation and THEN fails (portal stored it, answer lost). */
    fail(method: string, error: any = rest('INTERNAL_SERVER_ERROR', 500), opts: { applyFirst?: boolean; times?: number; match?: (params: any) => boolean } = {}) {
        this.faults.push({ method, error, applyFirst: !!opts.applyFirst, times: opts.times ?? 1, match: opts.match });
    }
    callsOf(method: string) { return this.calls.filter(c => c.method === method); }
    reset() { this.calls = []; this.downloads = []; this.faults = []; }

    // ---- inspection helpers ----
    pathOf(id: string): string { const parts: string[] = []; for (let o = this.objects.get(id); o && o.id !== this.rootId; o = o.parentId ? this.objects.get(o.parentId) : undefined) parts.unshift(o.name); return parts.join('/'); }
    files(): Obj[] { return [...this.objects.values()].filter(o => o.type === 'file' && !o.deleted); }
    folders(): Obj[] { return [...this.objects.values()].filter(o => o.type === 'folder' && !o.deleted && o.id !== this.rootId); }
    filePaths(): string[] { return this.files().map(f => this.pathOf(f.id)).sort(); }
    folderPaths(): string[] { return this.folders().map(f => this.pathOf(f.id)).sort(); }
    byPath(path: string): Obj | undefined { return [...this.objects.values()].find(o => !o.deleted && o.id !== this.rootId && this.pathOf(o.id) === path); }
    bytesOf(id: string): Buffer { return this.need(id, 'file').bytes!; }
    /** Out-of-band edit in Disk (a human replaced the file). */
    tamper(id: string, bytes: Buffer) { this.need(id, 'file').bytes = bytes; }
    trash(id: string) { this.need(id).deleted = 1; }
    remove(id: string) { this.objects.delete(id); }

    /** The sandboxed DiskTransport. */
    installedCall = async (tenantId: string, method: string, params: any = {}): Promise<any> => {
        this.calls.push({ method, tenantId, params: JSON.parse(JSON.stringify(params)) });
        const fault = this.faults.find(f => f.method === method && f.times > 0 && (!f.match || f.match(params)));
        if (fault) {
            fault.times--;
            if (fault.applyFirst) await this.dispatch(method, params);
            throw fault.error;
        }
        return this.dispatch(method, params);
    };

    /** The sandboxed DiskDownloader: maps a tokenised URL back to the file's bytes. */
    download = async (url: string): Promise<Buffer> => {
        this.downloads.push(url);
        const id = decodeURIComponent(new URL(url).searchParams.get('token') ?? '').split('|')[1];
        const o = this.objects.get(id);
        if (!o || o.type !== 'file' || o.deleted) throw rest('ERROR_NOT_FOUND', 404);
        return Buffer.from(o.bytes!);
    };

    private async dispatch(method: string, p: any): Promise<any> {
        switch (method) {
            case 'disk.storage.getforapp': return { ID: this.storageId, NAME: 'app', ROOT_OBJECT_ID: this.rootId };
            case 'disk.storage.get': if (String(p.id) !== this.storageId) throw rest('ERROR_NOT_FOUND', 400); return { ID: this.storageId, NAME: 'common', ROOT_OBJECT_ID: this.rootId };
            case 'disk.folder.get': return this.view(this.need(p.id, 'folder'));
            case 'disk.folder.getchildren': {
                const folder = this.need(p.id, 'folder');
                let kids = this.siblings(folder.id);
                if (p.filter?.NAME) kids = kids.filter(k => k.name === p.filter.NAME);
                const start = Number(p.start ?? 0);
                return kids.slice(start, start + 50).map(k => this.view(k));
            }
            case 'disk.folder.addsubfolder': {
                const parent = this.need(p.id, 'folder');
                if (this.siblings(parent.id).some(k => k.name === p.data.NAME)) throw rest('ERROR_NAME_EXISTS', 400);
                return this.view(this.add('folder', p.data.NAME, parent.id));
            }
            case 'disk.folder.rename': { const f = this.need(p.id, 'folder'); f.name = p.newName; return this.view(f); }
            case 'disk.folder.uploadfile': {
                const parent = this.need(p.id, 'folder');
                if (parent.deleted) throw rest('ERROR_NOT_FOUND', 400);
                if (!Array.isArray(p.fileContent) || p.fileContent[0] !== p.data?.NAME) throw rest('INVALID_REQUEST', 400);
                if (this.siblings(parent.id).some(k => k.name === p.data.NAME)) throw rest('ERROR_NAME_EXISTS', 400);
                return this.view(this.add('file', p.data.NAME, parent.id, Buffer.from(p.fileContent[1], 'base64')), true);
            }
            case 'disk.file.get': return this.view(this.need(p.id, 'file'), true);
            case 'disk.file.delete': { this.need(p.id, 'file'); this.objects.delete(String(p.id)); return true; }
            default: throw rest('ERROR_METHOD_NOT_FOUND', 404);
        }
    }
}

/** Captures console output of one test so log assertions (and the "no secrets" check) see exactly what an operator would. */
export function captureLogs() {
    const lines: string[] = [];
    const orig = { log: console.log, warn: console.warn, error: console.error };
    const grab = (...a: any[]) => { lines.push(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
    console.log = grab; console.warn = grab; console.error = grab;
    return {
        lines,
        events: () => lines.filter(l => l.startsWith('{')).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter((e): e is any => e?.component === 'file-storage'),
        restore() { console.log = orig.log; console.warn = orig.warn; console.error = orig.error; },
    };
}
