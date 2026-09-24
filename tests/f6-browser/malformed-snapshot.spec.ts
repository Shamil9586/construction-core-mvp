import { test, expect, type Page, type Route } from '@playwright/test';
import { demoInspections, demoObjects, demoWorks } from '../../apps/frontend/src/screens/demo/fixtures';

/**
 * F6-02 — automated browser regression (Work re-review, second pass).
 *
 * This is a *persistent, automated* regression for the exact defect the
 * review reproduced: a structurally valid internal Snapshot whose work
 * records carry a corrupted `blockers` field (missing, or `null`) reaching
 * `Ready` and crashing at render — `workStatusPresentation()`
 * (view-models/status.ts) reads `work.blockers.length`, and every one of
 * C01/O01/W01 calls it.
 *
 * This config (playwright.f6.config.ts) starts the real Vite dev server with
 * `VITE_DATA_PROVIDER=real`, so `App.tsx` actually selects `realDataProvider`
 * — the real, unmodified `getSnapshot()`/`validateSnapshot()` code runs.
 * `GET /api/snapshot` is intercepted with `page.route()` — a real HTTP
 * response is produced for that one request, not a page-script `fetch`
 * monkey-patch — but there is no real backend behind it. This is explicitly
 * an intercepted-response test, not a backend/database end-to-end test; the
 * manual run in the F6 corrective handoff, against a seeded local Postgres
 * backend, is the closest this project has to that, and is not automated.
 */

const VALID_SNAPSHOT = {
  objects: demoObjects,
  works: demoWorks,
  contractors: [],
  dependencies: [],
  inspections: demoInspections,
};

async function seedSession(page: Page): Promise<void> {
  // realDataProvider only reads sessionStorage['session']; the intercepted
  // /api/snapshot route below responds regardless of the Authorization
  // header it carries, but a real token is seeded anyway to match the real
  // same-tab, same-origin flow this provider is built around.
  await page.addInitScript(() => {
    window.sessionStorage.setItem('session', 'f6-browser-regression-token');
  });
}

async function interceptSnapshot(page: Page, body: unknown): Promise<void> {
  await page.route('**/api/snapshot', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }),
  );
}

test('sanity: a valid intercepted snapshot renders C01 normally under the real-provider config', async ({ page }) => {
  await seedSession(page);
  await interceptSnapshot(page, VALID_SNAPSHOT);

  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto('/app.html/company');

  await expect(page.getByRole('heading', { level: 1, name: 'Портфель объектов' })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('a work record with blockers missing entirely renders RouteError, not a crash or fixtures', async ({ page }) => {
  await seedSession(page);
  const { blockers, ...corruptedWork } = demoWorks[0];
  await interceptSnapshot(page, { ...VALID_SNAPSHOT, works: [corruptedWork, ...demoWorks.slice(1)] });

  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto('/app.html/company');

  await expect(
    page.getByText('Не удалось загрузить данные: Неверный ответ сервера: искажённый снимок данных.'),
  ).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Портфель объектов' })).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test('a work record with blockers: null renders RouteError, not a crash or fixtures', async ({ page }) => {
  await seedSession(page);
  const corruptedWork = { ...demoWorks[0], blockers: null };
  await interceptSnapshot(page, { ...VALID_SNAPSHOT, works: [corruptedWork, ...demoWorks.slice(1)] });

  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto('/app.html/company');

  await expect(
    page.getByText('Не удалось загрузить данные: Неверный ответ сервера: искажённый снимок данных.'),
  ).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Портфель объектов' })).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});
