import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * F8.1 Final Corrective Patch — Final Review, two remaining blockers:
 *   1. PortionCompletionService.unitCoverage() (and everything built on it —
 *      internalScStatus/customerScStatus/resolveInternalScAccepted, called
 *      identically by ReadService.snapshot() AND
 *      ProductionService.transition()) summed an accepted portion's own
 *      *planned* quantity, not what Internal/Customer SC actually
 *      confirmed. The review's own example: 500 planned, 500 RP fact, but
 *      Internal SC confirms only 100 — must read PARTIAL, not COMPLETE.
 *   2. `Number('')` is `0` in JavaScript — a blank "Подтверждённый объём"
 *      field on the W01 Internal SC decision form silently submitted a
 *      confirmed quantity of zero instead of being refused before the
 *      request was ever sent. Covered here as a browser-level, real-DOM
 *      proof that submission is blocked and no request reaches the backend;
 *      the parsing function's own character-level cases (whitespace,
 *      non-numeric, explicit zero) are unit-tested directly in
 *      tests/f8.1-w01-viewmodel.test.ts, no browser required.
 */

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=';

async function harness() {
  if (!process.env.E2E_DATABASE_URL) delete process.env.DATABASE_URL;
  process.env.AUTH_MODE = 'mock';
  process.env.MOCK_LOGIN_KEY = 'f8-1-final-key';
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
    const d = await req('auth/mock', { role, key: 'f8-1-final-key' });
    token = d.token;
    return d.user;
  }
  return { app, req, login };
}

const dt = (delta: number) => new Date(Date.now() + delta * 86400000).toISOString().slice(0, 10);

/* --------------------------------------------------------------------- *
 * Blocker 1 — acceptance must use the confirmed quantity, not the        *
 * portion's own planned quantity                                        *
 * --------------------------------------------------------------------- */

test('F8.1 Final: 500 planned / 500 RP fact / 100 Internal SC confirmed — the unit reads PARTIAL, not COMPLETE, and the work is not accepted', async () => {
  const { app, req, login } = await harness();
  try {
    const pm = await login('PROJECT_MANAGER');
    const dict = await req('dictionaries');
    const contractors = await req('contractors');
    await login('TECHNICAL_DIRECTOR');
    const o = await req('objects', { externalCode: 'F81FIN-PARTIAL-' + Date.now(), name: 'F8.1 Final частичное подтверждение', address: 'Тест, 1', organizationName: 'ООО СЗ «Гор-Строй»', projectManagerId: pm.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [contractors[0].id] });
    await login('PROJECT_MANAGER');
    const work = await req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, responsibleUserId: pm.id, name: 'Штукатурка (полное покрытие)', unit: 'м²', plannedQuantity: 500, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '100000' });
    const unit = await req('execution-units', { objectWorkId: work.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, unit: 'м²', plannedQuantity: 500 });
    const portion = await req(`execution-units/${unit.id}/portions`, { label: 'Секция A', plannedQuantity: 500 });

    await req(`portions/${portion.id}/fact`, { quantity: 500, version: portion.version, comment: 'Полный факт РП' });
    const request = await req(`portions/${portion.id}/inspection-request`, { inspectionType: 'INTERNAL_SC', version: portion.version + 1 });
    await login('CONSTRUCTION_CONTROL');
    const upload = await req('attachments', { fileName: 'a.png', mimeType: 'image/png', base64: PNG_BASE64 });
    await req(`inspections/${request.id}/photos`, { attachmentId: upload.id });
    // The review's own example: SC confirms only 100 of the 500 planned/RP-facted.
    const accepted = await req(`inspections/${request.id}/accept`, { version: request.version, comment: 'Подтверждено частично', quantity: 100 });
    assert.equal(accepted.status, 'ACCEPTED', 'the inspection itself is a real ACCEPTED decision — coverage is a separate question from acceptance');

    const snapshot = await req('snapshot');
    const unitRow = snapshot.executionUnits.find((u: any) => u.id === unit.id);
    assert.equal(unitRow.internalScStatus, 'PARTIAL', '100 confirmed of 500 planned must read PARTIAL, never COMPLETE just because the portion was accepted');
    const workRow = snapshot.works.find((w: any) => w.id === work.id);
    assert.equal(workRow.accepted, false, 'a PARTIAL unit must not make the whole work read as accepted');
  } finally {
    await app.close();
  }
});

test('F8.1 Final: 500 planned / Internal SC confirmed at 500 — the unit reads COMPLETE and the work is accepted', async () => {
  const { app, req, login } = await harness();
  try {
    const pm = await login('PROJECT_MANAGER');
    const dict = await req('dictionaries');
    const contractors = await req('contractors');
    await login('TECHNICAL_DIRECTOR');
    const o = await req('objects', { externalCode: 'F81FIN-COMPLETE-' + Date.now(), name: 'F8.1 Final полное подтверждение', address: 'Тест, 1', organizationName: 'ООО СЗ «Гор-Строй»', projectManagerId: pm.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [contractors[0].id] });
    await login('PROJECT_MANAGER');
    const work = await req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, responsibleUserId: pm.id, name: 'Штукатурка (полное покрытие)', unit: 'м²', plannedQuantity: 500, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '100000' });
    const unit = await req('execution-units', { objectWorkId: work.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, unit: 'м²', plannedQuantity: 500 });
    const portion = await req(`execution-units/${unit.id}/portions`, { label: 'Секция A', plannedQuantity: 500 });

    await req(`portions/${portion.id}/fact`, { quantity: 500, version: portion.version, comment: 'Полный факт РП' });
    const request = await req(`portions/${portion.id}/inspection-request`, { inspectionType: 'INTERNAL_SC', version: portion.version + 1 });
    await login('CONSTRUCTION_CONTROL');
    const upload = await req('attachments', { fileName: 'a.png', mimeType: 'image/png', base64: PNG_BASE64 });
    await req(`inspections/${request.id}/photos`, { attachmentId: upload.id });
    const accepted = await req(`inspections/${request.id}/accept`, { version: request.version, comment: 'Подтверждено полностью', quantity: 500 });
    assert.equal(accepted.status, 'ACCEPTED');

    const snapshot = await req('snapshot');
    const unitRow = snapshot.executionUnits.find((u: any) => u.id === unit.id);
    assert.equal(unitRow.internalScStatus, 'COMPLETE', '500 confirmed of 500 planned must read COMPLETE');
    const workRow = snapshot.works.find((w: any) => w.id === work.id);
    assert.equal(workRow.accepted, true);
  } finally {
    await app.close();
  }
});

test('F8.1 Final: transition()\'s own dependency gate also uses confirmed quantity — a partially-confirmed but ACCEPTED predecessor still blocks its successor', async () => {
  // The sibling call site: ReadService.snapshot() and
  // ProductionService.transition() each fetch and shape predecessor
  // portions independently (two separate SQL paths feeding the same
  // resolveInternalScAccepted()) — the two tests above only prove
  // snapshot()'s side. Fixing one and missing the other is exactly the
  // "F4's corrective patches hit three times running" shape this codebase's
  // own comments warn about.
  const { app, req, login } = await harness();
  try {
    const pm = await login('PROJECT_MANAGER');
    const dict = await req('dictionaries');
    const contractors = await req('contractors');
    await login('TECHNICAL_DIRECTOR');
    const o = await req('objects', { externalCode: 'F81FIN-TRANS-' + Date.now(), name: 'F8.1 Final transition confirmed quantity', address: 'Тест, 1', organizationName: 'ООО СЗ «Гор-Строй»', projectManagerId: pm.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [contractors[0].id] });
    await login('PROJECT_MANAGER');
    const predecessor = await req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, responsibleUserId: pm.id, name: 'Предшествующая', unit: 'м²', plannedQuantity: 200, plannedStartDate: dt(-5), plannedFinishDate: dt(5), estimatedCost: '40000' });
    const successor = await req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, responsibleUserId: pm.id, name: 'Последующая', unit: 'м²', plannedQuantity: 100, plannedStartDate: dt(6), plannedFinishDate: dt(20), estimatedCost: '20000' });
    await req('work-dependencies', { predecessorWorkId: predecessor.id, successorWorkId: successor.id, requiresAcceptance: true });

    const unit = await req('execution-units', { objectWorkId: predecessor.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, unit: 'м²', plannedQuantity: 200 });
    const portion = await req(`execution-units/${unit.id}/portions`, { label: 'Секция A', plannedQuantity: 200 });
    await req(`portions/${portion.id}/fact`, { quantity: 200, version: portion.version, comment: 'Полный факт' });
    const request = await req(`portions/${portion.id}/inspection-request`, { inspectionType: 'INTERNAL_SC', version: portion.version + 1 });
    await login('CONSTRUCTION_CONTROL');
    const upload = await req('attachments', { fileName: 'a.png', mimeType: 'image/png', base64: PNG_BASE64 });
    await req(`inspections/${request.id}/photos`, { attachmentId: upload.id });
    // ACCEPTED, but SC only confirms 50 of the unit's 200 planned — the old
    // accepted-boolean-driven transition() would read this predecessor as
    // fully accepted (the portion's own inspection status is ACCEPTED) and
    // unblock the successor regardless.
    await req(`inspections/${request.id}/accept`, { version: request.version, comment: 'Подтверждено частично', quantity: 50 });

    await login('PROJECT_MANAGER');
    const transition = await req(`works/${successor.id}/transition`);
    assert.equal(transition.allowed, false, 'transition() must block on confirmed coverage (50 of 200), not merely on the portion inspection being ACCEPTED');
    assert.ok(transition.reasons.some((r: string) => r.includes('строительного контроля')));

    const snapshot = await req('snapshot');
    const successorRow = snapshot.works.find((w: any) => w.id === successor.id);
    assert.ok(successorRow.blockers.some((b: string) => b.includes('Нет допуска строительного контроля')), 'the read model must agree with transition() — both derive from the same resolveInternalScAccepted()');
  } finally {
    await app.close();
  }
});
