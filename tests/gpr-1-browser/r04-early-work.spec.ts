import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

// Runs on the existing disposable PGlite + real Core UI harness only.
// R04 CP-02 (BR-01): the first pass looked for a standalone «Не назначен» node and expected «График не утверждён» without reading the object's
// GPR state; on this harness the object HAS an approved GPR, so an Early Work outside it is «Не включена в график». The schedule label is now
// asserted from the backend's own answer (GET /works/:id/schedule), and the no-baseline branch is exercised on an object without a GPR.
const API = 'http://127.0.0.1:3001';
const getOk = async (request: APIRequestContext, path: string, headers: Record<string, string>) => { const r = await request.get(API + path, { headers }); expect(r.status(), path).toBe(200); return r.json(); };
const login = async (request: APIRequestContext, role: string) => (await (await request.post(API + '/auth/mock', { data: { role, key: 'gpr-1-browser-key' } })).json()) as { token: string; user: any };
const SCHEDULE_LABEL = { NO_BASELINE: 'График не утверждён', NOT_SCHEDULED: 'Не включена в график' };

async function createEarlyWork(request: APIRequestContext, headers: Record<string, string>, objectId: string, name: string) {
    const dictionaries = await (await request.get(API + '/dictionaries', { headers })).json();
    const create = await request.post(API + '/works', { headers, data: { objectId, workTypeId: dictionaries.workTypes[0].id, name, unit: 'м²', plannedQuantity: '100', idempotencyKey: randomUUID() } });
    expect(create.status()).toBe(201);
    const work = await create.json();
    for (const f of ['contractorId', 'responsibleUserId', 'estimatedCost', 'plannedStartDate', 'plannedFinishDate']) expect(work[f], f).toBeNull();
    return work;
}

/** Everything W01 must say about an Early Work with no assignments and no dates, and the GPR state the backend reports for it. */
async function assertEarlyWorkW01(page: Page, request: APIRequestContext, headers: Record<string, string>, token: string, object: any, work: any, width: number) {
    const schedule = await getOk(request, `/works/${work.id}/schedule`, headers);
    expect(schedule.objectWorkId).toBe(work.id);
    const expected = schedule.hasBaseline ? (schedule.summary === null ? SCHEDULE_LABEL.NOT_SCHEDULED : null) : SCHEDULE_LABEL.NO_BASELINE;
    expect(expected, 'an Early Work just created is either outside the approved GPR or the object has none').not.toBeNull();
    const other = expected === SCHEDULE_LABEL.NO_BASELINE ? SCHEDULE_LABEL.NOT_SCHEDULED : SCHEDULE_LABEL.NO_BASELINE;

    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(value => sessionStorage.setItem('session', value), token);
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`/app.html/object/${object.id}/work/${work.id}`);
    const main = page.getByRole('main');

    // identity: the same Work, by id and name
    await expect(main.getByRole('heading', { level: 1, name: work.name })).toBeVisible();
    expect(new URL(page.url()).pathname).toContain(work.id);
    // the performer slot of the header: object · contractor, the contractor is unknown (snapshot 'Не назначен', no invented organisation)
    await expect(main.getByRole('paragraph').filter({ hasText: object.name })).toHaveText(`${object.name} · Не назначен`);
    // both assignments are named as the reasons production is blocked (W01 has no separate responsible field; no label is added for it)
    await expect(main.getByRole('heading', { level: 2, name: 'Причины блокировки' })).toBeVisible();
    await expect(main.getByRole('listitem').filter({ hasText: /^Не назначен подрядчик$/ })).toHaveCount(1);
    await expect(main.getByRole('listitem').filter({ hasText: /^Не назначен ответственный$/ })).toHaveCount(1);
    await expect(main.getByText('Заблокировано', { exact: true })).toBeVisible();
    // unknown provisional dates stay unknown
    for (const term of ['Плановое начало', 'Плановое окончание'])
        await expect(main.getByRole('term').filter({ hasText: new RegExp(`^${term}$`) }).locator('xpath=following-sibling::dd[1]')).toHaveText('—');
    // the GPR state, as the backend states it
    await expect(main.getByRole('heading', { level: 2, name: 'График производства работ' })).toBeVisible();
    await expect(main.getByText(expected!, { exact: true })).toBeVisible();
    await expect(main.getByText(other, { exact: true })).toHaveCount(0);
    await expect(main.getByText(expected === SCHEDULE_LABEL.NO_BASELINE
        ? 'График производства работ по объекту не утверждён — сроки работы не контролируются.'
        : 'Работа не включена в утверждённый график объекта.', { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
}

for (const width of [1440, 390]) {
    test(`R04 Early Work W01 keeps unknown planning values and identity — object with an approved GPR (${width}px)`, async ({ page, request }) => {
        const { token } = await login(request, 'PROJECT_MANAGER');
        const headers = { Authorization: 'Bearer ' + token };
        const snapshot = await (await request.get(API + '/snapshot', { headers })).json();
        const object = snapshot.objects.find((o: any) => o.name === 'Тест после удаления ролей');
        const objectSchedule = await getOk(request, `/objects/${object.id}/schedule`, headers);
        expect(objectSchedule.current, 'harness: this object has an approved GPR').toBeTruthy();
        const work = await createEarlyWork(request, headers, object.id, 'Ранняя работа ' + width);
        await assertEarlyWorkW01(page, request, headers, token, object, work, width);
    });

    test(`R04 Early Work W01 on an object without an approved GPR states «График не утверждён» (${width}px)`, async ({ page, request }) => {
        const pm = await login(request, 'PROJECT_MANAGER');
        const deputy = await login(request, 'DEPUTY_DIRECTOR');
        const deputyHeaders = { Authorization: 'Bearer ' + deputy.token };
        const contractors = await (await request.get(API + '/contractors', { headers: deputyHeaders })).json();
        const today = new Date().toISOString().slice(0, 10);
        const created = await request.post(API + '/objects', { headers: deputyHeaders, data: { externalCode: `R04-W01-${width}-${Date.now()}`, name: `R04 объект без графика ${width}`, address: 'г. Тест, ул. Ранняя, 1', organizationName: 'ООО Тест', projectManagerId: pm.user.id, startDate: today, plannedFinishDate: today, contractValue: '100000', contractorIds: [contractors[0].id] } });
        expect(created.status()).toBe(201);
        const object = await created.json();
        const headers = { Authorization: 'Bearer ' + pm.token };
        const objectSchedule = await getOk(request, `/objects/${object.id}/schedule`, headers);
        expect(objectSchedule.current ?? null, 'a new object has no approved GPR').toBeNull();
        const work = await createEarlyWork(request, headers, object.id, 'Ранняя работа без графика ' + width);
        await assertEarlyWorkW01(page, request, headers, pm.token, object, work, width);
    });
}
