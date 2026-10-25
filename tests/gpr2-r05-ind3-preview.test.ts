import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PreviewBinding, PreviewInput, PreviewOccurrence, blockingError, computeGenerationPreview, duplicateLocalQuantities, generationConfirmPayload, generationPreviewPayload, parseR05Payload
} from '../packages/domain/gpr2';

/**
 * GPR-2 R05 preview corrective — the two findings of the independent native acceptance of 7a838ca (2026-10-25-7a838ca-findings.md), pure and schema level:
 *   R05-IND3-01  one obligation (occurrence key, AreaScope) is stated at most once in `localQuantities` — a repeat, even of the same value, is refused
 *                (422 VALIDATION_FAILED / DUPLICATE_VALUE at the repeated element) by both payload schemas, and blocks the pure preview as well;
 *                no statement is chosen by its position.
 *   R05-IND3-02  an EXISTING item / existingWorks row is ONE binding: its quantity is the binding's own quantity on its AreaScope; the Work's whole planned
 *                quantity is the separate `workPlannedQuantity`. One Work 1000 = A 600 + B 400 is shown as 600 and 400, never as 1000 + 1000.
 * The command-guard and native PostgreSQL forms are in gpr2-r05-ind3-native-pg.test.ts.
 */
const U = 'м²';
const A = '00000000-0000-4000-8000-00000000000a', B = '00000000-0000-4000-8000-00000000000b', SV = '00000000-0000-4000-8000-0000000000f2';
const occ = (x: Partial<PreviewOccurrence> = {}): PreviewOccurrence => ({ id: 'occ-k', occurrenceKey: 'K', position: 1, workTypeId: 'wt', workTypeName: 'T', workTypeUnit: U,
  required: true, measureScope: 'LOCAL', measureUnit: U, proposedHoldHours: null, overrideKind: 'ADDED_LOCAL', ...x });
const NEW_STAGE = occ({ id: 'occ-n', occurrenceKey: 'N', position: 2, measureScope: 'MAIN' });
const binding = (area: string, basis: string, workQuantity: string, scope: 'MAIN' | 'LOCAL' = 'LOCAL', x: Partial<PreviewBinding> = {}): PreviewBinding => ({
  id: 'b-' + area, workId: 'W', occurrenceKey: 'K', areaScopeId: area, systemVersionId: 'sv1', workName: 'W', workUnit: U, workQuantity, workTypeId: 'wt', producedWorkTypeId: 'wt',
  producedMeasureUnit: U, producedMeasureScope: scope, basisQuantity: basis, ...x });
const input = (occurrences: PreviewOccurrence[], bindings: PreviewBinding[], request: any): PreviewInput => ({
  finishType: { id: 'ft', code: 'F', name: 'F', version: 1 }, systemVersion: { id: SV, versionNumber: 2, isCurrent: true }, scopeVersion: '5', occurrences,
  areas: [{ id: A, parentId: null, code: 'A', name: 'A', kind: 'ZONE', measureQuantity: '600.0000', measureUnit: U }, { id: B, parentId: null, code: 'B', name: 'B', kind: 'ZONE', measureQuantity: '400.0000', measureUnit: U }],
  bindings, otherFinishAreaIds: [], legacyWorks: [], request: { systemVersionId: SV, ...request } });
const lq = (...qs: [string, string, string][]) => qs.map(([occurrenceKey, areaScopeId, quantity]) => ({ occurrenceKey, areaScopeId, quantity }));
const violationsOf = (fn: () => unknown) => { try { fn(); } catch (e: any) { return { code: e.code, status: e.status, violations: e.details?.violations }; } return null; };
const confirmPayload = (localQuantities: unknown) => ({ systemVersionId: SV, areaScopeIds: [A], localQuantities, previewFingerprint: 'a'.repeat(64), expectedSourceVersions: { systemVersion: SV } });

// ------------------------------------------------------------------------------------------------------------------------------- R05-IND3-01, schemas
for (const [label, quantities] of [['10 then 20', ['10', '20']], ['20 then 10', ['20', '10']], ['20 and 20 (same value)', ['20', '20']], ['30 then 20', ['30', '20']], ['20 then 30', ['20', '30']]] as const) {
  test(`R05-IND3-01 schema: the same obligation stated twice (${label}) is refused by preview AND confirm — 422 DUPLICATE_VALUE at the repeat`, () => {
    const list = lq(['K', A, quantities[0]], ['K', A, quantities[1]]);
    const expected = { code: 'VALIDATION_FAILED', status: 422, violations: [{ path: 'localQuantities.1', rule: 'DUPLICATE_VALUE' }] };
    assert.deepEqual(violationsOf(() => parseR05Payload(generationPreviewPayload, { systemVersionId: SV, areaScopeIds: [A], localQuantities: list })), expected);
    assert.deepEqual(violationsOf(() => parseR05Payload(generationConfirmPayload, confirmPayload(list))), expected);
  });
}
test('R05-IND3-01 schema: the repeat is found after id normalisation (upper-case UUID) and at any position; every repeat is named', () => {
  const list = lq(['K', A, '1'], ['K', B, '2'], ['K', A.toUpperCase(), '3'], ['K', B, '4']);
  assert.deepEqual(violationsOf(() => parseR05Payload(generationPreviewPayload, { systemVersionId: SV, areaScopeIds: [A, B], localQuantities: list }))?.violations,
    [{ path: 'localQuantities.2', rule: 'DUPLICATE_VALUE' }, { path: 'localQuantities.3', rule: 'DUPLICATE_VALUE' }]);
});
test('R05-IND3-01 schema: distinct obligations stay valid — other occurrence key, other AreaScope, a single statement, 20.0000', () => {
  for (const list of [lq(['K', A, '20'], ['K2', A, '30']), lq(['K', A, '20'], ['K', B, '20']), lq(['K', A, '20']), lq(['K', A, '20.0000'])]) {
    assert.equal(violationsOf(() => parseR05Payload(generationPreviewPayload, { systemVersionId: SV, areaScopeIds: [A, B], localQuantities: list })), null);
    assert.equal(violationsOf(() => parseR05Payload(generationConfirmPayload, { ...confirmPayload(list), areaScopeIds: [A, B] })), null);
  }
  assert.deepEqual(duplicateLocalQuantities(undefined), []);
  assert.deepEqual(duplicateLocalQuantities(lq(['K', A, '1'], ['K', A, '1'], ['K', A, '1'])), [1, 2]);
});

// ------------------------------------------------------------------------------------------------------------------------------- R05-IND3-01, pure path
for (const [label, quantities] of [['10 then 20', ['10', '20']], ['20 then 10', ['20', '10']], ['20 and 20', ['20', '20']]] as const) {
  test(`R05-IND3-01 pure: a NEW LOCAL obligation stated twice (${label}) creates nothing and takes no value — the preview cannot be confirmed`, () => {
    const p = computeGenerationPreview(input([occ()], [], { areaScopeIds: [A], localQuantities: lq(['K', A, quantities[0]], ['K', A, quantities[1]]) }));
    assert.equal(p.canConfirm, false);
    assert.deepEqual(p.proposedWorks, [], 'neither the first nor the last statement becomes a Work');
    assert.deepEqual(p.items.map(i => [i.occurrenceKey, i.areaScopeId, i.status, i.quantity]), [['K', A, 'BLOCKED', null]]);
    assert.deepEqual(p.blockers.map(b => [b.error, b.rule, b.path]), [['VALIDATION_FAILED', 'DUPLICATE_VALUE', 'localQuantities.1']]);
    const e: any = blockingError(p);
    assert.equal(e.code, 'VALIDATION_FAILED'); assert.equal(e.status, 422);
    assert.deepEqual(e.details.violations, [{ path: 'localQuantities.1', rule: 'DUPLICATE_VALUE' }]);
  });
}
for (const [label, quantities] of [['30 then 20', ['30', '20']], ['20 then 30', ['20', '30']], ['20 and 20', ['20', '20']]] as const) {
  test(`R05-IND3-01 pure: existing LOCAL producer 20, the obligation restated twice (${label}) — refused in both orders, the producer is not offered as EXISTING`, () => {
    const p = computeGenerationPreview(input([occ(), NEW_STAGE], [binding(A, '20.0000', '20.0000')], { areaScopeIds: [A], localQuantities: lq(['K', A, quantities[0]], ['K', A, quantities[1]]) }));
    assert.equal(p.canConfirm, false);
    assert.deepEqual(p.existingWorks, []);
    assert.deepEqual(p.items.filter(i => i.occurrenceKey === 'K').map(i => [i.status, i.existingWorkId]), [['BLOCKED', 'W']]);
    assert.equal(blockingError(p)!.code, 'VALIDATION_FAILED');
  });
}
test('R05-IND3-01 pure: single statements keep their R3 behaviour — 20 / 20.0000 EXISTING, 30 PRODUCER_QUANTITY_CHANGED', () => {
  const at = (q: string) => computeGenerationPreview(input([occ(), NEW_STAGE], [binding(A, '20.0000', '20.0000')], { areaScopeIds: [A], localQuantities: lq(['K', A, q]) }));
  for (const q of ['20', '20.0000']) {
    const p = at(q);
    assert.equal(p.canConfirm, true); assert.deepEqual(p.existingWorks.map(w => [w.workId, w.quantity]), [['W', '20.0000']]);
  }
  assert.deepEqual(at('30').blockers.map(b => b.rule), ['PRODUCER_QUANTITY_CHANGED']);
});

// ------------------------------------------------------------------------------------------------------------------------------- R05-IND3-02
test('R05-IND3-02: one MAIN Work 1000 = A 600 + B 400 — EXISTING items and existingWorks show 600 and 400; the Work total is 1000, once', () => {
  const bs = [binding(A, '600.0000', '1000.0000', 'MAIN'), binding(B, '400.0000', '1000.0000', 'MAIN')];
  const p = computeGenerationPreview(input([occ({ measureScope: 'MAIN' }), NEW_STAGE], bs, { areaScopeIds: [A, B] }));
  assert.deepEqual(p.items.filter(i => i.occurrenceKey === 'K').map(i => [i.areaScopeId, i.status, i.quantity]).sort(), [[A, 'EXISTING', '600.0000'], [B, 'EXISTING', '400.0000']]);
  assert.deepEqual(p.existingWorks.map(w => [w.areaScopeId, w.workId, w.quantity, w.workPlannedQuantity]).sort(), [[A, 'W', '600.0000', '1000.0000'], [B, 'W', '400.0000', '1000.0000']]);
  const perWork = new Map<string, number>();
  for (const w of p.existingWorks) perWork.set(w.workId, (perWork.get(w.workId) ?? 0) + Number(w.quantity));
  assert.deepEqual([...perWork], [['W', 1000]], 'the rows of one Work add up to the Work, not to 2000');
  assert.deepEqual(p.proposedWorks.map(w => [w.occurrenceKey, w.quantity]), [['N', '1000.0000']]);
  assert.equal(p.canConfirm, true);
});
test('R05-IND3-02: a subset of the Work\'s AreaScopes shows only that binding — A alone is 600, not 1000', () => {
  const bs = [binding(A, '600.0000', '1000.0000', 'MAIN'), binding(B, '400.0000', '1000.0000', 'MAIN')];
  const p = computeGenerationPreview(input([occ({ measureScope: 'MAIN' }), NEW_STAGE], bs, { areaScopeIds: [A] }));
  assert.deepEqual(p.items.filter(i => i.occurrenceKey === 'K').map(i => [i.areaScopeId, i.quantity]), [[A, '600.0000']]);
  assert.deepEqual(p.existingWorks.map(w => [w.quantity, w.workPlannedQuantity]), [['600.0000', '1000.0000']]);
  assert.deepEqual(p.proposedWorks.map(w => [w.occurrenceKey, w.quantity]), [['N', '600.0000']]);
});
test('R05-IND3-02: one LOCAL Work 30 = A 20 + B 10 — EXISTING 20 and 10; a restatement is still compared with the binding, not the Work', () => {
  const bs = [binding(A, '20.0000', '30.0000'), binding(B, '10.0000', '30.0000')];
  const p = computeGenerationPreview(input([occ(), NEW_STAGE], bs, { areaScopeIds: [A, B], localQuantities: lq(['K', A, '20'], ['K', B, '10']) }));
  assert.deepEqual(p.existingWorks.map(w => [w.areaScopeId, w.quantity, w.workPlannedQuantity]).sort(), [[A, '20.0000', '30.0000'], [B, '10.0000', '30.0000']]);
  const p30 = computeGenerationPreview(input([occ(), NEW_STAGE], bs, { areaScopeIds: [A], localQuantities: lq(['K', A, '30']) }));
  assert.deepEqual(p30.blockers.map(b => b.rule), ['PRODUCER_QUANTITY_CHANGED']);
});
test('R05-IND3-02: the fingerprint covers the per-binding rows and is reproducible (the confirm recomputes the same projection)', () => {
  const bs = [binding(A, '600.0000', '1000.0000', 'MAIN'), binding(B, '400.0000', '1000.0000', 'MAIN')];
  const make = (b: PreviewBinding[]) => computeGenerationPreview(input([occ({ measureScope: 'MAIN' }), NEW_STAGE], b, { areaScopeIds: [B, A] }));
  assert.equal(make(bs).previewFingerprint, make([...bs].reverse()).previewFingerprint);
  assert.notEqual(make(bs).previewFingerprint, make([bs[0], { ...bs[1], basisQuantity: '399.0000' }]).previewFingerprint, 'a binding quantity is part of what is confirmed');
});
