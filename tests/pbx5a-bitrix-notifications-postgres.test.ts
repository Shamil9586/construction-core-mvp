import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { mkUser, byRole, outboxFor, activeLead, isolate, emptyCmd } from './helpers/pbx5a-fixtures';

/**
 * PBX-5A — REAL PostgreSQL evidence: migration chain 1-18, schema/index shape, duplicate-command race,
 * FOR UPDATE SKIP LOCKED (no concurrent delivery of one outbox row), tenant-scoped installation resolution
 * with the real RealBitrixAdapter over a mocked fetch (never a real portal).
 * Distributed exactly-once delivery is NOT claimed or tested.
 */
const ADMIN_URL = process.env.E2E_DATABASE_URL ?? 'postgresql://postgres:local-test-only@127.0.0.1:5432/postgres';
const DB_NAME = 'pbx5a_' + Math.random().toString(36).slice(2, 10);
const dbUrl = () => { const u = new URL(ADMIN_URL); u.pathname = '/' + DB_NAME; return u.toString(); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let admin: Client;
let ctx: any;

before(async () => {
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB_NAME} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`);
  process.env.DB_MODE = 'postgres';
  process.env.DATABASE_URL = dbUrl();
  process.env.AUTH_MODE = 'mock';
  process.env.MOCK_LOGIN_KEY = 'pbx5a-pg-key';
  process.env.TOKEN_ENCRYPTION_KEY = '22'.repeat(32);
  process.env.BITRIX_CLIENT_ID = 'client';
  process.env.BITRIX_CLIENT_SECRET = 'secret';
  process.env.BITRIX_PORTAL = 'pbx5a.bitrix24.ru';
  const { migrate } = await import('../scripts/migrate');
  const { seed } = await import('../scripts/seed');
  const db = await import('../apps/backend/src/db');
  const { ObjectTeamService } = await import('../apps/backend/src/team-service');
  const outbox = await import('../apps/backend/src/bitrix-notification-outbox');
  const bitrix = await import('../apps/backend/src/bitrix');
  await migrate();
  const tenant = await seed();
  const deputy = await byRole(tenant.id, 'DEPUTY_DIRECTOR');
  const objects = (await db.rows(db.pool, 'SELECT id FROM objects WHERE tenant_id=$1 ORDER BY external_code', [tenant.id])).map((o: any) => o.id);
  ctx = { db, svc: new ObjectTeamService(), outbox, bitrix, tenant, deputy, objects };
});
after(async () => {
  await ctx?.db.pool.end();
  await sleep(300);
  await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  await admin.end();
});
const client = async () => { const c = new Client({ connectionString: dbUrl() }); await c.connect(); return c; };

test('A migration chain is exactly 1-18 on native PostgreSQL; rerun is a no-op', async () => {
  const c = await client();
  try {
    const v = (await c.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map((r) => r.version);
    assert.deepEqual(v, Array.from({ length: 18 }, (_, i) => i + 1));
    const before = (await c.query('SELECT version, applied_at FROM schema_migrations ORDER BY version')).rows;
    await (await import('../scripts/migrate')).migrate();
    assert.deepEqual((await c.query('SELECT version, applied_at FROM schema_migrations ORDER BY version')).rows, before);
  } finally { await c.end(); }
});

test('A2 exact schema: columns, CHECKs, UNIQUEs, tenant-scoped FKs, static due index', async () => {
  const c = await client();
  try {
    const cols = (await c.query("SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name='bitrix_notification_outbox'")).rows;
    const names = cols.map((r) => r.column_name).sort();
    assert.deepEqual(names, ['attempt_count', 'bitrix_notification_id', 'bitrix_tag', 'created_at', 'delivered_at', 'delivered_bitrix_user_id', 'id', 'last_attempt_at', 'last_error_code', 'last_http_status', 'message', 'next_attempt_at', 'notification_type', 'object_id', 'recipient_user_id', 'source_assignment_id', 'status', 'tenant_id', 'updated_at', 'version'].sort());
    assert.equal(cols.find((r) => r.column_name === 'bitrix_notification_id')!.data_type, 'bigint');
    const defs = (await c.query("SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conrelid='bitrix_notification_outbox'::regclass")).rows.map((r) => r.d as string);
    for (const re of [/UNIQUE \(tenant_id, id\)/, /UNIQUE \(tenant_id, notification_type, source_assignment_id\)/, /UNIQUE \(tenant_id, bitrix_tag\)/,
      /FOREIGN KEY \(tenant_id, source_assignment_id\) REFERENCES object_function_lead_assignments\(tenant_id, id\)/,
      /FOREIGN KEY \(tenant_id, object_id\) REFERENCES objects\(tenant_id, id\)/,
      /FOREIGN KEY \(tenant_id, recipient_user_id\) REFERENCES users\(tenant_id, id\)/,
      /OBJECT_FUNCTION_LEAD_ASSIGNED/, /PENDING.*RETRY_WAIT.*DELIVERED.*PERMANENT_FAILURE/s, /attempt_count >= 0/])
      assert.ok(defs.some((d) => re.test(d)), String(re));
    const idx = (await c.query("SELECT indexdef FROM pg_indexes WHERE indexname='bitrix_notification_outbox_due_idx'")).rows[0].indexdef as string;
    assert.match(idx, /\(next_attempt_at, created_at\) WHERE \(status = ANY \(ARRAY\['PENDING'::text, 'RETRY_WAIT'::text\]\)\)/);
    assert.doesNotMatch(idx, /now\(\)|CURRENT_TIMESTAMP/i);
    // CHECKs actually bite
    const obj = ctx.objects[0];
    const head = await mkUser(ctx.tenant.id, 'Схема', 'PTO_HEAD');
    const r = await ctx.svc.assignObjectLead(ctx.deputy, obj, { leadUserId: head.id });
    const bad = async (patch: string) => { try { await c.query(`UPDATE bitrix_notification_outbox SET ${patch} WHERE source_assignment_id=$1`, [r.lead.id]); return null; } catch (e: any) { return e.code; } };
    assert.equal(await bad("message='   '"), '23514');
    assert.equal(await bad("bitrix_tag=''"), '23514');
    assert.equal(await bad('attempt_count=-1'), '23514');
    assert.equal(await bad("status='BOGUS'"), '23514');
    assert.equal(await bad("notification_type='OTHER'"), '23514');
    // the worker's due query can use the partial index (planner, forced)
    await c.query('SET enable_seqscan=off');
    const plan = (await c.query(`EXPLAIN ${ctx.outbox.DUE_ROW_SQL.replace('FOR UPDATE SKIP LOCKED', '')}`)).rows.map((x) => x['QUERY PLAN']).join('\n');
    assert.match(plan, /bitrix_notification_outbox_due_idx/);
    assert.match(ctx.outbox.DUE_ROW_SQL, /status IN \('PENDING','RETRY_WAIT'\)\s+AND next_attempt_at <= now\(\)\s+ORDER BY next_attempt_at, created_at\s+FOR UPDATE SKIP LOCKED\s+LIMIT 1/);
  } finally { await c.end(); }
});

test('D concurrent duplicate commands: one active assignment, one Core intent', async () => {
  const obj = ctx.objects[1];
  const head = await mkUser(ctx.tenant.id, 'Гонка', 'PTO_HEAD');
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => ctx.svc.assignObjectLead(ctx.deputy, obj, { leadUserId: head.id })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await ctx.db.pool.query("SELECT count(*)::int n FROM object_function_lead_assignments WHERE object_id=$1 AND ended_at IS NULL", [obj])).rows[0].n, 1);
  const rows = await outboxFor(obj);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sourceAssignmentId, (await activeLead(ctx.tenant.id, obj)).id);
  // redistribute racing assignObjectLead for the same new lead
  const obj2 = ctx.objects[2];
  const h2 = await mkUser(ctx.tenant.id, 'Гонка 2', 'PTO_HEAD');
  const mixed = await Promise.allSettled([
    ctx.svc.assignObjectLead(ctx.deputy, obj2, { leadUserId: h2.id }),
    ctx.svc.redistribute(ctx.deputy, { reason: 'r', ...emptyCmd, leadChanges: [{ objectId: obj2, leadUserId: h2.id }] }),
  ]);
  assert.equal(mixed.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await outboxFor(obj2)).length, 1);
});

test('E2 rollback of a redistribute that fails after leadChange removes assignment and intent (native)', async () => {
  const obj = ctx.objects[3];
  const head = await mkUser(ctx.tenant.id, 'Откат', 'PTO_HEAD');
  const stranger = await mkUser(ctx.tenant.id, 'Не член', 'PTO');
  const n = (await ctx.db.pool.query('SELECT count(*)::int n FROM bitrix_notification_outbox')).rows[0].n;
  await assert.rejects(ctx.svc.redistribute(ctx.deputy, { reason: 'r', ...emptyCmd, leadChanges: [{ objectId: obj, leadUserId: head.id }], memberEnds: [{ objectId: obj, memberUserId: stranger.id }] }));
  assert.equal((await ctx.db.pool.query('SELECT count(*)::int n FROM bitrix_notification_outbox')).rows[0].n, n);
  assert.equal(await activeLead(ctx.tenant.id, obj), undefined);
});

test('C2 concurrent workers never deliver the same outbox row concurrently (SKIP LOCKED)', async () => {
  const obj = ctx.objects[4];
  const head = await mkUser(ctx.tenant.id, 'Параллель', 'PTO_HEAD', '5151');
  const r = await ctx.svc.assignObjectLead(ctx.deputy, obj, { leadUserId: head.id });
  const o = (await outboxFor(obj))[0];
  await isolate(o.id);
  let inFlight = 0, maxInFlight = 0;
  const calls: any[] = [];
  const slow = { installedCall: async (tenantId: string, method: string, params: any) => { calls.push(params); inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await sleep(400); inFlight--; return 8080; } };
  const [a, b, c] = await Promise.all([ctx.outbox.deliverNextBitrixNotification(slow), ctx.outbox.deliverNextBitrixNotification(slow), ctx.outbox.deliverNextBitrixNotification(slow)]);
  assert.deepEqual([a, b, c].map((x) => x.outcome).sort(), ['DELIVERED', 'IDLE', 'IDLE']);
  assert.equal(calls.length, 1);
  assert.equal(maxInFlight, 1);
  assert.equal(calls[0].TAG, 'CC5A:' + r.lead.id);
});

test('H2 worker uses the OUTBOX tenant installation only (real adapter, mocked fetch, expired_token refresh)', async () => {
  const { pool, one, insert } = ctx.db;
  const { encrypt, decrypt } = await import('../apps/backend/src/security');
  // tenant 1 gets the installation; a neighbour tenant with the same portal pattern has different tokens
  await insert(pool, 'bitrix_installations', ctx.tenant.id, { portal: 'pbx5a.bitrix24.ru', memberId: 'demo-member', encryptedAccessToken: encrypt('T1-access'), encryptedRefreshToken: encrypt('T1-refresh'), encryptedApplicationToken: encrypt('T1-app'), expiresAt: new Date(Date.now() + 3600_000) });
  const t2 = await one(pool, "INSERT INTO tenants(portal,member_id,name) VALUES('neighbour.bitrix24.ru','nb-member-1','Сосед') RETURNING *");
  await insert(pool, 'bitrix_installations', t2.id, { portal: 'neighbour.bitrix24.ru', memberId: 'nb-member-1', encryptedAccessToken: encrypt('T2-access'), encryptedRefreshToken: encrypt('T2-refresh'), encryptedApplicationToken: encrypt('T2-app'), expiresAt: new Date(Date.now() + 3600_000) });
  const obj = ctx.objects[5];
  const head = await mkUser(ctx.tenant.id, 'Реальный адаптер', 'PTO_HEAD', '6262');
  await ctx.svc.assignObjectLead(ctx.deputy, obj, { leadUserId: head.id });
  const o = (await outboxFor(obj))[0];
  await isolate(o.id);
  const original = globalThis.fetch;
  const seen: any[] = [];
  globalThis.fetch = (async (input: any, init: any) => {
    const url = String(input);
    const body = init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : JSON.parse(init.body);
    seen.push({ url, body });
    if (url.startsWith('https://oauth.bitrix.info')) return new Response(JSON.stringify({ access_token: 'T1-access-2', refresh_token: 'T1-refresh-2', expires_in: 3600, member_id: 'demo-member' }));
    if (body.auth === 'T1-access') return new Response(JSON.stringify({ error: 'expired_token' }), { status: 401 });
    return new Response(JSON.stringify({ result: 4711 }));
  }) as any;
  try {
    const adapter = new ctx.bitrix.RealBitrixAdapter();
    assert.deepEqual(await ctx.outbox.deliverNextBitrixNotification(adapter), { outcome: 'DELIVERED', id: o.id });
    const rest = seen.filter((s) => !s.url.includes('oauth'));
    assert.deepEqual(rest.map((s) => s.url), Array(2).fill('https://pbx5a.bitrix24.ru/rest/im.notify.system.add.json'));
    assert.deepEqual(rest.map((s) => s.body.auth), ['T1-access', 'T1-access-2']);
    assert.ok(!seen.some((s) => JSON.stringify(s).includes('T2-')), 'neighbour tenant credentials never used');
    assert.deepEqual({ USER_ID: rest[1].body.USER_ID, MESSAGE: rest[1].body.MESSAGE, TAG: rest[1].body.TAG }, { USER_ID: 6262, MESSAGE: o.message, TAG: o.bitrixTag });
    assert.equal(decrypt((await one(pool, 'SELECT * FROM bitrix_installations WHERE tenant_id=$1', [ctx.tenant.id])).encryptedAccessToken), 'T1-access-2');
    assert.equal(decrypt((await one(pool, 'SELECT * FROM bitrix_installations WHERE tenant_id=$1', [t2.id])).encryptedAccessToken), 'T2-access');
    // an outbox tenant without an installation can never borrow another tenant's credentials
    const t3 = await one(pool, "INSERT INTO tenants(portal,member_id,name) VALUES('third.bitrix24.ru','t3-member-1','Третий') RETURNING *");
    seen.length = 0;
    await assert.rejects(adapter.installedCall(t3.id, 'im.notify.system.add', { USER_ID: 1, MESSAGE: 'm', TAG: 't' }));
    assert.equal(seen.length, 0);
  } finally { globalThis.fetch = original; }
});

test('H3 native tenant isolation: foreign recipient / object / source assignment are rejected by the composite FKs', async () => {
  const t2 = await ctx.db.one(ctx.db.pool, "SELECT * FROM tenants WHERE portal='neighbour.bitrix24.ru'");
  const foreign = await mkUser(t2.id, 'Чужой получатель', 'PTO_HEAD', '1');
  const src = (await outboxFor(ctx.objects[4]))[0];
  const c = await client();
  const sql = `INSERT INTO bitrix_notification_outbox(tenant_id,notification_type,source_assignment_id,object_id,recipient_user_id,message,bitrix_tag) VALUES($1,'OBJECT_FUNCTION_LEAD_ASSIGNED',$2,$3,$4,'m',$5)`;
  const code = async (args: any[]) => { await c.query('SAVEPOINT s'); try { await c.query(sql, args); await c.query('RELEASE SAVEPOINT s'); return null; } catch (e: any) { await c.query('ROLLBACK TO SAVEPOINT s'); return e.code; } };
  try {
    await c.query('BEGIN');
    await c.query('DELETE FROM bitrix_notification_outbox WHERE id=$1', [src.id]);
    assert.equal(await code([ctx.tenant.id, src.sourceAssignmentId, src.objectId, foreign.id, 'h3-a']), '23503', 'recipient of another tenant');
    assert.equal(await code([t2.id, src.sourceAssignmentId, src.objectId, foreign.id, 'h3-b']), '23503', 'object/assignment of another tenant');
    assert.equal(await code([ctx.tenant.id, src.sourceAssignmentId, src.objectId, src.recipientUserId, 'h3-c']), null, 'control: same-tenant triple is valid');
    await c.query('ROLLBACK');
  } finally { await c.end(); }
});
