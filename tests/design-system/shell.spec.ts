import { test, expect, type Page, type Locator } from '@playwright/test';

/**
 * Navigation-layer checks: AppShell, Sidebar, Breadcrumb, PageHeader.
 *
 * Run against the same isolated preview page as the other design-system specs,
 * with the legacy stylesheet loaded after the design system — the harder
 * ordering. Legacy styles bare `aside`, `header`, `main` (fixed width/height,
 * hardcoded padding, `position: fixed`) and, at its 760px breakpoint, a bare
 * `nav` too. Every property those rules touch is asserted here against the
 * token value, not merely against "not the legacy value", so a leak shows up as
 * a wrong number rather than as an accident that happens to look fine.
 */

const PREVIEW = '/preview.html';

async function style(target: Locator, property: string): Promise<string> {
  return target.evaluate(
    (node, prop) => getComputedStyle(node as Element).getPropertyValue(prop),
    property,
  );
}

function shellSection(page: Page): Locator {
  return page.locator('[data-section="app-shell"]');
}

function sidebarNav(page: Page): Locator {
  return shellSection(page).getByRole('navigation', { name: 'Основная навигация' });
}

function breadcrumbNav(page: Page): Locator {
  return shellSection(page).getByRole('navigation', { name: 'Хлебные крошки' });
}

test.beforeEach(async ({ page }: { page: Page }) => {
  await page.goto(PREVIEW);
  await expect(page.getByRole('heading', { name: 'Design System — F1' })).toBeVisible();
});

test.describe('AppShell landmarks', () => {
  test('renders exactly one aside, header and main', async ({ page }) => {
    const section = shellSection(page);
    await expect(section.locator('aside')).toHaveCount(1);
    await expect(section.locator('header')).toHaveCount(1);
    await expect(section.locator('main')).toHaveCount(1);
  });

  test('aside takes the sidebar token width and colour, not legacy 248px/#152c37', async ({
    page,
  }) => {
    const aside = shellSection(page).locator('aside');
    expect(await style(aside, 'width')).toBe('208px');
    // --cc-background-navigation (#142C3C), distinct from legacy's #152c37.
    expect(await style(aside, 'background-color')).toBe('rgb(20, 44, 60)');
  });

  test('aside is not fixed-positioned — legacy inset has nothing to attach to', async ({
    page,
  }) => {
    const aside = shellSection(page).locator('aside');
    expect(await style(aside, 'position')).toBe('static');
  });

  test('header takes the topbar token height, not legacy 78px', async ({ page }) => {
    const header = shellSection(page).locator('header');
    expect(await style(header, 'height')).toBe('64px');
  });

  test('main takes 4px-scale padding, not legacy 30px 36px 60px', async ({ page }) => {
    const main = shellSection(page).locator('main');
    expect(await style(main, 'padding-top')).toBe('32px');
    expect(await style(main, 'padding-left')).toBe('32px');
    expect(await style(main, 'padding-bottom')).toBe('40px');
    // Legacy also caps width and re-centres with margin: auto.
    expect(await style(main, 'max-width')).toBe('none');
  });

  test("narrow viewport: legacy's 760px breakpoint does not reach the shell", async ({
    page,
  }) => {
    // Legacy at <=760px: aside{position:relative;width:100%;padding:16px},
    // nav{display:flex;overflow:auto;margin-top:10px}, header{padding:12px;
    // height:auto}, main{padding:18px}. None of it is scoped to a media query on
    // our side, so our declarations hold regardless of viewport.
    await page.setViewportSize({ width: 480, height: 900 });
    const section = shellSection(page);

    expect(await style(section.locator('aside'), 'width')).toBe('208px');
    expect(await style(section.locator('header'), 'height')).toBe('64px');
    expect(await style(section.locator('main'), 'padding-left')).toBe('32px');
    expect(await style(section.locator('aside nav'), 'display')).toBe('block');

    await page.setViewportSize({ width: 1440, height: 1000 });
  });

  test('topbar content is never a direct child of <header>', async ({ page }) => {
    // Legacy hides a bare `header > span` under 760px. AppShell wraps the topbar
    // slot in its own element specifically so a caller's span can never be a
    // direct child of the real <header>.
    const header = shellSection(page).locator('header');
    const directChildTags = await header.evaluate((node) =>
      Array.from(node.children).map((child) => child.tagName.toLowerCase()),
    );
    expect(directChildTags).not.toContain('span');
  });
});

test.describe('AppShell — header isolation (corrective)', () => {
  // Work review finding 1: legacy's bare `header{display:flex;align-items:
  // center;justify-content:space-between}` had nothing on our side contesting
  // those three properties, so it applied to the real <header>. That in turn
  // left `.headerInner` — a flex item with no explicit width — sized to its own
  // content rather than stretched to fill <header>, so its own
  // `justify-content: space-between` had no real width to distribute across.

  test('the real <header> is not a flex container — legacy display:flex does not leak in', async ({
    page,
  }) => {
    const header = shellSection(page).locator('header');
    expect(await style(header, 'display')).toBe('block');
  });

  test('headerInner spans the full header width, not just its own content width', async ({
    page,
  }) => {
    const header = shellSection(page).locator('header');
    const inner = header.locator('div').first();

    const headerBox = await header.boundingBox();
    const innerBox = await inner.boundingBox();
    expect(headerBox).not.toBeNull();
    expect(innerBox).not.toBeNull();
    expect(Math.round(innerBox!.width)).toBe(Math.round(headerBox!.width));
  });

  test('the right-aligned topbar slot reaches the right edge, not just beside the left content', async ({
    page,
  }) => {
    const header = shellSection(page).locator('header');
    const left = header.getByText('Производственное ядро', { exact: true });
    const right = header.getByText('Демо-пользователь', { exact: true });

    const headerBox = await header.boundingBox();
    const leftBox = await left.boundingBox();
    const rightBox = await right.boundingBox();
    expect(headerBox && leftBox && rightBox).toBeTruthy();

    // The right slot sits within headerInner's own padding of the header's true
    // right edge — not bunched up beside the left label, which is what a
    // content-width-shrunk headerInner produced before this fix.
    const distanceFromRightEdge =
      headerBox!.x + headerBox!.width - (rightBox!.x + rightBox!.width);
    expect(distanceFromRightEdge).toBeLessThan(40);

    // Real distance between the two labels — space-between across the full
    // width, not two labels separated only by their 16px flex gap.
    expect(rightBox!.x - (leftBox!.x + leftBox!.width)).toBeGreaterThan(100);
  });
});

test.describe('AppShell — skip link', () => {
  test('is off-screen until focused, then jumps focus to main', async ({ page }) => {
    const section = shellSection(page);
    const skipLink = section.getByRole('link', { name: 'Перейти к содержимому' });

    expect(await style(skipLink, 'transform')).not.toBe('none');

    await skipLink.focus();
    await expect(skipLink).toBeFocused();
    // toHaveCSS auto-retries: a plain getComputedStyle read here can land mid
    // transition (the 150ms reveal), reporting the pre-focus value at t=0.
    await expect(skipLink).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');

    await page.keyboard.press('Enter');
    await expect(section.locator('main')).toBeFocused();
  });
});

test.describe('Sidebar', () => {
  test('items are named buttons, not links — no router dependency', async ({ page }) => {
    const nav = sidebarNav(page);
    for (const label of ['Панель', 'Объекты', 'Производство', 'Финансы']) {
      await expect(nav.getByRole('button', { name: label })).toBeVisible();
    }
    await expect(nav.locator('a')).toHaveCount(0);
  });

  test('activeKey drives aria-current, not any state inside the component', async ({
    page,
  }) => {
    const nav = sidebarNav(page);
    const objects = nav.getByRole('button', { name: 'Объекты' });
    const production = nav.getByRole('button', { name: 'Производство' });

    await expect(objects).toHaveAttribute('aria-current', 'page');
    expect(await production.getAttribute('aria-current')).toBeNull();

    await production.click();

    await expect(production).toHaveAttribute('aria-current', 'page');
    expect(await objects.getAttribute('aria-current')).toBeNull();
    await expect(shellSection(page).locator('[data-active-nav]')).toHaveText('production');
  });

  test('keyboard focus uses the inverse ring, per D-04', async ({ page }) => {
    const button = sidebarNav(page).getByRole('button', { name: 'Панель' });
    await button.focus();
    await expect(button).toBeFocused();

    // --cc-focus-ring-inverse (#7FB4E0), not the ordinary --cc-focus-ring.
    expect(await style(button, 'outline-color')).toBe('rgb(127, 180, 224)');
    expect(parseFloat(await style(button, 'outline-width'))).toBeGreaterThan(0);
  });

  test('activates on Enter, not only on click', async ({ page }) => {
    const nav = sidebarNav(page);
    const finance = nav.getByRole('button', { name: 'Финансы' });
    await finance.focus();
    await page.keyboard.press('Enter');
    await expect(finance).toHaveAttribute('aria-current', 'page');
  });
});

test.describe('Breadcrumb', () => {
  test('the current step is not a control', async ({ page }) => {
    const nav = breadcrumbNav(page);
    const current = nav.getByText('Учебный корпус · Северный', { exact: true });
    await expect(current).toHaveAttribute('aria-current', 'page');
    await expect(nav.getByRole('button')).toHaveCount(1); // only "Объекты" is interactive
  });

  test('the separator is decorative, not counted as a second interactive step', async ({
    page,
  }) => {
    const nav = breadcrumbNav(page);
    const separators = nav.locator('[aria-hidden="true"]');
    await expect(separators).toHaveCount(1);
    await expect(separators.first()).toHaveText('/');
  });

  test('a non-current step calls its own handler, distinct from the sidebar item of the same name', async ({
    page,
  }) => {
    // The activation counter is a page-wide demo marker (declared once, beside
    // the F2 table section), not scoped under app-shell — the same shared
    // instrumentation every other component spec's Button/retry tests use.
    await expect(page.locator('[data-activated]')).toHaveText('—');

    await breadcrumbNav(page).getByRole('button', { name: 'Объекты' }).click();

    await expect(page.locator('[data-activated]')).toHaveText('Объекты (хлебная крошка)');
    // The sidebar's own "Объекты" item did not become current as a side effect —
    // the two landmarks are independent despite sharing a label.
    await expect(sidebarNav(page).getByRole('button', { name: 'Объекты' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});

test.describe('Breadcrumb — narrow-viewport isolation (corrective)', () => {
  // Work review finding 2: Breadcrumb's root is a real <nav>, same as
  // Sidebar's rail, but only `display` was reset on it — `overflow` and
  // `margin-top` were left undeclared. Legacy styles a bare `nav` at its 760px
  // breakpoint (`nav{display:flex;overflow:auto;margin-top:10px}`), so both
  // would have applied unopposed at a narrow viewport. Sidebar's own `.nav`
  // already reset all three; this closes the same gap here.

  test('desktop: margin-top and overflow are already the intended values', async ({
    page,
  }) => {
    const nav = breadcrumbNav(page);
    expect(await style(nav, 'margin-top')).toBe('0px');
    expect(await style(nav, 'overflow-y')).toBe('visible');
  });

  test('narrow viewport: legacy margin-top:10px does not leak in', async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 900 });
    const nav = breadcrumbNav(page);

    expect(await style(nav, 'margin-top')).toBe('0px');

    await page.setViewportSize({ width: 1440, height: 1000 });
  });

  test('narrow viewport: overflow is the explicit visible choice, not legacy auto', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 480, height: 900 });
    const nav = breadcrumbNav(page);

    expect(await style(nav, 'overflow-y')).toBe('visible');
    expect(await style(nav, 'overflow-x')).toBe('visible');

    await page.setViewportSize({ width: 1440, height: 1000 });
  });

  test('narrow viewport: the trail wraps rather than causing horizontal overflow', async ({
    page,
  }) => {
    // Confirms .list's own flex-wrap is what actually handles narrow widths —
    // overflow: visible is safe specifically because wrapping, not scrolling,
    // is the real strategy. 480px, matching the shell-wide narrow-viewport
    // check above: at this shell's fixed (non-collapsing) 208px sidebar width,
    // that already leaves a realistically tight ~208px for <main>'s content,
    // enough to force this two-step demo trail onto two lines without going
    // narrower than the sidebar itself allows for.
    await page.setViewportSize({ width: 480, height: 900 });
    const nav = breadcrumbNav(page);

    const overflow = await nav.evaluate((node) => node.scrollWidth - node.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    await page.setViewportSize({ width: 1440, height: 1000 });
  });
});

test.describe('PageHeader', () => {
  test('renders one h1, an eyebrow and a description', async ({ page }) => {
    const section = shellSection(page);
    await expect(
      section.getByRole('heading', { level: 1, name: 'Учебный корпус · Северный' }),
    ).toBeVisible();
    await expect(section.getByText('ОБЪЕКТ', { exact: true })).toBeVisible();
    await expect(
      section.getByText('CC-024 · ул. Строителей, 12', { exact: true }),
    ).toBeVisible();
  });

  test('actions slot renders caller content, e.g. a Button', async ({ page }) => {
    const section = shellSection(page);
    await expect(page.locator('[data-activated]')).toHaveText('—');
    await section.getByRole('button', { name: 'Экспорт' }).click();
    await expect(page.locator('[data-activated]')).toHaveText('Экспорт');
  });
});

test.describe('layout and routing stay separated', () => {
  test('activating a nav item or a crumb never navigates the page itself', async ({ page }) => {
    // Only the handler fires — no <a href>, no history change, no reload. A
    // routing adapter above this component is what would turn `key` into a URL.
    const urlBefore = page.url();

    await sidebarNav(page).getByRole('button', { name: 'Финансы' }).click();
    await breadcrumbNav(page).getByRole('button', { name: 'Объекты' }).click();

    expect(page.url()).toBe(urlBefore);
  });
});
