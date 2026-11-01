import test from 'node:test';
import assert from 'node:assert/strict';
import { listFinishSystems } from '../apps/frontend/src/data/finishSystemApi';

const page = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('finish systems pagination follows cursor and returns all pages', async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input); calls.push(url);
    return calls.length === 1
      ? page({ items: [{ id: 'a', code: 'TYPE-1' }], nextCursor: 'next' })
      : page({ items: [{ id: 'b', code: 'TYPE-2' }], nextCursor: null });
  }) as typeof fetch;
  try { assert.deepEqual((await listFinishSystems('object-1')).map((x) => x.id), ['a', 'b']); assert.equal(calls.length, 2); }
  finally { globalThis.fetch = original; }
});

test('finish systems missing nextCursor fails closed', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => page({ items: [{ id: 'a' }] })) as typeof fetch;
  try { await assert.rejects(() => listFinishSystems('object-1')); }
  finally { globalThis.fetch = original; }
});

test('finish systems error preserves unavailable status', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => page({ message: 'forbidden' }, 403)) as typeof fetch;
  try { await assert.rejects(() => listFinishSystems('object-1'), (error: any) => error.status === 403); }
  finally { globalThis.fetch = original; }
});
