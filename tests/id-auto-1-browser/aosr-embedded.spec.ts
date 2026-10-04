import { test, expect, type Page } from '@playwright/test';
import JSZip from 'jszip';
import fs from 'node:fs';

/**
 * ID-AUTO-1 — the PTO package screen inside a CROSS-ORIGIN iframe (as the Bitrix24 portal embeds the app), real backend.
 * Covers: the generated DOCX downloads as a real DOCX; the executive-scheme file downloads; the method choice and the
 * scheme upload work in the embedded frame.
 */
let scenario: { token: string; pkgA: string; pkgB: string; aosr: string; scheme: string };
test.beforeAll(async () => { scenario = await (await fetch('http://localhost:3002/scenario')).json(); });

async function openEmbedded(page: Page, pkg: string, sandbox?: string) {
  await page.addInitScript((t: string) => { try { if (location.origin === 'http://127.0.0.1:5173') sessionStorage.setItem('session', t); } catch { /* storage blocked */ } }, scenario.token);
  await page.goto(`http://localhost:3002/portal?pkg=${pkg}${sandbox ? `&sandbox=${encodeURIComponent(sandbox)}` : ''}`, { waitUntil: 'domcontentloaded' });
  return page.frameLocator('#app');
}

async function expectRealDocx(download: import('@playwright/test').Download) {
  const bytes = fs.readFileSync((await download.path())!);
  expect(bytes.subarray(0, 2).toString()).toBe('PK');
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file('word/document.xml')!.async('string');
  expect(xml).toContain('освидетельствования'); // the official form text
  expect(xml).toContain('Устройство штукатурки стен'); // point 1 of this act
}

for (const sandbox of [undefined, 'allow-scripts allow-same-origin allow-forms allow-downloads']) {
  test(`embedded cross-origin frame${sandbox ? ' (sandbox with allow-downloads)' : ''}: «Скачать DOCX» saves the current editable DOCX`, async ({ page }) => {
    const frame = await openEmbedded(page, scenario.pkgA, sandbox);
    await frame.getByRole('button', { name: 'Открыть' }).first().click();
    const link = frame.getByRole('link', { name: 'Скачать DOCX' });
    await expect(link).toBeVisible();
    // A REAL anchor to a Blob with the real file name: saving is a native user click, not a click after an await.
    await expect(link).toHaveAttribute('href', /^blob:/);
    await expect(link).toHaveAttribute('download', /^АОСР_1_.*\.docx$/);
    const downloaded = page.waitForEvent('download');
    await link.click();
    await expectRealDocx(await downloaded);
  });
}

test('embedded frame: the executive-scheme file downloads as the real PDF', async ({ page }) => {
  const frame = await openEmbedded(page, scenario.pkgA);
  const downloaded = page.waitForEvent('download');
  await frame.getByRole('button', { name: 'Скачать', exact: true }).click();
  const bytes = fs.readFileSync((await (await downloaded).path())!);
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
});

test('embedded frame: the method is chosen explicitly; «вне Core» offers no Core AOSR tools and a scheme needs a real file', async ({ page }) => {
  const frame = await openEmbedded(page, scenario.pkgB);
  await expect(frame.getByText('Генератор АОСР в Core — необязательный инструмент')).toBeVisible();
  await expect(frame.getByRole('button', { name: '+ Создать АОСР' })).toHaveCount(0); // nothing is inferred before the choice
  await frame.getByRole('button', { name: 'АОСР формируются вне Core' }).click();
  await expect(frame.getByText('Core не требует ни записей АОСР, ни номера, ни DOCX')).toBeVisible();
  await expect(frame.getByRole('button', { name: '+ Создать АОСР' })).toHaveCount(0);
  // Executive scheme: title + FILE in one step (no empty record); the button needs both.
  await expect(frame.getByText('Исполнительных схем ещё нет')).toBeVisible();
  const upload = frame.getByRole('button', { name: 'Загрузить схему' });
  await frame.getByLabel('Название исполнительной схемы').fill('ES-777');
  await expect(upload).toBeDisabled();
  await frame.getByLabel('Файл исполнительной схемы').setInputFiles({ name: 'es-777.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF') });
  await upload.click();
  await expect(frame.getByText('файл загружен: es-777.pdf')).toBeVisible();
});
