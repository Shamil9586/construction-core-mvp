import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realDataProvider } from '../apps/frontend/src/data/realDataProvider';
import { selectDataProvider } from '../apps/frontend/src/data/selectDataProvider';
import { mockDataProvider } from '../apps/frontend/src/data/mockDataProvider';

/**
 * F6 — real DataProvider and provider-selection coverage.
 *
 * `realDataProvider` talks to `fetch`/`sessionStorage`, both browser globals
 * this suite stubs per test — the same style tests/http-errors.test.ts
 * already uses (constructing real, spec-compliant `Response` objects, no
 * mocking framework). Every stub is restored in a `finally`, so no test can
 * leak a stub into the next one.
 *
 * Route-container behaviour fed by a snapshot (unknown object/work, foreign
 * work, direct open/reload) is unchanged by F6 — CompanyRoute/ObjectRoute/
 * WorkRoute and SnapshotContext read `state.snapshot` generically and were
 * not touched — so that coverage stays exactly where F5 already proved it,
 * tests/design-system/app.spec.ts, rather than being duplicated here.
 */

function stubSessionStorage(token: string | null) {
  const original = (globalThis as unknown as { sessionStorage?: unknown }).sessionStorage;
  (globalThis as unknown as { sessionStorage: Storage }).sessionStorage = {
    getItem: (key: string) => (key === 'session' ? token : null),
  } as Storage;
  return () => {
    (globalThis as unknown as { sessionStorage: unknown }).sessionStorage = original;
  };
}

function stubFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  const original = globalThis.fetch;
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return handler(input, init);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('provider selection: explicit, no hidden default beyond documented mock', () => {
  assert.equal(selectDataProvider(undefined), mockDataProvider);
  assert.equal(selectDataProvider(''), mockDataProvider);
  assert.equal(selectDataProvider('mock'), mockDataProvider);
  assert.equal(selectDataProvider('real'), realDataProvider);
  assert.notEqual(selectDataProvider('real'), mockDataProvider);
});

test('provider selection: an unrecognised value fails closed instead of guessing', () => {
  assert.throws(
    () => selectDataProvider('production'),
    /Unknown VITE_DATA_PROVIDER value: "production"/,
  );
});

test('realDataProvider sends the session token as a bearer header to /api/snapshot', async () => {
  const restoreStorage = stubSessionStorage('tok-123');
  const snapshotBody = { objects: [], works: [], contractors: [], dependencies: [] };
  const { calls, restore } = stubFetch(async () => json(200, snapshotBody));
  try {
    const result = await realDataProvider.getSnapshot();
    assert.deepEqual(result, snapshotBody);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].input, '/api/snapshot');
    const headers = calls[0].init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer tok-123');
  } finally {
    restore();
    restoreStorage();
  }
});

test('realDataProvider sends no Authorization header when no session token is present', async () => {
  const restoreStorage = stubSessionStorage(null);
  const { calls, restore } = stubFetch(async () =>
    json(200, { objects: [], works: [], contractors: [], dependencies: [] }),
  );
  try {
    await realDataProvider.getSnapshot();
    const headers = (calls[0].init?.headers ?? {}) as Record<string, string>;
    assert.equal('Authorization' in headers, false);
  } finally {
    restore();
    restoreStorage();
  }
});

test('realDataProvider surfaces the backend business message on auth failure, not a parser error', async () => {
  const restoreStorage = stubSessionStorage('expired-token');
  const { restore } = stubFetch(async () => json(401, { statusCode: 401, message: 'Сессия истекла' }));
  try {
    await assert.rejects(
      () => realDataProvider.getSnapshot(),
      (e: Error) => e.message === 'Сессия истекла',
    );
  } finally {
    restore();
    restoreStorage();
  }
});

test('realDataProvider rejects on transport failure — it never substitutes mock fixtures', async () => {
  const restoreStorage = stubSessionStorage('tok');
  const { restore } = stubFetch(async () => {
    throw new TypeError('Failed to fetch');
  });
  try {
    await assert.rejects(() => realDataProvider.getSnapshot(), TypeError);
    // realDataProvider.ts has no import of mockDataProvider or its fixtures —
    // a transport failure has no fallback value to reach for, so the promise
    // can only reject, never resolve with demo data.
  } finally {
    restore();
    restoreStorage();
  }
});

test('realDataProvider returns exactly the parsed response — transport only, no fields added or dropped', async () => {
  const restoreStorage = stubSessionStorage('tok');
  const snapshotBody = {
    objects: [{ id: 'o1' }],
    works: [{ id: 'w1' }],
    contractors: [],
    dependencies: [],
    inspections: [{ id: 'i1' }],
  };
  const { restore } = stubFetch(async () => json(200, snapshotBody));
  try {
    const result = await realDataProvider.getSnapshot();
    assert.deepEqual(result, snapshotBody);
    assert.equal(Object.keys(result as object).length, Object.keys(snapshotBody).length);
  } finally {
    restore();
    restoreStorage();
  }
});
