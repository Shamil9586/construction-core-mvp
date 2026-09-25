import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * F8.2.1 PTO Operations Layer — HTTP-level. Step 3 ("Backend: добавить API.
 * Проверить: auth; permissions; object scope; tenant isolation"), over the
 * real backend, PGlite.
 *
 * Package creation, portion linking, document/version creation are already
 * covered end-to-end in tests/f8.2-documentation-http.test.ts (F8.2) — this
 * file covers only what F8.2.1 actually adds: status transition
 * enforcement (Decision 5) and the PTO Attention Queue (Decision 4).
 */

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=';

const dt = (delta: number) => new Date(Date.now() + delta * 86400000).toISOString().slice(0, 10);

async function harness() {
  if (!process.env.E2E_DATABASE_URL) delete process.env.DATABASE_URL;
  process.env.AUTH_MODE = 'mock';
  process.env.MOCK_LOGIN_KEY = 'f8-2-1-http-key';
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
    const d = await req('auth/mock', { role, key: 'f8-2-1-http-key' });
    token = d.token;
    return d.user;
  }
  return { app, req, login };
}

async function setUpObjectAndWork(req: any, login: any, externalCode: string, name: string) {
  const pm = await login('PROJECT_MANAGER');
  const dict = await req('dictionaries');
  const contractors = await req('contractors');
  await login('TECHNICAL_DIRECTOR');
  const o = await req('objects', { externalCode, name, address: 'Тест, 1', organizationName: 'ООО СЗ «Гор-Строй»', projectManagerId: pm.id, startDate: dt(-5), plannedFinishDate: dt(60), contractValue: '1000000', contractorIds: [contractors[0].id] });
  await login('PROJECT_MANAGER');
  const work = await req('works', { objectId: o.id, workTypeId: dict.workTypes[0].id, contractorId: contractors[0].id, responsibleUserId: pm.id, name: 'Работа', unit: 'м²', plannedQuantity: 100, plannedStartDate: dt(-5), plannedFinishDate: dt(10), estimatedCost: '20000' });
  return { pm, o, work };
}

/* --------------------------------------------------------------------- *
 * Decision 5 — status transition rules                                   *
 * --------------------------------------------------------------------- */

test('F8.2.1 HTTP: DRAFT -> PREPARING passes, DRAFT -> PRESENTED is refused (400), the Decision Lock\'s own named examples', async () => {
  const { app, req, login } = await harness();
  try {
    const { work } = await setUpObjectAndWork(req, login, 'F821-TRANS-' + Date.now(), 'F8.2.1 переходы статусов');
    const pto = await login('PTO');
    const pkg = await req('documentation-packages', { objectWorkId: work.id, responsibleUserId: pto.id });
    assert.equal(pkg.status, 'DRAFT');

    // Explicitly forbidden first, before the allowed one — proves the DRAFT
    // row is untouched by the rejected attempt (checkVersion would fail on
    // the next call if the reject had silently bumped the version).
    await req(`documentation-packages/${pkg.id}/status`, { status: 'PRESENTED', version: pkg.version }, 400);
    await req(`documentation-packages/${pkg.id}/status`, { status: 'ACCEPTED_BY_CUSTOMER', version: pkg.version }, 400);

    const prepared = await req(`documentation-packages/${pkg.id}/status`, { status: 'PREPARING', version: pkg.version });
    assert.equal(prepared.status, 'PREPARING');
  } finally {
    await app.close();
  }
});

test('F8.2.1 HTTP (Corrective F8.2.1-01): the full allowed chain succeeds end to end — DRAFT -> PREPARING -> READY_FOR_PRESENTATION -> PRESENTED -> RETURNED -> CORRECTING -> PRESENTED, the correction loop', async () => {
  const { app, req, login } = await harness();
  try {
    const { work } = await setUpObjectAndWork(req, login, 'F821-CHAIN-' + Date.now(), 'F8.2.1 полная цепочка');
    const pto = await login('PTO');
    let pkg = await req('documentation-packages', { objectWorkId: work.id, responsibleUserId: pto.id });

    pkg = await req(`documentation-packages/${pkg.id}/status`, { status: 'PREPARING', version: pkg.version });
    assert.equal(pkg.status, 'PREPARING');
    pkg = await req(`documentation-packages/${pkg.id}/status`, { status: 'READY_FOR_PRESENTATION', version: pkg.version });
    assert.equal(pkg.status, 'READY_FOR_PRESENTATION');
    pkg = await req(`documentation-packages/${pkg.id}/status`, { status: 'PRESENTED', version: pkg.version });
    assert.equal(pkg.status, 'PRESENTED');
    pkg = await req(`documentation-packages/${pkg.id}/status`, { status: 'RETURNED', version: pkg.version });
    assert.equal(pkg.status, 'RETURNED');

    // F8.2.1-01 — RETURNED is no longer a dead end: it now completes the
    // correction loop back to PRESENTED.
    pkg = await req(`documentation-packages/${pkg.id}/status`, { status: 'CORRECTING', version: pkg.version });
    assert.equal(pkg.status, 'CORRECTING');
    // CORRECTING does not skip back to READY_FOR_PRESENTATION.
    await req(`documentation-packages/${pkg.id}/status`, { status: 'READY_FOR_PRESENTATION', version: pkg.version }, 400);
    pkg = await req(`documentation-packages/${pkg.id}/status`, { status: 'PRESENTED', version: pkg.version });
    assert.equal(pkg.status, 'PRESENTED');

    // The loop can repeat: a second RETURNED -> CORRECTING -> PRESENTED pass.
    pkg = await req(`documentation-packages/${pkg.id}/status`, { status: 'RETURNED', version: pkg.version });
    pkg = await req(`documentation-packages/${pkg.id}/status`, { status: 'CORRECTING', version: pkg.version });
    pkg = await req(`documentation-packages/${pkg.id}/status`, { status: 'PRESENTED', version: pkg.version });
    assert.equal(pkg.status, 'PRESENTED');
  } finally {
    await app.close();
  }
});

test('F8.2.1 HTTP (Corrective F8.2.1-01): CORRECTING is reachable only through RETURNED, never directly from DRAFT/PREPARING/READY_FOR_PRESENTATION/PRESENTED', async () => {
  const { app, req, login } = await harness();
  try {
    const { work } = await setUpObjectAndWork(req, login, 'F821-CORR-GUARD-' + Date.now(), 'F8.2.1 защита CORRECTING');
    const pto = await login('PTO');
    const pkg = await req('documentation-packages', { objectWorkId: work.id, responsibleUserId: pto.id });

    // DRAFT -> CORRECTING is not a listed edge.
    await req(`documentation-packages/${pkg.id}/status`, { status: 'CORRECTING', version: pkg.version }, 400);

    const prepared = await req(`documentation-packages/${pkg.id}/status`, { status: 'PREPARING', version: pkg.version });
    // PREPARING -> CORRECTING is not a listed edge either.
    await req(`documentation-packages/${pkg.id}/status`, { status: 'CORRECTING', version: prepared.version }, 400);

    const ready = await req(`documentation-packages/${pkg.id}/status`, { status: 'READY_FOR_PRESENTATION', version: prepared.version });
    await req(`documentation-packages/${pkg.id}/status`, { status: 'CORRECTING', version: ready.version }, 400);

    const presented = await req(`documentation-packages/${pkg.id}/status`, { status: 'PRESENTED', version: ready.version });
    // PRESENTED must go through RETURNED first, not straight to CORRECTING.
    await req(`documentation-packages/${pkg.id}/status`, { status: 'CORRECTING', version: presented.version }, 400);
  } finally {
    await app.close();
  }
});

test('F8.2.1 HTTP: a backward or skip-ahead transition is refused even for an otherwise-valid target status', async () => {
  const { app, req, login } = await harness();
  try {
    const { work } = await setUpObjectAndWork(req, login, 'F821-SKIP-' + Date.now(), 'F8.2.1 пропуск шага');
    const pto = await login('PTO');
    const pkg = await req('documentation-packages', { objectWorkId: work.id, responsibleUserId: pto.id });
    // DRAFT -> READY_FOR_PRESENTATION skips PREPARING entirely.
    await req(`documentation-packages/${pkg.id}/status`, { status: 'READY_FOR_PRESENTATION', version: pkg.version }, 400);
    const prepared = await req(`documentation-packages/${pkg.id}/status`, { status: 'PREPARING', version: pkg.version });
    // PREPARING -> DRAFT goes backward.
    await req(`documentation-packages/${pkg.id}/status`, { status: 'DRAFT', version: prepared.version }, 400);
  } finally {
    await app.close();
  }
});

/* --------------------------------------------------------------------- *
 * Decision 4 — PTO Attention Queue                                       *
 * --------------------------------------------------------------------- */

test('F8.2.1 HTTP: a work with no package appears in the queue; READY_FOR_PRESENTATION clears it', async () => {
  const { app, req, login } = await harness();
  try {
    const { work } = await setUpObjectAndWork(req, login, 'F821-QUEUE-' + Date.now(), 'F8.2.1 очередь ПТО');
    const pto = await login('PTO');

    const before = await req('snapshot');
    const beforeItem = before.documentationAttentionQueue.find((item: any) => item.objectWorkId === work.id);
    assert.ok(beforeItem, 'a work with no documentation package at all must appear in the queue');
    assert.equal(beforeItem.level, 'RED');

    let pkg = await req('documentation-packages', { objectWorkId: work.id, responsibleUserId: pto.id });
    const afterCreate = await req('snapshot');
    const afterCreateItem = afterCreate.documentationAttentionQueue.find((item: any) => item.objectWorkId === work.id);
    assert.ok(afterCreateItem, 'DRAFT still needs attention');
    assert.equal(afterCreateItem.level, 'YELLOW');

    pkg = await req(`documentation-packages/${pkg.id}/status`, { status: 'PREPARING', version: pkg.version });
    pkg = await req(`documentation-packages/${pkg.id}/status`, { status: 'READY_FOR_PRESENTATION', version: pkg.version });

    const after = await req('snapshot');
    const afterItem = after.documentationAttentionQueue.find((item: any) => item.objectWorkId === work.id);
    assert.equal(afterItem, undefined, 'READY_FOR_PRESENTATION must clear the queue for this work');
  } finally {
    await app.close();
  }
});

test('F8.2.1 HTTP: the queue is excluded for SDO, same as the rest of F8.2\'s documentation data', async () => {
  const { app, req, login } = await harness();
  try {
    await setUpObjectAndWork(req, login, 'F821-QUEUE-SDO-' + Date.now(), 'F8.2.1 очередь и СДО');
    await login('SDO');
    const snapshot = await req('snapshot');
    assert.equal(snapshot.documentationAttentionQueue, undefined);
  } finally {
    await app.close();
  }
});

/* --------------------------------------------------------------------- *
 * F8.2.1-03 (Corrective Patch) — a work may have multiple packages;        *
 * the backend already allowed this (no uniqueness constraint), the UI     *
 * fix is what's new. This is the backend's own direct confirmation of     *
 * the claim "backend already supports this" the corrective patch made.   *
 * --------------------------------------------------------------------- */

test('F8.2.1 HTTP (Corrective F8.2.1-03): creating a second package for a work that already has one succeeds and returns a distinct id — no one-package-per-work constraint', async () => {
  const { app, req, login } = await harness();
  try {
    const { work } = await setUpObjectAndWork(req, login, 'F821-MULTI-' + Date.now(), 'F8.2.1 несколько пакетов');
    const pto = await login('PTO');
    const first = await req('documentation-packages', { objectWorkId: work.id, responsibleUserId: pto.id });
    const second = await req('documentation-packages', { objectWorkId: work.id, responsibleUserId: pto.id });

    assert.notEqual(first.id, second.id);
    assert.equal(second.objectWorkId, work.id);
    assert.equal(second.status, 'DRAFT');

    const snapshot = await req('snapshot');
    const own = snapshot.documentationPackages.filter((p: any) => p.objectWorkId === work.id);
    assert.equal(own.length, 2, 'both packages belong to the same work and both are visible');
  } finally {
    await app.close();
  }
});

/* --------------------------------------------------------------------- *
 * Permissions — RP/SC read-only, PTO full access (mutations already       *
 * covered by tests/f8.2-documentation-http.test.ts for create/link/       *
 * document/version; this confirms it holds for the new status route too) *
 * --------------------------------------------------------------------- */

test('F8.2.1 HTTP: RP and SC can read a package\'s status but cannot change it', async () => {
  const { app, req, login } = await harness();
  try {
    const { work, pm } = await setUpObjectAndWork(req, login, 'F821-ROLE-' + Date.now(), 'F8.2.1 роли');
    const pto = await login('PTO');
    const pkg = await req('documentation-packages', { objectWorkId: work.id, responsibleUserId: pto.id });

    await login('PROJECT_MANAGER');
    await req(`documentation-packages/${pkg.id}/status`, { status: 'PREPARING', version: pkg.version }, 403);
    const rpSnapshot = await req('snapshot');
    assert.ok(rpSnapshot.documentationPackages.some((p: any) => p.id === pkg.id), 'RP can still read it');

    await login('CONSTRUCTION_CONTROL');
    await req(`documentation-packages/${pkg.id}/status`, { status: 'PREPARING', version: pkg.version }, 403);
  } finally {
    await app.close();
  }
});
