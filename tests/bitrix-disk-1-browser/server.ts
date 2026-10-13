/**
 * BITRIX-DISK-1 browser gate — the UNMODIFIED ID-AUTO-1 embedded scenario (tests/id-auto-1-browser/server.ts: real backend on PGlite,
 * Core mock auth, app in a cross-origin iframe like the Bitrix24 portal) with every NEW file stored in the sandboxed Bitrix Disk.
 * Nothing contacts Bitrix: the Disk REST surface is the in-memory mock. Extra endpoint :3003/disk reports what the sandbox holds.
 */
process.env.AUTH_MODE = 'mock';
process.env.MOCK_LOGIN_KEY = 'id-auto-1-browser-key';
process.env.DB_MODE = 'pglite';
process.env.PGLITE_DIR = 'memory://';
delete process.env.DATABASE_URL;
process.env.FILE_STORAGE_PROVIDER = 'BITRIX_DISK';

(async () => {
  const { MockBitrixDisk } = await import('../helpers/mock-bitrix-disk');
  const { setBitrixDiskTestHooks } = await import('../../apps/backend/src/file-storage/file-store');
  const disk = new MockBitrixDisk();
  setBitrixDiskTestHooks({ transport: disk, downloader: disk.download });
  const http = await import('node:http');
  http.createServer((rq, rs) => {
    if (new URL(rq.url ?? '/', 'http://x').pathname !== '/disk') { rs.statusCode = 404; return rs.end(); }
    rs.setHeader('Content-Type', 'application/json');
    rs.end(JSON.stringify({ files: disk.filePaths(), downloads: disk.downloads.length, methods: [...new Set(disk.calls.map(c => c.method))].sort(), leaked: JSON.stringify(disk.calls).match(/auth|token|USER_ID/i) !== null }));
  }).listen(3003, 'localhost');
  require('../id-auto-1-browser/server'); // runs the unmodified scenario on top of the registered sandbox
})().catch((e) => { console.error(e); process.exit(1); });
