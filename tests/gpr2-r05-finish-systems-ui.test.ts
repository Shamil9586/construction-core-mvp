import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { listFinishSystems } from '../apps/frontend/src/data/finishSystemApi';
import { StageProvenance, VersionExclusions } from '../apps/frontend/src/screens/FinishSystems/Provenance';
import type { FinishSystemStage } from '../apps/frontend/src/types/finishSystem';

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

test('finish systems render stage provenance ids and every individual exclusion', () => {
  const stage = { sourceTemplateVersionId: 'tv-1', sourceTemplateStageId: 'ts-9' } as FinishSystemStage;
  const stageHtml = renderToStaticMarkup(React.createElement(StageProvenance, { stage }));
  assert.match(stageHtml, /data-field="sourceTemplateVersionId">tv-1</);
  assert.match(stageHtml, /data-field="sourceTemplateStageId">ts-9</);
  const nullStage = { sourceTemplateVersionId: null, sourceTemplateStageId: null } as FinishSystemStage;
  assert.equal((renderToStaticMarkup(React.createElement(StageProvenance, { stage: nullStage })).match(/>—</g) ?? []).length, 2);

  const exclusions = [
    { templateStageId: 'ts-1', sourceTemplateVersionId: 'tv-1', reason: 'Не применимо к объекту' },
    { templateStageId: 'ts-2', sourceTemplateVersionId: 'tv-2', reason: 'Заменено локальным этапом' },
  ];
  const html = renderToStaticMarkup(React.createElement(VersionExclusions, { exclusions }));
  assert.equal((html.match(/data-testid="exclusion"/g) ?? []).length, 2);
  for (const x of exclusions) {
    assert.ok(html.includes(`data-field="templateStageId">${x.templateStageId}<`));
    assert.ok(html.includes(`data-field="sourceTemplateVersionId">${x.sourceTemplateVersionId}<`));
    assert.ok(html.includes(`data-field="reason">${x.reason}<`));
  }
  assert.equal(renderToStaticMarkup(React.createElement(VersionExclusions, { exclusions: [] })), '');
});

test('finish systems error preserves unavailable status', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => page({ message: 'forbidden' }, 403)) as typeof fetch;
  try { await assert.rejects(() => listFinishSystems('object-1'), (error: any) => error.status === 403); }
  finally { globalThis.fetch = original; }
});
