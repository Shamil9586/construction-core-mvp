import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * F8.1 Corrective Patch Cycle — Independent Review, result NOT ACCEPTED.
 *
 * HTTP-level regression for the blockers confirmed real:
 *   F8.1-02 — partial vs complete execution-unit coverage, visible on the
 *             read model (executionUnits[].internalScStatus), not just
 *             correct internally.
 *   F8.1-03 — ProductionService.transition() (a real backend gate) and
 *             ReadService.snapshot()'s blockers must produce the same
 *             blocking decision for the same work, not two independent
 *             re-derivations that can disagree.
 *   F8.1-04 — a work with execution units treats them as its sole
 *             production fact source; the legacy progress() endpoint must
 *             refuse it outright, and a work with none must keep exact F7
 *             behaviour.
 *
 * F8.1-01 (accept creates a confirmation record) is covered at the direct
 * service level in tests/f8.1-quantity-confirmation.test.ts. F8.1-05
 * (snapshot validation) is a frontend-only concern, covered in
 * apps/frontend's own test file.
 */

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=';

async function harness() {
  if (!process.env.E2E_DATABASE_URL) delete process.env.DATABASE_URL;
  process.env.AUTH_MODE = 'mock';
  process.env.MOCK_LOGIN_KEY = 'f8-1-corrective-key';
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
    const d = await req('auth/mock', { role, key: 'f8-1-corrective-key' });
    token = d.token;
    return d.user;
  }
  return { app, req, login };
}

const dt = (delta: number) => new Date(Date.now() + delta * 86400000).toISOString().slice(0, 10);

/* --------------------------------------------------------------------- *
 * F8.1-02 — PARTIAL vs COMPLETE, visible on the read model               *
 * --------------------------------------------------------------------- */

test('F8.1-02: 500 planned / 100 portioned+accepted is PARTIAL, not COMPLETE; full coverage flips it to COMPLETE', async () => {
  const { app, req, login } = await harness();
  try {
    const pm = await login('PROJECT_MANAGER');
    const dict = await req('dictionaries');
    const contractors = await req('contractors');
    await login('TECHNICAL_DIRECTOR');
    const o = await req('objects', { externalCode: 'F81-COV-' + Date.now(), name: 'F8.1-02 coverage', address: 'Тест, 1', organizationName: 'ООО СЗ «Гор-Строй»', projectManagerId: pm.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [contractors[0].id] });
    await login('PROJECT_MANAGER');
    const work = await req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, responsibleUserId: pm.id, name: 'Штукатурка (покрытие)', unit: 'м²', plannedQuantity: 500, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '100000' });
    const unit = await req('execution-units', { objectWorkId: work.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, unit: 'м²', plannedQuantity: 500 });

    // Only 100 of the unit's 500 m² is ever portioned — the exact review example.
    const portionA = await req(`execution-units/${unit.id}/portions`, { label: 'Секция A', plannedQuantity: 100 });
    const factA = await req(`portions/${portionA.id}/fact`, { quantity: 100, version: portionA.version, comment: 'Полный факт A' });
    const requestA = await req(`portions/${portionA.id}/inspection-request`, { inspectionType: 'INTERNAL_SC', version: portionA.version + 1 });
    await login('CONSTRUCTION_CONTROL');
    const uploadA = await req('attachments', { fileName: 'a.png', mimeType: 'image/png', base64: PNG_BASE64 });
    await req(`inspections/${requestA.id}/photos`, { attachmentId: uploadA.id });
    await req(`inspections/${requestA.id}/accept`, { version: requestA.version, comment: 'Секция A принята', quantity: 100 });

    const partial = await req('snapshot');
    const unitPartial = partial.executionUnits.find((u: any) => u.id === unit.id);
    assert.equal(unitPartial.internalScStatus, 'PARTIAL', '100 of 500, fully accepted, must read PARTIAL — not the old any-created-portion-accepted bug');
    const workPartial = partial.works.find((w: any) => w.id === work.id);
    assert.equal(workPartial.accepted, false, 'a PARTIAL unit must never make the whole work read as accepted');

    // Cover the remaining 400 m² and accept it too — now the unit is genuinely complete.
    await login('PROJECT_MANAGER');
    const portionB = await req(`execution-units/${unit.id}/portions`, { label: 'Секция B', plannedQuantity: 400 });
    const factB = await req(`portions/${portionB.id}/fact`, { quantity: 400, version: portionB.version, comment: 'Полный факт B' });
    const requestB = await req(`portions/${portionB.id}/inspection-request`, { inspectionType: 'INTERNAL_SC', version: portionB.version + 1 });
    await login('CONSTRUCTION_CONTROL');
    const uploadB = await req('attachments', { fileName: 'b.png', mimeType: 'image/png', base64: PNG_BASE64 });
    await req(`inspections/${requestB.id}/photos`, { attachmentId: uploadB.id });
    await req(`inspections/${requestB.id}/accept`, { version: requestB.version, comment: 'Секция B принята', quantity: 400 });

    const complete = await req('snapshot');
    const unitComplete = complete.executionUnits.find((u: any) => u.id === unit.id);
    assert.equal(unitComplete.internalScStatus, 'COMPLETE', '100 + 400 = 500 of 500, fully accepted, must read COMPLETE');
    const workComplete = complete.works.find((w: any) => w.id === work.id);
    assert.equal(workComplete.accepted, true);
  } finally {
    await app.close();
  }
});

test('F8.1-02: zero portions on an execution unit is NONE, never COMPLETE', async () => {
  const { app, req, login } = await harness();
  try {
    const pm = await login('PROJECT_MANAGER');
    const dict = await req('dictionaries');
    const contractors = await req('contractors');
    await login('TECHNICAL_DIRECTOR');
    const o = await req('objects', { externalCode: 'F81-EMPTY-' + Date.now(), name: 'F8.1-02 empty unit', address: 'Тест, 1', organizationName: 'ООО СЗ «Гор-Строй»', projectManagerId: pm.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [contractors[0].id] });
    await login('PROJECT_MANAGER');
    const work = await req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, responsibleUserId: pm.id, name: 'Работа без участков', unit: 'м²', plannedQuantity: 200, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '50000' });
    const unit = await req('execution-units', { objectWorkId: work.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, unit: 'м²', plannedQuantity: 200 });

    const snapshot = await req('snapshot');
    const found = snapshot.executionUnits.find((u: any) => u.id === unit.id);
    assert.equal(found.internalScStatus, 'NONE');
    assert.equal(found.customerScStatus, 'NONE');
    const work2 = snapshot.works.find((w: any) => w.id === work.id);
    assert.equal(work2.accepted, false);
  } finally {
    await app.close();
  }
});

/* --------------------------------------------------------------------- *
 * F8.1-03 — the same acceptance semantics for the read model's blockers  *
 * and ProductionService.transition()'s own gate                         *
 * --------------------------------------------------------------------- */

test('F8.1-03: GET .../transition and the read model blockers agree, for a partially- then fully-accepted predecessor', async () => {
  const { app, req, login } = await harness();
  try {
    const pm = await login('PROJECT_MANAGER');
    const dict = await req('dictionaries');
    const contractors = await req('contractors');
    await login('TECHNICAL_DIRECTOR');
    const o = await req('objects', { externalCode: 'F81-TRANS-' + Date.now(), name: 'F8.1-03 transition agreement', address: 'Тест, 1', organizationName: 'ООО СЗ «Гор-Строй»', projectManagerId: pm.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [contractors[0].id] });
    await login('PROJECT_MANAGER');
    const predecessor = await req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, responsibleUserId: pm.id, name: 'Предшествующая', unit: 'м²', plannedQuantity: 500, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '100000' });
    const successor = await req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, responsibleUserId: pm.id, name: 'Последующая', unit: 'м²', plannedQuantity: 100, plannedStartDate: dt(11), plannedFinishDate: dt(20), estimatedCost: '50000' });
    await req('work-dependencies', { predecessorWorkId: predecessor.id, successorWorkId: successor.id, requiresAcceptance: true });

    const unitA = await req('execution-units', { objectWorkId: predecessor.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, unit: 'м²', plannedQuantity: 300 });
    const unitB = await req('execution-units', { objectWorkId: predecessor.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, unit: 'м²', plannedQuantity: 200 });
    const portionA = await req(`execution-units/${unitA.id}/portions`, { label: 'Секция A', plannedQuantity: 300 });
    const portionB = await req(`execution-units/${unitB.id}/portions`, { label: 'Секция B', plannedQuantity: 200 });

    await req(`portions/${portionA.id}/fact`, { quantity: 300, version: portionA.version, comment: 'Факт A' });
    const requestA = await req(`portions/${portionA.id}/inspection-request`, { inspectionType: 'INTERNAL_SC', version: portionA.version + 1 });
    await login('CONSTRUCTION_CONTROL');
    const uploadA = await req('attachments', { fileName: 'a.png', mimeType: 'image/png', base64: PNG_BASE64 });
    await req(`inspections/${requestA.id}/photos`, { attachmentId: uploadA.id });
    await req(`inspections/${requestA.id}/accept`, { version: requestA.version, comment: 'A принята', quantity: 300 });

    // Portion B stays untouched — the predecessor is only partially accepted.
    await login('PROJECT_MANAGER');
    const transitionPartial = await req(`works/${successor.id}/transition`);
    const snapshotPartial = await req('snapshot');
    const successorPartial = snapshotPartial.works.find((w: any) => w.id === successor.id);

    // The decision — allowed/blocked — is what F8.1-03 requires to agree; the
    // two callers keep their own existing wording (WorkTransitionPolicy's
    // "нет приёмки..." predates F8.1, ReadService's "Нет допуска..." is its
    // own blocker copy) — matching prose was never the bug, a diverging
    // accepted/not-accepted boolean was.
    assert.equal(transitionPartial.allowed, false, 'transition() must block the successor exactly when the read model does');
    assert.ok(transitionPartial.reasons.some((r: string) => r.includes('строительного контроля')));
    assert.ok(successorPartial.blockers.some((b: string) => b.includes('Нет допуска строительного контроля')));

    // Complete portion B too — full coverage, both views must agree it unblocks.
    await req(`portions/${portionB.id}/fact`, { quantity: 200, version: portionB.version, comment: 'Факт B' });
    const requestB = await req(`portions/${portionB.id}/inspection-request`, { inspectionType: 'INTERNAL_SC', version: portionB.version + 1 });
    await login('CONSTRUCTION_CONTROL');
    const uploadB = await req('attachments', { fileName: 'b.png', mimeType: 'image/png', base64: PNG_BASE64 });
    await req(`inspections/${requestB.id}/photos`, { attachmentId: uploadB.id });
    await req(`inspections/${requestB.id}/accept`, { version: requestB.version, comment: 'B принята', quantity: 200 });

    await login('PROJECT_MANAGER');
    const transitionComplete = await req(`works/${successor.id}/transition`);
    const snapshotComplete = await req('snapshot');
    const successorComplete = snapshotComplete.works.find((w: any) => w.id === successor.id);

    assert.equal(transitionComplete.allowed, true, 'transition() must unblock the successor exactly when the read model does');
    assert.ok(!successorComplete.blockers.some((b: string) => b.includes('Нет допуска строительного контроля')));
  } finally {
    await app.close();
  }
});

/* --------------------------------------------------------------------- *
 * F8.1-04 — execution units are the sole production fact source once     *
 * they exist; a work with none keeps exact F7 behaviour                  *
 * --------------------------------------------------------------------- */

test('F8.1-04: a work with no execution units keeps the legacy progress() endpoint working exactly as F7', async () => {
  const { app, req, login } = await harness();
  try {
    const pm = await login('PROJECT_MANAGER');
    const dict = await req('dictionaries');
    const contractors = await req('contractors');
    await login('TECHNICAL_DIRECTOR');
    const o = await req('objects', { externalCode: 'F81-LEGACY-' + Date.now(), name: 'F8.1-04 legacy work', address: 'Тест, 1', organizationName: 'ООО СЗ «Гор-Строй»', projectManagerId: pm.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [contractors[0].id] });
    await login('PROJECT_MANAGER');
    const work = await req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, responsibleUserId: pm.id, name: 'Обычная работа (без участков)', unit: 'м²', plannedQuantity: 200, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '50000' });

    const progressed = await req(`works/${work.id}/progress`, { totalQuantity: 150, version: work.version, comment: 'Обычный факт' });
    assert.equal(progressed.actualQuantity, '150.0000');

    const snapshot = await req('snapshot');
    const found = snapshot.works.find((w: any) => w.id === work.id);
    assert.equal(found.actualQuantity, '150.0000');
    assert.ok(found.lastReportedAt);
  } finally {
    await app.close();
  }
});

test('F8.1-04: a work with an execution unit refuses the legacy progress() endpoint outright — no second, competing fact source', async () => {
  const { app, req, login } = await harness();
  try {
    const pm = await login('PROJECT_MANAGER');
    const dict = await req('dictionaries');
    const contractors = await req('contractors');
    await login('TECHNICAL_DIRECTOR');
    const o = await req('objects', { externalCode: 'F81-DUAL-' + Date.now(), name: 'F8.1-04 dual source', address: 'Тест, 1', organizationName: 'ООО СЗ «Гор-Строй»', projectManagerId: pm.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [contractors[0].id] });
    await login('PROJECT_MANAGER');
    const work = await req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, responsibleUserId: pm.id, name: 'Работа с единицей исполнения', unit: 'м²', plannedQuantity: 400, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '80000' });
    const unit = await req('execution-units', { objectWorkId: work.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, unit: 'м²', plannedQuantity: 400 });

    // The legacy whole-work endpoint must now be refused outright.
    await req(`works/${work.id}/progress`, { totalQuantity: 100, version: work.version, comment: 'Не должно пройти' }, 400);

    // The portion path is the real, and only, fact source.
    const portion = await req(`execution-units/${unit.id}/portions`, { label: 'Секция A', plannedQuantity: 250 });
    await req(`portions/${portion.id}/fact`, { quantity: 250, version: portion.version, comment: 'Факт по участку' });

    const snapshot = await req('snapshot');
    const found = snapshot.works.find((w: any) => w.id === work.id);
    assert.equal(found.actualQuantity, '250.0000', "the work's actual quantity must come from the portion, never the untouched legacy column");
    assert.ok(found.lastReportedAt, 'factReported must become true from portion activity, not stay frozen at "never" once a unit exists');
    const unitRow = snapshot.executionUnits.find((u: any) => u.id === unit.id);
    assert.equal(unitRow.actualQuantity, '250.0000');
  } finally {
    await app.close();
  }
});
