import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realDataProvider } from '../apps/frontend/src/data/realDataProvider';
import { selectDataProvider } from '../apps/frontend/src/data/selectDataProvider';
import { mockDataProvider } from '../apps/frontend/src/data/mockDataProvider';
import { demoInspections, demoObjects, demoWorks } from '../apps/frontend/src/screens/demo/fixtures';

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
 *
 * F6-01/F6-02 corrective (Work review): the two blocks below add coverage
 * for the two confirmed blockers — provider selection failing closed outside
 * development, and a structurally malformed successful response being
 * rejected instead of trusted through to render.
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

/** A minimal but structurally valid internal Snapshot body — passes validateSnapshot. */
const validMinimalSnapshot = () => ({
  objects: [{ id: 'o1' }],
  works: [{ id: 'w1', objectId: 'o1' }],
  contractors: [],
  dependencies: [],
  inspections: [],
});

/* --------------------------------------------------------------------- *
 * F6-01 — provider selection fails closed outside development           *
 * --------------------------------------------------------------------- */

test('provider selection: an explicit value always wins, in development or not', () => {
  assert.equal(selectDataProvider('real', true), realDataProvider);
  assert.equal(selectDataProvider('real', false), realDataProvider);
  assert.equal(selectDataProvider('mock', true), mockDataProvider);
  assert.equal(selectDataProvider('mock', false), mockDataProvider);
});

test('provider selection: unset/empty/whitespace defaults to mock only in development', () => {
  assert.equal(selectDataProvider(undefined, true), mockDataProvider);
  assert.equal(selectDataProvider('', true), mockDataProvider);
  assert.equal(selectDataProvider('   ', true), mockDataProvider);
});

test('provider selection: unset/empty/whitespace outside development is a configuration error, not mock', () => {
  for (const rawMode of [undefined, '', '   ']) {
    assert.throws(
      () => selectDataProvider(rawMode, false),
      /VITE_DATA_PROVIDER is not set/,
      `expected a throw for ${JSON.stringify(rawMode)}`,
    );
  }
});

test('provider selection: an unrecognised value fails closed regardless of environment', () => {
  assert.throws(() => selectDataProvider('production', true), /Unknown VITE_DATA_PROVIDER value: "production"/);
  assert.throws(() => selectDataProvider('production', false), /Unknown VITE_DATA_PROVIDER value: "production"/);
});

/* --------------------------------------------------------------------- *
 * realDataProvider — transport, auth header, HTTP error handling         *
 * --------------------------------------------------------------------- */

test('realDataProvider sends the session token as a bearer header to /api/snapshot', async () => {
  const restoreStorage = stubSessionStorage('tok-123');
  const { calls, restore } = stubFetch(async () => json(200, validMinimalSnapshot()));
  try {
    await realDataProvider.getSnapshot();
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
  const { calls, restore } = stubFetch(async () => json(200, validMinimalSnapshot()));
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

test('realDataProvider rejects non-2xx HTML/text without leaking the body (proxy/infra errors)', async () => {
  const restoreStorage = stubSessionStorage('tok');
  const { restore } = stubFetch(
    async () => new Response('<html>Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }),
  );
  try {
    await assert.rejects(() => realDataProvider.getSnapshot(), (e: Error) => e.message === 'HTTP 502');
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

/* --------------------------------------------------------------------- *
 * F6-02 — malformed successful (2xx) responses are rejected, not trusted *
 * --------------------------------------------------------------------- */

test('realDataProvider: a fully-formed internal Snapshot passes through unchanged (representative fixture)', async () => {
  const restoreStorage = stubSessionStorage('tok');
  const snapshotBody = {
    objects: demoObjects,
    works: demoWorks,
    contractors: [],
    dependencies: [],
    inspections: demoInspections,
  };
  const { restore } = stubFetch(async () => json(200, snapshotBody));
  try {
    const result = await realDataProvider.getSnapshot();
    assert.deepEqual(result, snapshotBody);
  } finally {
    restore();
    restoreStorage();
  }
});

test('realDataProvider: inspections: [] (a legitimate empty list) is accepted, not rejected', async () => {
  const restoreStorage = stubSessionStorage('tok');
  const { restore } = stubFetch(async () => json(200, validMinimalSnapshot()));
  try {
    const result = await realDataProvider.getSnapshot();
    assert.deepEqual(result.inspections, []);
  } finally {
    restore();
    restoreStorage();
  }
});

const MALFORMED_CASES: Array<{ label: string; body: unknown }> = [
  { label: 'empty object', body: {} },
  { label: 'null body', body: null },
  { label: 'objects is not an array', body: { ...validMinimalSnapshot(), objects: {} } },
  { label: 'works is not an array', body: { ...validMinimalSnapshot(), works: {} } },
  { label: 'contractors is not an array', body: { ...validMinimalSnapshot(), contractors: null } },
  { label: 'dependencies is not an array', body: { ...validMinimalSnapshot(), dependencies: null } },
  {
    label: 'an object record without an id (corrupted used record)',
    body: { ...validMinimalSnapshot(), objects: [{ name: 'no id' }] },
  },
  {
    label: 'a work record without objectId (corrupted used record)',
    body: { ...validMinimalSnapshot(), works: [{ id: 'w1' }] },
  },
  {
    label: 'inspections missing entirely — must not be read as []',
    body: (() => {
      const { inspections, ...rest } = validMinimalSnapshot();
      return rest;
    })(),
  },
  { label: 'inspections: null — must not be read as []', body: { ...validMinimalSnapshot(), inspections: null } },
];

for (const { label, body } of MALFORMED_CASES) {
  test(`realDataProvider rejects a malformed 2xx snapshot: ${label}`, async () => {
    const restoreStorage = stubSessionStorage('tok');
    const { restore } = stubFetch(async () => json(200, body));
    try {
      await assert.rejects(
        () => realDataProvider.getSnapshot(),
        (e: Error) => e.message === 'Неверный ответ сервера: искажённый снимок данных.',
      );
    } finally {
      restore();
      restoreStorage();
    }
  });
}
