import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

/**
 * GPR-2 R01 — the guarded /v2 surface exists ONLY when GPR2_CONTRACT_ROUTES is exactly "enabled" (main.ts). With the flag absent or anything else,
 * the application's routes are exactly what they were: no /v2 route, no /v2 swagger path, GPR-1 untouched, and ordinary errors keep their old body
 * (the error filter adds `code` and `details` for a GPR-2 exception only).
 *
 * Each value needs its own process (the module list is fixed when main.ts is imported), started with a MINIMAL environment — no DATABASE_URL, no PG*,
 * no inherited secrets — so the probe cannot reach any database even by accident.
 */
const probe = (value: string) => {
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'tests/helpers/gpr2-flag-probe.ts', value], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 120000,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'test' }
  });
  const line = r.stdout.split('\n').find(l => l.startsWith('PROBE '));
  assert.ok(line, `probe for ${value} produced no result (exit ${r.status}): ${r.stderr.slice(-400)}`);
  return JSON.parse(line.slice(6));
};

const OFF = ['<unset>', 'true', 'ENABLED', '1'];
for (const value of OFF)
  test(`flag ${value === '<unset>' ? 'absent' : JSON.stringify(value)}: no /v2 route exists, GPR-1 is untouched, and an ordinary 401 keeps its old body`, () => {
    const p = probe(value);
    assert.equal(p.v2Command.status, 404, 'POST /v2/objects/:id/schedule/revisions is not a route');
    assert.equal(p.v2Corporate.status, 404, 'nor is the tenant-level publication route');
    assert.deepEqual(p.v2Reads.map((r: any) => r.status), [404, 404, 404, 404, 404], 'D1: the five R05 reads fail closed — they are not routes without the flag');
    assert.equal(p.swaggerHasV2, false, 'and the API document does not list it');
    assert.equal(p.legacyGpr1.status, 401, 'the legacy GPR-1 route is still there (and still authenticates first)');
    assert.deepEqual(p.legacyGpr1.keys, ['message', 'requestId', 'statusCode'], 'an ordinary error body has no `code` / `details` — the filter is unchanged for it');
    assert.equal(p.health.status, 200);
  });

test('flag "enabled": the /v2 routes exist and authenticate first; the legacy routes and their error bodies are unchanged', () => {
  const p = probe('enabled');
  assert.equal(p.v2Command.status, 401);
  assert.equal(p.v2Corporate.status, 401);
  assert.deepEqual(p.v2Reads.map((r: any) => r.status), [401, 401, 401, 401, 401], 'D1: the five R05 reads exist and authenticate first');
  assert.equal(p.swaggerHasV2, true);
  assert.equal(p.legacyGpr1.status, 401);
  assert.deepEqual(p.legacyGpr1.keys, ['message', 'requestId', 'statusCode']);
  assert.deepEqual(p.v2Command.keys, ['message', 'requestId', 'statusCode'], 'a 401 is the authentication layer\'s own and stays in its format');
});

test('R01-B05: the served API document outside the GPR-2 contract is byte-for-byte the same with the flag on and off — the contract is added, nothing else changes', () => {
  const off = probe('<unset>'), on = probe('enabled');
  assert.equal(off.v2PathCount, 0);
  assert.equal(on.v2PathCount, 36, 'exactly the paths of the 35 mounted commands and the 5 D1 reads (R05: +3; D1: +1 — four of the five reads share a path with a command)');
  assert.ok(off.legacyPathCount > 50, 'a real document: ' + off.legacyPathCount + ' legacy paths');
  assert.equal(on.legacyPathCount, off.legacyPathCount);
  assert.equal(on.legacyDigest, off.legacyDigest, 'no legacy path, schema, tag or security scheme differs');
  for (const value of ['true', 'ENABLED', '1']) assert.equal(probe(value).legacyDigest, off.legacyDigest, value);
});
