import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EscalationService, defaultRisk } from '../packages/domain';

/**
 * ROLE-CLEANUP-R01 — the escalation tier is addressed to DEPUTY_DIRECTOR and
 * named escalateDeputyDays everywhere (domain, settings API, DB column).
 */
test('domain: defaultRisk/EscalationService use escalateDeputyDays; thresholds and behaviour unchanged', () => {
  assert.equal((defaultRisk as any).escalateDeputyDays, 3);
  assert.equal(defaultRisk.escalateDirectorDays, 7);
  assert.equal('escalateTechnicalDays' in defaultRisk, false);
  const s = new EscalationService();
  assert.equal(s.recipient(1), 'PROJECT_MANAGER');
  assert.equal(s.recipient(2), 'PROJECT_MANAGER');
  assert.equal(s.recipient(3), 'DEPUTY_DIRECTOR');
  assert.equal(s.recipient(6), 'DEPUTY_DIRECTOR');
  assert.equal(s.recipient(7), 'GENERAL_DIRECTOR');
  assert.equal(s.recipient(5, { ...defaultRisk, escalateDeputyDays: 5, escalateDirectorDays: 9 }), 'DEPUTY_DIRECTOR');
  assert.equal(s.recipient(4, { ...defaultRisk, escalateDeputyDays: 5, escalateDirectorDays: 9 }), 'PROJECT_MANAGER');
});

test('settings API: POST /settings/risk accepts escalateDeputyDays, rejects escalateTechnicalDays, enforces director > deputy; DB column is escalate_deputy_days', async () => {
  if (!process.env.E2E_DATABASE_URL) delete process.env.DATABASE_URL;
  process.env.AUTH_MODE = 'mock';
  process.env.MOCK_LOGIN_KEY = 'risk-key';
  process.env.DB_MODE = process.env.E2E_DATABASE_URL ? 'postgres' : 'pglite';
  process.env.PGLITE_DIR = 'memory://';
  if (process.env.E2E_DATABASE_URL) process.env.DATABASE_URL = process.env.E2E_DATABASE_URL;
  const { migrate } = await import('../scripts/migrate');
  const { seed } = await import('../scripts/seed');
  const { createApp } = await import('../apps/backend/src/main');
  const { pool, one } = await import('../apps/backend/src/db');
  await migrate();
  await seed();
  const app = await createApp();
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as any).port}`;
  try {
    const call = async (path: string, token: string, body?: any) => {
      const r = await fetch(base + '/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, data: (await r.json().catch(() => null)) as any };
    };
    const login = async (role: string) => (await call('auth/mock', '', { role, key: 'risk-key' })).data.token as string;
    const admin = await login('ADMIN');
    const cols = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='risk_settings'")).rows.map((r: any) => r.column_name);
    assert.ok(cols.includes('escalate_deputy_days'));
    assert.equal(cols.includes('escalate_technical_days'), false);
    const row = await one(pool, 'SELECT * FROM risk_settings LIMIT 1');
    const body = { yellowVariance: -5, redVariance: -15, staleDays: 7, ptoDays: 5, sdoDays: 10, escalateDeputyDays: 4, escalateDirectorDays: 8, version: row.version };
    const ok = await call('settings/risk', admin, body);
    assert.ok(ok.status < 300, JSON.stringify(ok.data));
    assert.equal((await one(pool, 'SELECT escalate_deputy_days AS d, escalate_director_days AS g FROM risk_settings LIMIT 1')).d, 4);
    const { escalateDeputyDays, ...rest } = body;
    assert.equal((await call('settings/risk', admin, { ...rest, escalateTechnicalDays: 4, version: row.version + 1 })).status, 400, 'old field rejected');
    assert.equal((await call('settings/risk', admin, { ...body, escalateDeputyDays: 9, escalateDirectorDays: 9, version: row.version + 1 })).status, 400, 'director must exceed deputy');
    assert.equal((await call('settings/risk', await login('PROJECT_MANAGER'), body)).status, 403);
  } finally {
    await app.close();
  }
});
