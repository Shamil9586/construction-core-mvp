/**
 * OBJ-1 browser gate — REAL backend (PGlite, mock auth, demo seed) on :3001, then the demo tenant's
 * portfolio is emptied (zero objects, zero contractors; users kept) to reproduce the empty-tenant shape.
 */
process.env.AUTH_MODE = 'mock';
process.env.MOCK_LOGIN_KEY = 'obj1-browser-key';
process.env.DB_MODE = 'pglite';
process.env.PGLITE_DIR = 'memory://';
delete process.env.DATABASE_URL;
process.env.RATE_LIMIT_MAX = '5000';
process.env.AUTH_RATE_LIMIT_MAX = '500';

(async () => {
  const { migrate } = await import('../../scripts/migrate');
  const { seed } = await import('../../scripts/seed');
  const { createApp } = await import('../../apps/backend/src/main');
  const { pool } = await import('../../apps/backend/src/db');
  await migrate();
  await seed();
  // Test-only: detach users from contractors so the CASCADE does not wipe the users we need.
  await pool.query('ALTER TABLE users DROP CONSTRAINT users_tenant_id_contractor_id_fkey');
  await pool.query('TRUNCATE objects, contractors CASCADE');
  const users = (await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n;
  if (!users) throw new Error('OBJ-1 browser server: users were truncated by CASCADE');
  const app = await createApp();
  await app.listen(3001, '127.0.0.1');
})().catch((e) => { console.error(e); process.exit(1); });
