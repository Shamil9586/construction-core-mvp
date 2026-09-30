import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import fs from 'node:fs';
import path from 'node:path';

/**
 * PBX-2 corrective — migration 015 (infra/015_department_head_roles.sql),
 * NATIVE PostgreSQL only (never PGlite): the users.role CHECK constraint is
 * widened to accept PTO_HEAD / CONSTRUCTION_CONTROL_HEAD / SDO_HEAD while every
 * previously valid value (incl. legacy TECHNICAL_DIRECTOR and DEPARTMENT_HEAD)
 * stays valid and no existing row is touched.
 *
 * Each test uses its own freshly created database. Path A runs the real
 * scripts/migrate.ts runner (1 -> latest, then a re-run that must be a no-op).
 * Path B drives schema_migrations itself to stop at version 14, seeds legacy
 * users, then applies 015 and proves nothing was rewritten.
 */
const ADMIN_DATABASE_URL = process.env.E2E_ADMIN_DATABASE_URL ?? 'postgresql://postgres:local-test-only@127.0.0.1:5432/postgres';
const HOST = process.env.E2E_POSTGRES_HOST_URL ?? 'postgresql://postgres:local-test-only@127.0.0.1:5432/';

const OLD_ROLES = ['GENERAL_DIRECTOR', 'TECHNICAL_DIRECTOR', 'PROJECT_MANAGER', 'CONSTRUCTION_CONTROL', 'PTO', 'SDO', 'DEPARTMENT_HEAD', 'ADMIN', 'CONTRACTOR_VIEWER', 'DEPUTY_DIRECTOR'];
const NEW_ROLES = ['PTO_HEAD', 'CONSTRUCTION_CONTROL_HEAD', 'SDO_HEAD'];

async function withAdmin<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const admin = new Client({ connectionString: ADMIN_DATABASE_URL });
  await admin.connect();
  try { return await fn(admin); } finally { await admin.end(); }
}
const createDb = (name: string) => withAdmin(async (a) => { await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await a.query(`CREATE DATABASE ${name}`); return HOST + name; });
const dropDb = (name: string) => withAdmin((a) => a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
const migrationFiles = () => fs.readdirSync('infra').filter((f) => /^\d+_.*\.sql$/.test(f)).sort();

async function applyThrough(client: Client, maxVersion: number) {
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations(version int PRIMARY KEY, applied_at timestamptz DEFAULT now())');
  for (const file of migrationFiles()) {
    const version = Number(file.split('_')[0]);
    if (version > maxVersion) continue;
    if ((await client.query('SELECT 1 FROM schema_migrations WHERE version=$1', [version])).rows.length) continue;
    await client.query(fs.readFileSync(path.join('infra', file), 'utf8'));
    await client.query('INSERT INTO schema_migrations(version) VALUES($1)', [version]);
  }
}

const tenant = async (c: Client) => (await c.query("INSERT INTO tenants(portal,member_id,name) VALUES('t.bitrix24.com','m1','T') RETURNING id")).rows[0].id as string;
const addUser = (c: Client, tenantId: string, n: number, role: string) => c.query('INSERT INTO users(tenant_id,bitrix_user_id,name,role) VALUES($1,$2,$3,$4)', [tenantId, String(n), 'U' + n, role]);
const rejected = async (c: Client, fn: () => Promise<unknown>) => { try { await fn(); } catch (e: any) { return e.code as string; } return null; };

test('migration 015 exists as the next version after 014', () => {
  const files = migrationFiles();
  assert.ok(files.includes('015_department_head_roles.sql'));
  assert.equal(Number(files[files.length - 1].split('_')[0]), 15);
  const versions = files.map((f) => Number(f.split('_')[0]));
  assert.deepEqual(versions, versions.map((_, i) => i + 1), 'no gaps or duplicates in the chain');
});

test('Path A (fresh native DB): full chain 1 -> latest, re-run is a no-op, CHECK accepts all 13 roles and rejects an unknown one', async () => {
  const name = 'pbx2_heads_fresh';
  const url = await createDb(name);
  process.env.DATABASE_URL = url;
  process.env.DB_MODE = 'postgres';
  const { migrate } = await import('../scripts/migrate');
  const { pool } = await import('../apps/backend/src/db');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await migrate();
    const first = (await client.query('SELECT version, applied_at FROM schema_migrations ORDER BY version')).rows;
    assert.deepEqual(first.map((r) => r.version), migrationFiles().map((f) => Number(f.split('_')[0])), 'every migration 1..15 recorded');
    assert.equal(first[first.length - 1].version, 15);
    await migrate();
    const second = (await client.query('SELECT version, applied_at FROM schema_migrations ORDER BY version')).rows;
    assert.deepEqual(second, first, 're-running the runner changes nothing (applied versions skipped)');

    const checks = (await client.query("SELECT conname, pg_get_constraintdef(oid) def FROM pg_constraint WHERE conrelid='users'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%role%'")).rows;
    assert.equal(checks.length, 1, 'exactly one role CHECK remains: ' + JSON.stringify(checks));
    for (const role of [...OLD_ROLES, ...NEW_ROLES]) assert.match(checks[0].def, new RegExp(`'${role}'`), role);

    const t = await tenant(client);
    let n = 0;
    for (const role of [...OLD_ROLES, ...NEW_ROLES]) { await addUser(client, t, ++n, role); }
    assert.equal((await client.query('SELECT count(*)::int n FROM users')).rows[0].n, 13);
    assert.equal(await rejected(client, () => addUser(client, t, ++n, 'BOGUS_ROLE')), '23514');
    assert.equal(await rejected(client, () => addUser(client, t, ++n, 'pto_head')), '23514', 'role match is exact');
    assert.equal(await rejected(client, () => client.query("UPDATE users SET role='NOT_A_ROLE' WHERE bitrix_user_id='1'")), '23514');
  } finally {
    await client.end();
    await pool.end();
    await dropDb(name);
  }
});

test('Path B (native DB at version 14 -> 15): existing users untouched, legacy rows readable, new roles insertable afterwards', async () => {
  const name = 'pbx2_heads_upgrade';
  const url = await createDb(name);
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await applyThrough(client, 14);
    assert.equal((await client.query('SELECT max(version)::int v FROM schema_migrations')).rows[0].v, 14);
    const t = await tenant(client);
    let n = 0;
    for (const role of OLD_ROLES) await addUser(client, t, ++n, role);
    // before 015 the new roles are refused by the DB
    for (const role of NEW_ROLES) assert.equal(await rejected(client, () => addUser(client, t, 900 + NEW_ROLES.indexOf(role), role)), '23514', role + ' before 015');
    const snapshot = async () => (await client.query('SELECT * FROM users ORDER BY bitrix_user_id::int')).rows;
    const before = await snapshot();
    assert.equal(before.length, 10);

    await applyThrough(client, 15);
    assert.equal((await client.query('SELECT max(version)::int v FROM schema_migrations')).rows[0].v, 15);

    assert.deepEqual(await snapshot(), before, 'no user row was rewritten (values, version and updated_at identical)');
    const legacy = (await client.query("SELECT role FROM users WHERE role IN ('TECHNICAL_DIRECTOR','DEPARTMENT_HEAD') ORDER BY role")).rows.map((r) => r.role);
    assert.deepEqual(legacy, ['DEPARTMENT_HEAD', 'TECHNICAL_DIRECTOR'], 'legacy roles neither converted nor removed');
    for (const role of NEW_ROLES) await addUser(client, t, 950 + NEW_ROLES.indexOf(role), role);
    assert.equal((await client.query('SELECT count(*)::int n FROM users')).rows[0].n, 13);
    assert.equal(await rejected(client, () => addUser(client, t, 990, 'BOGUS_ROLE')), '23514');
    // an already-applied 015 is skipped, not re-run
    await applyThrough(client, 15);
    assert.equal((await client.query('SELECT count(*)::int n FROM schema_migrations WHERE version=15')).rows[0].n, 1);
  } finally {
    await client.end();
    await dropDb(name);
  }
});
