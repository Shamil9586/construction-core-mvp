import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Phase 3 added four new top-level snapshot collections (executionUnits,
 * executionUnitLayers, portions, portionConfirmations), all sourced from the
 * same `enriched`/`works` data CONTRACTOR_VIEWER's branch already redacts
 * money fields from. ReadService.snapshot()'s CONTRACTOR_VIEWER return
 * statement is a separate object literal from the internal-role one — it's
 * easy to add a new collection to the internal return and forget the
 * CONTRACTOR_VIEWER one exists at all, silently leaking Internal/Customer SC
 * control data to an external role that the domain contract says must never
 * see it. This proves the four keys are absent, not merely empty, so the
 * check also catches "gated but returns []" as well as "not gated at all".
 */
test('F8.1: CONTRACTOR_VIEWER snapshot omits the new execution-unit/portion collections entirely', async () => {
  if (!process.env.E2E_DATABASE_URL) delete process.env.DATABASE_URL;
  process.env.AUTH_MODE = 'mock';
  process.env.MOCK_LOGIN_KEY = 'f8-1-contractor-viewer-key';
  process.env.DB_MODE = process.env.E2E_DATABASE_URL ? 'postgres' : 'pglite';
  process.env.PGLITE_DIR = 'memory://';
  if (process.env.E2E_DATABASE_URL) process.env.DATABASE_URL = process.env.E2E_DATABASE_URL;

  const { migrate } = await import('../scripts/migrate');
  const { seed } = await import('../scripts/seed');
  const { createApp } = await import('../apps/backend/src/main');
  await migrate();
  await seed();
  const app = await createApp();
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  const base = `http://127.0.0.1:${address.port}`;
  let token = '';
  async function req(path: string, body?: any, expected = body === undefined ? 200 : 201) {
    const r = await fetch(base + '/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data: any = await r.json();
    assert.equal(r.status, expected, path + ': ' + JSON.stringify(data));
    return data;
  }
  async function login(role: string) {
    const d = await req('auth/mock', { role, key: 'f8-1-contractor-viewer-key' });
    token = d.token;
    return d.user;
  }
  const dt = (delta: number) => new Date(Date.now() + delta * 86400000).toISOString().slice(0, 10);

  try {
    const pm = await login('PROJECT_MANAGER');
    const dict = await req('dictionaries');
    const contractors = await req('contractors');
    await login('TECHNICAL_DIRECTOR');
    const o = await req('objects', { externalCode: 'F81-CV-' + Date.now(), name: 'F8.1 CONTRACTOR_VIEWER scope', address: 'Тест, 1', organizationName: 'ООО СЗ «Гор-Строй»', projectManagerId: pm.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [contractors[0].id] });
    await login('PROJECT_MANAGER');
    const work = await req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, responsibleUserId: pm.id, name: 'Работа для проверки видимости', unit: 'м²', plannedQuantity: 100, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '10000' });
    const unit = await req('execution-units', { objectWorkId: work.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, unit: 'м²', plannedQuantity: 100 });
    await req(`execution-units/${unit.id}/portions`, { label: 'Секция 1', plannedQuantity: 100 });

    // Sanity: the internal role that created this data really does see the
    // new collections, and they are really non-empty for this tenant.
    const internalSnapshot = await req('snapshot');
    assert.ok(internalSnapshot.executionUnits.some((u: any) => u.id === unit.id), 'internal snapshot must include the execution unit just created');
    assert.ok(internalSnapshot.portions.length > 0, 'internal snapshot must include at least one portion');

    await login('CONTRACTOR_VIEWER');
    const snap = await req('snapshot');
    assert.equal(snap.executionUnits, undefined, 'CONTRACTOR_VIEWER must not receive executionUnits at all');
    assert.equal(snap.executionUnitLayers, undefined, 'CONTRACTOR_VIEWER must not receive executionUnitLayers at all');
    assert.equal(snap.portions, undefined, 'CONTRACTOR_VIEWER must not receive portions at all');
    assert.equal(snap.portionConfirmations, undefined, 'CONTRACTOR_VIEWER must not receive portionConfirmations at all');
    // And the response is a real CONTRACTOR_VIEWER snapshot, not an error page.
    assert.ok(Array.isArray(snap.objects));
    assert.ok(Array.isArray(snap.works));
    assert.ok(Array.isArray(snap.contractors));
  } finally {
    await app.close();
  }
});
