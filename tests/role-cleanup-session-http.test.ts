import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * ROLE-CLEANUP — session evidence (native PostgreSQL). A bearer session created
 * BEFORE migration 017 for a TECHNICAL_DIRECTOR / DEPARTMENT_HEAD user keeps
 * working afterwards and resolves the converted user as DEPUTY_DIRECTOR,
 * because sessions store only user_id and authenticate() joins the current
 * users row (no session-role alias). /auth/mock rejects the removed strings.
 */
const ADMIN_DATABASE_URL = process.env.E2E_ADMIN_DATABASE_URL ?? 'postgresql://postgres:local-test-only@127.0.0.1:5432/postgres';
const HOST = process.env.E2E_POSTGRES_HOST_URL ?? 'postgresql://postgres:local-test-only@127.0.0.1:5432/';

test('pre-017 session of a legacy-role user resolves DEPUTY_DIRECTOR after migration; auth/mock rejects removed role strings', async () => {
  const name = 'role_cleanup_session_http';
  const admin = new Client({ connectionString: ADMIN_DATABASE_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  const url = HOST + name;
  const client = new Client({ connectionString: url });
  await client.connect();
  let app: any; let pool: any;
  try {
    await client.query('CREATE TABLE schema_migrations(version int PRIMARY KEY, applied_at timestamptz DEFAULT now())');
    const files = fs.readdirSync('infra').filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
    const apply = async (max: number, min = 0) => {
      for (const f of files) {
        const v = Number(f.split('_')[0]);
        if (v > max || v <= min) continue;
        await client.query(fs.readFileSync(path.join('infra', f), 'utf8'));
        await client.query('INSERT INTO schema_migrations(version) VALUES($1)', [v]);
      }
    };
    await apply(16);
    const tenant = (await client.query("INSERT INTO tenants(portal,member_id,name) VALUES('demo.local','m','T') RETURNING id")).rows[0].id;
    const tokens: Record<string, string> = {};
    const ids: Record<string, string> = {};
    for (const [i, role] of ['TECHNICAL_DIRECTOR', 'DEPARTMENT_HEAD'].entries()) {
      const u = (await client.query('INSERT INTO users(tenant_id,bitrix_user_id,name,role) VALUES($1,$2,$3,$4) RETURNING id', [tenant, String(i + 1), 'Legacy ' + role, role])).rows[0];
      ids[role] = u.id;
      tokens[role] = randomBytes(32).toString('base64url');
      await client.query("INSERT INTO sessions(tenant_id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')", [tenant, u.id, createHash('sha256').update(tokens[role]).digest('hex')]);
    }
    await apply(17, 16);

    process.env.DATABASE_URL = url;
    process.env.DB_MODE = 'postgres';
    process.env.AUTH_MODE = 'mock';
    process.env.MOCK_LOGIN_KEY = 'role-cleanup-key';
    ({ pool } = await import('../apps/backend/src/db'));
    const { createApp } = await import('../apps/backend/src/main');
    app = await createApp();
    await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${(app.getHttpServer().address() as any).port}`;

    for (const role of Object.keys(tokens)) {
      const r = await fetch(base + '/me', { headers: { Authorization: 'Bearer ' + tokens[role] } });
      assert.equal(r.status, 200, role + ' session still authenticates');
      const me: any = await r.json();
      assert.equal(me.role, 'DEPUTY_DIRECTOR', role + ' resolves as DEPUTY_DIRECTOR');
      assert.equal(me.id, ids[role], 'same user id');
    }
    for (const role of ['TECHNICAL_DIRECTOR', 'DEPARTMENT_HEAD', 'CONSTRUCTION_DIRECTOR', 'DoC']) {
      const r = await fetch(base + '/auth/mock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role, key: 'role-cleanup-key' }) });
      assert.ok(r.status >= 400 && r.status < 500, role + ' rejected: ' + r.status);
    }
    const ok = await fetch(base + '/auth/mock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'DEPUTY_DIRECTOR', key: 'role-cleanup-key' }) });
    assert.notEqual(ok.status >= 400, true, 'DEPUTY_DIRECTOR still validates (status ' + ok.status + ')');
  } finally {
    if (app) await app.close();
    if (pool) await pool.end();
    await client.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
});
