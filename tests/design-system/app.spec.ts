import { test, expect, type Page } from '@playwright/test';

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
