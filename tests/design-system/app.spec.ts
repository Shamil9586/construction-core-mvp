import { test, expect, type Page, type Response } from '@playwright/test';

/**
 * F5 — application composition: routing, shell integration and screen
 * composition, driven end to end against the real running app (`app.html`,
 * `mockDataProvider`, real react-router navigation) rather than the isolated
 * preview. Same webServer as the other design-system specs — no backend, no
 * database — since F5 explicitly does not connect a production backend yet.
 *
 * Data-boundary coverage that does not need a browser (the provider's shape,
 * route path builders) lives in tests/app-data-boundary.test.ts instead.
 */

const APP = '/app.html';

/**
 * Reads the raw HTML a navigation actually received — the F5-01 regression
 * (Work review) is that a direct open/reload of an /app.html/... deep path
 * got HTTP 200 at the right URL while the *response body* was the legacy
 * entry (`/src/main.tsx`), not app.html's (`/src/app/main.tsx`). Status code
 * and the address bar alone cannot see that; this reads the served markup
 * itself, before any client-side JS runs.
 */
async function servedEntryScripts(response: Response | null): Promise<string> {
  expect(response).not.toBeNull();
  expect(response!.status()).toBe(200);
  return response!.text();
}

test.beforeEach(async ({ page }: { page: Page }) => {
  await page.goto(APP);
});

test.describe('Application shell + routing foundation', () => {
  test('loading the app redirects to /company and renders C01', async ({ page }) => {
    await expect(page).toHaveURL(/\/app\.html\/company$/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Портфель объектов' }),
    ).toBeVisible();
  });

  test('renders exactly one AppShell aside and main', async ({ page }) => {
    await expect(page.locator('aside')).toHaveCount(1);
    await expect(page.locator('main')).toHaveCount(1);
  });

  test('the sidebar shows the one section this app routes, current by default', async ({
    page,
  }) => {
    const item = page
      .getByRole('navigation', { name: 'Основная навигация' })
      .getByRole('button', { name: 'Портфель' });
    await expect(item).toHaveAttribute('aria-current', 'page');
  });

  test('an unmatched path renders a not-found message, not a crash', async ({ page }) => {
    await page.evaluate(() => {
      window.history.pushState({}, '', '/app.html/does-not-exist');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.getByText('Страница не найдена', { exact: true })).toBeVisible();
    // The shell — and its navigation — stays mounted even on a not-found route.
    await expect(page.getByRole('navigation', { name: 'Основная навигация' })).toBeVisible();
  });
});

test.describe('C01 → O01 → W01, real client-side navigation', () => {
  test('activating a portfolio object navigates to /object/:objectId and renders O01', async ({
    page,
  }) => {
    await page.getByRole('button', { name: 'Жилой комплекс «Полесье»' }).click();
    await expect(page).toHaveURL(/\/object\/demo-object-1$/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Жилой комплекс «Полесье»' }),
    ).toBeVisible();
  });

  test('activating a work navigates to /object/:objectId/work/:workId and renders W01', async ({
    page,
  }) => {
    await page.getByRole('button', { name: 'Жилой комплекс «Полесье»' }).click();
    await page
      .getByRole('table', { name: /Работы объекта/ })
      .getByRole('button', { name: 'Отделка фасада' })
      .click();

    await expect(page).toHaveURL(/\/object\/demo-object-1\/work\/demo-work-1-1$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Отделка фасада' })).toBeVisible();
  });

  test('W01 breadcrumb goes back to the object, then to the portfolio, by real URL', async ({
    page,
  }) => {
    await page.getByRole('button', { name: 'Жилой комплекс «Полесье»' }).click();
    await page
      .getByRole('table', { name: /Работы объекта/ })
      .getByRole('button', { name: 'Отделка фасада' })
      .click();

    await page
      .getByRole('navigation', { name: 'Хлебные крошки' })
      .getByRole('button', { name: 'Жилой комплекс «Полесье»' })
      .click();
    await expect(page).toHaveURL(/\/object\/demo-object-1$/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Жилой комплекс «Полесье»' }),
    ).toBeVisible();

    await page
      .getByRole('navigation', { name: 'Хлебные крошки' })
      .getByRole('button', { name: 'Портфель' })
      .click();
    await expect(page).toHaveURL(/\/company$/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Портфель объектов' }),
    ).toBeVisible();
  });

  test('the sidebar navigates back to /company from a nested route, and stays current', async ({
    page,
  }) => {
    await page.getByRole('button', { name: 'Жилой комплекс «Полесье»' }).click();
    await expect(page).toHaveURL(/\/object\/demo-object-1$/);

    const item = page
      .getByRole('navigation', { name: 'Основная навигация' })
      .getByRole('button', { name: 'Портфель' });
    await expect(item).toHaveAttribute('aria-current', 'page');

    await item.click();
    await expect(page).toHaveURL(/\/company$/);
  });

  test('an object id absent from the snapshot renders a not-found message', async ({ page }) => {
    await page.evaluate(() => {
      window.history.pushState({}, '', '/app.html/object/does-not-exist');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.getByText('Объект не найден', { exact: true })).toBeVisible();
  });

  test('a work id that exists but under the wrong object is treated as not found', async ({
    page,
  }) => {
    // demo-work-2-1 is real, but belongs to demo-object-2, not demo-object-1.
    await page.evaluate(() => {
      window.history.pushState({}, '', '/app.html/object/demo-object-1/work/demo-work-2-1');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.getByText('Работа не найдена', { exact: true })).toBeVisible();
  });
});

test.describe('Data boundary — the application renders the same typed demo data as the preview', () => {
  test('the portfolio lists every mock object with its physical readiness', async ({ page }) => {
    await expect(
      page.getByRole('button', { name: 'Жилой комплекс «Полесье»' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Бизнес-центр «Горизонт»' }),
    ).toBeVisible();
    await expect(page.getByText('62%', { exact: true })).toBeVisible();
  });
});

/**
 * F5-01 (Work review corrective) — direct open and reload.
 *
 * `BrowserRouter basename="/app.html"` only tells the *client* which URL
 * segment is its own root; it has no way to make the *dev server* answer a
 * fresh GET for `/app.html/company` (or any deeper path) with app.html
 * instead of Vite's default SPA fallback (`index.html`, the legacy app).
 * Every case below is a real navigation against the actual Vite dev server —
 * never `history.pushState`, route interception, or a mocked HTML response —
 * because the bug this reproduces is specifically about what the *server*
 * answers before any client-side router runs.
 */
const DIRECT_OPEN_CASES: Array<{ label: string; path: string; heading: string }> = [
  { label: 'C01', path: '/app.html/company', heading: 'Портфель объектов' },
  { label: 'O01', path: '/app.html/object/demo-object-1', heading: 'Жилой комплекс «Полесье»' },
  {
    label: 'W01',
    path: '/app.html/object/demo-object-1/work/demo-work-1-1',
    heading: 'Отделка фасада',
  },
];

test.describe('F5-01 — direct open and reload serve the F5 entry, never the legacy one', () => {
  for (const { label, path, heading } of DIRECT_OPEN_CASES) {
    test(`${label}: direct open serves /src/app/main.tsx and renders the correct screen`, async ({
      page,
    }) => {
      const response = await page.goto(path);
      const body = await servedEntryScripts(response);

      expect(body).toContain('src="/src/app/main.tsx"');
      expect(body).not.toContain('src="/src/main.tsx"');
      expect(page.url()).toContain(path);

      await expect(page.locator('aside')).toHaveCount(1);
      await expect(page.locator('main')).toHaveCount(1);
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    });

    test(`${label}: reload serves /src/app/main.tsx again and keeps the same screen`, async ({
      page,
    }) => {
      await page.goto(path);

      const response = await page.reload();
      const body = await servedEntryScripts(response);

      expect(body).toContain('src="/src/app/main.tsx"');
      expect(body).not.toContain('src="/src/main.tsx"');
      expect(page.url()).toContain(path);

      await expect(page.locator('aside')).toHaveCount(1);
      await expect(page.locator('main')).toHaveCount(1);
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    });
  }

  test('a query string on a direct-opened nested F5 URL survives the dev-serving rewrite', async ({
    page,
  }) => {
    const response = await page.goto('/app.html/object/demo-object-1?debug=1');
    const body = await servedEntryScripts(response);

    expect(body).toContain('src="/src/app/main.tsx"');
    expect(page.url()).toContain('debug=1');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Жилой комплекс «Полесье»' }),
    ).toBeVisible();
  });
});

test.describe('F5-01 — direct open of not-found routes/entities lands in an F5 state, never legacy', () => {
  test('an unknown F5 route, opened directly', async ({ page }) => {
    const response = await page.goto('/app.html/does-not-exist');
    const body = await servedEntryScripts(response);

    expect(body).toContain('src="/src/app/main.tsx"');
    await expect(page.getByText('Страница не найдена', { exact: true })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Основная навигация' })).toBeVisible();
  });

  test('an unknown objectId, opened directly', async ({ page }) => {
    const response = await page.goto('/app.html/object/does-not-exist');
    const body = await servedEntryScripts(response);

    expect(body).toContain('src="/src/app/main.tsx"');
    await expect(page.getByText('Объект не найден', { exact: true })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Основная навигация' })).toBeVisible();
  });

  test('an unknown workId under a real object, opened directly', async ({ page }) => {
    const response = await page.goto('/app.html/object/demo-object-1/work/does-not-exist');
    const body = await servedEntryScripts(response);

    expect(body).toContain('src="/src/app/main.tsx"');
    await expect(page.getByText('Работа не найдена', { exact: true })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Основная навигация' })).toBeVisible();
  });

  test('a real work id under the wrong object id, opened directly, never shows the foreign work', async ({
    page,
  }) => {
    // demo-work-2-1 is real, but belongs to demo-object-2, not demo-object-1.
    const response = await page.goto('/app.html/object/demo-object-1/work/demo-work-2-1');
    const body = await servedEntryScripts(response);

    expect(body).toContain('src="/src/app/main.tsx"');
    await expect(page.getByText('Работа не найдена', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Монтаж каркаса' })).toHaveCount(0);
  });
});

test.describe('F5-01 — HTML entry isolation: legacy, preview and F5 boundaries stay intact', () => {
  test('/ still serves the legacy entry', async ({ page }) => {
    const response = await page.goto('/');
    const body = await servedEntryScripts(response);

    expect(body).toContain('src="/src/main.tsx"');
    expect(body).not.toContain('src="/src/app/main.tsx"');
    await expect(page.getByText('Вход в тестовую среду', { exact: true })).toBeVisible();
  });

  test('/index.html still serves the legacy entry', async ({ page }) => {
    const response = await page.goto('/index.html');
    const body = await servedEntryScripts(response);

    expect(body).toContain('src="/src/main.tsx"');
    expect(body).not.toContain('src="/src/app/main.tsx"');
  });

  test('/preview.html still serves the preview entry, untouched by the F5 dev middleware', async ({
    page,
  }) => {
    const response = await page.goto('/preview.html');
    const body = await servedEntryScripts(response);

    expect(body).toContain('src="/src/preview/main.tsx"');
    expect(body).not.toContain('src="/src/app/main.tsx"');
    await expect(page.getByRole('heading', { name: 'Design System — F1' })).toBeVisible();
  });

  test('/app.html still serves the F5 entry directly and redirects to /company', async ({
    page,
  }) => {
    const response = await page.goto('/app.html');
    const body = await servedEntryScripts(response);

    expect(body).toContain('src="/src/app/main.tsx"');
    await expect(page).toHaveURL(/\/app\.html\/company$/);
  });

  test('a neighbouring prefix (/app.html-other) is not captured by the F5 dev middleware', async ({
    page,
  }) => {
    const response = await page.goto('/app.html-other');
    const body = await servedEntryScripts(response);

    expect(body).not.toContain('src="/src/app/main.tsx"');
  });
});
