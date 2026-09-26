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
 * F6-01/F6-02 corrective (Work review, two passes): the blocks below add
 * coverage for provider selection failing closed outside development, and
 * for a structurally malformed successful response — including a corrupted
 * *field within an otherwise valid record*, not just a malformed top-level
 * shape — being rejected instead of trusted through to render. The second
 * pass's browser-level proof (a genuinely automated, persistent regression,
 * not a manual run) lives in tests/f6-browser/malformed-snapshot.spec.ts.
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

/**
 * A structurally valid Snapshot with every required collection present but
 * empty — legitimate per the type (mockDataProvider ships the same shape for
 * contractors/dependencies) and passes validateSnapshot vacuously. Used only
 * by tests that care about transport (headers, URL, HTTP status handling),
 * never as a stand-in for "a valid record" — the review's own finding was
 * that a snapshot content-free of real records must not be mistaken for one.
 */
const validEmptySnapshot = () => ({
  objects: [],
  works: [],
  contractors: [],
  dependencies: [],
  inspections: [],
});

/** The real, typed demo fixtures — every field a genuine internal Snapshot record carries. */
const validRepresentativeSnapshot = () => ({
  objects: demoObjects,
  works: demoWorks,
  contractors: [],
  dependencies: [],
  inspections: demoInspections,
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
  const { calls, restore } = stubFetch(async () => json(200, validEmptySnapshot()));
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
  const { calls, restore } = stubFetch(async () => json(200, validEmptySnapshot()));
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

test('realDataProvider rejects invalid JSON on an HTTP 200 (not a Snapshot-shape defect, a parse defect)', async () => {
  const restoreStorage = stubSessionStorage('tok');
  const { restore } = stubFetch(
    async () => new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'application/json' } }),
  );
  try {
    await assert.rejects(
      () => realDataProvider.getSnapshot(),
      (e: Error) => /Неверный ответ сервера: HTTP 200/.test(e.message),
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

/* --------------------------------------------------------------------- *
 * F6-02 — malformed successful (2xx) responses are rejected, not trusted *
 * --------------------------------------------------------------------- */

test('realDataProvider: a fully-formed internal Snapshot passes through unchanged (representative fixture)', async () => {
  const restoreStorage = stubSessionStorage('tok');
  const snapshotBody = validRepresentativeSnapshot();
  const { restore } = stubFetch(async () => json(200, snapshotBody));
  try {
    const result = await realDataProvider.getSnapshot();
    assert.deepEqual(result, snapshotBody);
  } finally {
    restore();
    restoreStorage();
  }
});

test('realDataProvider: inspections: [] and works with no blockers (legitimate empties) are accepted', async () => {
  const restoreStorage = stubSessionStorage('tok');
  const { restore } = stubFetch(async () => json(200, validEmptySnapshot()));
  try {
    const result = await realDataProvider.getSnapshot();
    assert.deepEqual(result.inspections, []);
  } finally {
    restore();
    restoreStorage();
  }
});

test('realDataProvider: customerName/organizationName — a string and a null both pass through unchanged', async () => {
  // F6-02 corrective, third pass (Work re-review): both fields are
  // `string | null` in the type; o01.ts reads them through `?? NO_DATA_DASH`
  // and screens/O01/index.tsx renders the result directly as a JSX child.
  // A real snapshot legitimately carries both shapes — demoObjects[0] has a
  // string customerName, demoObjects[1] has customerName: null — and both
  // must survive validation exactly as sent, never coerced.
  const restoreStorage = stubSessionStorage('tok');
  const snapshotBody = {
    ...validRepresentativeSnapshot(),
    objects: [
      { ...demoObjects[0], customerName: 'ООО «Заказчик»', organizationName: null },
      { ...demoObjects[1], customerName: null, organizationName: 'ООО «Организация»' },
    ],
  };
  const { restore } = stubFetch(async () => json(200, snapshotBody));
  try {
    const result = await realDataProvider.getSnapshot();
    assert.equal(result.objects[0].customerName, 'ООО «Заказчик»');
    assert.equal(result.objects[0].organizationName, null);
    assert.equal(result.objects[1].customerName, null);
    assert.equal(result.objects[1].organizationName, 'ООО «Организация»');
  } finally {
    restore();
    restoreStorage();
  }
});

test('realDataProvider: an unrecognised scheduleStatus/inspection status is accepted, not rejected', async () => {
  // status.ts's own switch statements already read an unrecognised value as
  // neutral, by deliberate design (see its corrective notes) — validation
  // must not fight that, only reject structurally broken records.
  const restoreStorage = stubSessionStorage('tok');
  const snapshotBody = {
    ...validRepresentativeSnapshot(),
    works: [{ ...demoWorks[0], scheduleStatus: 'SOME_FUTURE_STATUS' }],
    inspections: [{ ...demoInspections[0], status: 'SOME_FUTURE_STATUS' }],
  };
  const { restore } = stubFetch(async () => json(200, snapshotBody));
  try {
    const result = await realDataProvider.getSnapshot();
    assert.equal(result.works[0].scheduleStatus, 'SOME_FUTURE_STATUS');
    assert.equal(result.inspections?.[0].status, 'SOME_FUTURE_STATUS');
  } finally {
    restore();
    restoreStorage();
  }
});

function rejects(body: unknown) {
  return async () => {
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
  };
}

const MALFORMED_TOP_LEVEL_CASES: Array<{ label: string; body: unknown }> = [
  { label: 'empty object', body: {} },
  { label: 'null body', body: null },
  { label: 'objects is not an array', body: { ...validEmptySnapshot(), objects: {} } },
  { label: 'works is not an array', body: { ...validEmptySnapshot(), works: {} } },
  { label: 'contractors is not an array', body: { ...validEmptySnapshot(), contractors: null } },
  { label: 'dependencies is not an array', body: { ...validEmptySnapshot(), dependencies: null } },
  {
    label: 'inspections missing entirely — must not be read as []',
    body: (() => {
      const { inspections, ...rest } = validEmptySnapshot();
      return rest;
    })(),
  },
  { label: 'inspections: null — must not be read as []', body: { ...validEmptySnapshot(), inspections: null } },
];

for (const { label, body } of MALFORMED_TOP_LEVEL_CASES) {
  test(`realDataProvider rejects a malformed 2xx snapshot (top level): ${label}`, rejects(body));
}

/**
 * The review's concrete reproduction and its immediate neighbours: a
 * corrupted *field inside an otherwise valid work record*, the exact defect
 * the first validateSnapshot pass missed. Each case starts from the real
 * demoWorks fixture and corrupts exactly one field.
 */
const CORRUPTED_WORK_FIELD_CASES: Array<{ label: string; work: Record<string, unknown> }> = [
  { label: 'blockers missing entirely', work: (() => { const { blockers, ...rest } = demoWorks[0] as any; return rest; })() },
  { label: 'blockers: null', work: { ...demoWorks[0], blockers: null } },
  { label: 'blockers: {} (has no real length, was silently treated as not-blocked)', work: { ...demoWorks[0], blockers: {} } },
  { label: 'blockers: [123] — a non-string element (would throw rendering <li>{reason}</li>)', work: { ...demoWorks[0], blockers: [123] } },
  { label: 'blockers: [{}] — an object element', work: { ...demoWorks[0], blockers: [{}] } },
  { label: 'id missing', work: (() => { const { id, ...rest } = demoWorks[0] as any; return rest; })() },
  { label: 'objectId missing', work: (() => { const { objectId, ...rest } = demoWorks[0] as any; return rest; })() },
  { label: 'name: 5 (rendered directly as JSX text)', work: { ...demoWorks[0], name: 5 } },
  { label: 'contractor: null (joined via joinMeta elsewhere on the object side, direct render here)', work: { ...demoWorks[0], contractor: null } },
  { label: 'unit missing', work: (() => { const { unit, ...rest } = demoWorks[0] as any; return rest; })() },
];

for (const { label, work } of CORRUPTED_WORK_FIELD_CASES) {
  test(`realDataProvider rejects a work record with a corrupted consumed field: ${label}`, rejects({
    ...validRepresentativeSnapshot(),
    works: [work, ...demoWorks.slice(1)],
  }));
}

const CORRUPTED_OBJECT_FIELD_CASES: Array<{ label: string; object: Record<string, unknown> }> = [
  { label: 'name: {} (rendered directly as JSX text)', object: { ...demoObjects[0], name: {} } },
  { label: 'externalCode: 42 (joined via joinMeta, which calls .trim())', object: { ...demoObjects[0], externalCode: 42 } },
  { label: 'address missing', object: (() => { const { address, ...rest } = demoObjects[0] as any; return rest; })() },
  { label: 'responsible: null', object: { ...demoObjects[0], responsible: null } },
  { label: 'customerName: {} (rendered directly as a JSX child in O01, same crash class as name)', object: { ...demoObjects[0], customerName: {} } },
  { label: 'customerName: [] (an array is not a string or null either)', object: { ...demoObjects[0], customerName: [] } },
  { label: 'organizationName: {}', object: { ...demoObjects[0], organizationName: {} } },
  { label: 'organizationName: []', object: { ...demoObjects[0], organizationName: [] } },
  {
    label: 'organizationName missing entirely — SELECT o.* always selects this column, so a missing key is a transport defect',
    object: (() => { const { organizationName, ...rest } = demoObjects[0] as any; return rest; })(),
  },
];

for (const { label, object } of CORRUPTED_OBJECT_FIELD_CASES) {
  test(`realDataProvider rejects an object record with a corrupted consumed field: ${label}`, rejects({
    ...validRepresentativeSnapshot(),
    objects: [object, ...demoObjects.slice(1)],
  }));
}

const CORRUPTED_INSPECTION_FIELD_CASES: Array<{ label: string; inspection: Record<string, unknown> }> = [
  { label: 'objectWorkId missing (the field WorkRoute/buildW01ViewModel match on)', inspection: (() => { const { objectWorkId, ...rest } = demoInspections[0] as any; return rest; })() },
  { label: 'status: null', inspection: { ...demoInspections[0], status: null } },
];

for (const { label, inspection } of CORRUPTED_INSPECTION_FIELD_CASES) {
  test(`realDataProvider rejects an inspection record with a corrupted consumed field: ${label}`, rejects({
    ...validRepresentativeSnapshot(),
    inspections: [inspection, ...demoInspections.slice(1)],
  }));
}
