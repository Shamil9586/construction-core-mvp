import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockingError, computeGenerationPreview, type PreviewBinding, type PreviewInput, type PreviewOccurrence } from '../packages/domain/gpr2/r05';

/**
 * GPR-2 R05 third corrective — the LOCAL-quantity case of GPT_REVIEW_20261025_R05_INDEPENDENT_CORRECTIVE. A LOCAL producer was generated for the quantity
 * stated then (its binding's basis). Restating the obligation with another quantity is a quantity change (R06 / R07): never satisfied by the old
 * producer, never silently replaced — a structured blocker. Pure: preview AND confirm run this. Native / command-guard form: gpr2-r05-r3-native-pg.test.ts.
 */
const U = 'м²';
const local = (x: Partial<PreviewOccurrence> = {}): PreviewOccurrence => ({ id: 'occ-v2', occurrenceKey: 'SAME_KEY', position: 1, workTypeId: 'wt-X', workTypeName: 'X', workTypeUnit: U,
  required: true, measureScope: 'LOCAL', measureUnit: U, proposedHoldHours: null, overrideKind: 'ADDED_LOCAL', ...x });
const producer: PreviewBinding = { id: 'b1', workId: 'w-20', occurrenceKey: 'SAME_KEY', areaScopeId: 'R', systemVersionId: 'sv1', workName: 'old', workUnit: U, workQuantity: '20.0000',
  workTypeId: 'wt-X', producedWorkTypeId: 'wt-X', producedMeasureUnit: U, producedMeasureScope: 'LOCAL', basisQuantity: '20.0000' };
const input = (stated: string | null, occ = local()): PreviewInput => ({
  finishType: { id: 'ft', code: 'T', name: 'Тип', version: 1 }, systemVersion: { id: 'sv2', versionNumber: 2, isCurrent: true }, scopeVersion: '5',
  occurrences: [occ, { ...local({ id: 'occ-new', occurrenceKey: 'NEW_STAGE', position: 2 }), measureScope: 'MAIN' }],
  areas: [{ id: 'R', parentId: null, code: 'R', name: 'R', kind: 'ZONE', measureQuantity: '50', measureUnit: U }], bindings: [producer], otherFinishAreaIds: [], legacyWorks: [],
  request: { systemVersionId: 'sv2', areaScopeIds: ['R'], ...(stated === null ? {} : { localQuantities: [{ occurrenceKey: 'SAME_KEY', areaScopeId: 'R', quantity: stated }] }) } as any
});

test('LOCAL 20 → restated 30: the 20 producer does not satisfy 30 — blocker PRODUCER_QUANTITY_CHANGED, no EXISTING, no new producer, confirm refused', () => {
  const p = computeGenerationPreview(input('30'));
  assert.equal(p.canConfirm, false);
  assert.deepEqual(p.blockers.map(b => [b.error, b.rule, b.occurrenceKey, b.areaScopeId]), [['ONE_PRODUCER_CONFLICT', 'PRODUCER_QUANTITY_CHANGED', 'SAME_KEY', 'R']]);
  assert.deepEqual(p.existingWorks, []);
  assert.ok(!p.proposedWorks.some(w => w.occurrenceKey === 'SAME_KEY'));
  assert.equal(p.items.find(i => i.occurrenceKey === 'SAME_KEY')!.status, 'BLOCKED');
  assert.deepEqual((blockingError(p) as any).details.violations, [{ path: 'localQuantities', rule: 'PRODUCER_QUANTITY_CHANGED' }]);
});

test('LOCAL 20 → restated 20 (also as "20.0000"): EXISTING — the same obligation; only the new stage is proposed', () => {
  for (const q of ['20', '20.0000']) {
    const p = computeGenerationPreview(input(q));
    assert.deepEqual(p.blockers, []);
    assert.deepEqual(p.existingWorks.map(w => [w.workId, w.quantity]), [['w-20', '20.0000']]);
    assert.deepEqual(p.proposedWorks.map(w => w.occurrenceKey), ['NEW_STAGE']);
  }
});

test('LOCAL 20 → restated 19.9999: exact decimals — a blocker, not a rounding to "equal"', () => {
  assert.deepEqual(computeGenerationPreview(input('19.9999')).blockers.map(b => b.rule), ['PRODUCER_QUANTITY_CHANGED']);
});

test('LOCAL 20, no quantity restated: the existing producer is shown as it is (nothing new is asked of it)', () => {
  const p = computeGenerationPreview(input(null));
  assert.deepEqual(p.blockers, []);
  assert.deepEqual(p.existingWorks.map(w => w.quantity), ['20.0000']);
});

test('an incompatible producer is reported as PRODUCER_INCOMPATIBLE first, whatever quantity is stated', () => {
  const p = computeGenerationPreview(input('30', local({ workTypeId: 'wt-Y' })));
  assert.deepEqual(p.blockers.map(b => b.rule), ['PRODUCER_INCOMPATIBLE']);
});
