import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, expect, type Page, type Request } from '@playwright/test';
import { createIsolatedDatabase, recordEvidence, scrubConnectionEnvironment } from './helpers/gpr2-native-pg';

/**
 * R05 D5 pilot: real Chromium → Vite proxy → Nest → disposable native PostgreSQL.
 * No page.route(), synthetic API responses, corporate templates or production credentials.
 * The profile runner provisions PostgreSQL and Chromium; this file refuses to run without
 * the existing loopback/cluster-name guard and creates one fresh database of its own.
 */
scrubConnectionEnvironment();

test('S2 → S3 → S4 real-backend pilot and authorization/version/idempotency fences', { timeout: 300_000 }, async () => {
  const db = await createIsolatedDatabase('r05pilot');
  process.env.DATABASE_URL = db.url;
  process.env.AUTH_MODE = 'mock';
  process.env.MOCK_LOGIN_KEY = randomUUID();
  process.env.GPR2_CONTRACT_ROUTES = 'enabled';
  process.env.VITE_DATA_PROVIDER = 'real';
  delete process.env.NODE_ENV;

  let api: Awaited<ReturnType<typeof import('../apps/backend/src/main').createApp>> | undefined;
  let web: Awaited<ReturnType<typeof import('vite').createServer>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let pool: (typeof import('../apps/backend/src/db'))['pool'] | undefined;
  let page: Page | undefined;
  const trace: Array<{ method: string; path: string; status?: number }> = [];
  try {
    const { migrate } = await import('../scripts/migrate');
    const { seed } = await import('../scripts/seed');
    ({ pool } = await import('../apps/backend/src/db'));
    await migrate();
    await seed();

    const { createApp } = await import('../apps/backend/src/main');
    api = await createApp();
    await api.listen(0, '127.0.0.1');
    const apiBase = `http://127.0.0.1:${(api.getHttpServer().address() as { port: number }).port}`;
    const { createServer } = await import('vite');
    web = await createServer({
      configFile: 'apps/frontend/vite.config.ts',
      server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: apiBase, rewrite: p => p.replace(/^\/api/, '') } } },
    });
    await web.listen();
    const origin = web.resolvedUrls?.local[0];
    assert.ok(origin?.startsWith('http://127.0.0.1:'), 'Vite must bind only to loopback');

    const login = async (role: string): Promise<string> => {
      const r = await fetch(`${apiBase}/auth/mock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role, key: process.env.MOCK_LOGIN_KEY }) });
      assert.equal(r.status, 201, `mock login ${role}`);
      const body = await r.json() as { token: string };
      assert.ok(body.token);
      return body.token;
    };
    const pmToken = await login('PROJECT_MANAGER');
    const ptoToken = await login('PTO');
    const as = async (token: string, path: string, body?: unknown, key?: string) => {
      // The browser uses Vite's /api prefix; Nest itself is mounted at /v2.
      const r = await fetch(`${apiBase}${path.replace(/^\/api(?=\/)/, '')}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, data: await r.json() as any };
    };
    const owner = await as(pmToken, '/me');
    assert.equal(owner.status, 200);
    const objects = (await pool.query('SELECT id, name, project_manager_id FROM objects ORDER BY external_code')).rows as Array<{ id: string; name: string; project_manager_id: string }>;
    const object = objects.find(o => o.project_manager_id === owner.data.id);
    const other = objects.find(o => o.project_manager_id !== owner.data.id);
    assert.ok(object && other, 'seed must supply owned and foreign objects');
    const o = object.id;
    const areaPath = `/api/v2/objects/${o}/area-scopes`;
    const systemPath = `/api/v2/objects/${o}/finish-systems`;
    const worksBefore = Number((await pool.query('SELECT count(*)::int AS n FROM works WHERE object_id=$1', [o])).rows[0].n);

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ru-RU' });
    await context.addInitScript(token => sessionStorage.setItem('session', token), pmToken);
    page = await context.newPage();
    const requested: Array<{ method: string; path: string; body: string | null; key?: string }> = [];
    page.on('request', (r: Request) => {
      const path = new URL(r.url()).pathname;
      if (path.startsWith('/api/v2/')) requested.push({ method: r.method(), path, body: r.postData(), key: r.headers()['idempotency-key'] });
    });
    page.on('response', r => {
      const path = new URL(r.url()).pathname;
      if (path.startsWith('/api/v2/')) trace.push({ method: r.request().method(), path, status: r.status() });
    });

    // S2: create a measured root and a child through the actual object route.
    await page.goto(`${origin}app.html/object/${o}/finish/areas`);
    await expect(page.getByRole('heading', { level: 1, name: 'Зоны объекта' })).toBeVisible();
    await page.getByLabel('Код', { exact: true }).fill('PILOT-ROOT');
    await page.getByLabel('Название', { exact: true }).fill('Пилотный корпус');
    await page.getByLabel('Количество (необязательно)').fill('20');
    await page.getByLabel('Единица (необязательно)').selectOption('м²');
    await page.getByRole('button', { name: 'Создать зону' }).click();
    await expect(page.getByRole('list', { name: 'Зоны объекта' })).toContainText('Пилотный корпус');
    await page.getByRole('button', { name: 'Добавить зону внутрь: PILOT-ROOT Пилотный корпус' }).click();
    await page.getByLabel('Код', { exact: true }).fill('PILOT-CHILD');
    await page.getByLabel('Название', { exact: true }).fill('Пилотная зона');
    await page.getByLabel('Количество (необязательно)').fill('10');
    await page.getByLabel('Единица (необязательно)').selectOption('м²');
    await page.getByRole('button', { name: 'Создать зону' }).click();
    await expect(page.getByRole('list', { name: 'Вложенные зоны: PILOT-ROOT' })).toContainText('Пилотная зона');
    const areas = await as(pmToken, areaPath);
    assert.equal(areas.status, 200);
    const child = areas.data.items.find((a: any) => a.code === 'PILOT-CHILD');
    const root = areas.data.items.find((a: any) => a.code === 'PILOT-ROOT');
    assert.equal(child.parentId, root.id);
    assert.equal(child.measureQuantity, '10.0000');

    // S3: publish one object-local system with a required MAIN stage, no template.
    await page.goto(`${origin}app.html/object/${o}/finish/systems`);
    await expect(page.getByRole('heading', { name: 'Новая опубликованная версия системы' })).toBeVisible();
    const workType = page.getByLabel('Вид работы');
    await expect(workType.locator('option')).not.toHaveCount(1);
    const typeId = await workType.locator('option').evaluateAll(options => (options as HTMLOptionElement[]).find(x => x.textContent?.includes('Штукатурка стен'))?.value);
    assert.ok(typeId, 'seeded m² WorkType visible through real Q1');
    await page.getByLabel('Код', { exact: true }).fill('PILOT-FINISH');
    await page.getByLabel('Название', { exact: true }).fill('Пилотная отделка');
    await page.getByLabel('Ключ этапа').fill('PLASTER');
    await workType.selectOption(typeId);
    await page.getByRole('button', { name: 'Опубликовать версию' }).click();
    const card = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Пилотная отделка' }) });
    await expect(card.getByRole('heading', { name: 'Генерация работ · версия 1' })).toBeVisible();
    const systems = await as(pmToken, systemPath);
    assert.equal(systems.status, 200);
    const system = systems.data.items.find((s: any) => s.code === 'PILOT-FINISH');
    assert.ok(system?.currentVersion?.id);
    assert.equal(system.currentVersion.stages[0].occurrenceKey, 'PLASTER');
    assert.equal(system.currentVersion.sourceTemplateVersionId ?? null, null);

    // S4: preview is no-write; confirm persists a Work and links to W01.
    const panel = card.getByRole('heading', { name: 'Генерация работ · версия 1' }).locator('..');
    await panel.getByLabel(/PILOT-CHILD/).check();
    await panel.getByRole('button', { name: 'Предварительный расчёт' }).click();
    await expect(panel.getByText(/Будет создана/)).toBeVisible();
    const previewRequest = requested.filter(r => r.path.endsWith('/preview')).at(-1);
    assert.ok(previewRequest?.body);
    const previewResponse = await as(pmToken, `${systemPath}/${system.id}/preview`, JSON.parse(previewRequest.body));
    assert.equal(previewResponse.status, 200);
    assert.equal(previewResponse.data.preview.canConfirm, true);
    assert.match(previewResponse.data.preview.previewFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(previewResponse.data.preview.items[0].status, 'PROPOSED');
    assert.equal(Number((await pool.query('SELECT count(*)::int AS n FROM works WHERE object_id=$1', [o])).rows[0].n), worksBefore);

    // Invalid fingerprint is rejected before any write; no hidden retry or new Work.
    const selection = JSON.parse(previewRequest.body).payload;
    const stale = await as(pmToken, `${systemPath}/${system.id}/confirm`, {
      expectedVersion: system.version, expectedScopeVersion: previewResponse.data.preview.scopeVersion,
      payload: { ...selection, previewFingerprint: '0'.repeat(64), expectedSourceVersions: { systemVersion: selection.systemVersionId } },
    }, randomUUID());
    assert.ok([409, 422].includes(stale.status), `bad fingerprint must fail closed: ${stale.status}`);
    assert.equal(Number((await pool.query('SELECT count(*)::int AS n FROM works WHERE object_id=$1', [o])).rows[0].n), worksBefore);

    await panel.getByRole('button', { name: 'Создать работы по этому расчёту' }).click();
    await expect(panel.getByText('Создано работ: 1')).toBeVisible();
    const confirmRequest = requested.filter(r => r.path.endsWith('/confirm')).at(-1);
    assert.ok(confirmRequest?.body && confirmRequest.key);
    const confirmed = await as(pmToken, confirmRequest.path, JSON.parse(confirmRequest.body), confirmRequest.key);
    assert.ok(confirmed.status < 300, `same-key replay: ${confirmed.status}`);
    assert.equal(confirmed.data.resultIds.length, 1);
    const workId = confirmed.data.resultIds[0];
    assert.equal(Number((await pool.query('SELECT count(*)::int AS n FROM works WHERE object_id=$1', [o])).rows[0].n), worksBefore + 1);
    const persisted = (await pool.query('SELECT id, object_id, contractor_id, responsible_user_id FROM works WHERE id=$1', [workId])).rows[0];
    assert.equal(persisted.object_id, o);
    assert.equal(persisted.contractor_id, null);
    assert.equal(persisted.responsible_user_id, null);
    await panel.getByRole('button', { name: `Открыть работу ${workId}` }).click();
    await expect(page).toHaveURL(new RegExp(`/object/${o}/work/${workId}$`));
    await expect(page.locator('main')).toContainText('Штукатурка');
    await page.goto(`${origin}app.html/object/${o}`);
    await expect(page.locator('main')).toContainText('Штукатурка');

    // A fresh UI preview sees the persisted producer and cannot create it again.
    await page.goto(`${origin}app.html/object/${o}/finish/systems`);
    const again = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Пилотная отделка' }) });
    const againPanel = again.getByRole('heading', { name: 'Генерация работ · версия 1' }).locator('..');
    await againPanel.getByLabel(/PILOT-CHILD/).check();
    await againPanel.getByRole('button', { name: 'Предварительный расчёт' }).click();
    await expect(againPanel.getByText(/Уже существует/)).toBeVisible();
    await expect(againPanel.getByRole('button', { name: 'Создать работы по этому расчёту' })).toHaveCount(0);

    // Real backend role and object fences, plus a browser direct-route presentation gate.
    const deniedRole = await as(ptoToken, areaPath);
    assert.equal(deniedRole.status, 403);
    const deniedObject = await as(pmToken, `/api/v2/objects/${other.id}/area-scopes`);
    assert.equal(deniedObject.status, 404);
    const deniedConfirm = await as(ptoToken, `${systemPath}/${system.id}/confirm`, JSON.parse(confirmRequest.body), randomUUID());
    assert.equal(deniedConfirm.status, 403);
    const ptoContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ptoContext.addInitScript(token => sessionStorage.setItem('session', token), ptoToken);
    const ptoPage = await ptoContext.newPage();
    const ptoV2: string[] = [];
    ptoPage.on('request', r => { if (new URL(r.url()).pathname.startsWith('/api/v2/')) ptoV2.push(r.url()); });
    await ptoPage.goto(`${origin}app.html/object/${o}/finish/systems`);
    await expect(ptoPage.getByText('Раздел «Системы отделки» доступен руководителю проекта.')).toBeVisible();
    assert.deepEqual(ptoV2, []);
    await ptoContext.close();

    assert.ok(requested.length > 0);
    assert.ok(requested.every(r => r.path.startsWith(`/api/v2/objects/${o}/`)), 'browser R05 requests stay on selected object');
    assert.ok(trace.every(r => r.status === undefined || r.status < 400), 'positive browser path has no failing R05 response');
    recordEvidence('r05-s2-s3-s4-pilot', {
      database: db.name, cluster: db.evidence, source: 'real Chromium → Vite → Nest → native PostgreSQL',
      objectId: o, otherObjectId: other.id, areaScopeIds: [root.id, child.id], finishSystemId: system.id,
      systemVersionId: system.currentVersion.id, workId, workCountBefore: worksBefore, workCountAfter: worksBefore + 1,
      staleFingerprintStatus: stale.status, deniedRoleStatus: deniedRole.status, deniedObjectStatus: deniedObject.status,
      requests: trace, productionCredentialsUsed: false,
    });
    await context.close();
  } catch (error) {
    const dir = process.env.GPR2_EVIDENCE_DIR;
    if (dir && page && !page.isClosed()) {
      fs.mkdirSync(dir, { recursive: true });
      await page.screenshot({ path: path.join(dir, 'r05-pilot-failure.png'), fullPage: true }).catch(() => undefined);
    }
    throw error;
  } finally {
    await browser?.close().catch(() => undefined);
    await web?.close().catch(() => undefined);
    await api?.close().catch(() => undefined);
    await pool?.end().catch(() => undefined);
    await db.drop();
    delete process.env.DATABASE_URL;
  }
});
