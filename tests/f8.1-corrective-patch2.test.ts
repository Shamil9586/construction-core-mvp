import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * F8.1 Corrective Patch Cycle 2 — Independent Re-Review, three remaining
 * blockers:
 *   F8.1-01 — Internal SC / Customer SC acceptance must record an
 *             INDEPENDENTLY confirmed quantity, never a copy of the
 *             portion's latest RP_FACT.
 *   F8.1-03 — recordPortionFact() must honour the same production
 *             dependency rules as transition()/snapshot blockers: a
 *             blocked predecessor must prevent fact recording on the
 *             successor's portions too, not just on a whole-work
 *             progress() call.
 *   F8.1-04 — an execution unit's measurement unit and work type must be
 *             validated against its parent work at creation time (the
 *             aggregate-side defence — mixed units excluded from the sum,
 *             not blindly combined — is covered at the domain level in
 *             tests/production-execution.test.ts).
 */

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=';

async function harness() {
  if (!process.env.E2E_DATABASE_URL) delete process.env.DATABASE_URL;
  process.env.AUTH_MODE = 'mock';
  process.env.MOCK_LOGIN_KEY = 'f8-1-patch2-key';
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
    const d = await req('auth/mock', { role, key: 'f8-1-patch2-key' });
    token = d.token;
    return d.user;
  }
  return { app, req, login };
}

const dt = (delta: number) => new Date(Date.now() + delta * 86400000).toISOString().slice(0, 10);

/* --------------------------------------------------------------------- *
 * F8.1-01 v2 — independently confirmed quantity, never copied from      *
 * RP_FACT                                                                *
 * --------------------------------------------------------------------- */

test('F8.1-01 v2: RP_FACT 500 / Internal SC 498 / Customer SC 496 all persist independently, never copied', async () => {
  const { app, req, login } = await harness();
  try {
    const pm = await login('PROJECT_MANAGER');
    const dict = await req('dictionaries');
    const contractors = await req('contractors');
    await login('TECHNICAL_DIRECTOR');
    const o = await req('objects', { externalCode: 'F81P2-QTY-' + Date.now(), name: 'F8.1-01 v2 независимая величина', address: 'Тест, 1', organizationName: 'ООО СЗ «Гор-Строй»', projectManagerId: pm.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [contractors[0].id] });
    await login('PROJECT_MANAGER');
    const work = await req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, responsibleUserId: pm.id, name: 'Штукатурка', unit: 'м²', plannedQuantity: 500, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '100000' });
    const unit = await req('execution-units', { objectWorkId: work.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, unit: 'м²', plannedQuantity: 500 });
    const portion = await req(`execution-units/${unit.id}/portions`, { label: 'Секция A', plannedQuantity: 500 });

    await req(`portions/${portion.id}/fact`, { quantity: 500, version: portion.version, comment: 'Полный факт' });
    const internalRequest = await req(`portions/${portion.id}/inspection-request`, { inspectionType: 'INTERNAL_SC', version: portion.version + 1 });

    await login('CONSTRUCTION_CONTROL');
    const uploadA = await req('attachments', { fileName: 'a.png', mimeType: 'image/png', base64: PNG_BASE64 });
    await req(`inspections/${internalRequest.id}/photos`, { attachmentId: uploadA.id });
    // The reviewed example's own number — deliberately different from RP_FACT's 500.
    const internalAccepted = await req(`inspections/${internalRequest.id}/accept`, { version: internalRequest.version, comment: 'Принято с расхождением', quantity: 498 });
    assert.equal(internalAccepted.status, 'ACCEPTED');

    await login('PROJECT_MANAGER');
    // Portion version: 1 (created) -> 2 (fact) -> 3 (first inspection-request).
    // inspectionAction() bumps the inspection's own version, not the
    // portion's, so the portion is still at 3 here.
    const customerRequest = await req(`portions/${portion.id}/inspection-request`, { inspectionType: 'CUSTOMER_SC', version: portion.version + 2 });
    await login('CONSTRUCTION_CONTROL');
    const uploadB = await req('attachments', { fileName: 'b.png', mimeType: 'image/png', base64: PNG_BASE64 });
    await req(`inspections/${customerRequest.id}/photos`, { attachmentId: uploadB.id });
    const customerAccepted = await req(`inspections/${customerRequest.id}/accept`, { version: customerRequest.version, comment: 'Заказчик принял с расхождением', quantity: 496 });
    assert.equal(customerAccepted.status, 'ACCEPTED');

    const snapshot = await req('snapshot');
    const portionRow = snapshot.portions.find((p: any) => p.id === portion.id);
    assert.equal(portionRow.rpFactQuantity, '500.0000');
    assert.equal(portionRow.internalScConfirmedQuantity, '498.0000', 'Internal SC must record its own inspector-confirmed figure, not a copy of RP_FACT');
    assert.equal(portionRow.customerScConfirmedQuantity, '496.0000', 'Customer SC must record its own figure too, independent of both RP_FACT and Internal SC');

    const history = snapshot.portionConfirmations.filter((c: any) => c.portionId === portion.id);
    assert.equal(history.length, 3, 'RP_FACT + INTERNAL_SC + CUSTOMER_SC, three independent rows');
    const bySource = Object.fromEntries(history.map((c: any) => [c.source, c.quantity]));
    assert.equal(bySource.RP_FACT, '500.0000');
    assert.equal(bySource.INTERNAL_SC, '498.0000');
    assert.equal(bySource.CUSTOMER_SC, '496.0000');
  } finally {
    await app.close();
  }
});

test('F8.1-01 v2: accepting a portion-scoped inspection without a quantity is rejected — no silent default, no copy', async () => {
  const { app, req, login } = await harness();
  try {
    const pm = await login('PROJECT_MANAGER');
    const dict = await req('dictionaries');
    const contractors = await req('contractors');
    await login('TECHNICAL_DIRECTOR');
    const o = await req('objects', { externalCode: 'F81P2-NOQTY-' + Date.now(), name: 'F8.1-01 v2 без величины', address: 'Тест, 1', organizationName: 'ООО СЗ «Гор-Строй»', projectManagerId: pm.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [contractors[0].id] });
    await login('PROJECT_MANAGER');
    const work = await req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, responsibleUserId: pm.id, name: 'Работа', unit: 'м²', plannedQuantity: 100, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '20000' });
    const unit = await req('execution-units', { objectWorkId: work.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, unit: 'м²', plannedQuantity: 100 });
    const portion = await req(`execution-units/${unit.id}/portions`, { label: 'Секция A', plannedQuantity: 100 });
    await req(`portions/${portion.id}/fact`, { quantity: 100, version: portion.version, comment: 'Факт' });
    const request = await req(`portions/${portion.id}/inspection-request`, { inspectionType: 'INTERNAL_SC', version: portion.version + 1 });

    await login('CONSTRUCTION_CONTROL');
    const upload = await req('attachments', { fileName: 'a.png', mimeType: 'image/png', base64: PNG_BASE64 });
    await req(`inspections/${request.id}/photos`, { attachmentId: upload.id });
    await req(`inspections/${request.id}/accept`, { version: request.version, comment: 'Без величины' }, 400);
  } finally {
    await app.close();
  }
});

test('F8.1-01 v2: a whole-work (non-portioned) inspection still accepts without a quantity — exact F7 behaviour preserved', async () => {
  const { app, req, login } = await harness();
  try {
    const pm = await login('PROJECT_MANAGER');
    const dict = await req('dictionaries');
    const contractors = await req('contractors');
    await login('TECHNICAL_DIRECTOR');
    const o = await req('objects', { externalCode: 'F81P2-LEGACY-' + Date.now(), name: 'F8.1-01 v2 обычная работа', address: 'Тест, 1', organizationName: 'ООО СЗ «Гор-Строй»', projectManagerId: pm.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [contractors[0].id] });
    await login('PROJECT_MANAGER');
    const work = await req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, responsibleUserId: pm.id, name: 'Обычная работа', unit: 'м²', plannedQuantity: 100, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '20000' });
    await req(`works/${work.id}/progress`, { totalQuantity: 100, version: work.version, comment: 'Факт' });
    const request = await req(`works/${work.id}/inspection-request`, { version: work.version + 1 });

    await login('CONSTRUCTION_CONTROL');
    const upload = await req('attachments', { fileName: 'a.png', mimeType: 'image/png', base64: PNG_BASE64 });
    await req(`inspections/${request.id}/photos`, { attachmentId: upload.id });
    const accepted = await req(`inspections/${request.id}/accept`, { version: request.version, comment: 'Принято' });
    assert.equal(accepted.status, 'ACCEPTED');
  } finally {
    await app.close();
  }
});

/* --------------------------------------------------------------------- *
 * F8.1-03 v2 — recordPortionFact() honours the same dependency rules     *
 * as transition()/snapshot blockers                                     *
 * --------------------------------------------------------------------- */

test('F8.1-03 v2: recordPortionFact is refused while the predecessor is not yet accepted, and works once it is', async () => {
  const { app, req, login } = await harness();
  try {
    const pm = await login('PROJECT_MANAGER');
    const dict = await req('dictionaries');
    const contractors = await req('contractors');
    await login('TECHNICAL_DIRECTOR');
    const o = await req('objects', { externalCode: 'F81P2-DEP-' + Date.now(), name: 'F8.1-03 v2 зависимость факта', address: 'Тест, 1', organizationName: 'ООО СЗ «Гор-Строй»', projectManagerId: pm.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [contractors[0].id] });
    await login('PROJECT_MANAGER');
    const predecessor = await req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, responsibleUserId: pm.id, name: 'Предшествующая', unit: 'м²', plannedQuantity: 100, plannedStartDate: dt(-5), plannedFinishDate: dt(5), estimatedCost: '20000' });
    const successor = await req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, responsibleUserId: pm.id, name: 'Последующая', unit: 'м²', plannedQuantity: 200, plannedStartDate: dt(6), plannedFinishDate: dt(20), estimatedCost: '40000' });
    await req('work-dependencies', { predecessorWorkId: predecessor.id, successorWorkId: successor.id, requiresAcceptance: true });

    const unit = await req('execution-units', { objectWorkId: successor.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, unit: 'м²', plannedQuantity: 200 });
    const portion = await req(`execution-units/${unit.id}/portions`, { label: 'Секция A', plannedQuantity: 200 });

    // Predecessor is entirely untouched (0 of 100) — recordPortionFact on the
    // successor's own portion must be blocked by the same dependency rule
    // transition()/the read model already enforce, not merely the portion's
    // own freeze guard (which has nothing to say here — no inspection was
    // ever requested on this portion).
    await req(`portions/${portion.id}/fact`, { quantity: 50, version: portion.version, comment: 'Не должно пройти' }, 400);

    // Complete and accept the predecessor.
    await req(`works/${predecessor.id}/progress`, { totalQuantity: 100, version: predecessor.version, comment: 'Факт' });
    const request = await req(`works/${predecessor.id}/inspection-request`, { version: predecessor.version + 1 });
    await login('CONSTRUCTION_CONTROL');
    const upload = await req('attachments', { fileName: 'a.png', mimeType: 'image/png', base64: PNG_BASE64 });
    await req(`inspections/${request.id}/photos`, { attachmentId: upload.id });
    await req(`inspections/${request.id}/accept`, { version: request.version, comment: 'Принято' });

    // Now the successor's own portion fact must go through.
    await login('PROJECT_MANAGER');
    const recorded = await req(`portions/${portion.id}/fact`, { quantity: 50, version: portion.version, comment: 'Теперь можно' });
    assert.equal(recorded.quantity, '50.0000');
  } finally {
    await app.close();
  }
});

test('F8.1-03 v2: a work with no dependency at all is unaffected — recordPortionFact works exactly as before', async () => {
  const { app, req, login } = await harness();
  try {
    const pm = await login('PROJECT_MANAGER');
    const dict = await req('dictionaries');
    const contractors = await req('contractors');
    await login('TECHNICAL_DIRECTOR');
    const o = await req('objects', { externalCode: 'F81P2-NODEP-' + Date.now(), name: 'F8.1-03 v2 без зависимости', address: 'Тест, 1', organizationName: 'ООО СЗ «Гор-Строй»', projectManagerId: pm.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [contractors[0].id] });
    await login('PROJECT_MANAGER');
    const work = await req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, responsibleUserId: pm.id, name: 'Независимая работа', unit: 'м²', plannedQuantity: 100, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '20000' });
    const unit = await req('execution-units', { objectWorkId: work.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, unit: 'м²', plannedQuantity: 100 });
    const portion = await req(`execution-units/${unit.id}/portions`, { label: 'Секция A', plannedQuantity: 100 });
    const recorded = await req(`portions/${portion.id}/fact`, { quantity: 100, version: portion.version, comment: 'Факт' });
    assert.equal(recorded.quantity, '100.0000');
  } finally {
    await app.close();
  }
});

/* --------------------------------------------------------------------- *
 * F8.1-04 v2 — createExecutionUnit() rejects a measurement-unit or        *
 * work-type mismatch against its parent work                            *
 * --------------------------------------------------------------------- */

test('F8.1-04 v2: an execution unit measured differently from its parent work is refused', async () => {
  const { app, req, login } = await harness();
  try {
    const pm = await login('PROJECT_MANAGER');
    const dict = await req('dictionaries');
    const contractors = await req('contractors');
    await login('TECHNICAL_DIRECTOR');
    const o = await req('objects', { externalCode: 'F81P2-UNIT-' + Date.now(), name: 'F8.1-04 v2 несовместимая единица', address: 'Тест, 1', organizationName: 'ООО СЗ «Гор-Строй»', projectManagerId: pm.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [contractors[0].id] });
    await login('PROJECT_MANAGER');
    const work = await req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, responsibleUserId: pm.id, name: 'Работа в м²', unit: 'м²', plannedQuantity: 100, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '20000' });
    await req('execution-units', { objectWorkId: work.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, unit: 'м³', plannedQuantity: 100 }, 400);
  } finally {
    await app.close();
  }
});

test('F8.1-04 v2: an execution unit whose work type disagrees with its parent work is refused', async () => {
  const { app, req, login } = await harness();
  try {
    const pm = await login('PROJECT_MANAGER');
    const dict = await req('dictionaries');
    const contractors = await req('contractors');
    assert.ok(dict.workTypes.length > 1, 'seed must provide at least two distinct work types for this test to be meaningful');
    await login('TECHNICAL_DIRECTOR');
    const o = await req('objects', { externalCode: 'F81P2-TYPE-' + Date.now(), name: 'F8.1-04 v2 несовместимый вид работ', address: 'Тест, 1', organizationName: 'ООО СЗ «Гор-Строй»', projectManagerId: pm.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [contractors[0].id] });
    await login('PROJECT_MANAGER');
    const work = await req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, responsibleUserId: pm.id, name: 'Работа вида 0', unit: 'м²', plannedQuantity: 100, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '20000' });
    await req('execution-units', { objectWorkId: work.id, workTypeId: dict.workTypes[1].id, contractorId: contractors[0].id, unit: 'м²', plannedQuantity: 100 }, 400);
  } finally {
    await app.close();
  }
});

test('F8.1-04 v2: a matching measurement unit and work type still creates the execution unit normally', async () => {
  const { app, req, login } = await harness();
  try {
    const pm = await login('PROJECT_MANAGER');
    const dict = await req('dictionaries');
    const contractors = await req('contractors');
    await login('TECHNICAL_DIRECTOR');
    const o = await req('objects', { externalCode: 'F81P2-OK-' + Date.now(), name: 'F8.1-04 v2 совместимо', address: 'Тест, 1', organizationName: 'ООО СЗ «Гор-Строй»', projectManagerId: pm.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [contractors[0].id] });
    await login('PROJECT_MANAGER');
    const work = await req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, responsibleUserId: pm.id, name: 'Работа', unit: 'м²', plannedQuantity: 100, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '20000' });
    const unit = await req('execution-units', { objectWorkId: work.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, unit: 'м²', plannedQuantity: 100 });
    assert.equal(unit.unit, 'м²');
  } finally {
    await app.close();
  }
});
