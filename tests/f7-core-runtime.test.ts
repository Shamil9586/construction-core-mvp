import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Permission, hasPermission, roles as domainRoles } from '../packages/domain';
import {
  EXTERNAL_PARTICIPANT_ROLE,
  INTERNAL_CORE_ROLES,
  INTERNAL_ROLE_LABELS,
  canManageDocumentation,
  classifyCoreRole,
  isInternalCoreRole,
} from '../apps/frontend/src/auth/internalRoles';
import {
  MALFORMED_AUTH_MODE_MESSAGE,
  MALFORMED_SESSION_MESSAGE,
  NON_INTERNAL_ROLE_MESSAGE,
  fetchAuthMode,
  fetchSessionUser,
  signInWithMockKey,
  signOutSession,
} from '../apps/frontend/src/auth/sessionClient';
import { AuthenticationError } from '../apps/frontend/src/auth/AuthenticationError';
import {
  SESSION_STORAGE_KEY,
  clearSessionToken,
  readSessionToken,
  storeSessionToken,
} from '../apps/frontend/src/auth/sessionToken';
import { realDataProvider } from '../apps/frontend/src/data/realDataProvider';
import { mockDataProvider } from '../apps/frontend/src/data/mockDataProvider';
import { DATA_SOURCE_LABELS, resolveCoreRuntime } from '../apps/frontend/src/app/coreRuntime';
import { initialSessionState, sessionStateForUser } from '../apps/frontend/src/app/sessionState';
import {
  CORE_BUILD_MODE,
  assertCoreBuildProvider,
  coreBuildEntry,
  coreBuildInputs,
} from '../apps/frontend/vite-plugins/coreBuildEntry';

/**
 * F7 — internal runtime foundation: UNIT tests.
 *
 * Pure functions and the HTTP client, no browser and no backend. `fetch` and
 * `sessionStorage` are browser globals this suite stubs per test, the same
 * way tests/f6-real-data-provider.test.ts does (real, spec-compliant
 * `Response` objects, no mocking framework); every stub is restored in a
 * `finally`. Rendered behaviour is covered by tests/f7-browser/ (intercepted
 * API) and tests/f7-production/ (production-like serving + real backend).
 */

/* --------------------------------------------------------------------- *
 * helpers                                                                *
 * --------------------------------------------------------------------- */

function stubSessionStorage(initial: Record<string, string> = {}) {
  const original = (globalThis as unknown as { sessionStorage?: unknown }).sessionStorage;
  const values = new Map(Object.entries(initial));
  (globalThis as unknown as { sessionStorage: Storage }).sessionStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  } as Storage;
  return {
    values,
    restore: () => {
      (globalThis as unknown as { sessionStorage: unknown }).sessionStorage = original;
    },
  };
}

type FetchCall = { input: RequestInfo | URL; init?: RequestInit };

function stubFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return handler(input, init);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const headersOf = (call: FetchCall) => (call.init?.headers ?? {}) as Record<string, string>;

const INTERNAL_ACTOR = { id: 'u-1', tenantId: 't-1', name: 'Александр Волков', role: 'GENERAL_DIRECTOR' };
const EXTERNAL_ACTOR = { id: 'u-9', tenantId: 't-1', name: 'Представитель подрядчика', role: 'CONTRACTOR_VIEWER' };

/* --------------------------------------------------------------------- *
 * Decision 3/4 — internal roles only                                     *
 * --------------------------------------------------------------------- */

test('internal roles: CONTRACTOR_VIEWER is never an internal Core role', () => {
  assert.equal((INTERNAL_CORE_ROLES as readonly string[]).includes('CONTRACTOR_VIEWER'), false);
  assert.equal(isInternalCoreRole('CONTRACTOR_VIEWER'), false);
  assert.equal(EXTERNAL_PARTICIPANT_ROLE, 'CONTRACTOR_VIEWER');
  assert.equal(Object.keys(INTERNAL_ROLE_LABELS).includes('CONTRACTOR_VIEWER'), false);
});

test('internal roles: every domain role is either internal or the one external role — a new domain role forces a decision here', () => {
  const internal = new Set<string>(INTERNAL_CORE_ROLES);
  for (const role of domainRoles) {
    assert.ok(
      internal.has(role) || role === EXTERNAL_PARTICIPANT_ROLE,
      `domain role ${role} is neither an internal Core role nor the external-participant role`,
    );
  }
  assert.equal(INTERNAL_CORE_ROLES.length + 1, domainRoles.length);
});

test('internal roles: each internal role has a Russian label', () => {
  for (const role of INTERNAL_CORE_ROLES) {
    assert.ok(INTERNAL_ROLE_LABELS[role].trim().length > 0, role);
  }
});

test('role classification: internal / external / unrecognised — an unknown role is never treated as internal', () => {
  assert.deepEqual(classifyCoreRole('GENERAL_DIRECTOR'), { kind: 'Internal', role: 'GENERAL_DIRECTOR' });
  assert.deepEqual(classifyCoreRole('PTO'), { kind: 'Internal', role: 'PTO' });
  assert.deepEqual(classifyCoreRole('CONTRACTOR_VIEWER'), { kind: 'External' });
  assert.deepEqual(classifyCoreRole('SOME_FUTURE_ROLE'), { kind: 'Unrecognized' });
  assert.deepEqual(classifyCoreRole('general_director'), { kind: 'Unrecognized' });
  assert.deepEqual(classifyCoreRole(''), { kind: 'Unrecognized' });
});

test('canManageDocumentation: agrees with the backend\'s own DOCUMENTATION_MANAGE grant for every domain role, so the frontend action-gating can never quietly drift from what the backend actually enforces', () => {
  for (const role of domainRoles) {
    assert.equal(
      canManageDocumentation(role),
      hasPermission(role, Permission.DOCUMENTATION_MANAGE),
      `canManageDocumentation(${role}) disagrees with the backend's own grant`,
    );
  }
  assert.equal(canManageDocumentation('PTO'), true);
  assert.equal(canManageDocumentation('ADMIN'), true);
  assert.equal(canManageDocumentation('SDO'), false);
  assert.equal(canManageDocumentation('PROJECT_MANAGER'), false);
  assert.equal(canManageDocumentation('CONSTRUCTION_CONTROL'), false);
  assert.equal(canManageDocumentation('unrecognized-role'), false);
});

test('session state: an internal actor is Authenticated; CONTRACTOR_VIEWER and unknown roles are Unavailable, never Authenticated', () => {
  assert.deepEqual(sessionStateForUser(INTERNAL_ACTOR), {
    status: 'Authenticated',
    user: INTERNAL_ACTOR,
    role: 'GENERAL_DIRECTOR',
  });
  assert.deepEqual(sessionStateForUser(EXTERNAL_ACTOR), {
    status: 'Unavailable',
    user: EXTERNAL_ACTOR,
    access: 'External',
  });
  const unknown = { ...INTERNAL_ACTOR, role: 'SOME_FUTURE_ROLE' };
  assert.deepEqual(sessionStateForUser(unknown), { status: 'Unavailable', user: unknown, access: 'Unrecognized' });
});

test('session state: no token in the tab is Unauthenticated immediately (no request); a token starts Checking', () => {
  const storage = stubSessionStorage();
  try {
    assert.deepEqual(initialSessionState(), { status: 'Unauthenticated', reason: 'NoSession' });
    storage.values.set(SESSION_STORAGE_KEY, '   ');
    assert.deepEqual(initialSessionState(), { status: 'Unauthenticated', reason: 'NoSession' });
    storage.values.set(SESSION_STORAGE_KEY, 'tok');
    assert.deepEqual(initialSessionState(), { status: 'Checking' });
  } finally {
    storage.restore();
  }
});

/* --------------------------------------------------------------------- *
 * session artifact — the existing sessionStorage['session'] key          *
 * --------------------------------------------------------------------- */

test('session token: reuses the existing sessionStorage key the legacy entry and Bitrix launch write', () => {
  assert.equal(SESSION_STORAGE_KEY, 'session');
  const storage = stubSessionStorage();
  try {
    assert.equal(readSessionToken(), null);
    storeSessionToken('abc');
    assert.equal(storage.values.get('session'), 'abc');
    assert.equal(readSessionToken(), 'abc');
    clearSessionToken();
    assert.equal(storage.values.has('session'), false);
    assert.equal(readSessionToken(), null);
  } finally {
    storage.restore();
  }
});

test('session token: a browser that blocks storage reads as "no session", never a render-time crash', () => {
  const original = (globalThis as unknown as { sessionStorage?: unknown }).sessionStorage;
  (globalThis as unknown as { sessionStorage: Storage }).sessionStorage = {
    getItem: () => {
      throw new Error('SecurityError: storage is disabled');
    },
  } as unknown as Storage;
  try {
    assert.equal(readSessionToken(), null);
    assert.deepEqual(initialSessionState(), { status: 'Unauthenticated', reason: 'NoSession' });
  } finally {
    (globalThis as unknown as { sessionStorage: unknown }).sessionStorage = original;
  }
});

/* --------------------------------------------------------------------- *
 * GET /api/me — session validation                                       *
 * --------------------------------------------------------------------- */

test('fetchSessionUser: sends the token as a bearer header to the existing /api/me and returns the actor', async () => {
  const { calls, restore } = stubFetch(async () => json(200, { ...INTERNAL_ACTOR, bitrixUserId: '1', isActive: true }));
  try {
    const user = await fetchSessionUser('tok-1');
    assert.deepEqual(user, { id: 'u-1', name: 'Александр Волков', role: 'GENERAL_DIRECTOR' });
    assert.equal(calls[0].input, '/api/me');
    assert.equal(headersOf(calls[0]).Authorization, 'Bearer tok-1');
  } finally {
    restore();
  }
});

test('fetchSessionUser: HTTP 401 is an AuthenticationError carrying the backend message', async () => {
  for (const message of ['Сессия истекла', 'Требуется вход']) {
    const { restore } = stubFetch(async () => json(401, { statusCode: 401, message }));
    try {
      await assert.rejects(
        () => fetchSessionUser('tok'),
        (e: unknown) => e instanceof AuthenticationError && e.message === message,
      );
    } finally {
      restore();
    }
  }
});

test('fetchSessionUser: 5xx, 429 and transport failures are NOT authentication errors (nothing to sign out of)', async () => {
  const cases: Array<() => Promise<Response>> = [
    async () => new Response('<html>Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }),
    async () => new Response('Too many', { status: 429, headers: { 'content-type': 'text/plain' } }),
    async () => {
      throw new TypeError('Failed to fetch');
    },
  ];
  for (const handler of cases) {
    const { restore } = stubFetch(handler);
    try {
      await assert.rejects(
        () => fetchSessionUser('tok'),
        (e: unknown) => e instanceof Error && !(e instanceof AuthenticationError),
      );
    } finally {
      restore();
    }
  }
});

test('fetchSessionUser: a 200 without a usable name/role is malformed, not a user', async () => {
  for (const body of [{}, null, [], { ...INTERNAL_ACTOR, role: 7 }, { ...INTERNAL_ACTOR, name: '' }, { id: 'x', name: 'n' }]) {
    const { restore } = stubFetch(async () => json(200, body));
    try {
      await assert.rejects(
        () => fetchSessionUser('tok'),
        (e: unknown) => e instanceof Error && !(e instanceof AuthenticationError) && e.message === MALFORMED_SESSION_MESSAGE,
      );
    } finally {
      restore();
    }
  }
});

/* --------------------------------------------------------------------- *
 * GET /api/health — auth-mode discovery                                  *
 * --------------------------------------------------------------------- */

test('fetchAuthMode: reads authMode verbatim from the existing public /api/health, with no token', async () => {
  for (const authMode of ['mock', 'bitrix', 'something-else']) {
    const { calls, restore } = stubFetch(async () => json(200, { status: 'ok', authMode, databaseMode: 'postgres' }));
    try {
      assert.equal(await fetchAuthMode(), authMode);
      assert.equal(calls[0].input, '/api/health');
      assert.equal('Authorization' in headersOf(calls[0]), false);
    } finally {
      restore();
    }
  }
});

test('fetchAuthMode: a missing/blank authMode or a failed request rejects — it never guesses "mock"', async () => {
  for (const handler of [
    async () => json(200, { status: 'ok' }),
    async () => json(200, { status: 'ok', authMode: '' }),
    async () => json(200, { status: 'ok', authMode: 5 }),
  ]) {
    const { restore } = stubFetch(handler);
    try {
      await assert.rejects(() => fetchAuthMode(), (e: Error) => e.message === MALFORMED_AUTH_MODE_MESSAGE);
    } finally {
      restore();
    }
  }
  const { restore } = stubFetch(async () => new Response('down', { status: 503, headers: { 'content-type': 'text/plain' } }));
  try {
    await assert.rejects(() => fetchAuthMode(), (e: Error) => e.message === 'HTTP 503');
  } finally {
    restore();
  }
});

/* --------------------------------------------------------------------- *
 * POST /api/auth/mock — Core test sign-in                                *
 * --------------------------------------------------------------------- */

test('signInWithMockKey: posts role and key to the existing /api/auth/mock and returns the new session', async () => {
  const { calls, restore } = stubFetch(async () => json(201, { token: 'new-token', user: INTERNAL_ACTOR }));
  try {
    const grant = await signInWithMockKey('CONSTRUCTION_CONTROL', 'test-key');
    assert.deepEqual(grant, { token: 'new-token', user: { id: 'u-1', name: 'Александр Волков', role: 'GENERAL_DIRECTOR' } });
    assert.equal(calls[0].input, '/api/auth/mock');
    assert.equal(calls[0].init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { role: 'CONSTRUCTION_CONTROL', key: 'test-key' });
  } finally {
    restore();
  }
});

test('signInWithMockKey: refuses CONTRACTOR_VIEWER before any request is sent', async () => {
  const { calls, restore } = stubFetch(async () => json(201, { token: 't', user: EXTERNAL_ACTOR }));
  try {
    await assert.rejects(
      () => signInWithMockKey('CONTRACTOR_VIEWER' as unknown as 'GENERAL_DIRECTOR', 'k'),
      (e: Error) => e.message === NON_INTERNAL_ROLE_MESSAGE,
    );
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('signInWithMockKey: a rejected key is the backend message, not an AuthenticationError (no session existed)', async () => {
  const { restore } = stubFetch(async () => json(401, { statusCode: 401, message: 'Неверный тестовый ключ' }));
  try {
    await assert.rejects(
      () => signInWithMockKey('GENERAL_DIRECTOR', 'wrong'),
      (e: unknown) => e instanceof Error && !(e instanceof AuthenticationError) && e.message === 'Неверный тестовый ключ',
    );
  } finally {
    restore();
  }
});

test('signInWithMockKey: a success without a token or a usable user is malformed', async () => {
  for (const body of [{ user: INTERNAL_ACTOR }, { token: '', user: INTERNAL_ACTOR }, { token: 't' }, { token: 't', user: { name: 'x' } }]) {
    const { restore } = stubFetch(async () => json(201, body));
    try {
      await assert.rejects(() => signInWithMockKey('GENERAL_DIRECTOR', 'k'), (e: Error) => e.message === MALFORMED_SESSION_MESSAGE);
    } finally {
      restore();
    }
  }
});

/* --------------------------------------------------------------------- *
 * POST /api/auth/logout                                                  *
 * --------------------------------------------------------------------- */

test('signOutSession: posts to the existing /api/auth/logout with the bearer token', async () => {
  const { calls, restore } = stubFetch(async () => json(201, { loggedOut: true }));
  try {
    await signOutSession('tok-9');
    assert.equal(calls[0].input, '/api/auth/logout');
    assert.equal(calls[0].init?.method, 'POST');
    assert.equal(headersOf(calls[0]).Authorization, 'Bearer tok-9');
  } finally {
    restore();
  }
});

test('signOutSession: a 401 (session already gone server-side) counts as signed out', async () => {
  const { restore } = stubFetch(async () => json(401, { statusCode: 401, message: 'Сессия истекла' }));
  try {
    await signOutSession('dead');
  } finally {
    restore();
  }
});

test('signOutSession: any other failure rejects — a sign-out the server did not confirm is not reported as done', async () => {
  const { restore } = stubFetch(async () => new Response('oops', { status: 500, headers: { 'content-type': 'text/plain' } }));
  try {
    await assert.rejects(() => signOutSession('tok'), (e: Error) => e.message === 'HTTP 500');
  } finally {
    restore();
  }
});

/* --------------------------------------------------------------------- *
 * realDataProvider — auth failure is distinguished from data failure     *
 * --------------------------------------------------------------------- */

test('realDataProvider: HTTP 401 on /api/snapshot is an AuthenticationError with the backend message', async () => {
  const storage = stubSessionStorage({ session: 'expired' });
  const { restore } = stubFetch(async () => json(401, { statusCode: 401, message: 'Сессия истекла' }));
  try {
    await assert.rejects(
      () => realDataProvider.getSnapshot(),
      (e: unknown) => e instanceof AuthenticationError && e.message === 'Сессия истекла',
    );
  } finally {
    restore();
    storage.restore();
  }
});

test('realDataProvider: 403, 5xx and malformed data stay data failures, never AuthenticationError, never mock fixtures', async () => {
  const storage = stubSessionStorage({ session: 'tok' });
  const cases: Array<{ handler: () => Promise<Response>; message: string }> = [
    { handler: async () => json(403, { statusCode: 403, message: 'Недостаточно прав: X' }), message: 'Недостаточно прав: X' },
    { handler: async () => new Response('<html/>', { status: 502, headers: { 'content-type': 'text/html' } }), message: 'HTTP 502' },
    { handler: async () => json(200, {}), message: 'Неверный ответ сервера: искажённый снимок данных.' },
  ];
  try {
    for (const { handler, message } of cases) {
      const { restore } = stubFetch(handler);
      try {
        await assert.rejects(
          () => realDataProvider.getSnapshot(),
          (e: unknown) => e instanceof Error && !(e instanceof AuthenticationError) && e.message === message,
        );
      } finally {
        restore();
      }
    }
  } finally {
    storage.restore();
  }
});

/* --------------------------------------------------------------------- *
 * provider configuration — F6 fail-closed, now renderable               *
 * --------------------------------------------------------------------- */

test('runtime: an explicit real/mock configuration resolves to that provider and data source', () => {
  assert.deepEqual(resolveCoreRuntime('real', false), { kind: 'Configured', dataSource: 'real', provider: realDataProvider });
  assert.deepEqual(resolveCoreRuntime('real', true), { kind: 'Configured', dataSource: 'real', provider: realDataProvider });
  assert.deepEqual(resolveCoreRuntime('mock', false), { kind: 'Configured', dataSource: 'mock', provider: mockDataProvider });
  assert.deepEqual(resolveCoreRuntime(' real ', false), { kind: 'Configured', dataSource: 'real', provider: realDataProvider });
});

test('runtime: unset outside the dev server is a ConfigurationError — no provider at all, never mock', () => {
  for (const raw of [undefined, '', '   ']) {
    const runtime = resolveCoreRuntime(raw, false);
    assert.equal(runtime.kind, 'ConfigurationError', JSON.stringify(raw));
    assert.equal('provider' in runtime, false);
    if (runtime.kind === 'ConfigurationError') assert.match(runtime.message, /VITE_DATA_PROVIDER is not set/);
  }
});

test('runtime: an unrecognised value is a ConfigurationError in every environment', () => {
  for (const isDevelopment of [true, false]) {
    const runtime = resolveCoreRuntime('production', isDevelopment);
    assert.equal(runtime.kind, 'ConfigurationError');
    assert.equal('provider' in runtime, false);
    if (runtime.kind === 'ConfigurationError') assert.match(runtime.message, /Unknown VITE_DATA_PROVIDER value: "production"/);
  }
});

test('runtime: the dev-server default stays mock (F6-01), and says so', () => {
  assert.deepEqual(resolveCoreRuntime(undefined, true), { kind: 'Configured', dataSource: 'mock', provider: mockDataProvider });
});

test('runtime wording: the footer names the real source and never calls server data demo data', () => {
  assert.equal(DATA_SOURCE_LABELS.real, 'Источник данных: сервер');
  assert.equal(DATA_SOURCE_LABELS.mock, 'Источник данных: встроенные демо-данные');
  assert.equal(DATA_SOURCE_LABELS.unconfigured, 'Источник данных: не настроен');
  assert.doesNotMatch(DATA_SOURCE_LABELS.real, /демо/i);
  for (const label of Object.values(DATA_SOURCE_LABELS)) assert.doesNotMatch(label, /F5/);
});

test('runtime wording: the sidebar footer is the runtime footer, not a fixed phase label', () => {
  // The rendered text itself is asserted in the browser suites (real, mock and
  // unconfigured builds); this pins the wiring that makes it follow the build.
  const sidebar = readFileSync(path.join(__dirname, '../apps/frontend/src/app/AppSidebar.tsx'), 'utf8');
  assert.match(sidebar, /footer=\{<RuntimeFooter \/>\}/);
  assert.doesNotMatch(sidebar, /footer=\{<span>/);
});

/* --------------------------------------------------------------------- *
 * build — opt-in Core entry                                              *
 * --------------------------------------------------------------------- */

type ConfigHook = (config: { root?: string; envDir?: string }, env: { command: 'build'; mode: string }) => unknown;

function runCoreBuildHook(mode: string, rawProvider: string | undefined): unknown {
  const previous = process.env.VITE_DATA_PROVIDER;
  if (rawProvider === undefined) delete process.env.VITE_DATA_PROVIDER;
  else process.env.VITE_DATA_PROVIDER = rawProvider;
  try {
    const hook = coreBuildEntry().config as unknown as ConfigHook;
    return hook({ root: 'apps/frontend' }, { command: 'build', mode });
  } finally {
    if (previous === undefined) delete process.env.VITE_DATA_PROVIDER;
    else process.env.VITE_DATA_PROVIDER = previous;
  }
}

test('build: the default build (mode "production") is left exactly as it was — no input override', () => {
  assert.equal(runCoreBuildHook('production', undefined), null);
  assert.equal(runCoreBuildHook('production', 'real'), null);
});

test('build: build:core adds exactly the legacy and Core entries — never preview.html', () => {
  const result = runCoreBuildHook(CORE_BUILD_MODE, 'real') as { build: { rollupOptions: { input: Record<string, string> } } };
  const input = result.build.rollupOptions.input;
  assert.deepEqual(Object.keys(input).sort(), ['app', 'index']);
  assert.equal(path.basename(input.index), 'index.html');
  assert.equal(path.basename(input.app), 'app.html');
  assert.ok(Object.values(input).every((file) => !file.includes('preview')));
  assert.deepEqual(input, coreBuildInputs(path.resolve('apps/frontend')));
});

test('build: build:core is refused without an explicit real/mock data source', () => {
  for (const raw of [undefined, '', '  ', 'production']) {
    assert.throws(() => runCoreBuildHook(CORE_BUILD_MODE, raw), /requires VITE_DATA_PROVIDER/, JSON.stringify(raw));
  }
  assert.doesNotThrow(() => assertCoreBuildProvider('mock'));
  assert.doesNotThrow(() => assertCoreBuildProvider(' real '));
});

test('build: the core-entry plugin only applies to builds; the dev server is untouched', () => {
  assert.equal(coreBuildEntry().apply, 'build');
});

/* --------------------------------------------------------------------- *
 * infra/Caddyfile — the Core handle (static reading; behaviour is        *
 * exercised against a real Caddy in tests/f7-production/)                *
 * --------------------------------------------------------------------- */

const caddyfile = readFileSync(path.join(__dirname, '../infra/Caddyfile'), 'utf8');

/**
 * The block opened by the line that is exactly `opening`, up to its closing
 * `}` at the same indentation. Braces inside lines (`{path}`,
 * `{$VAR:default}`) are placeholders, not structure, so lines — not
 * characters — are what is matched.
 */
function handleBlock(opening: string): string {
  const lines = caddyfile.split('\n');
  const start = lines.findIndex((line) => line === opening);
  assert.notEqual(start, -1, `missing: ${opening}`);
  const indent = opening.slice(0, opening.length - opening.trimStart().length);
  const end = lines.findIndex((line, index) => index > start && line === `${indent}}`);
  assert.notEqual(end, -1, `unterminated block: ${opening}`);
  return lines.slice(start, end + 1).join('\n');
}

test('Caddyfile: /app.html and /app.html/* have their own handle that serves app.html with no legacy fallback', () => {
  assert.match(caddyfile, /@core path \/app\.html \/app\.html\/\*/);
  const core = handleBlock('  handle @core {');
  assert.match(core, /rewrite \* \/app\.html/);
  assert.match(core, /root \* \/srv/);
  assert.match(core, /file_server/);
  assert.doesNotMatch(core, /try_files|index\.html/);
});

test('Caddyfile: the legacy catch-all is unchanged and the Core CSP is identical to it', () => {
  const legacy = handleBlock('  handle {');
  assert.match(legacy, /try_files \{path\} \/index\.html/);
  const cspOf = (block: string) => block.match(/header Content-Security-Policy "([^"]+)"/)?.[1];
  assert.ok(cspOf(legacy));
  assert.equal(cspOf(handleBlock('  handle @core {')), cspOf(legacy));
});
