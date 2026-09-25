import { test, expect, type Page, type Route } from '@playwright/test';
import { demoInspections, demoObjects, demoWorks } from '../../apps/frontend/src/screens/demo/fixtures';

/**
 * F6-02 — automated browser regression (Work re-review, three passes).
 *
 * This is a *persistent, automated* regression for the defects the review
 * reproduced:
 *   - a structurally valid internal Snapshot whose work records carry a
 *     corrupted `blockers` field (missing, or `null`) reaching `Ready` and
 *     crashing at render — `workStatusPresentation()` (view-models/status.ts)
 *     reads `work.blockers.length`, and every one of C01/O01/W01 calls it;
 *   - an object record whose `customerName`/`organizationName` is a truthy
 *     non-string (`{}`) — `o01.ts` reads it through `?? NO_DATA_DASH`, which
 *     only replaces `null`/`undefined`, so the object passes straight
 *     through into `O01Details` and `screens/O01/index.tsx` renders it
 *     directly as a JSX child.
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
  // F7: the real data source now validates the tab's session through the
  // existing GET /api/me before it loads any data (app/SessionGate.tsx), so
  // that request is intercepted too — with an internal-role actor, so every
  // assertion below still exercises the F6 snapshot path it was written for.
  await page.route('**/api/me', (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'f6-actor', tenantId: 'f6-tenant', name: 'F6 Regression', role: 'GENERAL_DIRECTOR' }),
    }),
  );
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

test('F6-02 (third pass): an object with customerName: {} renders RouteError on O01, not a crash or fixtures', async ({ page }) => {
  await seedSession(page);
  const corruptedObject = { ...demoObjects[0], customerName: {} };
  await interceptSnapshot(page, { ...VALID_SNAPSHOT, objects: [corruptedObject, ...demoObjects.slice(1)] });

  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  // demoObjects[0].id — navigating O01's own route directly, since the
  // review's reproduction was specifically O01 rendering customerName as a
  // JSX child (screens/O01/index.tsx). Validation runs once, upstream of
  // every route (SnapshotContext), so the rejection is the same guard
  // C01 already exercises above — this proves the O01 rendering path this
  // field actually reaches is covered too, not a second, different guard.
  await page.goto('/app.html/object/demo-object-1');

  await expect(
    page.getByText('Не удалось загрузить данные: Неверный ответ сервера: искажённый снимок данных.'),
  ).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: demoObjects[0].name })).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});
