import { test, expect } from '@playwright/test';

/**
 * Companion to the unmodified ID-AUTO-1 embedded spec (same run, see playwright.bitrix-disk-1.config.ts): proves the files that spec
 * downloaded really live in Disk — not in the Core database — and that the browser-visible API never exposes the Disk side.
 */
let scenario: { token: string; pkgA: string; aosr: string; scheme: string };
test.beforeAll(async () => { scenario = await (await fetch('http://localhost:3002/scenario')).json(); });
const api = (path: string) => fetch(`http://127.0.0.1:3001/${path}`, { headers: { Authorization: 'Bearer ' + scenario.token } });

test('the scenario DOCX and executive scheme are stored in Bitrix Disk under the Object tree; Core serves them with its own name and headers', async () => {
  const disk: any = await (await fetch('http://localhost:3003/disk')).json();
  expect(disk.files.some((f: string) => /^Construction Core\/.+ \[[0-9a-f]{8}\]\/ПТО\/Исполнительная документация\/АОСР\/АОСР_1_.+ \[[0-9a-f]{8}\]\.docx$/.test(f))).toBe(true);
  expect(disk.files.some((f: string) => /\/Исполнительные схемы\/scheme \[[0-9a-f]{8}\]\.pdf$/.test(f))).toBe(true);
  expect(disk.leaked, 'no user identity / token in any Disk call').toBe(false);

  const docx = await api(`aosr/${scenario.aosr}/docx`);
  expect(docx.status).toBe(200);
  expect(docx.headers.get('cache-control')).toBe('private, no-store');
  expect(decodeURIComponent(docx.headers.get('content-disposition') ?? '')).toMatch(/filename\*=UTF-8''АОСР_1_.+\.docx$/);
  expect(Buffer.from(await docx.arrayBuffer()).subarray(0, 2).toString()).toBe('PK');

  const before = disk.downloads;
  const scheme = await api(`documentation-packages/${scenario.pkgA}/executive-schemes/${scenario.scheme}/file`);
  expect(scheme.status).toBe(200);
  expect(Buffer.from(await scheme.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');
  expect((await (await fetch('http://localhost:3003/disk')).json() as any).downloads).toBeGreaterThan(before);

  const snapshot = JSON.stringify(await (await api('snapshot')).json());
  expect(snapshot).not.toMatch(/externalFileId|externalFolderId|download\.json|SECRET-TOKEN|BITRIX_DISK/);
});
