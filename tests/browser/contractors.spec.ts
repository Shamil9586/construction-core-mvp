import { test, expect } from '@playwright/test';

// Core 2.1: assign/remove a contractor on the object card, and verify ContractorPanel
// membership follows the same active-relation source (not historical works).
test('Core 2.1: assign/remove contractor on object card, ContractorPanel membership follows it', async ({ page }, info) => {
  if (!process.env.MOCK_LOGIN_KEY) throw Error('Set mock test key for seeded test deployment');
  await page.goto('/');
  await page.locator('.login .ant-select-selector').click();
  await page.getByText('Администратор', { exact: true }).click();
  await page.getByLabel('Тестовый ключ').fill(process.env.MOCK_LOGIN_KEY);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Куда смотреть сегодня' })).toBeVisible();

  await page.getByRole('link', { name: 'Объекты', exact: true }).click();
  const firstObjectLink = page.locator('.objects-grid .object-card h2').first();
  const objectName = await firstObjectLink.innerText();
  await firstObjectLink.click();
  await expect(page.getByRole('heading', { name: objectName, exact: true })).toBeVisible();
  // The object card defaults to the "Производство" tab — the contractor list lives on "Обзор".
  await page.getByRole('tab', { name: 'Обзор', exact: true }).click();

  const overview = page.locator('.ant-tabs-tabpane-active');
  const contractorTags = () => overview.locator('.ant-descriptions-item-content .ant-tag');
  const before = await contractorTags().count();

  await page.getByRole('button', { name: 'Добавить подрядчика', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Субподрядчик', { exact: true }).selectOption({ index: 1 });
  const addedName = await dialog.getByLabel('Субподрядчик', { exact: true }).locator('option:checked').innerText();
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(contractorTags()).toHaveCount(before + 1);
  const newTag = contractorTags().filter({ hasText: addedName });
  await expect(newTag).toBeVisible();
  await page.screenshot({ path: info.outputPath('object-contractor-assigned.png'), fullPage: true });

  // ContractorPanel groups this object under the newly-assigned contractor (active relation).
  await page.getByRole('link', { name: 'Субподрядчики', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Контроль по субподрядчикам' });
  await panel.getByLabel('Субподрядчик', { exact: true }).selectOption({ label: addedName });
  await expect(panel.locator('.portfolio-object', { hasText: objectName })).toBeVisible();

  // Remove it again — object leaves that contractor's group, tag disappears from the card.
  await page.getByRole('link', { name: objectName, exact: true }).first().click();
  await page.getByRole('tab', { name: 'Обзор', exact: true }).click();
  await newTag.locator('.ant-tag-close-icon').click();
  await expect(contractorTags()).toHaveCount(before);
  await expect(contractorTags().filter({ hasText: addedName })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('object-contractor-removed.png'), fullPage: true });

  await page.getByRole('link', { name: 'Субподрядчики', exact: true }).click();
  await panel.getByLabel('Субподрядчик', { exact: true }).selectOption({ label: addedName });
  await expect(panel.locator('.portfolio-object', { hasText: objectName })).toHaveCount(0);

  // Reassign — object rejoins that contractor's group. Navigate via the objects
  // grid, not a link on the current page: the ContractorPanel is still filtered
  // to `addedName`, and the object was just confirmed absent from that filtered
  // view (line above) — there is no longer a link with objectName on this page.
  await page.getByRole('link', { name: 'Объекты', exact: true }).click();
  await page.locator('.objects-grid .object-card h2', { hasText: objectName }).click();
  await expect(page.getByRole('heading', { name: objectName, exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Обзор', exact: true }).click();
  await page.getByRole('button', { name: 'Добавить подрядчика', exact: true }).click();
  await dialog.getByLabel('Субподрядчик', { exact: true }).selectOption({ label: addedName });
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(contractorTags().filter({ hasText: addedName })).toBeVisible();

  // F4: object history shows ASSIGN, REMOVE and the reassign ASSIGN, in order (newest
  // first, per the audit feed's own ordering) — a removed relation's history must not
  // disappear once it's no longer an active relation.
  await page.getByRole('tab', { name: 'История', exact: true }).click();
  const historyItems = page.locator('.ant-timeline-item-content').filter({ hasText: 'ObjectContractor' });
  await expect(historyItems).toHaveCount(3);
  const historyActions = (await historyItems.allInnerTexts()).map(t => t.split(' · ')[0]);
  expect(historyActions).toEqual(['ASSIGN', 'REMOVE', 'ASSIGN']);
  await page.screenshot({ path: info.outputPath('object-contractor-history.png'), fullPage: true });
});

// Core 2.1: restricted Object Edit — whitelisted fields only, no contractValue/status control.
test('Core 2.1: restricted Object Edit form', async ({ page }, info) => {
  if (!process.env.MOCK_LOGIN_KEY) throw Error('Set mock test key for seeded test deployment');
  await page.goto('/');
  await page.locator('.login .ant-select-selector').click();
  await page.getByText('Администратор', { exact: true }).click();
  await page.getByLabel('Тестовый ключ').fill(process.env.MOCK_LOGIN_KEY);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Куда смотреть сегодня' })).toBeVisible();

  await page.getByRole('link', { name: 'Объекты', exact: true }).click();
  const firstObjectLink = page.locator('.objects-grid .object-card h2').first();
  await firstObjectLink.click();
  const newName = 'Отредактированный объект ' + Date.now();

  // The object card defaults to the "Производство" tab — Edit lives on "Обзор".
  await page.getByRole('tab', { name: 'Обзор', exact: true }).click();
  await page.getByRole('button', { name: 'Редактировать объект', exact: true }).click();
  const dialog = page.getByRole('dialog');
  // ADMIN passes the same can('TECHNICAL_DIRECTOR') check, so the РП field is present here.
  await expect(dialog.getByLabel('Руководитель проекта', { exact: true })).toBeVisible();
  await dialog.getByLabel('Название', { exact: true }).fill(newName);
  await dialog.getByLabel('Адрес', { exact: true }).fill('Новый адрес, 1');
  // F6: startDate is part of the restricted whitelist alongside the other fields.
  await dialog.getByLabel('Дата начала', { exact: true }).fill('2000-01-01');
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('heading', { name: newName, exact: true })).toBeVisible();
  await expect(page.locator('.page-heading')).toContainText('Новый адрес, 1');
  await page.getByRole('tab', { name: 'Обзор', exact: true }).click();
  await expect(page.locator('.ant-descriptions-item-label', { hasText: 'Плановый старт' }).locator('xpath=following-sibling::td[1]')).toContainText('01.01.2000');
  await page.screenshot({ path: info.outputPath('object-edited.png'), fullPage: true });

  // contractValue and status are not editable through this form at all.
  await page.getByRole('tab', { name: 'Обзор', exact: true }).click();
  await page.getByRole('button', { name: 'Редактировать объект', exact: true }).click();
  await expect(dialog.getByLabel('Сумма договора')).toHaveCount(0);
  await expect(dialog.getByLabel('Статус')).toHaveCount(0);
  await dialog.locator('.ant-modal-close').click();
  await expect(dialog).toHaveCount(0);
});
