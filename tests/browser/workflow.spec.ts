import { test, expect } from '@playwright/test';
import ExcelJS from 'exceljs';

// Runs against an already started, seeded, disposable MOCK test environment.
// All business mutations are made through UI; HTTP helpers are deliberately absent.
test('производственный цикл через интерфейс и desktop QA', async ({ page }, info) => {
  if (!process.env.MOCK_LOGIN_KEY) throw new Error('Set MOCK_LOGIN_KEY for a disposable test environment');
  const suffix = Date.now().toString(), name = `Приёмка ${suffix}`;
  const day = (n = 0) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const pdf = { name: 'acceptance.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% Acceptance test fixture only\n%%EOF') };
  const png = { name: 'inspection.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64') };
  const dialog = () => page.getByRole('dialog');
  const fill = async (values: Record<string,string>) => { for (const [label,value] of Object.entries(values)) await dialog().getByLabel(label, { exact: true }).fill(value); };
  const choose = async (label: string, value: string) => { await dialog().getByLabel(label, { exact: true }).selectOption({ label: value }); };
  const save = async () => { await dialog().getByRole('button', { name: 'Сохранить', exact: true }).click(); await expect(dialog()).toHaveCount(0); };
  // A row can legitimately mention another work's name inside its own dependency-blocker
  // text (read-service.ts: `${before.name}: не завершена`), e.g. the "Бетонирование" row
  // mentions "Армирование фундамента" while it's waiting on that predecessor. Exclude rows
  // where the match is only inside that .error blocker note, so the locator stays unique.
  const row = (text: string) => page.locator('.ant-tabs-tabpane-active tr')
    .filter({ hasText: text })
    .filter({ hasNot: page.locator('.error', { hasText: text }) });
  const tab = async (label: string) => { await page.getByRole('tab', { name: label, exact: true }).click(); };
  const screen = async (label: string) => {
    await expect(page.locator('main')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBeTruthy();
    await page.screenshot({ path: info.outputPath(`${label}.png`), fullPage: true });
  };
  await page.goto('/');
  // antd Select renders a hidden search <input role="combobox"> overlapped by a
  // .ant-select-selection-item span showing the current value; a direct click on
  // the combobox role is intercepted by that span. Click the visible selector
  // container instead, matching what a real user's pointer actually hits.
  await page.locator('.login .ant-select-selector').click();
  await page.getByText('Администратор', { exact: true }).click();
  await page.getByLabel('Тестовый ключ').fill(process.env.MOCK_LOGIN_KEY);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Куда смотреть сегодня' })).toBeVisible();
  await screen('dashboard');
  await page.getByRole('link', { name: 'Объекты', exact: true }).click();
  await screen('objects');
  await page.getByRole('button', { name: 'Создать объект' }).click();
  await fill({ 'УКО': `QA-${suffix}`, 'Название': name, 'Адрес': 'Москва, Тестовая улица, 20', 'Начало': day(-20), 'Срок сдачи': day(30), 'Стоимость, ₽': '2000000' });
  // Select existing seeded roles/contractors through native UI controls.
  const pm = await dialog().getByLabel('Руководитель проекта', { exact: true }).locator('option').nth(1).innerText();
  const contractor = await dialog().getByLabel('Субподрядчик', { exact: true }).locator('option').nth(1).innerText();
  await choose('Руководитель проекта', pm); await choose('Субподрядчик', contractor); await save();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  const objectUrl = page.url();
  const work = async (title: string, type: string, unit: string) => {
    await page.getByRole('button', { name: 'Добавить работу', exact: true }).click();
    await fill({ 'Название работы': title, 'Единица': unit, 'Плановый объём': '20', 'Начало': day(-10), 'Окончание': day(-1), 'Ориентировочная стоимость, ₽': '1000000' });
    await choose('Вид работ', type); await choose('Субподрядчик', contractor); await choose('Ответственный РП', pm); await save();
  };
  await work('Армирование фундамента', 'Армирование фундамента', 'т');
  await work('Бетонирование', 'Армирование фундамента', 'м³');
  await page.getByRole('link', { name: 'Производство', exact: true }).click();
  await page.getByRole('button', { name: 'Добавить зависимость' }).click();
  await choose('Предыдущая работа', `${name} — Армирование фундамента`); await choose('Следующая работа', `${name} — Бетонирование`); await save();
  await page.goto(objectUrl);
  const progress = async (quantity: string) => {
    await row('Армирование фундамента').getByRole('button', { name: 'Внести факт' }).click();
    await fill({ 'Всего выполнено, т': quantity, 'Комментарий': 'Факт для технической приёмки' }); await save();
  };
  await progress('10');
  await expect(row('Армирование фундамента')).toContainText('50%');
  await expect(row('Армирование фундамента')).toContainText('План 100% · Δ -50 п.п.');
  await expect(page.locator('.page-heading')).toContainText('Проблема');
  await screen('object-production');
  await progress('20');
  await expect(row('Армирование фундамента')).toContainText('100%');
  await row('Армирование фундамента').getByRole('button', { name: 'Предъявить СК' }).click();
  await tab('Строительный контроль');
  await row('Армирование фундамента').getByRole('button', { name: 'Замечание', exact: true }).click();
  await fill({ 'Замечание': 'Защитный слой арматуры', 'Описание': 'Восстановить фиксаторы', 'Устранить до': day(1) });
  await choose('Важность', 'CRITICAL'); await choose('Ответственный', pm); await save();
  await tab('Производство');
  await expect(row('Бетонирование').locator('.error')).not.toHaveCount(0);
  await row('Бетонирование').getByRole('button', { name: 'Начать работу' }).click();
  await expect(row('Бетонирование').getByRole('button', { name: 'Начать работу' })).toBeVisible();
  await tab('Строительный контроль');
  await row('Защитный слой арматуры').getByRole('button', { name: 'Устранено', exact: true }).click();
  await tab('Строительный контроль');
  await row('Защитный слой арматуры').getByRole('button', { name: 'Проверить устранение' }).click();
  await tab('Строительный контроль');
  await expect(row('Защитный слой арматуры')).toContainText('Закрыто');
  await row('Армирование фундамента').locator('input[type=file]').setInputFiles(png);
  await expect(page.getByText('Сохранено', { exact: true }).last()).toBeVisible();
  await tab('Строительный контроль');
  await row('Армирование фундамента').getByRole('button', { name: 'Принять', exact: true }).click();
  await tab('Строительный контроль');
  await expect(row('Армирование фундамента')).toContainText('Принято'); await screen('inspection');
  await tab('Производство');
  await expect(row('Бетонирование').locator('.error')).toHaveCount(0);
  await row('Бетонирование').getByRole('button', { name: 'Начать работу' }).click();
  await expect(row('Бетонирование').getByRole('button', { name: 'Начать работу' })).toHaveCount(0);
  await row('Армирование фундамента').getByRole('button', { name: 'Создать пакет ИД' }).click();
  await page.getByRole('link', { name: 'Материалы', exact: true }).click();
  await page.locator('main input[type=file]').setInputFiles(pdf);
  await page.getByRole('button', { name: 'Привязать к работе' }).click();
  await choose('Работа', `${name} — Армирование фундамента`);
  await fill({ 'Производитель': 'Тестовый завод', 'Номер партии': suffix, 'Количество': '20', 'Номер паспорта': `П-${suffix}`, 'Действителен до': day(365) }); await save();
  await page.goto(objectUrl); await tab('ПТО / документы');
  await row('Армирование фундамента').getByRole('button', { name: 'Документ', exact: true }).click();
  await fill({ 'Номер': `АОСР-${suffix}` });
  await dialog().getByLabel('Проверенный файл документа').setInputFiles(pdf);
  await expect(page.getByText('Файл загружен', { exact: true }).last()).toBeVisible(); await save();
  await tab('ПТО / документы');
  await row(`АОСР-${suffix}`).getByRole('button', { name: 'Подтвердить ПТО' }).click();
  await tab('ПТО / документы');
  await expect(row(`АОСР-${suffix}`)).toContainText('Подтверждено');
  await row('Армирование фундамента').getByRole('button', { name: 'Готов', exact: true }).click();
  await tab('ПТО / документы'); await screen('pto');
  await row('Армирование фундамента').getByRole('button', { name: 'Передать в СДО' }).click();
  await tab('СДО');
  await row('Армирование фундамента').getByRole('button', { name: 'Ввести расчёт' }).click();
  await fill({ 'Рассчитанная стоимость, ₽': '1000000' }); await save();
  await tab('СДО'); await expect(row('Армирование фундамента')).toContainText('Осмечено'); await screen('sdo');
  await page.getByRole('link', { name: 'Панель', exact: true }).click();
  const kpi = (label: string) => page.locator('.kpi-grid .ant-card').filter({ hasText: label }).locator('.kpi-number');
  const before = await kpi('Факт за месяц').innerText(), potential = await kpi('Потенциал закрытия').innerText();
  await page.goto(objectUrl); await tab('СДО');
  await row('Армирование фундамента').getByRole('button', { name: 'Закрыть сумму' }).click();
  await fill({ 'Сумма закрытия, ₽': '1000000' }); await save();
  await tab('Финансы'); await expect(page.locator('.ant-tabs-tabpane-active')).toContainText('1 млн ₽'); await screen('finance');
  await page.getByRole('link', { name: 'Панель', exact: true }).click();
  await expect(kpi('Факт за месяц')).not.toHaveText(before);
  await expect(kpi('Потенциал закрытия')).not.toHaveText(potential);
  await page.getByRole('link', { name: 'Субподрядчики', exact: true }).click(); await screen('contractors');
  await page.getByRole('link', { name: 'Администрирование', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'История действий' })).toBeVisible();
  // Last ten events include the closing and SDO/PTO decisions of this isolated run.
  await expect(page.locator('tr').filter({ hasText: 'FinancialClosing' })).toContainText('CREATE');
  await expect(page.locator('tr').filter({ hasText: 'SdoCase' })).toContainText('CALCULATE');
  await screen('audit');
});

// Isolated regression test for the Admin fix (main.tsx: Admin() lifted its Excel-import
// preview/selected/scale state up to App() props, mirroring the earlier Materials fix), kept
// independent of the workflow test above on purpose: Admin is a nested function of App,
// recreated (and remounted by React, wiping its own useState) on every App re-render. A fresh,
// minimal login straight to /admin means this verification doesn't depend on unrelated steps
// elsewhere in the app (e.g. the inspection-accept flow in the workflow test above).
test('Admin: импорт Excel переживает перерендер App', async ({ page }, info) => {
  if (!process.env.MOCK_LOGIN_KEY) throw new Error('Set MOCK_LOGIN_KEY for a disposable test environment');
  const suffix = Date.now().toString();
  // Built with the same library the backend uses to parse it (apps/backend/src/importer.ts),
  // so this is a genuine workbook, not a fake buffer: sheet name and header row must match
  // what parseWorkbook() looks for (source 'ГПО', columns УКО/Объект/адрес/стоимость).
  const buildImportWorkbook = async () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('ГПО');
    sheet.addRow(['УКО', 'Объект', 'Полный адрес объекта', 'Стоимость объекта']);
    sheet.addRow([`QA-IMPORT-${suffix}`, `Импорт ${suffix}`, 'Москва, Импортная ул., 1', 5]);
    return Buffer.from(await wb.xlsx.writeBuffer());
  };
  const dialog = () => page.getByRole('dialog');
  const save = async () => { await dialog().getByRole('button', { name: 'Сохранить', exact: true }).click(); await expect(dialog()).toHaveCount(0); };
  const tab = async (label: string) => { await page.getByRole('tab', { name: label, exact: true }).click(); };
  const screen = async (label: string) => {
    await expect(page.locator('main')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBeTruthy();
    await page.screenshot({ path: info.outputPath(`${label}.png`), fullPage: true });
  };
  // Setting preview/selected/scale (lifted to App state by the fix) makes App re-render; since
  // Admin stays a nested function of App by design (the architecture wasn't changed, only this
  // state was lifted), that re-render always remounts Admin, which resets antd Tabs' own
  // uncontrolled tab selection back to its default ('Пользователи'). The fix's job is only that
  // preview/selected/scale themselves survive the remount — they do, as App-level state — but
  // which tab happens to be showing is a separate, expected side effect outside the fix's scope,
  // and it flips right after every interaction that sets this lifted state (the upload, then the
  // row checkbox itself). Poll re-selecting the tab and re-checking so each assertion lands once
  // the remount has actually settled, instead of racing a single click against it.
  const onImportTab = (assert: () => Promise<void>) => expect(async () => {
    await tab('Импорт Excel');
    await assert();
  }).toPass({ timeout: 15000 });
  await page.goto('/');
  // antd Select renders a hidden search <input role="combobox"> overlapped by a
  // .ant-select-selection-item span showing the current value; a direct click on
  // the combobox role is intercepted by that span. Click the visible selector
  // container instead, matching what a real user's pointer actually hits.
  await page.locator('.login .ant-select-selector').click();
  await page.getByText('Администратор', { exact: true }).click();
  await page.getByLabel('Тестовый ключ').fill(process.env.MOCK_LOGIN_KEY);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Куда смотреть сегодня' })).toBeVisible();
  await page.getByRole('link', { name: 'Администрирование', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'История действий' })).toBeVisible();
  // Upload → select a row, then force a real App-level re-render on the SAME /admin route (a
  // query invalidation from an unrelated mutation, not navigation — that's what actually
  // remounted the buggy nested component before the fix), then confirm the Excel import
  // preview and selection survived.
  await tab('Импорт Excel');
  await page.locator('.ant-tabs-tabpane-active input[type=file]').setInputFiles({ name: `import-${suffix}.xlsx`, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: await buildImportWorkbook() });
  await onImportTab(() => expect(page.getByText(/строк готовы к выбору/)).toBeVisible({ timeout: 1000 }));
  await page.locator('.ant-tabs-tabpane-active tbody tr').first().getByRole('checkbox').click();
  const importButton = page.getByRole('button', { name: 'Импортировать выбранные', exact: true });
  await onImportTab(() => expect(importButton).toBeEnabled({ timeout: 1000 }));
  await tab('Пороги риска');
  await page.getByRole('button', { name: 'Изменить пороги', exact: true }).click();
  await save();
  await onImportTab(async () => {
    await expect(page.getByText(/строк готовы к выбору/)).toBeVisible({ timeout: 1000 });
    await expect(importButton).toBeEnabled({ timeout: 1000 });
  });
  await screen('admin-import');
});
