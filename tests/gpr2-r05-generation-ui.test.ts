import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmFinishGeneration, previewFinishGeneration } from '../apps/frontend/src/data/finishGenerationApi';
import { generationSelection } from '../apps/frontend/src/screens/FinishSystems/generationSelection';
import type { FinishSystemRead } from '../apps/frontend/src/types/finishSystem';
import type { AreaScopeRead } from '../apps/frontend/src/types/areaScope';
import type { GenerationPreviewResponse } from '../apps/frontend/src/types/finishGeneration';

const system = {
  id: 'system-1', lifecycle: 'ACTIVE', version: '7',
  currentVersion: { id: 'version-1', versionNumber: 2, stages: [
    { id: 'stage-1', occurrenceKey: 'MAIN-1', required: true, measureScope: 'MAIN', measureUnit: 'м²' },
    { id: 'stage-2', occurrenceKey: 'LOCAL-1', required: false, measureScope: 'LOCAL', measureUnit: 'м²' },
  ] },
} as FinishSystemRead;
const areas = [{ id: 'area-1', lifecycle: 'ACTIVE' }, { id: 'area-2', lifecycle: 'RETIRED' }] as AreaScopeRead[];
const response: GenerationPreviewResponse = {
  preview: { previewFingerprint: 'a'.repeat(64), scopeVersion: '12', systemVersionId: 'version-1',
    sourceVersions: { systemVersion: 'version-1' }, grouping: 'PER_OCCURRENCE', proposedWorks: [],
    existingWorks: [], items: [], blockers: [], missingInputs: [], warnings: [], canConfirm: true,
  }, appliedVersions: { aggregate: '7', scope: '12' }, resultIds: [], warnings: [],
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json' },
});

test('S4 selection includes only active zones and explicit local quantities', () => {
  const selection = generationSelection(system, ['area-1', 'area-1'], ['LOCAL-1'],
    { 'LOCAL-1|area-1': ' 2.50 ' }, 'PER_AREA', areas);
  assert.deepEqual(selection, { systemVersionId: 'version-1', areaScopeIds: ['area-1'],
    includeOptional: ['LOCAL-1'], localQuantities: [{ occurrenceKey: 'LOCAL-1', areaScopeId: 'area-1', quantity: '2.50' }],
    grouping: 'PER_AREA' });
  assert.throws(() => generationSelection(system, ['area-2'], [], {}, 'PER_OCCURRENCE', areas), /действующих зон/);
  assert.throws(() => generationSelection(system, ['area-1'], ['UNKNOWN'], {}, 'PER_OCCURRENCE', areas), /неизвестный/);
  assert.throws(() => generationSelection(system, ['area-1'], ['LOCAL-1'], { 'LOCAL-1|area-1': '0' }, 'PER_OCCURRENCE', areas), /положительным/);
});

test('S4 preview is read-only projection; confirm carries all fences and the caller retry key', async () => {
  const original = globalThis.fetch;
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit) => {
    calls.push({ url: String(input), init });
    return json(calls.length === 1 ? response : { resultIds: ['work-1'], appliedVersions: { aggregate: '7', scope: '13' }, warnings: [] });
  }) as typeof fetch;
  try {
    const selection = generationSelection(system, ['area-1'], [], {}, 'PER_OCCURRENCE', areas);
    const preview = await previewFinishGeneration('object /1', system.id, system.version, selection);
    const result = await confirmFinishGeneration('object /1', system.id, system.version, selection, preview, 'stable-key');
    assert.deepEqual(result.resultIds, ['work-1']);
    assert.equal(calls[0]?.url, '/api/v2/objects/object%20%2F1/finish-systems/system-1/preview');
    assert.equal(calls[1]?.url, '/api/v2/objects/object%20%2F1/finish-systems/system-1/confirm');
    assert.equal((calls[0]?.init.headers as Record<string, string>)['Idempotency-Key'], undefined);
    assert.equal((calls[1]?.init.headers as Record<string, string>)['Idempotency-Key'], 'stable-key');
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { expectedVersion: '7', payload: selection });
    assert.deepEqual(JSON.parse(String(calls[1]?.init.body)), { expectedVersion: '7', expectedScopeVersion: '12',
      payload: { ...selection, previewFingerprint: 'a'.repeat(64), expectedSourceVersions: { systemVersion: 'version-1' } } });
  } finally { globalThis.fetch = original; }
});

test('S4 rejects incomplete preview instead of enabling confirm', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => json({ preview: { canConfirm: true } })) as typeof fetch;
  try {
    await assert.rejects(() => previewFinishGeneration('object-1', system.id, system.version,
      generationSelection(system, ['area-1'], [], {}, 'PER_OCCURRENCE', areas)), /Неверный ответ сервера/);
  } finally { globalThis.fetch = original; }
});
