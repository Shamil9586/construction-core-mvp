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
  await page.getByRole('link', { name: 'Подрядчики', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Контроль по субподрядчикам' });
  await panel.getByLabel('Субподрядчик', { exact: true }).selectOption({ label: addedName });
  await expect(panel.locator('.portfolio-object', { hasText: objectName })).toBeVisible();

  // Remove it again — object leaves that contractor's group, tag disappears from the card.
  await page.getByRole('link', { name: objectName, exact: true }).first().click();
  await newTag.locator('.ant-tag-close-icon').click();
  await expect(contractorTags()).toHaveCount(before);
  await expect(contractorTags().filter({ hasText: addedName })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('object-contractor-removed.png'), fullPage: true });

  await page.getByRole('link', { name: 'Подрядчики', exact: true }).click();
  await panel.getByLabel('Субподрядчик', { exact: true }).selectOption({ label: addedName });
  await expect(panel.locator('.portfolio-object', { hasText: objectName })).toHaveCount(0);
});
