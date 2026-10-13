import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { gprHarness, applyPendingScheduleMigration, type Harness } from './helpers/gpr-fixtures';

/**
 * GPR-1 — the schedule's schema is a PENDING migration. A database that has not had it applied must degrade cleanly: the schedule routes say
 * so (503, a plain Russian message — not a generic 500), every other part of the application keeps working, authorization still answers
 * before the missing table is ever touched, and the schedule comes alive the moment the migration is applied — no restart, no code change.
 */
let h: Harness;
before(async () => { h = await gprHarness('gpr-1-unprovisioned-key', { applyPending: false }); });
after(async () => { await h?.close(); });

test('without the migration: schedule routes answer 503 with a clear message; the rest of the application is untouched; then the migration is applied', async () => {
  await h.login('DEPUTY_DIRECTOR');
  const snap = await h.req('snapshot');
  assert.ok(snap.objects.length > 0, 'the rest of the application works');
  const object = snap.objects[0], work = snap.works.find((w: any) => w.objectId === object.id);

  for (const [path, body] of [[`objects/${object.id}/schedule`, undefined], [`works/${work.id}/schedule`, undefined], [`objects/${object.id}/schedule/draft`, {}]] as const) {
    const r = await h.raw(path, body);
    assert.equal(r.status, 503, path);
    assert.match(r.data.message, /График производства работ.* не активирован/);
    assert.ok(!/42P01|relation|schedule_/i.test(JSON.stringify(r.data)), 'no schema detail leaks to the client');
  }
  // authorization and validation answer first — nothing depends on the missing table
  await h.login('CONTRACTOR_VIEWER');
  assert.equal((await h.raw(`objects/${object.id}/schedule`)).status, 403);
  await h.login('DEPUTY_DIRECTOR');
  assert.equal((await h.raw('objects/not-a-uuid/schedule')).status, 400);
  assert.equal((await fetch(`${h.base}/objects/${object.id}/schedule`)).status, 401);
  // the existing production flows are unaffected
  assert.equal((await h.raw(`objects/${object.id}`)).status, 200);
  assert.equal((await h.raw(`works/${work.id}/progress`)).status, 200);

  // the coordinator promotes / applies the migration: the same routes answer
  await applyPendingScheduleMigration();
  const live = await h.req(`objects/${object.id}/schedule`);
  assert.equal(live.conclusion.status, 'NO_BASELINE');
  assert.equal((await h.req(`works/${work.id}/schedule`)).hasBaseline, false);
});
