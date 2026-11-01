import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAreaTree, describeApiError, kindLabel, measureText, parentOptions } from '../apps/frontend/src/view-models/areaScope';
import {
  AREA_SCOPE_MAX_PAGES,
  AreaScopeApiError,
  AreaScopePaginationError,
  createAreaScope,
  listAllAreaScopes,
  violationsOf,
} from '../apps/frontend/src/data/areaScopeApi';
import { canViewAreaScopes, INTERNAL_CORE_ROLES } from '../apps/frontend/src/auth/internalRoles';
import { areaScopesPath } from '../apps/frontend/src/app/routePaths';
import type { AreaScopeRead } from '../apps/frontend/src/types/areaScope';

/**
 * GPR-2 R05 S2 — pure/frontend-boundary tests. No browser, no backend: `fetch` is replaced by a recording stub, so these prove request
 * shape and fail-closed behaviour of the client, NOT real backend integration.
 */
const node = (over: Partial<AreaScopeRead> & { id: string }): AreaScopeRead => ({
  parentId: null, kind: 'BUILDING', code: over.id, name: `Зона ${over.id}`, measureQuantity: null, measureUnit: null,
  lifecycle: 'ACTIVE', version: 1, createdAt: '2026-10-30T00:00:00Z', updatedAt: '2026-10-30T00:00:00Z', ...over,
});

test('flat list becomes a parent/child tree, any kind under any kind', () => {
  const tree = buildAreaTree([
    node({ id: 'room', parentId: 'b', kind: 'ROOM' }),
    node({ id: 'b', kind: 'BUILDING' }),
    node({ id: 'surface', parentId: 'b', kind: 'SURFACE' }),
    node({ id: 'deep', parentId: 'room', kind: 'BUILDING' }),
  ]);
  assert.equal(tree.total, 4);
  assert.deepEqual(tree.roots.map((n) => n.id), ['b']);
  assert.deepEqual(tree.roots[0]!.children.map((n) => n.id), ['room', 'surface']);
  assert.equal(tree.roots[0]!.children[0]!.children[0]!.id, 'deep');
  assert.deepEqual(tree.rows.map((n) => [n.id, n.depth]), [['b', 0], ['room', 1], ['deep', 2], ['surface', 1]]);
  assert.equal(tree.orphanCount + tree.cycleCount + tree.duplicateIdCount, 0);
});

test('ordering: natural code order, then name, then id — independent of input order', () => {
  const items = [node({ id: 'c', code: 'Этаж 10' }), node({ id: 'a', code: 'Этаж 2' }), node({ id: 'b', code: 'Этаж 2', name: 'Я' }), node({ id: 'd', code: 'Этаж 2', name: 'А' })];
  const forward = buildAreaTree(items).rows.map((n) => n.id);
  const reversed = buildAreaTree([...items].reverse()).rows.map((n) => n.id);
  assert.deepEqual(forward, ['d', 'a', 'b', 'c'].map((id) => id)); // 2 < 10 numerically; ties by name ("А" < "Зона a" < "Я")
  assert.deepEqual(forward, reversed);
});

test('orphan: a missing parent is shown at top level and flagged, never dropped', () => {
  const tree = buildAreaTree([node({ id: 'x', parentId: 'ghost' }), node({ id: 'self', parentId: 'self' })]);
  assert.equal(tree.total, 2);
  assert.equal(tree.orphanCount, 2);
  assert.ok(tree.roots.every((n) => n.flag === 'ORPHAN'));
});

test('cycle: nodes only reachable through a parent loop are surfaced once, flagged, and terminate', () => {
  const tree = buildAreaTree([node({ id: 'a', parentId: 'b' }), node({ id: 'b', parentId: 'a' }), node({ id: 'ok' })]);
  assert.equal(tree.total, 3);
  assert.equal(tree.cycleCount, 1);
  assert.equal(new Set(tree.rows.map((n) => n.id)).size, 3);
  assert.equal(tree.roots.filter((n) => n.flag === 'CYCLE').length, 1);
});

test('duplicate ids are rendered once and counted', () => {
  const tree = buildAreaTree([node({ id: 'a', name: 'первый' }), node({ id: 'a', name: 'второй' })]);
  assert.equal(tree.total, 1);
  assert.equal(tree.duplicateIdCount, 1);
  assert.equal(tree.rows[0]!.name, 'первый');
});

test('unknown kind and lifecycle fall back to a visible, non-lossy label', () => {
  assert.deepEqual(kindLabel('ZONE'), { label: 'Захватка', known: true });
  assert.deepEqual(kindLabel('ATTIC'), { label: 'Неизвестный вид (ATTIC)', known: false });
  assert.equal(kindLabel('constructor').known, false);
  const tree = buildAreaTree([node({ id: 'a', kind: 'ATTIC', lifecycle: 'PAUSED' })]);
  assert.equal(tree.rows[0]!.kindKnown, false);
  assert.equal(tree.rows[0]!.kindRaw, 'ATTIC');
  assert.equal(tree.rows[0]!.active, false);
  assert.match(tree.rows[0]!.lifecycle, /PAUSED/);
});

test('quantity stays a decimal string: no float conversion', () => {
  assert.equal(measureText('0.1000', 'м²'), '0,1000 м²');
  assert.equal(measureText('12345678901234567890.1234', 'т'), '12345678901234567890,1234 т');
  assert.equal(measureText(null, null), 'Без объёма');
});

test('parent options list only ACTIVE nodes, in display order', () => {
  const tree = buildAreaTree([node({ id: 'a' }), node({ id: 'b', parentId: 'a', lifecycle: 'RETIRED' }), node({ id: 'c', parentId: 'a' })]);
  assert.deepEqual(parentOptions(tree).map((o) => o.id), ['a', 'c']);
});

test('PROJECT_MANAGER is the only role offered the screen; ADMIN gets no implicit grant', () => {
  for (const role of INTERNAL_CORE_ROLES) assert.equal(canViewAreaScopes(role), role === 'PROJECT_MANAGER', role);
  assert.equal(canViewAreaScopes('CONTRACTOR_VIEWER'), false);
  assert.equal(canViewAreaScopes('SOMETHING_NEW'), false);
});

test('route path carries the real object id, encoded', () => {
  assert.equal(areaScopesPath('obj-1'), '/object/obj-1/finish/areas');
  assert.equal(areaScopesPath('a/b'), '/object/a%2Fb/finish/areas');
});

/* ---------------------------- client (stubbed fetch) ---------------------------- */

interface Call { url: string; init: RequestInit | undefined }
function stubFetch(responses: Array<{ status?: number; body?: unknown; contentType?: string; headers?: Record<string, string> }>): { calls: Call[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  let index = 0;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const r = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { 'content-type': r.contentType ?? 'application/json', ...(r.headers ?? {}) },
    });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}
const page = (ids: string[], nextCursor: string | null) => ({ body: { items: ids.map((id) => node({ id })), nextCursor } });

test('pagination: follows every cursor, one object only, limit=200, bearer sent', async () => {
  const store = new Map<string, string>([['session', 'tok-1']]);
  (globalThis as any).sessionStorage = { getItem: (k: string) => store.get(k) ?? null };
  const stub = stubFetch([page(['a'], 'c1'), page(['b'], 'c2'), page(['c'], null)]);
  try {
    const items = await listAllAreaScopes('obj 1');
    assert.deepEqual(items.map((i) => i.id), ['a', 'b', 'c']);
    assert.equal(stub.calls.length, 3);
    assert.ok(stub.calls.every((c) => c.url.startsWith('/api/v2/objects/obj%201/area-scopes?')));
    assert.ok(stub.calls.every((c) => new URL(c.url, 'http://x').searchParams.get('limit') === '200'));
    assert.deepEqual(stub.calls.map((c) => new URL(c.url, 'http://x').searchParams.get('cursor')), [null, 'c1', 'c2']);
    assert.ok(stub.calls.every((c) => (c.init?.headers as Record<string, string>).Authorization === 'Bearer tok-1'));
  } finally {
    stub.restore();
    delete (globalThis as any).sessionStorage;
  }
});

test('pagination fails closed on a repeated cursor and returns no partial list', async () => {
  const stub = stubFetch([page(['a'], 'c1'), page(['b'], 'c1')]);
  try {
    await assert.rejects(() => listAllAreaScopes('o'), AreaScopePaginationError);
    assert.equal(stub.calls.length, 2);
  } finally { stub.restore(); }
});

test('pagination fails closed when the page budget is exhausted', async () => {
  let n = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ items: [], nextCursor: `c${n++}` }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  try {
    await assert.rejects(() => listAllAreaScopes('o'), AreaScopePaginationError);
    assert.equal(n, AREA_SCOPE_MAX_PAGES);
  } finally { globalThis.fetch = original; }
});

test('a malformed page or item is rejected, not rendered', async () => {
  const stub = stubFetch([{ body: { items: [{ id: 1 }], nextCursor: null } }]);
  try { await assert.rejects(() => listAllAreaScopes('o'), AreaScopePaginationError); } finally { stub.restore(); }
  const stub2 = stubFetch([{ body: '<html>proxy</html>', contentType: 'text/html' }]);
  try { await assert.rejects(() => listAllAreaScopes('o'), AreaScopePaginationError); } finally { stub2.restore(); }
});

test('403/404 become typed errors (never an empty list); code, details and requestId are kept', async () => {
  for (const status of [403, 404]) {
    const stub = stubFetch([{ status, body: { statusCode: status, message: 'Недостаточно прав', code: 'PERMISSION_DENIED', requestId: 'req-1' } }]);
    try {
      await assert.rejects(() => listAllAreaScopes('o'), (error: unknown) => {
        assert.ok(error instanceof AreaScopeApiError);
        assert.equal(error.status, status);
        assert.equal(error.code, 'PERMISSION_DENIED');
        assert.equal(error.requestId, 'req-1');
        const view = describeApiError(error, violationsOf(error.details));
        assert.equal(view.kind, 'unavailable');
        assert.doesNotMatch(view.message, /Недостаточно прав|не найден/i); // generic: no disclosure
        return true;
      });
    } finally { stub.restore(); }
  }
});

test('create: POST to the route object with Idempotency-Key, JSON body, bearer', async () => {
  const store = new Map<string, string>([['session', 'tok-2']]);
  (globalThis as any).sessionStorage = { getItem: (k: string) => store.get(k) ?? null };
  const stub = stubFetch([{ body: { resultIds: ['n1'], appliedVersions: {}, warnings: [] } }]);
  try {
    const result = await createAreaScope('obj-9', { parentId: 'p1', kind: 'FLOOR', code: '2', name: 'Этаж 2', measureQuantity: '10.5', measureUnit: 'м²' }, 'key-123');
    assert.deepEqual(result.resultIds, ['n1']);
    const call = stub.calls[0]!;
    assert.equal(call.url, '/api/v2/objects/obj-9/area-scopes');
    assert.equal(call.init?.method, 'POST');
    const headers = call.init?.headers as Record<string, string>;
    assert.equal(headers['Idempotency-Key'], 'key-123');
    assert.equal(headers.Authorization, 'Bearer tok-2');
    assert.deepEqual(JSON.parse(String(call.init?.body)), { parentId: 'p1', kind: 'FLOOR', code: '2', name: 'Этаж 2', measureQuantity: '10.5', measureUnit: 'м²' });
  } finally {
    stub.restore();
    delete (globalThis as any).sessionStorage;
  }
});

test('server validation error: Russian message and field lines, details and requestId preserved', async () => {
  const body = { statusCode: 400, message: 'Запрос не соответствует контракту', code: 'VALIDATION_FAILED', details: { violations: [{ path: 'measureUnit', rule: 'UNIT_MISSING' }, { path: 'code', rule: 'SOMETHING_NEW' }] }, requestId: 'req-7' };
  const stub = stubFetch([{ status: 400, body }]);
  try {
    await assert.rejects(() => createAreaScope('o', { kind: 'ZONE', code: 'x', name: 'y', measureQuantity: '1' }, 'k'), (error: unknown) => {
      assert.ok(error instanceof AreaScopeApiError);
      assert.equal(error.code, 'VALIDATION_FAILED');
      assert.equal(error.requestId, 'req-7');
      const view = describeApiError(error, violationsOf(error.details));
      assert.equal(view.kind, 'validation');
      assert.equal(view.message, 'Запрос не соответствует контракту');
      assert.deepEqual(view.lines, ['Единица: укажите единицу вместе с количеством', 'Код: не принято сервером']);
      assert.equal(view.reference, 'Код обращения: req-7');
      return true;
    });
  } finally { stub.restore(); }
});

test('a non-JSON error body never reaches the user (status-level message only)', async () => {
  const stub = stubFetch([{ status: 502, body: 'connect ECONNREFUSED 10.0.0.7:3001', contentType: 'text/plain' }]);
  try {
    await assert.rejects(() => listAllAreaScopes('o'), (error: unknown) => {
      assert.ok(error instanceof AreaScopeApiError);
      const view = describeApiError(error, []);
      assert.doesNotMatch(view.message, /ECONNREFUSED|10\.0\.0\.7/);
      return true;
    });
  } finally { stub.restore(); }
});
