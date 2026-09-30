import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';

/**
 * PBX-2 — last-ADMIN invariant under real concurrency, NATIVE PostgreSQL.
 *
 * PGlite is single-connection and cannot prove row-lock blocking, so this file
 * requires a real server (E2E_DATABASE_URL, else the local test cluster used by
 * f8.3-postgres-concurrency.test.ts). If it is unreachable the test FAILS — it
 * never falls back to PGlite.
 *
 * Interleaving is forced, not hoped for (same mechanism as F8.3-18): an
 * independent connection takes the tenant-access lock (FOR NO KEY UPDATE on the
 * tenant row, which every /admin/users mutation takes first) and holds it while
 * both HTTP requests are fired; the test asserts NEITHER has settled — so both
 * are provably in flight together — and only then releases the lock. Without
 * serialisation both requests would read "the other admin is still active" and
 * both would succeed, leaving zero active ADMINs (write skew).
 */
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? 'postgresql://postgres:local-test-only@127.0.0.1:5432/construction_test';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('PBX-2 P: concurrent requests can never remove or downgrade every active ADMIN (native PostgreSQL)', async (t) => {
  process.env.AUTH_MODE = 'mock';
  process.env.MOCK_LOGIN_KEY = 'pbx2-pg-concurrency-key';
  process.env.DB_MODE = 'postgres';
  process.env.DATABASE_URL = DATABASE_URL;

  const probe = new Client({ connectionString: DATABASE_URL });
  await probe.connect();
  const version = (await probe.query('SHOW server_version')).rows[0].server_version;
  const { migrate } = await import('../scripts/migrate');
  const { createApp } = await import('../apps/backend/src/main');
  const { session } = await import('../apps/backend/src/security');
  const { pool, insert } = await import('../apps/backend/src/db');
  await migrate();
  const app = await createApp();
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  const patch = async (token: string, id: string, body: any) => {
    const r = await fetch(`${base}/admin/users/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const activeAdmins = async (tenantId: string) => (await pool.query("SELECT count(*)::int n FROM users WHERE tenant_id=$1 AND role='ADMIN' AND is_active=true", [tenantId])).rows[0].n;

  async function scenario(admins: number, plan: (users: any[]) => Array<{ actor: number; target: number; body: any }>) {
    const tenant = (await pool.query('INSERT INTO tenants(portal,member_id,name) VALUES($1,$2,$3) RETURNING id', [`c-${suffix}-${Math.random().toString(36).slice(2, 6)}.bitrix24.com`, `m-${suffix}-${Math.random().toString(36).slice(2, 8)}`, 'PBX2 concurrency'])).rows[0].id;
    const users: any[] = [], tokens: string[] = [];
    for (let i = 0; i < admins; i++) {
      const u = await insert(pool, 'users', tenant, { bitrixUserId: String(100 + i), name: 'Admin ' + i, role: 'ADMIN' });
      users.push(u);
      tokens.push((await session(u)).token);
    }
    const barrier = new Client({ connectionString: DATABASE_URL });
    await barrier.connect();
    try {
      await barrier.query('BEGIN');
      await barrier.query('SELECT id FROM tenants WHERE id=$1 FOR NO KEY UPDATE', [tenant]);
      const settled: boolean[] = [];
      const racers = plan(users).map((p, i) => { settled[i] = false; return patch(tokens[p.actor], users[p.target].id, p.body).finally(() => { settled[i] = true; }); });
      await sleep(500);
      assert.deepEqual(settled, settled.map(() => false), 'all racing requests must be queued behind the tenant lock (proof of genuine overlap)');
      await barrier.query('COMMIT');
      const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('deadlock/timeout')), 15000));
      const results = await Promise.race([Promise.all(racers), timeout]);
      return { tenant, results };
    } finally {
      await barrier.end();
    }
  }

  try {
    assert.match(String(version), /^\d+/);
    await t.test('two admins deactivate each other simultaneously → exactly one wins', async () => {
      const { tenant, results } = await scenario(2, () => [{ actor: 0, target: 1, body: { isActive: false } }, { actor: 1, target: 0, body: { isActive: false } }]);
      // The loser is rejected either by the invariant (409) or because the winner deleted its session (401): never 500, never both 200.
      assert.equal(results.filter((r) => r.status === 200).length, 1, JSON.stringify(results));
      assert.ok(results.every((r) => [200, 401, 409].includes(r.status)), JSON.stringify(results));
      assert.equal(await activeAdmins(tenant), 1);
    });
    await t.test('two admins downgrade each other simultaneously → exactly one wins', async () => {
      const { tenant, results } = await scenario(2, () => [{ actor: 0, target: 1, body: { role: 'PTO' } }, { actor: 1, target: 0, body: { role: 'PTO' } }]);
      assert.equal(results.filter((r) => r.status === 200).length, 1, JSON.stringify(results));
      assert.ok(results.every((r) => [200, 409].includes(r.status)), JSON.stringify(results));
      assert.equal(await activeAdmins(tenant), 1);
    });
    await t.test('one deactivates, the other downgrades → exactly one wins', async () => {
      const { tenant, results } = await scenario(2, () => [{ actor: 0, target: 1, body: { isActive: false } }, { actor: 1, target: 0, body: { role: 'SDO' } }]);
      assert.equal(results.filter((r) => r.status === 200).length, 1, JSON.stringify(results));
      assert.ok(results.every((r) => [200, 401, 409].includes(r.status)), JSON.stringify(results));
      assert.equal(await activeAdmins(tenant), 1);
    });
    await t.test('self-demotion race among three admins → at least one ADMIN always remains, both losers refused', async () => {
      const { tenant, results } = await scenario(3, () => [{ actor: 0, target: 0, body: { role: 'PTO' } }, { actor: 1, target: 1, body: { role: 'PTO' } }, { actor: 2, target: 2, body: { isActive: false } }]);
      assert.equal(results.filter((r) => r.status === 200).length, 2, JSON.stringify(results));
      assert.equal(results.filter((r) => r.status === 409).length, 1, JSON.stringify(results));
      assert.equal(await activeAdmins(tenant), 1);
    });
    await t.test('the lock is per tenant: another tenant is not blocked by a held lock', async () => {
      const other = (await pool.query('INSERT INTO tenants(portal,member_id,name) VALUES($1,$2,$3) RETURNING id', [`iso-${suffix}.bitrix24.com`, `iso-${suffix}`, 'iso'])).rows[0].id;
      const a = await insert(pool, 'users', other, { bitrixUserId: '1', name: 'A', role: 'ADMIN' });
      const b = await insert(pool, 'users', other, { bitrixUserId: '2', name: 'B', role: 'ADMIN' });
      const held = (await pool.query("SELECT id FROM tenants WHERE portal NOT LIKE 'iso-%' LIMIT 1")).rows[0];
      const barrier = new Client({ connectionString: DATABASE_URL });
      await barrier.connect();
      try {
        await barrier.query('BEGIN');
        await barrier.query('SELECT id FROM tenants WHERE id=$1 FOR NO KEY UPDATE', [held.id]);
        const r = await Promise.race([patch((await session(a)).token, b.id, { isActive: false }), sleep(5000).then(() => 'blocked' as const)]);
        assert.notEqual(r, 'blocked');
        assert.equal((r as any).status, 200);
      } finally { await barrier.query('ROLLBACK'); await barrier.end(); }
    });
  } finally {
    await app.close();
    await probe.end();
  }
});
