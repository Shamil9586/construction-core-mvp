import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockingError, computeGenerationPreview, producerCompatible, type PreviewBinding, type PreviewInput, type PreviewOccurrence } from '../packages/domain/gpr2/r05';

/**
 * GPR-2 R05 independent-acceptance corrective — R05-IND-NEW-05: an existing producer satisfies an obligation of another version only when it performs the
 * SAME operation (WorkType of its Work and of its occurrence, unit, measure scope). Pure: this is the function preview AND confirm run. The command-guard
 * and native PostgreSQL forms are in gpr2-r05-independent-native-pg.test.ts and gpr2-r05d-generation.test.ts.
 */
const U = 'м²';
const occ = (x: Partial<PreviewOccurrence> = {}): PreviewOccurrence => ({ id: 'occ-v2', occurrenceKey: 'SAME_KEY', position: 1, workTypeId: 'wt-A', workTypeName: 'A', workTypeUnit: U,
  required: true, measureScope: 'MAIN', measureUnit: U, proposedHoldHours: null, overrideKind: 'ADDED_LOCAL', ...x });
const producer = (x: Partial<PreviewBinding> = {}): PreviewBinding => ({ id: 'b1', workId: 'w-old', occurrenceKey: 'SAME_KEY', areaScopeId: 'R', systemVersionId: 'sv1', workName: 'old',
  workUnit: U, workQuantity: '50.0000', workTypeId: 'wt-A', producedWorkTypeId: 'wt-A', producedMeasureUnit: U, producedMeasureScope: 'MAIN', basisQuantity: '50.0000', ...x });
const input = (o: PreviewOccurrence, b: PreviewBinding, extra: any = {}): PreviewInput => ({
  finishType: { id: 'ft', code: 'T', name: 'Тип', version: 1 }, systemVersion: { id: 'sv2', versionNumber: 2, isCurrent: true }, scopeVersion: '3',
  occurrences: [o, occ({ id: 'occ-new', occurrenceKey: 'NEW_STAGE', position: 2, workTypeId: 'wt-A' })], areas: [{ id: 'R', parentId: null, code: 'R', name: 'R', kind: 'ZONE', measureQuantity: '50', measureUnit: U }],
  bindings: [b], otherFinishAreaIds: [], legacyWorks: [], request: { systemVersionId: 'sv2', areaScopeIds: ['R'], ...extra }
});

test('NEW-05: same key + same operation → EXISTING (compatible version transition; the producer of another version is reused, not duplicated)', () => {
  assert.equal(producerCompatible(producer(), occ()), true);
  const p = computeGenerationPreview(input(occ(), producer()));
  assert.deepEqual(p.blockers, []); assert.equal(p.canConfirm, true);
  assert.deepEqual(p.existingWorks.map(w => [w.workId, w.systemVersionId]), [['w-old', 'sv1']]);
  assert.ok(p.warnings.some(w => w.code === 'EXISTING_FROM_OTHER_VERSION'));
  assert.deepEqual(p.proposedWorks.map(w => w.occurrenceKey), ['NEW_STAGE']);
});

for (const [name, o, b, extra] of [
  ['changed WorkType', occ({ workTypeId: 'wt-B' }), producer(), {}],
  ['changed unit (another WorkType in another unit)', occ({ workTypeId: 'wt-C', workTypeUnit: 'м³', measureUnit: 'м³' }), producer(), {}],
  ['MAIN → LOCAL', occ({ measureScope: 'LOCAL' }), producer(), { localQuantities: [{ occurrenceKey: 'SAME_KEY', areaScopeId: 'R', quantity: '20' }] }],
  ['LOCAL → MAIN (changed measurement rule)', occ(), producer({ producedMeasureScope: 'LOCAL' }), {}],
  ['a producer Work of another WorkType than its own occurrence (defence in depth)', occ(), producer({ workTypeId: 'wt-X' }), {}]
] as [string, PreviewOccurrence, PreviewBinding, any][]) {
  test('NEW-05: same key + ' + name + ' → structured blocker PRODUCER_INCOMPATIBLE; the old Work is not EXISTING, nothing for SAME_KEY is proposed, confirm is refused', () => {
    assert.equal(producerCompatible(b, o), false);
    const p = computeGenerationPreview(input(o, b, extra));
    assert.equal(p.canConfirm, false);
    assert.deepEqual(p.blockers.map(x => [x.error, x.rule, x.occurrenceKey, x.areaScopeId]), [['ONE_PRODUCER_CONFLICT', 'PRODUCER_INCOMPATIBLE', 'SAME_KEY', 'R']]);
    assert.deepEqual(p.existingWorks, []);
    assert.ok(!p.proposedWorks.some(w => w.occurrenceKey === 'SAME_KEY'), 'no duplicate producer of the held obligation');
    assert.deepEqual(p.items.find(i => i.occurrenceKey === 'SAME_KEY'), { occurrenceKey: 'SAME_KEY', occurrenceId: o.id, areaScopeId: 'R', status: 'BLOCKED', quantity: null, unit: o.measureUnit, existingWorkId: 'w-old' });
    const e = blockingError(p)!;
    assert.equal(e.code, 'ONE_PRODUCER_CONFLICT');
    assert.deepEqual((e as any).details.violations, [{ path: 'areaScopeIds', rule: 'PRODUCER_INCOMPATIBLE' }]);
  });
}

test('NEW-05: the fingerprint distinguishes a compatible from an incompatible transition (confirm cannot reuse one preview for the other)', () => {
  const ok = computeGenerationPreview(input(occ(), producer())), bad = computeGenerationPreview(input(occ({ workTypeId: 'wt-B' }), producer()));
  assert.notEqual(ok.previewFingerprint, bad.previewFingerprint);
});
