/**
 * PBX-3A browser gate — a REAL backend (PGlite in memory, mock auth, demo seed) on :3001.
 * The Vite dev server proxies /api to it (apps/frontend/vite.config.ts), so the browser scenario
 * exercises the real routes, permissions, redistribution transaction and read model end to end.
 */
process.env.AUTH_MODE = 'mock';
process.env.MOCK_LOGIN_KEY = 'pbx3a-browser-key';
process.env.DB_MODE = 'pglite';
process.env.PGLITE_DIR = 'memory://';
delete process.env.DATABASE_URL;
process.env.RATE_LIMIT_MAX = '5000';
process.env.AUTH_RATE_LIMIT_MAX = '500';

(async () => {
  const { migrate } = await import('../../scripts/migrate');
  const { seed } = await import('../../scripts/seed');
  const { createApp } = await import('../../apps/backend/src/main');
  await migrate();
  await seed();
  const app = await createApp();
  await app.listen(3001, '127.0.0.1');
})().catch((e) => { console.error(e); process.exit(1); });
