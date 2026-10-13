import { test, expect, type Page } from '@playwright/test';

/**
 * ID-AUTO-2 — «Реестр ИД» in a real browser over a REAL backend (PILOT-W01-shaped Object, see server.ts).
 * Selectors are role/text based. Screenshots are written only when SHOT_DIR is set (review aid, never an assertion).
 */
let sc: { tokens: Record<string, string>; objectId: string; objectName: string; pkgA: string; pkgB: string; pkgC: string; pkgTest: string; workA: string; aosrDone: string; aosrDraft: string; ptoName: string };
test.beforeAll(async () => { sc = await (await fetch('http://localhost:3002/scenario')).json(); });

async function asRole(page: Page, role: 'pto' | 'head' | 'deputy' | 'engineer') {
  const token = sc.tokens[role]!;
  await page.addInitScript((t: string) => { try { sessionStorage.setItem('session', t); } catch { /* storage blocked */ } }, token);
}
const registryUrl = (qs = '') => `/app.html/object/${sc.objectId}/documentation${qs}`;
async function shot(page: Page, name: string) {
  if (!process.env.SHOT_DIR) return;
  const size = page.viewportSize() ?? { width: 1440, height: 1000 };
  await page.setViewportSize({ width: size.width, height: 2400 }); // the app scrolls inside <main>: a tall viewport captures all of it
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${process.env.SHOT_DIR}/${name}.png` });
  await page.setViewportSize(size);
}
const rowOf = (page: Page, work: string) => page.getByRole('row').filter({ has: page.getByRole('button', { name: work, exact: true }) });

test('PTO: the pilot package reads in business terms and says exactly WHY it is not ready; archived packages are absent', async ({ page }) => {
  await asRole(page, 'pto');
  await page.goto(registryUrl());
  await expect(page.getByRole('heading', { name: 'Реестр ИД', level: 1 })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Хлебные крошки' })).toContainText(sc.objectName);

  // summary: derived server-side from the same rows
  const summary = page.getByRole('list', { name: 'Сводка по объекту' });
  await expect(summary.getByRole('listitem').filter({ hasText: 'Активных пакетов' })).toContainText('3');
  await expect(summary.getByRole('listitem').filter({ hasText: 'Не готово' })).toContainText('2');
  await expect(summary.getByRole('listitem').filter({ hasText: 'Готово' }).first()).toBeVisible();

  const main = rowOf(page, 'PILOT-W01 Штукатурка стен');
  await expect(main).toContainText('1 этаж · 498 м²');
  await expect(main).toContainText('Формируются в Core');
  await expect(main).toContainText('Черновик');
  await expect(main).toContainText('2 АОСР · сформировано 1');
  await expect(main).toContainText('Не готово');
  await expect(main).toContainText('АОСР «Грунтовка основания» не сформирован');
  await expect(main).toContainText(sc.ptoName);
  // the disposable test package is archived: not in the working registry, not in the counts
  await expect(page.getByText('Тестовый участок')).toHaveCount(0);
  // no technical ids on screen
  expect(await page.locator('main').innerText()).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}/i);
  await shot(page, 'registry-1440');

  // EXTERNAL with zero Core AOSRs is shown as ready, with the method stated — not as a defect
  const external = rowOf(page, 'PILOT-W02 Окраска стен');
  await expect(external).toContainText('Формируются вне Core');
  await expect(external).toContainText('Готово');
  await expect(external).not.toContainText('Не готово');
  await expect(external).not.toContainText('не сформирован');
  // METHOD_UNSET is its own explicit state
  const unset = rowOf(page, 'PILOT-W03 Шпатлёвка');
  await expect(unset).toContainText('Способ подготовки АОСР не выбран');
  await expect(unset).toContainText('Не готово');
});

test('the AOSR register inside a Core package: one row per act, number / no number, DOCX state, scheme coverage, readiness', async ({ page }) => {
  await asRole(page, 'pto');
  await page.goto(registryUrl());
  const main = rowOf(page, 'PILOT-W01 Штукатурка стен');
  await main.getByRole('button', { name: /Показать акты и замечания/ }).click();
  const register = page.getByRole('region', { name: /Реестр АОСР/ });
  await expect(register).toBeVisible();
  const done = register.getByRole('row').filter({ hasText: 'Устройство штукатурки стен' });
  await expect(done).toContainText('№ 1');
  await expect(done).toContainText('Актуальный DOCX');
  await expect(done).toContainText('PILOT-W01-ES-001');
  await expect(done).toContainText('Готово');
  const draft = register.getByRole('row').filter({ hasText: 'Грунтовка основания' });
  await expect(draft).toContainText('номер не присвоен');
  await expect(draft).toContainText('Не сформирован');
  await expect(draft).toContainText('Схема с файлом не привязана');
  await expect(draft).toContainText('Не готово');
  await draft.getByText('Подробнее').click();
  await expect(draft).toContainText('Не заполнено для формирования');
  await shot(page, 'registry-expanded-1440');
});

test('a blocker leads to the place that fixes it: registry -> package -> the exact AOSR, and back to the registry', async ({ page }) => {
  await asRole(page, 'pto');
  await page.goto(registryUrl());
  const main = rowOf(page, 'PILOT-W01 Штукатурка стен');
  await main.getByRole('button', { name: /Показать акты и замечания/ }).click();
  await page.getByRole('region', { name: 'Что нужно устранить' }).getByRole('button', { name: 'Открыть АОСР' }).first().click();
  await expect(page).toHaveURL(new RegExp(`/pto/package/${sc.pkgA}\\?focus=aosr&aosr=${sc.aosrDraft}`));
  await expect(page.getByRole('heading', { name: 'PILOT-W01 Штукатурка стен' }).first()).toBeVisible();
  // the draft's card is open (its «Свернуть» is offered) and focused
  const card = page.locator(`#package-focus-aosr-${sc.aosrDraft}`);
  await expect(card).toBeVisible();
  await expect(card.getByRole('button', { name: 'Свернуть' })).toBeVisible();
  await expect(card).toBeFocused();
  await page.getByRole('button', { name: 'Реестр ИД объекта' }).click();
  await expect(page).toHaveURL(new RegExp(`/object/${sc.objectId}/documentation$`));
  // the row's own link opens the package itself
  await page.getByRole('button', { name: 'PILOT-W03 Шпатлёвка', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/pto/package/${sc.pkgC}$`));
});

test('METHOD_UNSET blocker deep-links to the method choice on the package screen', async ({ page }) => {
  await asRole(page, 'pto');
  await page.goto(registryUrl());
  await rowOf(page, 'PILOT-W03 Шпатлёвка').getByRole('button', { name: /Показать акты и замечания/ }).click();
  await page.getByRole('button', { name: 'Выбрать способ подготовки' }).click();
  await expect(page).toHaveURL(new RegExp(`/pto/package/${sc.pkgC}\\?focus=method`));
  await expect(page.locator('#package-focus-method')).toBeFocused();
  await expect(page.getByText('Генератор АОСР в Core — необязательный инструмент')).toBeVisible();
});

test('filters live in the URL and narrow the rows; counts keep describing the whole object; reset clears them', async ({ page }) => {
  await asRole(page, 'pto');
  await page.goto(registryUrl());
  await page.getByLabel('Готовность').selectOption('false');
  await expect(page).toHaveURL(/ready=false/);
  await expect(page.getByRole('button', { name: 'PILOT-W02 Окраска стен', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'PILOT-W01 Штукатурка стен', exact: true })).toBeVisible();
  await expect(page.getByText('2 из 3 пакета')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Сводка по объекту' }).getByRole('listitem').filter({ hasText: 'Активных пакетов' })).toContainText('3');

  await page.getByLabel('Способ АОСР').selectOption('UNSET');
  await expect(page.getByRole('button', { name: 'PILOT-W03 Шпатлёвка', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'PILOT-W01 Штукатурка стен', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Сбросить фильтры' }).click();
  await expect(page).not.toHaveURL(/ready=|method=/);
  await expect(page.getByRole('button', { name: 'PILOT-W01 Штукатурка стен', exact: true })).toBeVisible();

  await page.getByLabel('Поиск: работа, участок, АОСР').fill('окраск');
  await expect(page.getByRole('button', { name: 'PILOT-W02 Окраска стен', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'PILOT-W01 Штукатурка стен', exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(/q=/);
  // a shared link restores the same view
  await page.goto(registryUrl('?ready=true'));
  await expect(page.getByRole('button', { name: 'PILOT-W02 Окраска стен', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'PILOT-W03 Шпатлёвка', exact: true })).toHaveCount(0);
  await page.goto(registryUrl('?ready=false&status=BOGUS'));
  await expect(page.getByRole('button', { name: 'PILOT-W03 Шпатлёвка', exact: true })).toBeVisible(); // an unknown value is ignored, not guessed
});

test('«Показать архивные» is an explicit secondary view: read-only, with who / when / why, and no effect on the counts', async ({ page }) => {
  await asRole(page, 'pto');
  await page.goto(registryUrl());
  await expect(page.getByRole('region', { name: 'Архивные пакеты' })).toHaveCount(0);
  await page.getByLabel(/Показать архивные/).check();
  await expect(page.getByLabel(/Показать архивные/)).toBeChecked();
  const archive = page.getByRole('region', { name: 'Архивные пакеты' });
  await expect(archive).toContainText('Тестовый участок');
  await expect(archive).toContainText('Причина: Тестовый пакет после проверки');
  await expect(archive).toContainText('Архивирован:');
  await expect(page.getByRole('list', { name: 'Сводка по объекту' }).getByRole('listitem').filter({ hasText: 'Активных пакетов' })).toContainText('3');
  await shot(page, 'registry-archive-1440');
});

test('PTO head sees the whole object; an assignment-scoped engineer sees only the work they hold; a read-only role sees no package links', async ({ page, browser }) => {
  await asRole(page, 'head');
  await page.goto(registryUrl());
  await expect(page.getByRole('button', { name: 'PILOT-W01 Штукатурка стен', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'PILOT-W02 Окраска стен', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'PILOT-W03 Шпатлёвка', exact: true })).toBeVisible();

  const engineer = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ru-RU' });
  const ePage = await engineer.newPage();
  await ePage.addInitScript((t: string) => { try { sessionStorage.setItem('session', t); } catch { /* */ } }, sc.tokens.engineer!);
  await ePage.goto(registryUrl());
  await expect(ePage.getByText('Показаны только работы, на которые вы назначены.')).toBeVisible();
  await expect(ePage.getByRole('button', { name: 'PILOT-W02 Окраска стен', exact: true })).toBeVisible();
  await expect(ePage.getByRole('button', { name: 'PILOT-W01 Штукатурка стен', exact: true })).toHaveCount(0);
  await expect(ePage.getByRole('list', { name: 'Сводка по объекту' }).getByRole('listitem').filter({ hasText: 'Активных пакетов' })).toContainText('1');
  await engineer.close();

  const deputy = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ru-RU' });
  const dPage = await deputy.newPage();
  await dPage.addInitScript((t: string) => { try { sessionStorage.setItem('session', t); } catch { /* */ } }, sc.tokens.deputy!);
  await dPage.goto(registryUrl());
  await expect(dPage.getByText('PILOT-W01 Штукатурка стен')).toBeVisible();
  await expect(dPage.getByRole('button', { name: 'PILOT-W01 Штукатурка стен', exact: true })).toHaveCount(0); // the name is not a link for a read-only role
  await expect(dPage.getByText('АОСР «Грунтовка основания» не сформирован')).toBeVisible(); // still told WHY, read-only
  await deputy.close();
});

test('entry points: /pto object cell, the object page, and W01 all lead to the same registry', async ({ page }) => {
  await asRole(page, 'pto');
  await page.goto('/app.html/pto');
  await page.getByRole('button', { name: 'Реестр ИД' }).first().click();
  await expect(page).toHaveURL(new RegExp(`/object/${sc.objectId}/documentation$`));
  await page.goto(`/app.html/object/${sc.objectId}`);
  await page.getByRole('button', { name: 'Реестр ИД объекта' }).click();
  await expect(page).toHaveURL(new RegExp(`/object/${sc.objectId}/documentation$`));
  await page.goto(`/app.html/object/${sc.objectId}/work/${sc.workA}`);
  await expect(page.getByRole('button', { name: 'Открыть пакет' }).first()).toBeVisible(); // W01 keeps its own package cards
  await page.getByRole('button', { name: 'Открыть в реестре ИД' }).click();
  await expect(page).toHaveURL(new RegExp(`/object/${sc.objectId}/documentation$`));
  await expect(page.getByRole('navigation', { name: 'Основная навигация' }).or(page.locator('nav').first())).toBeVisible();
});

test('responsive: no page-level horizontal overflow at desktop or phone width; rows stack into labelled blocks on a phone', async ({ page }) => {
  await asRole(page, 'pto');
  await page.goto(registryUrl());
  await expect(page.getByRole('button', { name: 'PILOT-W01 Штукатурка стен', exact: true })).toBeVisible();
  const overflow = () => page.evaluate(() => ({ page: document.documentElement.scrollWidth - document.documentElement.clientWidth, table: (document.querySelector('[role="region"][aria-label="Пакеты ИД объекта"]') as HTMLElement | null)?.scrollWidth ?? 0, tableClient: (document.querySelector('[role="region"][aria-label="Пакеты ИД объекта"]') as HTMLElement | null)?.clientWidth ?? 0 }));
  let o = await overflow();
  expect(o.page).toBeLessThanOrEqual(0);
  expect(o.table, 'at 1440 the register table needs no horizontal scrolling').toBeLessThanOrEqual(o.tableClient);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  o = await overflow();
  expect(o.page, 'no page-level horizontal scroll on a phone').toBeLessThanOrEqual(0);
  // stacked rows carry their labels
  await expect(page.getByText('Готовность ИД').first()).toBeVisible();
  await rowOf(page, 'PILOT-W01 Штукатурка стен').getByRole('button', { name: /Показать акты и замечания/ }).click();
  o = await overflow();
  expect(o.page).toBeLessThanOrEqual(0);
  await shot(page, 'registry-390');
});
