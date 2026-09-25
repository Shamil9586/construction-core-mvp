import { test, expect, type APIRequestContext } from '@playwright/test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * F7 — build outputs and production routing.
 *
 * TEST TYPE: production-like local serving (real `npm run build` /
 * `npm run build:core` output, real Caddy running infra/Caddyfile — see
 * global-setup.ts). Raw HTTP checks read what the *server* answers before any
 * JavaScript runs, because the F5-01 class of bug is exactly a 200 at the
 * right URL with the wrong application in the body.
 */

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — run this suite through playwright.f7-prod.config.ts`);
  return value;
};

const CORE = () => env('F7_CORE_URL');
const LEGACY_ONLY = () => env('F7_LEGACY_URL');
const workspace = () => env('F7_WORKSPACE');

const CORE_ENTRY = 'id="app-root"';
const LEGACY_ENTRY = 'id="root"';

function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(dir, full).split(path.sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

async function served(request: APIRequestContext, url: string) {
  const response = await request.get(url, { maxRedirects: 0 });
  return { status: response.status(), body: await response.text(), headers: response.headers() };
}

const CORE_PATHS = [
  '/app.html',
  '/app.html/company',
  '/app.html/object/any-object-id',
  '/app.html/object/any-object-id/work/any-work-id',
  '/app.html/does-not-exist',
  '/app.html/object/any-object-id?tab=works',
];

/* --------------------------------------------------------------------- *
 * builds                                                                 *
 * --------------------------------------------------------------------- */

test.describe('build outputs', () => {
  test('npm run build (default) is still the legacy-only build: index.html and its assets, no Core, no preview', () => {
    const dir = path.join(workspace(), 'dist-legacy');
    const list = files(dir);
    expect(list).toContain('index.html');
    expect(list).not.toContain('app.html');
    expect(list).not.toContain('preview.html');
    expect(list.filter((file) => !/^assets\/index-[\w-]+\.(js|css)$/.test(file) && file !== 'index.html')).toEqual([]);

    expect(readFileSync(path.join(dir, 'index.html'), 'utf8')).toContain(LEGACY_ENTRY);
    for (const file of list.filter((name) => name.endsWith('.js'))) {
      expect(readFileSync(path.join(dir, file), 'utf8'), file).not.toContain('app-root');
    }
  });

  test('npm run build:core includes the Core entry beside the legacy one — and never preview.html', () => {
    const dir = path.join(workspace(), 'dist-core');
    const list = files(dir);
    expect(list).toEqual(expect.arrayContaining(['index.html', 'app.html']));
    expect(list).not.toContain('preview.html');
    expect(readFileSync(path.join(dir, 'index.html'), 'utf8')).toContain(LEGACY_ENTRY);
    expect(readFileSync(path.join(dir, 'app.html'), 'utf8')).toContain(CORE_ENTRY);
    for (const file of list) expect(file, 'no preview module in the Core build').not.toMatch(/preview/i);
  });

  test('npm run build:core without VITE_DATA_PROVIDER is refused before anything is written', () => {
    const refused = JSON.parse(readFileSync(path.join(workspace(), 'build-core-refused.json'), 'utf8')) as {
      status: number | null;
      output: string;
    };
    expect(refused.status).not.toBe(0);
    expect(refused.output).toContain('npm run build:core requires VITE_DATA_PROVIDER to be set explicitly to "real" or "mock"');
    expect(existsSync(path.join(workspace(), 'dist-refused', 'app.html'))).toBe(false);
  });
});

/* --------------------------------------------------------------------- *
 * serving — a build that contains Core                                  *
 * --------------------------------------------------------------------- */

test.describe('Caddy serving the Core build', () => {
  for (const corePath of CORE_PATHS) {
    test(`${corePath} is answered with the Core entry, never the legacy one`, async ({ request }) => {
      const response = await served(request, CORE() + corePath);
      expect(response.status).toBe(200);
      expect(response.body).toContain(CORE_ENTRY);
      expect(response.body).not.toContain(LEGACY_ENTRY);
    });
  }

  test('/app.html/ redirects to /app.html (Caddy canonical file URI) and so still lands on Core', async ({ request }) => {
    const response = await served(request, `${CORE()}/app.html/`);
    expect(response.status).toBe(308);
    expect(response.headers.location).toBe('/app.html');
  });

  test('legacy paths keep the legacy entry: /, /index.html and a legacy deep link', async ({ request }) => {
    for (const legacyPath of ['/', '/index.html', '/objects/any-object-id']) {
      const response = await served(request, CORE() + legacyPath);
      expect(response.status, legacyPath).toBe(200);
      expect(response.body, legacyPath).toContain(LEGACY_ENTRY);
      expect(response.body, legacyPath).not.toContain(CORE_ENTRY);
    }
  });

  test('a neighbouring path (/app.html-other) is not captured by the Core handle', async ({ request }) => {
    const response = await served(request, `${CORE()}/app.html-other`);
    expect(response.body).toContain(LEGACY_ENTRY);
    expect(response.body).not.toContain(CORE_ENTRY);
  });

  test('the design-system preview is not served in production', async ({ request }) => {
    const response = await served(request, `${CORE()}/preview.html`);
    expect(response.body).not.toContain('preview-root');
    expect(response.body).not.toContain(CORE_ENTRY);
  });

  test('Core responses carry the same security headers as legacy ones', async ({ request }) => {
    const legacy = await served(request, `${CORE()}/`);
    const core = await served(request, `${CORE()}/app.html/company`);
    expect(core.headers['content-security-policy']).toBeTruthy();
    expect(core.headers['content-security-policy']).toBe(legacy.headers['content-security-policy']);
    expect(core.headers['x-content-type-options']).toBe('nosniff');
    expect(core.headers['referrer-policy']).toBe('no-referrer');
  });

  test('/api/* still reaches the backend through the same server', async ({ request }) => {
    const response = await request.get(`${CORE()}/api/health`);
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok', authMode: 'mock' });
  });
});

/* --------------------------------------------------------------------- *
 * serving — a build WITHOUT Core (today's default production build)     *
 * --------------------------------------------------------------------- */

test.describe('Caddy serving the legacy-only build', () => {
  for (const corePath of CORE_PATHS) {
    test(`${corePath} fails explicitly (404) instead of serving the legacy app`, async ({ request }) => {
      const response = await served(request, LEGACY_ONLY() + corePath);
      expect(response.status).toBe(404);
      expect(response.body).not.toContain(LEGACY_ENTRY);
    });
  }

  test('legacy / is untouched', async ({ request }) => {
    const response = await served(request, `${LEGACY_ONLY()}/`);
    expect(response.status).toBe(200);
    expect(response.body).toContain(LEGACY_ENTRY);
  });
});

/* --------------------------------------------------------------------- *
 * legacy isolation, rendered                                             *
 * --------------------------------------------------------------------- */

test('the legacy app still renders at / beside Core, with its own sign-in', async ({ page }) => {
  await page.goto(`${CORE()}/`);
  await expect(page.getByText('Вход в тестовую среду', { exact: true })).toBeVisible();
  await expect(page.locator('#app-root')).toHaveCount(0);
});
