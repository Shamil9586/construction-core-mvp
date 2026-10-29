import { test } from 'node:test';
import assert from 'node:assert/strict';
import { areaCoverageGaps, blockingError, computeGenerationPreview, type PreviewArea, type PreviewInput, type PreviewOccurrence } from '../packages/domain/gpr2/r05';

/**
 * GPR-2 R05 corrective — R05-GPT-B04 (GPT_REVIEW_20261024): a measured parent AreaScope is generated only when its leaves represent ALL of its measure.
 * Pure: computeGenerationPreview() is the function the backend runs for the preview AND again inside the confirm transaction, so what is pinned here is
 * what both answer. The database side (AreaScope sums, the confirm refusal, concurrent confirms) is in gpr2-r05-corrective-native-pg.test.ts.
 *
 * Semantics: never a remainder AreaScope invented, never a quantity silently dropped. A node whose children cover less than its measure (in the stage
 * unit) is a structured blocker MISSING_REQUIRED_DATA / AREA_COVERAGE_INCOMPLETE naming the node, with the uncovered quantity as a missing input; more
 * than its measure is AREA_SCOPE_CONFLICT / AREA_OVERLAP. LOCAL stages apply only where their own quantity is stated, so coverage does not concern them.
 */
const U = 'м²';
const area = (id: string, parentId: string | null, q: string | null, unit: string | null = q === null ? null : U): PreviewArea =>
  ({ id, parentId, code: id, name: id, kind: 'ZONE', measureQuantity: q, measureUnit: unit });
const occ = (key: string, position: number, extra: Partial<PreviewOccurrence> = {}): PreviewOccurrence => ({
  id: 'occ-' + key, occurrenceKey: key, position, workTypeId: 'wt-' + key, workTypeName: key, workTypeUnit: U, required: true, measureScope: 'MAIN', measureUnit: U,
  proposedHoldHours: null, overrideKind: 'ADDED_LOCAL', ...extra
});
const input = (areas: PreviewArea[], areaScopeIds: string[], occurrences = [occ('PLASTER', 1)], extra: Record<string, unknown> = {}): PreviewInput => ({
  finishType: { id: 'ft', code: 'T1', name: 'Тип №1', version: 1 }, systemVersion: { id: 'sv', versionNumber: 1, isCurrent: true }, scopeVersion: '7',
  occurrences, areas, bindings: [], otherFinishAreaIds: [], legacyWorks: [], request: { systemVersionId: 'sv', areaScopeIds, ...extra } as any
});
const rules = (p: ReturnType<typeof computeGenerationPreview>) => p.blockers.map(b => [b.error, b.rule, b.areaScopeId]);

test('B04: parent 1000 with a single child 600 — the 400 is a blocker with the uncovered quantity, nothing proposed for confirmation, confirm refused', () => {
  const p = computeGenerationPreview(input([area('P', null, '1000'), area('C1', 'P', '600')], ['P']));
  assert.equal(p.canConfirm, false);
  assert.deepEqual(rules(p), [['MISSING_REQUIRED_DATA', 'AREA_COVERAGE_INCOMPLETE', 'P']]);
  assert.deepEqual(p.missingInputs, [{ kind: 'AREA_COVERAGE', occurrenceKey: 'PLASTER', areaScopeId: 'P', quantity: '400.0000', unit: U }]);
  assert.ok(!p.items.some(i => i.areaScopeId === 'P'), 'no remainder area is invented');
  const e = blockingError(p)!;
  assert.equal(e.code, 'MISSING_REQUIRED_DATA');
  assert.deepEqual((e as any).details.violations, [{ path: 'areaScopeIds', rule: 'AREA_COVERAGE_INCOMPLETE' }]);
});

test('B04: children 600 + 400 cover 1000 exactly — one Work of 1000, no blocker', () => {
  const p = computeGenerationPreview(input([area('P', null, '1000'), area('C1', 'P', '600'), area('C2', 'P', '400')], ['P']));
  assert.deepEqual(p.blockers, []); assert.equal(p.canConfirm, true);
  assert.deepEqual(p.proposedWorks.map(w => [w.quantity, w.areaScopeIds]), [['1000.0000', ['C1', 'C2']]]);
});

test('B04: children 600 + 500 exceed 1000 (PostgreSQL refuses such a child; the pure rule refuses it too) — AREA_SCOPE_CONFLICT, nothing confirmable', () => {
  const p = computeGenerationPreview(input([area('P', null, '1000'), area('C1', 'P', '600'), area('C2', 'P', '500')], ['P']));
  assert.equal(p.canConfirm, false);
  assert.deepEqual(rules(p), [['AREA_SCOPE_CONFLICT', 'AREA_OVERLAP', 'P']]);
});

test('B04: parent and child selected together — AREA_OVERLAP first (priority), the coverage gap of the parent is still reported', () => {
  const p = computeGenerationPreview(input([area('P', null, '1000'), area('C1', 'P', '600')], ['P', 'C1']));
  assert.equal(p.canConfirm, false);
  assert.deepEqual(rules(p)[0], ['AREA_SCOPE_CONFLICT', 'AREA_OVERLAP', 'C1']);
  assert.ok(rules(p).some(r => r[1] === 'AREA_COVERAGE_INCOMPLETE' && r[2] === 'P'));
});

test('B04: nested hierarchy — the gap is reported at the level where it is, with its own uncovered quantity; an unmeasured intermediate is covered by its children', () => {
  const full = [area('P', null, '1000'), area('F1', 'P', '600'), area('R1', 'F1', '300'), area('R2', 'F1', '300'), area('F2', 'P', '400')];
  assert.deepEqual(computeGenerationPreview(input(full, ['P'])).blockers, []);
  const inner = [area('P', null, '1000'), area('F1', 'P', '600'), area('R1', 'F1', '300'), area('R2', 'F1', '200'), area('F2', 'P', '400')];
  const p = computeGenerationPreview(input(inner, ['P']));
  assert.deepEqual(rules(p), [['MISSING_REQUIRED_DATA', 'AREA_COVERAGE_INCOMPLETE', 'F1']]);
  assert.deepEqual(p.missingInputs.map(m => [m.areaScopeId, m.quantity]), [['F1', '100.0000']]);
  // F1 without a measure: P is covered by R1 + R2 + F2 = 900 < 1000 → the gap is P's (100)
  const unmeasured = [area('P', null, '1000'), area('F1', 'P', null), area('R1', 'F1', '300'), area('R2', 'F1', '200'), area('F2', 'P', '400')];
  assert.deepEqual(computeGenerationPreview(input(unmeasured, ['P'])).missingInputs.map(m => [m.areaScopeId, m.quantity]), [['P', '100.0000']]);
  // selecting only the inner node: P is not part of the selection, its coverage is not this preview's question
  assert.deepEqual(rules(computeGenerationPreview(input(inner, ['F1']))), [['MISSING_REQUIRED_DATA', 'AREA_COVERAGE_INCOMPLETE', 'F1']]);
  assert.deepEqual(computeGenerationPreview(input(inner, ['R1', 'F2'])).blockers, [], 'leaves selected directly carry no coverage question');
});

test('B04: a child without a measure is QUANTITY_MISSING (not a fabricated coverage figure); a parent measured in another unit declares nothing to cover', () => {
  const p = computeGenerationPreview(input([area('P', null, '1000'), area('C1', 'P', '600'), area('C2', 'P', null)], ['P']));
  assert.deepEqual(rules(p), [['MISSING_REQUIRED_DATA', 'QUANTITY_MISSING', 'C2']]);
  const cubic = computeGenerationPreview(input([area('P', null, '30', 'м³'), area('C1', 'P', '600')], ['P']));
  assert.deepEqual(cubic.blockers, []); assert.deepEqual(cubic.proposedWorks.map(w => w.quantity), ['600.0000']);
});

test('B04: LOCAL stages — coverage does not concern them (their quantity is stated per area); the MAIN stage of the same preview is still blocked', () => {
  const areas = [area('P', null, '1000'), area('C1', 'P', '600')];
  const local = occ('WATERPROOF', 2, { measureScope: 'LOCAL' });
  const onlyLocal = computeGenerationPreview(input(areas, ['P'], [local], { localQuantities: [{ occurrenceKey: 'WATERPROOF', areaScopeId: 'C1', quantity: '150' }] }));
  assert.deepEqual(onlyLocal.blockers, []); assert.deepEqual(onlyLocal.proposedWorks.map(w => w.quantity), ['150.0000']);
  const mixed = computeGenerationPreview(input(areas, ['P'], [occ('PLASTER', 1), local], { localQuantities: [{ occurrenceKey: 'WATERPROOF', areaScopeId: 'C1', quantity: '150' }] }));
  assert.deepEqual(rules(mixed), [['MISSING_REQUIRED_DATA', 'AREA_COVERAGE_INCOMPLETE', 'P']]);
  assert.equal(mixed.canConfirm, false);
});

test('B04: one blocker per MAIN occurrence; preview fingerprint is deterministic and moves when coverage changes', () => {
  const areas = [area('P', null, '1000'), area('C1', 'P', '600')];
  const two = [occ('PLASTER', 1), occ('PAINT', 2)];
  const a = computeGenerationPreview(input(areas, ['P'], two)), b = computeGenerationPreview(input([...areas].reverse(), ['P'], [...two].reverse()));
  assert.equal(a.previewFingerprint, b.previewFingerprint, 'the same inputs in another order → the same fingerprint');
  assert.deepEqual(a.blockers.map(x => x.occurrenceKey).sort(), ['PAINT', 'PLASTER']);
  const covered = computeGenerationPreview(input([...areas, area('C2', 'P', '400')], ['P'], two));
  assert.notEqual(covered.previewFingerprint, a.previewFingerprint);
  assert.equal(covered.canConfirm, true);
});

test('areaCoverageGaps(): exact decimals, no float drift (0.1 + 0.2 = 0.3)', () => {
  const m = new Map([area('P', null, '0.3'), area('A', 'P', '0.1'), area('B', 'P', '0.2')].map(a => [a.id, a]));
  const kids = new Map([['P', ['A', 'B']]]);
  assert.deepEqual(areaCoverageGaps('P', U, m, kids), []);
  m.set('B', area('B', 'P', '0.1999'));
  assert.deepEqual(areaCoverageGaps('P', U, m, kids), [{ areaScopeId: 'P', kind: 'INCOMPLETE', quantity: '0.0001' }]);
});
