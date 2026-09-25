import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * F8.1 decision 8, the specific regression named in the handoff: `accepted`
 * is computed once (read-service.ts's workScStatus map) and read by BOTH the
 * enriched work's own `accepted` field AND the work_dependencies blockers
 * check on its successor — proving that directly, over real HTTP, against
 * the real backend. A predecessor work with one accepted portion and one
 * unaccepted portion (of two) must still block its successor, not only fail
 * its own `accepted` field — the exact "fixed one call site, missed the
 * sibling" shape F4's corrective patches hit three times running.
 */
test('F8.1: a partially-accepted predecessor blocks its successor via work_dependencies, not only its own accepted field', async () => {
  if (!process.env.E2E_DATABASE_URL) delete process.env.DATABASE_URL;
  process.env.AUTH_MODE = 'mock';
  process.env.MOCK_LOGIN_KEY = 'f8-1-aggregate-key';
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
    const d = await req('auth/mock', { role, key: 'f8-1-aggregate-key' });
    token = d.token;
    return d.user;
  }
  const dt = (delta: number) => new Date(Date.now() + delta * 86400000).toISOString().slice(0, 10);

  try {
    const pm = await login('PROJECT_MANAGER');
    const dict = await req('dictionaries');
    const contractors = await req('contractors');
    await login('TECHNICAL_DIRECTOR');
    const o = await req('objects', { externalCode: 'F81-AGG-' + Date.now(), name: 'F8.1 агрегат приёмки', address: 'Тест, 1', organizationName: 'ООО СЗ «Гор-Строй»', projectManagerId: pm.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [contractors[0].id] });
    await login('PROJECT_MANAGER');
    const predecessor = await req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, responsibleUserId: pm.id, name: 'Предшествующая (частично принятая)', unit: 'м²', plannedQuantity: 500, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '100000' });
    const successor = await req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, responsibleUserId: pm.id, name: 'Последующая', unit: 'м²', plannedQuantity: 100, plannedStartDate: dt(11), plannedFinishDate: dt(20), estimatedCost: '50000' });
    await req('work-dependencies', { predecessorWorkId: predecessor.id, successorWorkId: successor.id, requiresAcceptance: true });

    // Two execution units on the predecessor, one portion each — this is the
    // minimal shape that distinguishes "some portion accepted" from "every
    // portion accepted".
    const unitA = await req('execution-units', { objectWorkId: predecessor.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, unit: 'м²', plannedQuantity: 300 });
    const unitB = await req('execution-units', { objectWorkId: predecessor.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, unit: 'м²', plannedQuantity: 200 });
    const portionA = await req(`execution-units/${unitA.id}/portions`, { label: 'Секция A', plannedQuantity: 300 });
    const portionB = await req(`execution-units/${unitB.id}/portions`, { label: 'Секция B', plannedQuantity: 200 });

    // Portion A: full fact, requested, accepted. recordPortionFact() returns
    // the confirmation row (its own version, unrelated) — the portion's own
    // version is bumped separately, so the next call tracks it as +1.
    await req(`portions/${portionA.id}/fact`, { quantity: 300, version: portionA.version, comment: 'Полный факт A' });
    const requestA = await req(`portions/${portionA.id}/inspection-request`, { inspectionType: 'INTERNAL_SC', version: portionA.version + 1 });
    await login('CONSTRUCTION_CONTROL');
    const upload = await req('attachments', { fileName: 'a.png', mimeType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=' });
    await req(`inspections/${requestA.id}/photos`, { attachmentId: upload.id });
    await req(`inspections/${requestA.id}/accept`, { version: requestA.version, comment: 'Секция A принята', quantity: 300 });

    // Portion B: full fact, requested, but left WAITING — deliberately not accepted.
    await login('PROJECT_MANAGER');
    await req(`portions/${portionB.id}/fact`, { quantity: 200, version: portionB.version, comment: 'Полный факт B' });
    await req(`portions/${portionB.id}/inspection-request`, { inspectionType: 'INTERNAL_SC', version: portionB.version + 1 });

    const snapshot = await req('snapshot');
    const predecessorRow = snapshot.works.find((w: any) => w.id === predecessor.id);
    const successorRow = snapshot.works.find((w: any) => w.id === successor.id);

    assert.equal(predecessorRow.accepted, false, 'one of two portions is still WAITING — the work-level aggregate must read false, not any-portion-accepted true');
    assert.ok(
      successorRow.blockers.some((b: string) => b.includes('Нет допуска строительного контроля')),
      `successor must be blocked by the incomplete predecessor; blockers were: ${JSON.stringify(successorRow.blockers)}`,
    );

    // Now accept portion B too — completion is real once every portion is,
    // and the block must lift through the same shared computation.
    await login('CONSTRUCTION_CONTROL');
    const requestB = (await req('snapshot')).inspections.find((i: any) => i.portionId === portionB.id);
    const uploadB = await req('attachments', { fileName: 'b.png', mimeType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=' });
    await req(`inspections/${requestB.id}/photos`, { attachmentId: uploadB.id });
    await req(`inspections/${requestB.id}/accept`, { version: requestB.version, comment: 'Секция B принята', quantity: 200 });

    const after = await req('snapshot');
    const predecessorAfter = after.works.find((w: any) => w.id === predecessor.id);
    const successorAfter = after.works.find((w: any) => w.id === successor.id);
    assert.equal(predecessorAfter.accepted, true, 'every portion of every unit is now accepted');
    assert.ok(
      !successorAfter.blockers.some((b: string) => b.includes('Нет допуска строительного контроля')),
      `successor must no longer be blocked; blockers were: ${JSON.stringify(successorAfter.blockers)}`,
    );

    // customerScAccepted stays a separate, independent field — never derived
    // from Internal SC completion (F8.1 clarification 2).
    assert.equal(predecessorAfter.customerScAccepted, false, 'no Customer SC inspection was ever requested for either portion');
  } finally {
    await app.close();
  }
});
