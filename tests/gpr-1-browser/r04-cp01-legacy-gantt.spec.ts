import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

// R04 CP01 — the LEGACY object card (index.html → main.tsx → Gantt.tsx) with Early Works whose planned dates are NULL.
// Runs on the existing disposable PGlite + real backend harness of this config only.
for (const width of [1440, 390]) test(`R04 CP01 legacy Gantt lists Early Works without dates and keeps dated bars (${width}px)`, async ({ page, request }) => {
    const api = 'http://127.0.0.1:3001';
    const { token } = await (await request.post(api + '/auth/mock', { data: { role: 'PROJECT_MANAGER', key: 'gpr-1-browser-key' } })).json();
    const headers = { Authorization: 'Bearer ' + token };
    const snapshot = await (await request.get(api + '/snapshot', { headers })).json();
    const object = snapshot.objects.find((o: any) => o.name === 'Тест после удаления ролей');
    const dictionaries = await (await request.get(api + '/dictionaries', { headers })).json();
    const early = [
        { name: `CP01 без дат ${width}`, plannedStartDate: null, plannedFinishDate: null },
        { name: `CP01 только начало ${width}`, plannedStartDate: '2026-05-01', plannedFinishDate: null },
        { name: `CP01 только окончание ${width}`, plannedStartDate: null, plannedFinishDate: '2026-06-30' },
    ];
    for (const e of early) {
        const r = await request.post(api + '/works', { headers, data: { objectId: object.id, workTypeId: dictionaries.workTypes[0].id, unit: 'м²', plannedQuantity: '10', idempotencyKey: randomUUID(), ...e } });
        expect(r.status()).toBe(201);
    }
    const works = (await (await request.get(api + '/snapshot', { headers })).json()).works.filter((w: any) => w.objectId === object.id);
    const dated = works.filter((w: any) => w.plannedStartDate && w.plannedFinishDate);
    const undated = works.length - dated.length;
    expect(dated.length).toBeGreaterThan(0);
    expect(undated).toBeGreaterThanOrEqual(early.length);

    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(value => sessionStorage.setItem('session', value), token);
    const errors: string[] = [];
    page.on('pageerror', e => { errors.push(e.message); console.log('pageerror: ' + e.message); });
    await page.goto(`/objects/${object.id}`);
    await page.getByRole('tab', { name: 'График' }).click();
    const chart = page.locator('.gantt-scroll');
    await expect(chart).toBeVisible();
    for (const e of early) await expect(chart.getByText(e.name, { exact: true })).toBeVisible();
    await expect(chart.locator('.gantt-undated')).toHaveCount(undated);
    await expect(chart.locator('.gantt-undated').first()).toHaveText('Даты не определены');
    await expect(chart.locator('.gantt-bar-chip')).toHaveCount(dated.length);
    const geometry = await chart.locator('.gantt-bar-chip').evaluateAll(els => els.map(el => [(el as HTMLElement).style.left, (el as HTMLElement).style.width]));
    for (const [left, w] of geometry) { expect(Number.isFinite(parseFloat(left))).toBe(true); expect(Number.isFinite(parseFloat(w))).toBe(true); }
    await expect(chart.locator('.today')).toHaveCount(1);
    expect(await chart.innerText()).not.toMatch(/NaN|Invalid Date|undefined/);

    await page.goto('/schedule');
    await expect(page.getByRole('heading', { name: 'График производства работ' })).toBeVisible();
    await expect(page.locator('.gantt-scroll').getByText(early[0].name, { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
});
