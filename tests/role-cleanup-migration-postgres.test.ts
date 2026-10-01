import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import fs from 'node:fs';
import path from 'node:path';

/**
 * ROLE-CLEANUP — migration 017 (infra/017_remove_legacy_director_roles.sql),
 * NATIVE PostgreSQL only. Each test creates its own database, applies
 * migrations 1..16, seeds pre-017 data (incl. the removed roles), applies 017
 * and asserts: rows converted to DEPUTY_DIRECTOR with identity preserved,
 * narrowed CHECK, audit history untouched, sessions resolve via user_id.
 */
const ADMIN_DATABASE_URL = process.env.E2E_ADMIN_DATABASE_URL ?? 'postgresql://postgres:local-test-only@127.0.0.1:5432/postgres';
const HOST = process.env.E2E_POSTGRES_HOST_URL ?? 'postgresql://postgres:local-test-only@127.0.0.1:5432/';

const CURRENT_ROLES = ['GENERAL_DIRECTOR', 'DEPUTY_DIRECTOR', 'PROJECT_MANAGER', 'CONSTRUCTION_CONTROL', 'CONSTRUCTION_CONTROL_HEAD', 'PTO', 'PTO_HEAD', 'SDO', 'SDO_HEAD', 'ADMIN', 'CONTRACTOR_VIEWER'];
const REMOVED = ['TECHNICAL_DIRECTOR', 'DEPARTMENT_HEAD'];

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
const tenant = async (c: Client, portal: string) => (await c.query("INSERT INTO tenants(portal,member_id,name) VALUES($1,$2,'T') RETURNING id", [portal, portal])).rows[0].id as string;
const addUser = async (c: Client, tenantId: string, n: number, role: string, active = true) =>
  (await c.query('INSERT INTO users(tenant_id,bitrix_user_id,name,role,is_active) VALUES($1,$2,$3,$4,$5) RETURNING *', [tenantId, String(n), 'U' + n, role, active])).rows[0];
const riskColumns = async (c: Client) => (await c.query("SELECT column_name FROM information_schema.columns WHERE table_name='risk_settings'")).rows.map((r) => r.column_name as string);
const rejected = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (e: any) { return e.code as string; } return null; };

test('migration 017 is the next version after 016', () => {
  const files = migrationFiles();
  const versions = files.map((f) => Number(f.split('_')[0]));
  assert.deepEqual(versions, versions.map((_, i) => i + 1), 'no gaps or duplicates');
  assert.equal(files[16], '017_remove_legacy_director_roles.sql');
});

test('017: removed-role rows (both in one tenant, several per role) convert to DEPUTY_DIRECTOR preserving identity; history untouched; CHECK narrowed', async () => {
  const name = 'role_cleanup_upgrade';
  const url = await createDb(name);
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await applyThrough(client, 16);
    const t1 = await tenant(client, 'a.bitrix24.com'), t2 = await tenant(client, 'b.bitrix24.com');
    const contractor = (await client.query("INSERT INTO contractors(tenant_id,name) VALUES($1,'C') RETURNING id", [t1])).rows[0].id;
    const td1 = await addUser(client, t1, 1, 'TECHNICAL_DIRECTOR');
    const td2 = await addUser(client, t1, 2, 'TECHNICAL_DIRECTOR', false);
    const dh1 = await addUser(client, t1, 3, 'DEPARTMENT_HEAD');
    const dh2 = await addUser(client, t2, 4, 'DEPARTMENT_HEAD');
    const others: any[] = [];
    let n = 10;
    for (const role of CURRENT_ROLES) others.push(await addUser(client, t1, ++n, role));
    await client.query('UPDATE users SET contractor_id=$1 WHERE id=$2', [contractor, td1.id]);
    // a referencing row + an immutable history row carrying the old role string
    const objectFk = await client.query("SELECT 1 FROM information_schema.tables WHERE table_name='sessions'");
    assert.equal(objectFk.rows.length, 1);
    const token = randomUUID();
    await client.query('INSERT INTO sessions(tenant_id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval \'1 day\')', [t1, td1.id, token]).catch(async () => {
      const cols = (await client.query("SELECT column_name FROM information_schema.columns WHERE table_name='sessions'")).rows.map((r) => r.column_name);
      throw new Error('sessions columns: ' + cols.join(','));
    });
    await client.query('INSERT INTO risk_settings(tenant_id,escalate_technical_days,escalate_director_days) VALUES($1,5,11),($2,6,12)', [t1, t2]);
    const preCols = await riskColumns(client);
    assert.ok(preCols.includes('escalate_technical_days') && !preCols.includes('escalate_deputy_days'), 'pre-017 historical column name');
    const auditPayload = { role: 'TECHNICAL_DIRECTOR' };
    await client.query("INSERT INTO audit_logs(tenant_id,user_id,entity_type,entity_id,action,old_value,new_value) VALUES($1,$2,'User',$2,'ASSIGN',NULL,$3)", [t1, td1.id, JSON.stringify(auditPayload)]);
    const auditBefore = (await client.query('SELECT * FROM audit_logs ORDER BY id')).rows;
    const othersBefore = (await client.query('SELECT * FROM users WHERE id = ANY($1) ORDER BY id', [others.map((u) => u.id)])).rows;

    await applyThrough(client, 17);

    for (const before of [td1, td2, dh1, dh2]) {
      const after = (await client.query('SELECT * FROM users WHERE id=$1', [before.id])).rows[0];
      assert.equal(after.role, 'DEPUTY_DIRECTOR', before.role + ' converted');
      for (const col of ['id', 'tenant_id', 'bitrix_user_id', 'name', 'is_active', 'contractor_id', 'created_at']) assert.deepEqual(after[col], col === 'contractor_id' && before.id === td1.id ? contractor : before[col], col);
      assert.equal(after.version, before.version + 1);
    }
    assert.equal((await client.query("SELECT is_active FROM users WHERE id=$1", [td2.id])).rows[0].is_active, false, 'inactive stays inactive');
    assert.deepEqual((await client.query('SELECT * FROM users WHERE id = ANY($1) ORDER BY id', [others.map((u) => u.id)])).rows, othersBefore, 'other users untouched');
    assert.equal((await client.query("SELECT count(*)::int n FROM users WHERE role IN ('TECHNICAL_DIRECTOR','DEPARTMENT_HEAD')")).rows[0].n, 0);
    assert.deepEqual((await client.query('SELECT * FROM audit_logs ORDER BY id')).rows, auditBefore, 'audit history not rewritten');
    assert.deepEqual((await client.query("SELECT new_value FROM audit_logs WHERE entity_type='User'")).rows[0].new_value, auditPayload);

    // session row still points at the same user id, which now reads DEPUTY_DIRECTOR
    const viaSession = (await client.query('SELECT u.role FROM sessions s JOIN users u ON u.id=s.user_id AND u.tenant_id=s.tenant_id WHERE s.token_hash=$1', [token])).rows[0];
    assert.equal(viaSession.role, 'DEPUTY_DIRECTOR');

    // risk_settings: column renamed, per-tenant values preserved
    const postCols = await riskColumns(client);
    assert.ok(postCols.includes('escalate_deputy_days'));
    assert.equal(postCols.includes('escalate_technical_days'), false);
    assert.deepEqual((await client.query('SELECT tenant_id, escalate_deputy_days d, escalate_director_days g FROM risk_settings ORDER BY d')).rows, [{ tenant_id: t1, d: 5, g: 11 }, { tenant_id: t2, d: 6, g: 12 }]);
    assert.equal(await rejected(() => client.query('UPDATE risk_settings SET escalate_deputy_days=20 WHERE tenant_id=$1', [t1])), '23514', 'director > deputy CHECK still enforced after rename');

    // CHECK: exactly the current set
    const checks = (await client.query("SELECT pg_get_constraintdef(oid) def FROM pg_constraint WHERE conrelid='users'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%role%'")).rows;
    assert.equal(checks.length, 1);
    for (const role of CURRENT_ROLES) assert.match(checks[0].def, new RegExp(`'${role}'`), role);
    for (const role of [...REMOVED, 'CONSTRUCTION_DIRECTOR', 'DoC']) assert.doesNotMatch(checks[0].def, new RegExp(`'${role}'`), role);
    let k = 500;
    for (const role of [...REMOVED, 'CONSTRUCTION_DIRECTOR', 'DoC', 'BOGUS']) {
      assert.equal(await rejected(() => addUser(client, t1, ++k, role)), '23514', 'INSERT ' + role);
      assert.equal(await rejected(() => client.query('UPDATE users SET role=$2 WHERE id=$1', [others[0].id, role])), '23514', 'UPDATE ' + role);
    }
    for (const role of CURRENT_ROLES) await addUser(client, t2, ++k, role);

    // already applied: skipped, no second conversion
    await applyThrough(client, 17);
    assert.equal((await client.query('SELECT count(*)::int n FROM schema_migrations WHERE version=17')).rows[0].n, 1);
  } finally {
    await client.end();
    await dropDb(name);
  }
});

test('017: succeeds with zero removed-role rows and with only one removed role', async () => {
  for (const [label, roles] of [['zero', []], ['only_dh', ['DEPARTMENT_HEAD']], ['only_td', ['TECHNICAL_DIRECTOR']]] as const) {
    const name = 'role_cleanup_' + label;
    const url = await createDb(name);
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      await applyThrough(client, 16);
      const t = await tenant(client, label + '.bitrix24.com');
      let n = 0;
      const created = [];
      for (const role of [...CURRENT_ROLES, ...roles]) created.push(await addUser(client, t, ++n, role));
      await applyThrough(client, 17);
      assert.equal((await client.query('SELECT max(version)::int v FROM schema_migrations')).rows[0].v, 17);
      const after = (await client.query('SELECT id, role FROM users ORDER BY bitrix_user_id::int')).rows;
      assert.deepEqual(after.map((r) => r.id), created.map((r) => r.id));
      assert.deepEqual(after.map((r) => r.role), created.map((r) => (REMOVED.includes(r.role) ? 'DEPUTY_DIRECTOR' : r.role)));
    } finally {
      await client.end();
      await dropDb(name);
    }
  }
});

test('017 via the real runner on a fresh database: full chain applies and re-run is a no-op', async () => {
  const name = 'role_cleanup_fresh';
  const url = await createDb(name);
  process.env.DATABASE_URL = url;
  process.env.DB_MODE = 'postgres';
  const { migrate } = await import('../scripts/migrate');
  const { pool } = await import('../apps/backend/src/db');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await migrate();
    await migrate();
    assert.equal((await client.query('SELECT max(version)::int v FROM schema_migrations')).rows[0].v, 17);
    const cols = await riskColumns(client);
    assert.ok(cols.includes('escalate_deputy_days'));
    assert.equal(cols.includes('escalate_technical_days'), false);
    assert.equal((await client.query("SELECT count(*)::int n FROM pg_constraint WHERE conrelid='users'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%TECHNICAL_DIRECTOR%'")).rows[0].n, 0);
  } finally {
    await client.end();
    await pool.end();
    await dropDb(name);
  }
});
