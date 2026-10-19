import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  QUANTITY, NORMATIVE, decimalOf, classifyPhysical, remainingQuantityOf, validateQuantityProjection, validateScheduleProjection, validateLaborCoverage,
  SCHEDULE_STATES, SCHEDULE_VERDICTS, COVERAGE_STATES, PHYSICAL_STATES, ORIGINAL_PROVENANCE, GPR2_ENDPOINTS, endpointById, mountedEndpoints, routeOf, pathParamsOf,
  parseCommand, parseIdempotencyKey, zodViolations, gprChangeSet, gprChangeApply, gprEntryInput, commandResultSchema, Gpr2Error, Gpr2Permission,
  type QuantityProjection, type ScheduleProjection, type LaborCoverageProjection, type DecimalString
} from '../packages/domain/gpr2';

/**
 * GPR-2 R01 — the read contracts, the endpoint register and the API schemas (TD §5.4, §6.1–6.3, §7.5–7.6, §8.1, §8.4, §10.3, §11.1–11.2;
 * D01/D04/D08/D13–D16/D19, K01/K02, C01/C04/C05/C08/C09/C11). Pure domain.
 */
const q = (s: string) => decimalOf(QUANTITY, s);
// §5.1 / §10.3 / §12.2: every projection carries its calculation version, its source version(s) and the instant it was computed (R01-B07)
const META = { calculationVersion: 'calc-r01', sourceVersion: 'src-1', sourceVersionIds: { quantity: '00000007-0000-4000-8000-000000000000' }, computedAt: '2026-10-19T00:00:00Z' };
const U = (n: number) => `0000000${n}-0000-4000-8000-000000000000`.slice(-36);
const KEY = '11111111-1111-4111-8111-111111111111';
const must = (fn: () => unknown): Gpr2Error => { try { fn(); } catch (e: any) { assert.ok(e instanceof Gpr2Error, String(e)); return e; } assert.fail('expected a contract error'); };

// ---------------------------------------------------------------------------------------------------------------------------------
// Quantities: four different numbers, and NULL ≠ 0
// ---------------------------------------------------------------------------------------------------------------------------------

const projection = (over: Partial<QuantityProjection> = {}): QuantityProjection => {
  const current = over.currentQuantity ?? q('800'), fact = over.rpFactQuantity === undefined ? q('800') : over.rpFactQuantity;
  return { originalQuantity: q('1000'), originalProvenance: 'PROVEN', currentQuantity: current, currentQuantityVersionId: U(1), baselineQuantity: q('1000'), rpFactQuantity: fact,
    excludedQuantity: q('200'), addedQuantity: q('0'), remainingQuantity: remainingQuantityOf(current, fact), physicalState: classifyPhysical(current, fact), workPhysicalPercent: null, ...META, ...over };
};

test('D04/D19, §6.3 case 1: original 1000 / current 800 / fact 800 / excluded 200 — four different numbers, physically complete, nothing invented', () => {
  const p = projection();
  assert.deepEqual([p.originalQuantity, p.currentQuantity, p.baselineQuantity, p.rpFactQuantity], ['1000.0000', '800.0000', '1000.0000', '800.0000']);
  assert.equal(p.physicalState, 'OK');
  assert.equal(p.remainingQuantity, '0.0000');
  assert.equal(p.excludedQuantity, '200.0000', 'the exclusion explains the change of the task; it is not a fact (no RP 200 is created)');
  assert.deepEqual(validateQuantityProjection(p), []);
  assert.notEqual(p.baselineQuantity, p.currentQuantity, 'a baseline snapshot and the current task are different fields with different values');
});

test('§6.1: a fact above the current task is INTEGRITY_CONFLICT — shown, not clamped to 100 % — and current = 0 is not "100 % done"', () => {
  assert.equal(classifyPhysical(q('800'), q('850')), 'INTEGRITY_CONFLICT');
  assert.equal(remainingQuantityOf(q('800'), q('850')), null, 'no clamp to 0 that would hide the violation');
  assert.equal(classifyPhysical(q('0'), q('0')), 'NOT_APPLICABLE');
  assert.equal(remainingQuantityOf(q('0'), q('0')), '0.0000');
  assert.equal(classifyPhysical(q('0'), q('5')), 'INTEGRITY_CONFLICT', 'current = 0 with a protected fact is invalid');
  assert.equal(classifyPhysical(q('1000'), q('0')), 'OK', 'nothing done yet is a real, valid 0');
  assert.equal(classifyPhysical(q('1000'), q('1000')), 'OK');
  assert.equal(remainingQuantityOf(q('1000'), q('400')), '600.0000');
  const conflict = projection({ currentQuantity: q('800'), rpFactQuantity: q('850') });
  assert.equal(conflict.physicalState, 'INTEGRITY_CONFLICT');
  assert.deepEqual(validateQuantityProjection(conflict), []);
  assert.ok(validateQuantityProjection({ ...conflict, workPhysicalPercent: q('100') }).length > 0, 'a percent next to a conflict is a lie');
  assert.ok(validateQuantityProjection({ ...conflict, physicalState: 'OK' }).length > 0, 'the state must follow from the numbers');
});

test('NULL vs 0 in the quantities: an unproven fact is UNKNOWN (null), not 0 — and remaining is then null, not the whole task', () => {
  assert.equal(classifyPhysical(q('1000'), null), 'UNKNOWN');
  assert.equal(remainingQuantityOf(q('1000'), null), null);
  const unknownFact = projection({ currentQuantity: q('1000'), rpFactQuantity: null });
  assert.equal(unknownFact.physicalState, 'UNKNOWN');
  assert.deepEqual(validateQuantityProjection(unknownFact), []);
  assert.ok(validateQuantityProjection({ ...unknownFact, remainingQuantity: q('1000') }).length > 0, 'remaining must not pretend the fact is 0');
  // a zero fact is a different, valid statement
  const zeroFact = projection({ currentQuantity: q('1000'), rpFactQuantity: q('0') });
  assert.equal(zeroFact.physicalState, 'OK');
  assert.equal(zeroFact.remainingQuantity, '1000.0000');
});

test('D04/C05: an unproven original is UNKNOWN_LEGACY with a null value — never the current figure, never 0; a proven original may genuinely be 0', () => {
  assert.deepEqual([...ORIGINAL_PROVENANCE], ['PROVEN', 'UNKNOWN_LEGACY']);
  assert.deepEqual(validateQuantityProjection(projection({ originalProvenance: 'UNKNOWN_LEGACY', originalQuantity: null })), []);
  assert.ok(validateQuantityProjection(projection({ originalProvenance: 'UNKNOWN_LEGACY', originalQuantity: q('0') })).length > 0, 'unknown is not 0');
  assert.ok(validateQuantityProjection(projection({ originalProvenance: 'UNKNOWN_LEGACY', originalQuantity: q('800') })).length > 0, 'the current value is not the original');
  assert.ok(validateQuantityProjection(projection({ originalProvenance: 'PROVEN', originalQuantity: null })).length > 0, 'a proven original carries its value');
  assert.deepEqual(validateQuantityProjection(projection({ originalProvenance: 'PROVEN', originalQuantity: q('0'), currentQuantity: q('0'), rpFactQuantity: q('0'), baselineQuantity: null })), [], 'a proven 0 is valid');
  assert.deepEqual([...PHYSICAL_STATES], ['OK', 'NOT_APPLICABLE', 'INTEGRITY_CONFLICT', 'UNKNOWN']);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Schedule state (D13–D15, K02)
// ---------------------------------------------------------------------------------------------------------------------------------

const sched = (over: Partial<ScheduleProjection>): ScheduleProjection => ({
  baselineRevisionId: U(1), calendarVersionId: U(2), objectTimezone: 'Europe/Moscow', evaluatedThroughLocalDate: '2026-03-10', scheduleState: 'ON_PLAN', stateReason: null,
  operativeStart: '2026-03-01', operativeEnd: '2026-03-20', baselineQuantity: q('1000'), quantityBehind: q('0'), workingDayLag: decimalOf(NORMATIVE, '0'), verdict: 'ON_PLAN', ...META, ...over
});
const NOTHING: Partial<ScheduleProjection> = { operativeStart: null, operativeEnd: null, baselineQuantity: null, quantityBehind: null, workingDayLag: null, verdict: null };

test('§8.4 priority order and the categorical verdicts are fixed lists', () => {
  assert.deepEqual([...SCHEDULE_STATES], ['NO_APPROVED_GPR', 'NOT_INCLUDED', 'REBASELINE_REQUIRED', 'DATA_INCOMPLETE', 'INTEGRITY_CONFLICT', 'NOT_STARTED_BY_PLAN', 'ON_PLAN', 'BEHIND',
    'COMPLETED_ON_TIME', 'COMPLETED_LATE', 'COMPLETED_COMPLETION_DATE_UNKNOWN']);
  assert.deepEqual([...SCHEDULE_VERDICTS], ['ON_PLAN', 'BEHIND', 'COMPLETED_ON_TIME', 'COMPLETED_LATE']);
});

test('D14: no approved GPR — no dates, no baseline, no verdict, no lag; nothing is invented', () => {
  assert.deepEqual(validateScheduleProjection(sched({ scheduleState: 'NO_APPROVED_GPR', baselineRevisionId: null, calendarVersionId: null, ...NOTHING })), []);
  for (const [field, value] of [['operativeStart', '2026-03-01'], ['operativeEnd', '2026-03-02'], ['baselineQuantity', q('1')], ['quantityBehind', q('0')], ['workingDayLag', q('0')], ['verdict', 'ON_PLAN'], ['baselineRevisionId', U(9)]] as const)
    assert.ok(validateScheduleProjection(sched({ scheduleState: 'NO_APPROVED_GPR', baselineRevisionId: null, ...NOTHING, [field]: value } as any)).length > 0, 'NO_APPROVED_GPR must refuse ' + field);
  assert.ok(validateScheduleProjection(sched({ scheduleState: 'NO_APPROVED_GPR', baselineRevisionId: null, ...NOTHING, workingDayLag: decimalOf(NORMATIVE, '0') })).length > 0, 'a lag of 0 is still a lag: null ≠ 0');
});

test('D15: a Work outside the approved GPR is NOT_INCLUDED — an approved revision exists, but no dates, verdict or lag are attached to this Work', () => {
  assert.deepEqual(validateScheduleProjection(sched({ scheduleState: 'NOT_INCLUDED', stateReason: 'не включена в ГПР', ...NOTHING })), []);
  assert.ok(validateScheduleProjection(sched({ scheduleState: 'NOT_INCLUDED', baselineRevisionId: null, ...NOTHING })).length > 0, 'without an approved revision the state is NO_APPROVED_GPR');
  assert.ok(validateScheduleProjection(sched({ scheduleState: 'NOT_INCLUDED', ...NOTHING, verdict: 'ON_PLAN' })).length > 0);
  assert.ok(validateScheduleProjection(sched({ scheduleState: 'NOT_INCLUDED', ...NOTHING, operativeStart: '2026-03-01' })).length > 0, 'no fabricated plan dates (D15)');
});

test('K02: REBASELINE_REQUIRED keeps the previous baseline visible and withholds the verdict and the current lag', () => {
  assert.deepEqual(validateScheduleProjection(sched({ scheduleState: 'REBASELINE_REQUIRED', verdict: null, quantityBehind: null, workingDayLag: null })), []);
  assert.ok(validateScheduleProjection(sched({ scheduleState: 'REBASELINE_REQUIRED', verdict: null, quantityBehind: null, workingDayLag: null, baselineQuantity: null })).length > 0, 'the old baseline quantity stays visible');
  assert.ok(validateScheduleProjection(sched({ scheduleState: 'REBASELINE_REQUIRED', verdict: null, quantityBehind: null, workingDayLag: null, operativeStart: null })).length > 0, 'and its dates');
  assert.ok(validateScheduleProjection(sched({ scheduleState: 'REBASELINE_REQUIRED', verdict: 'ON_PLAN', quantityBehind: null, workingDayLag: null })).length > 0, 'no categorical verdict against a stale basis');
  assert.ok(validateScheduleProjection(sched({ scheduleState: 'REBASELINE_REQUIRED', verdict: null, workingDayLag: decimalOf(NORMATIVE, '2') })).length > 0, 'no current lag against a stale basis');
});

test('§8.4/§8.3: DATA_INCOMPLETE and INTEGRITY_CONFLICT give a reason and never an "on time"; an unproven completion date is never invented', () => {
  for (const state of ['DATA_INCOMPLETE', 'INTEGRITY_CONFLICT'] as const) {
    assert.deepEqual(validateScheduleProjection(sched({ scheduleState: state, stateReason: 'нет календаря', verdict: null, quantityBehind: null, workingDayLag: null })), [], state);
    assert.ok(validateScheduleProjection(sched({ scheduleState: state, stateReason: null, verdict: null, quantityBehind: null, workingDayLag: null })).length > 0, state + ' needs a concrete reason');
    assert.ok(validateScheduleProjection(sched({ scheduleState: state, stateReason: 'x', verdict: 'ON_PLAN', quantityBehind: null, workingDayLag: null })).length > 0, state + ' never carries a verdict');
  }
  assert.deepEqual(validateScheduleProjection(sched({ scheduleState: 'COMPLETED_COMPLETION_DATE_UNKNOWN', verdict: null, quantityBehind: q('0'), workingDayLag: null })), [], 'the lag is fixed at a moment nobody can prove');
  assert.ok(validateScheduleProjection(sched({ scheduleState: 'COMPLETED_COMPLETION_DATE_UNKNOWN', verdict: null, workingDayLag: decimalOf(NORMATIVE, '0') })).length > 0, 'and a lag of 0 would be an invented "on time"');
  assert.ok(validateScheduleProjection(sched({ scheduleState: 'COMPLETED_COMPLETION_DATE_UNKNOWN', verdict: 'COMPLETED_ON_TIME' as any })).length > 0, 'no "on time" when the completion date is unknown');
  assert.deepEqual(validateScheduleProjection(sched({ scheduleState: 'BEHIND', verdict: 'BEHIND', quantityBehind: q('200'), workingDayLag: decimalOf(NORMATIVE, '1') })), []);
  assert.deepEqual(validateScheduleProjection(sched({ scheduleState: 'COMPLETED_LATE', verdict: 'COMPLETED_LATE', quantityBehind: q('0'), workingDayLag: decimalOf(NORMATIVE, '2') })), []);
  assert.ok(validateScheduleProjection(sched({ scheduleState: 'BEHIND', verdict: null })).length > 0, 'a verdict state states its verdict');
  assert.ok(validateScheduleProjection(sched({ scheduleState: 'ON_PLAN', verdict: 'BEHIND' })).length > 0, 'the verdict is the state, not a second opinion');
  assert.ok(validateScheduleProjection(sched({ scheduleState: 'NOPE' as any })).length > 0);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Labor coverage (K01)
// ---------------------------------------------------------------------------------------------------------------------------------

const labor = (over: Partial<LaborCoverageProjection>): LaborCoverageProjection => ({
  coverageState: 'COMPLETE', plannedWorkerHours: decimalOf(NORMATIVE, '1600'), earnedWorkerHours: decimalOf(NORMATIVE, '1600'), objectPhysicalPercent: decimalOf(NORMATIVE, '100'),
  ...META, ...over
});

test('K01/§7.6: the general physical percent exists only for COMPLETE coverage with a positive worker denominator; everywhere else it is null, never 0 or 100', () => {
  assert.deepEqual(validateLaborCoverage(labor({})), [], 'A28: current 800 × rate 2 = 1600 planned, 1600 earned');
  for (const state of COVERAGE_STATES.filter(s => s !== 'COMPLETE')) {
    // a zero denominator is its own state and needs a KNOWN zero plan; the other states are fine with the default hours
    const basis: Partial<LaborCoverageProjection> = state === 'ZERO_WORKER_DENOMINATOR' ? { plannedWorkerHours: decimalOf(NORMATIVE, '0'), earnedWorkerHours: decimalOf(NORMATIVE, '0') } : {};
    assert.deepEqual(validateLaborCoverage(labor({ coverageState: state, objectPhysicalPercent: null, ...basis })), [], state + ' → null is correct');
    assert.ok(validateLaborCoverage(labor({ coverageState: state, ...basis })).length > 0, state + ' must not carry a percent');
    assert.ok(validateLaborCoverage(labor({ coverageState: state, objectPhysicalPercent: decimalOf(NORMATIVE, '0'), ...basis })).length > 0, state + ' must not carry 0 as a stand-in for "unknown"');
  }
  assert.ok(validateLaborCoverage(labor({ plannedWorkerHours: decimalOf(NORMATIVE, '0'), earnedWorkerHours: decimalOf(NORMATIVE, '0') })).length > 0, 'a zero denominator is not "100 %"');
  assert.ok(validateLaborCoverage(labor({ plannedWorkerHours: null })).length > 0, 'COMPLETE states its planned hours');
  assert.ok(validateLaborCoverage(labor({ earnedWorkerHours: decimalOf(NORMATIVE, '1601') })).length > 0, 'earned cannot exceed planned (0 ≤ f ≤ q)');
  assert.deepEqual([...COVERAGE_STATES], ['COMPLETE', 'MISSING_ESTIMATE', 'UNMAPPED', 'STALE_RECIPE', 'AMBIGUOUS', 'AMBIGUOUS_EARNED_ALLOCATION', 'CONFLICT', 'EMPTY_SCOPE', 'ZERO_WORKER_DENOMINATOR']);
  assert.deepEqual(validateLaborCoverage(labor({ coverageState: 'AMBIGUOUS_EARNED_ALLOCATION', objectPhysicalPercent: null })), [], 'A27: 50×1 h + 50×3 h with 50 done — no fabricated 50 %');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The endpoint register (§11.2)
// ---------------------------------------------------------------------------------------------------------------------------------

const REGISTER_IDS = [
  'works.list', 'works.get', 'works.create', 'works.assignments.patch',
  'work-type.create', 'work-type.publication.request', 'work-type.publication.approve', 'work-type.publication.reject',
  'finish-systems.list', 'finish-system.upsert', 'finish-system.preview', 'finish-system.confirm', 'finish-template.publish',
  'quantity.request.create', 'quantity.request.patch', 'quantity.request.submit', 'quantity.request.review-note', 'quantity.request.approve', 'quantity.request.return', 'quantities.history',
  'calendars.list', 'calendar.version.create', 'calendar.version.patch',
  'schedule.current', 'schedule.revision.get', 'schedule.evaluation', 'schedule.revision.create', 'schedule.changes.preview', 'schedule.changes.apply', 'schedule.backplan.preview',
  'schedule.revision.submit', 'schedule.revision.discard', 'schedule.revision.approve', 'schedule.revision.return',
  'works.release',
  'finish-change.record-external-outcome', 'finish-change.record-correction', 'finish-changes.get', 'finish-changes.result-uses',
  'imports.boq.upload', 'imports.estimate-labor.upload', 'imports.preview', 'imports.issues', 'imports.boq.allocations', 'imports.boq.commit',
  'imports.estimate-labor.mapping-proposals', 'imports.estimate-labor.mapping-reviews', 'imports.estimate-labor.commit', 'physical-readiness', 'labor-coverage'
];

test('§11.2: the register is the design\'s complete business API surface (snapshot of ids), every id and every (method, path) unique', () => {
  assert.deepEqual(GPR2_ENDPOINTS.map(e => e.id), REGISTER_IDS);
  assert.equal(new Set(GPR2_ENDPOINTS.map(e => e.id)).size, GPR2_ENDPOINTS.length);
  assert.equal(new Set(GPR2_ENDPOINTS.map(e => e.method + ' ' + e.path)).size, GPR2_ENDPOINTS.length);
  assert.equal(GPR2_ENDPOINTS.filter(e => e.kind === 'COMMAND').length, 35);
  assert.equal(GPR2_ENDPOINTS.filter(e => e.kind === 'QUERY').length, 15);
  assert.ok(Object.isFrozen(GPR2_ENDPOINTS));
  assert.equal(routeOf(endpointById('schedule.revision.approve')!), 'objects/:objectId/schedule/revisions/:id/approve');
  assert.deepEqual(pathParamsOf(endpointById('schedule.revision.approve')!), ['objectId', 'id']);
});

test('§11.2 closing note: there is no generic PATCH of a Work\'s current quantity, baseline, fact or suitability, and no route to approve suitability', () => {
  const patches = GPR2_ENDPOINTS.filter(e => e.method === 'PATCH').map(e => e.path);
  assert.ok(!patches.includes('/objects/{objectId}/works/{id}'), 'no generic Work PATCH');
  assert.deepEqual(patches.filter(p => /\/works\//.test(p)), ['/objects/{objectId}/works/{id}/assignments'], 'the only Work PATCH changes assignments (not quantity, dates, fact or suitability)');
  for (const e of GPR2_ENDPOINTS) {
    assert.doesNotMatch(e.path, /suitab/i, e.id);
    assert.doesNotMatch(e.path, /\/works\/\{id\}\/(quantity|current-quantity|fact|baseline|dates)/, e.id + ': a Work\'s quantity, fact, baseline and dates have no direct route');
  }
});

test('every command states how it is guarded: idempotent unless it is a pure preview; aggregate token exactly when it acts on an existing aggregate', () => {
  for (const e of GPR2_ENDPOINTS) {
    if (e.kind === 'QUERY') { assert.deepEqual([e.idempotent, e.aggregateVersion, e.scopeFence, e.pure, e.mounted], [false, false, false, true, false], e.id); continue; }
    assert.equal(e.pure, /preview/.test(e.id), e.id + ': exactly the previews are pure');
    assert.equal(e.idempotent, !e.pure, e.id + ': Idempotency-Key everywhere except a pure preview');
    assert.equal(e.aggregateVersion, pathParamsOf(e).includes('id'), e.id + ': expectedVersion ⇔ the command addresses an existing aggregate');
    if (e.scopeFence) assert.equal(e.scope, 'OBJECT', e.id + ': the scope fence is an object token');
  }
});

test('D16/C11/C16: exactly the scope-sensitive commands carry expectedScopeVersion — schedule submit/approve, quantity create/submit/approve, finish-system confirm, BoQ commit', () => {
  assert.deepEqual(GPR2_ENDPOINTS.filter(e => e.scopeFence).map(e => e.id).sort(), ['finish-system.confirm', 'imports.boq.commit', 'quantity.request.approve', 'quantity.request.create',
    'quantity.request.submit', 'schedule.revision.approve', 'schedule.revision.submit']);
});

test('the guarded surface: every mounted route is a command with a GPR-2 permission or the N01 capability; reads and "existing rules" commands are catalogued, not mounted', () => {
  const mounted = mountedEndpoints();
  assert.equal(mounted.length, 32);
  for (const e of mounted) {
    assert.equal(e.kind, 'COMMAND', e.id);
    assert.notEqual(e.authorization.type, 'EXISTING_RULES', e.id);
    assert.equal(e.scope === 'OBJECT', e.path.startsWith('/objects/{objectId}/'), e.id + ': scope matches the path');
  }
  for (const e of GPR2_ENDPOINTS.filter(x => !x.mounted)) assert.ok(e.kind === 'QUERY' || e.authorization.type === 'EXISTING_RULES' || e.routeFixedByTd === false, e.id + ' is unmounted for a stated reason');
  assert.deepEqual(GPR2_ENDPOINTS.filter(e => !e.routeFixedByTd).map(e => e.id), ['finish-template.publish'], 'the one operation the design names without a route');
});

test('A19 (register): each permission guards exactly the commands of its §11.3 row; the corporate grant guards nothing but publication; N01 has no role path', () => {
  const guarded = (p: Gpr2Permission) => GPR2_ENDPOINTS.filter(e => e.authorization.type !== 'EXISTING_RULES' && 'permission' in e.authorization && e.authorization.permission === p).map(e => e.id).sort();
  assert.deepEqual(guarded(Gpr2Permission.CORPORATE_PUBLICATION), ['finish-template.publish', 'work-type.publication.approve', 'work-type.publication.reject']);
  assert.deepEqual(guarded(Gpr2Permission.SCHEDULE_REVIEW), ['schedule.revision.approve', 'schedule.revision.return']);
  assert.deepEqual(guarded(Gpr2Permission.QUANTITY_REVIEW), ['quantity.request.approve', 'quantity.request.return']);
  assert.deepEqual(guarded(Gpr2Permission.QUANTITY_REVIEW_NOTE), ['quantity.request.review-note']);
  assert.deepEqual(guarded(Gpr2Permission.SCHEDULE_AUTHOR), ['calendar.version.create', 'calendar.version.patch', 'schedule.backplan.preview', 'schedule.changes.apply', 'schedule.changes.preview',
    'schedule.revision.create', 'schedule.revision.discard', 'schedule.revision.submit']);
  assert.deepEqual(guarded(Gpr2Permission.QUANTITY_AUTHOR), ['quantity.request.create', 'quantity.request.patch', 'quantity.request.submit']);
  assert.deepEqual(guarded(Gpr2Permission.EXTERNAL_OUTCOME_RECORD), ['finish-change.record-correction', 'finish-change.record-external-outcome']);
  assert.deepEqual(endpointById('imports.estimate-labor.mapping-reviews')!.authorization, { type: 'CAPABILITY', capability: 'ESTIMATE_MAPPING_REVIEW' }, 'review: capability only');
  assert.deepEqual(endpointById('imports.estimate-labor.mapping-proposals')!.authorization, { type: 'PERMISSION_OR_CAPABILITY', permission: Gpr2Permission.IMPORT_MANAGE, capability: 'ESTIMATE_MAPPING_REVIEW' });
  assert.deepEqual(endpointById('imports.estimate-labor.commit')!.authorization, { type: 'PERMISSION', permission: Gpr2Permission.IMPORT_MANAGE }, 'commit is the РП\'s and cannot bypass the review');
  // every GPR-2 permission is used by at least one command: no orphan grants
  for (const p of Object.values(Gpr2Permission)) assert.ok(guarded(p).length > 0, p + ' guards something');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Envelope and payload schemas (§11.1)
// ---------------------------------------------------------------------------------------------------------------------------------

const ep = (id: string) => endpointById(id)!;
const violations = (fn: () => unknown) => { const e = must(fn); assert.equal(e.code, 'VALIDATION_FAILED'); return e.details!.violations!.map(v => `${v.path}:${v.rule}`).sort(); };

test('§11.1 envelope: header Idempotency-Key (uuid) + body { expectedVersion?, expectedScopeVersion?, payload }; a token the command does not use is REFUSED, one it uses is REQUIRED', () => {
  const ok = parseCommand(ep('schedule.revision.submit'), { 'idempotency-key': KEY.toUpperCase() }, { expectedVersion: '3', expectedScopeVersion: '12', payload: { changeReason: ' готово ' } });
  assert.deepEqual(ok, { idempotencyKey: KEY, expectedVersion: '3', expectedScopeVersion: '12', payload: { changeReason: 'готово' } });
  assert.deepEqual(violations(() => parseCommand(ep('schedule.revision.submit'), {}, {})), ['Idempotency-Key:IDEMPOTENCY_KEY_REQUIRED', 'expectedScopeVersion:VERSION_TOKEN_REQUIRED', 'expectedVersion:VERSION_TOKEN_REQUIRED', 'payload:FIELD_REQUIRED']);
  assert.deepEqual(violations(() => parseCommand(ep('schedule.revision.discard'), { 'idempotency-key': KEY }, { expectedVersion: '3', expectedScopeVersion: '12', payload: {} })), ['expectedScopeVersion:FIELD_NOT_ALLOWED']);
  assert.deepEqual(violations(() => parseCommand(ep('schedule.revision.discard'), { 'idempotency-key': KEY }, { expectedVersion: '3', payload: {}, surprise: 1 })), ['surprise:FIELD_NOT_ALLOWED']);
  assert.deepEqual(violations(() => parseCommand(ep('quantity.request.create'), { 'idempotency-key': KEY }, { expectedVersion: '1', expectedScopeVersion: '1', payload: {} })), ['expectedVersion:FIELD_NOT_ALLOWED'], 'creation has no aggregate to version');
  assert.deepEqual(violations(() => parseCommand(ep('schedule.revision.discard'), { 'idempotency-key': KEY }, { expectedVersion: 3, payload: {} })), ['expectedVersion:VERSION_TOKEN_NOT_A_STRING'], 'a JSON number is refused');
  assert.deepEqual(violations(() => parseCommand(ep('schedule.revision.discard'), { 'idempotency-key': KEY }, { expectedVersion: '03', payload: {} })), ['expectedVersion:VERSION_TOKEN_MALFORMED']);
  assert.deepEqual(violations(() => parseCommand(ep('schedule.revision.discard'), { 'idempotency-key': 'abc' }, { expectedVersion: '3', payload: {} })), ['Idempotency-Key:IDEMPOTENCY_KEY_MALFORMED']);
  assert.deepEqual(violations(() => parseCommand(ep('schedule.revision.discard'), { 'idempotency-key': KEY }, { expectedVersion: '3', payload: 'x' })), ['payload:FIELD_TYPE']);
});

test('a pure preview needs no Idempotency-Key — but one that is sent must still be well-formed', () => {
  assert.deepEqual(parseCommand(ep('schedule.changes.preview'), {}, { expectedVersion: '1', payload: {} }).idempotencyKey, null);
  assert.deepEqual(parseIdempotencyKey(undefined, false), { ok: true, value: null });
  assert.deepEqual(parseIdempotencyKey('', true), { ok: false, rule: 'IDEMPOTENCY_KEY_REQUIRED' });
  assert.deepEqual(violations(() => parseCommand(ep('schedule.changes.preview'), { 'idempotency-key': 'nope' }, { expectedVersion: '1', payload: {} })), ['Idempotency-Key:IDEMPOTENCY_KEY_MALFORMED']);
  assert.deepEqual(parseIdempotencyKey(KEY, true), { ok: true, value: KEY });
});

test('D01/C01: a GPR entry is one Work — an execution-unit field is an ERROR, not an ignored extra — and dates must be ordered civil dates', () => {
  const entry = { workId: U(5).toUpperCase(), startDate: '2026-03-01', endDate: '2026-03-20' };
  const parsed = gprChangeSet.parse({ entries: [entry] });
  assert.equal(parsed.entries![0].workId, U(5), 'ids are canonicalised to lower case');
  assert.deepEqual(violations(() => parseCommand(ep('schedule.changes.preview'), {}, { expectedVersion: '1', payload: { entries: [{ ...entry, executionUnitId: U(6) }] } })), ['payload.entries.0.executionUnitId:FIELD_NOT_ALLOWED']);
  assert.deepEqual(violations(() => parseCommand(ep('schedule.changes.preview'), {}, { expectedVersion: '1', payload: { entries: [{ ...entry, startDate: '2026-03-21' }] } })), ['payload.entries.0.endDate:OUT_OF_RANGE']);
  assert.deepEqual(violations(() => parseCommand(ep('schedule.changes.preview'), {}, { expectedVersion: '1', payload: { entries: [{ ...entry, startDate: '2026-02-30' }] } })), ['payload.entries.0.startDate:DATE_MALFORMED']);
  assert.deepEqual(violations(() => parseCommand(ep('schedule.changes.preview'), {}, { expectedVersion: '1', payload: { entries: [{ startDate: '2026-03-01', endDate: '2026-03-02' }] } })), ['payload.entries.0.workId:FIELD_REQUIRED']);
  assert.equal(gprEntryInput.safeParse({ ...entry, startDate: '2026-03-20' }).success, true, 'a one-day entry (start = end) is valid');
  assert.ok(Object.keys(gprEntryInput.shape).every(k => !/execution|weu|portion/i.test(k)), 'the schema has no execution-unit or portion field at all');
});

test('D08: dependency types are FS / SS / FF; SF is refused EXPLICITLY with its own code; lag is a decimal STRING in a named unit; a Work cannot depend on itself', () => {
  const edge = { predecessorWorkId: U(1), successorWorkId: U(2), type: 'FS', lagKind: 'WORKING_DAYS', lagValue: '0' };
  const run = (e: unknown) => parseCommand(ep('schedule.changes.preview'), {}, { expectedVersion: '1', payload: { edges: [e] } });
  for (const type of ['FS', 'SS', 'FF']) assert.equal(run({ ...edge, type }).payload.edges[0].type, type);
  const sf = must(() => run({ ...edge, type: 'SF' }));
  assert.equal(sf.code, 'UNSUPPORTED_DEPENDENCY_TYPE');
  assert.equal(sf.status, 422);
  assert.deepEqual(violations(() => run({ ...edge, type: 'XX' })), ['payload.edges.0.type:ENUM_VALUE']);
  assert.equal(run({ ...edge, lagKind: 'ELAPSED_HOURS', lagValue: '48' }).payload.edges[0].lagValue, '48.000000000000', '48 h cure is elapsed hours, not working days');
  assert.deepEqual(violations(() => run({ ...edge, lagValue: 48 })), ['payload.edges.0.lagValue:DECIMAL_NOT_A_STRING']);
  assert.deepEqual(violations(() => run({ ...edge, lagKind: 'CALENDAR_DAYS' })), ['payload.edges.0.lagKind:ENUM_VALUE'], 'calendar days are normalised to 48 elapsed hours by the caller, not accepted as a unit');
  assert.deepEqual(violations(() => run({ ...edge, successorWorkId: U(1) })), ['payload.edges.0.successorWorkId:OUT_OF_RANGE']);
});

test('D16/C11: every Work is included or excluded, and an exclusion always has its reason', () => {
  const run = (o: unknown) => parseCommand(ep('schedule.changes.preview'), {}, { expectedVersion: '1', payload: { omissions: [o] } });
  assert.equal(run({ workId: U(1), inclusion: 'INCLUDED' }).payload.omissions[0].inclusion, 'INCLUDED');
  assert.equal(run({ workId: U(1), inclusion: 'EXCLUDED', omissionReason: ' нет актуального задания ' }).payload.omissions[0].omissionReason, 'нет актуального задания', 'the reason is kept, trimmed');
  for (const reason of [undefined, null, '', '   ']) assert.deepEqual(violations(() => run({ workId: U(1), inclusion: 'EXCLUDED', omissionReason: reason })), ['payload.omissions.0.omissionReason:REASON_REQUIRED']);
  assert.deepEqual(violations(() => run({ workId: U(1), inclusion: 'MAYBE' })), ['payload.omissions.0.inclusion:ENUM_VALUE']);
});

test('A10: an apply names the exact preview it confirms; the preview itself does not', () => {
  assert.equal(gprChangeSet.safeParse({}).success, true);
  assert.deepEqual(violations(() => parseCommand(ep('schedule.changes.apply'), { 'idempotency-key': KEY }, { expectedVersion: '1', payload: {} })), ['payload.previewFingerprint:FIELD_REQUIRED']);
  assert.deepEqual(violations(() => parseCommand(ep('schedule.changes.apply'), { 'idempotency-key': KEY }, { expectedVersion: '1', payload: { previewFingerprint: 'abc' } })), ['payload.previewFingerprint:FIELD_TYPE']);
  assert.equal(parseCommand(ep('schedule.changes.apply'), { 'idempotency-key': KEY }, { expectedVersion: '1', payload: { previewFingerprint: 'a'.repeat(64) } }).payload.previewFingerprint, 'a'.repeat(64));
  assert.equal(gprChangeApply.safeParse({ previewFingerprint: 'a'.repeat(64), entries: [] }).success, true);
});

test('approve names its input fingerprint and expected source versions (§11.1); return / reject need a real reason; the reason is trimmed', () => {
  const approve = (payload: unknown) => parseCommand(ep('schedule.revision.approve'), { 'idempotency-key': KEY }, { expectedVersion: '2', expectedScopeVersion: '5', payload });
  const good = approve({ inputFingerprint: 'b'.repeat(64), expectedSourceVersions: { calendar: U(7).toUpperCase(), quantity: U(8) } });
  assert.deepEqual(good.payload.expectedSourceVersions, { calendar: U(7), quantity: U(8) });
  assert.deepEqual(violations(() => approve({ expectedSourceVersions: { calendar: U(7) } })), ['payload.inputFingerprint:FIELD_REQUIRED']);
  assert.deepEqual(violations(() => approve({})), ['payload.expectedSourceVersions:FIELD_REQUIRED', 'payload.inputFingerprint:FIELD_REQUIRED'], 'the fence is mandatory (R01-B03)');
  assert.deepEqual(violations(() => approve({ inputFingerprint: 'b'.repeat(64), expectedSourceVersions: { calendar: 'x' } })), ['payload.expectedSourceVersions.calendar:ID_MALFORMED']);
  for (const id of ['schedule.revision.return', 'quantity.request.return', 'work-type.publication.reject']) {
    const run = (reason: unknown) => parseCommand(ep(id), { 'idempotency-key': KEY }, { expectedVersion: '1', payload: { reason } });
    assert.equal(run('  причина  ').payload.reason, 'причина');
    for (const bad of [undefined, null, '', '  ', 5, 'x'.repeat(2001)]) assert.deepEqual(violations(() => run(bad)), ['payload.reason:REASON_REQUIRED'], id);
  }
});

test('validation errors name the path and the rule — never the offending value, and never a hostile field name', () => {
  const secret = 'TOP-SECRET-<script>-9f2';
  const e = must(() => parseCommand(ep('schedule.changes.apply'), { 'idempotency-key': secret }, { expectedVersion: secret, payload: { previewFingerprint: secret, entries: [{ workId: secret, startDate: secret, endDate: secret, [secret]: 1 }] } }));
  assert.equal(e.code, 'VALIDATION_FAILED');
  const wire = JSON.stringify(e.toBody());
  assert.equal(wire.includes('SECRET'), false, 'no value is echoed');
  assert.equal(wire.includes('script'), false, 'a hostile key is reported as "*"');
  assert.ok(e.details!.violations!.some(v => v.path === 'payload.entries.0.*' && v.rule === 'FIELD_NOT_ALLOWED'));
  // a plain field name IS reported — it tells a client which field to remove
  const plain = must(() => parseCommand(ep('schedule.changes.preview'), {}, { expectedVersion: '1', payload: { entries: [], colour: 'red' } }));
  assert.deepEqual(plain.details!.violations, [{ path: 'payload.colour', rule: 'FIELD_NOT_ALLOWED' }]);
});

test('§11.1 success envelope: command id, result ids, applied versions as strings, structured warnings', () => {
  const ok = { commandId: U(1), resultIds: [U(2)], appliedVersions: { aggregate: '4', scope: null }, warnings: [{ code: 'DATES_OUTSIDE_CALENDAR', path: 'payload.entries.0' }] };
  assert.equal(commandResultSchema.safeParse(ok).success, true);
  assert.equal(commandResultSchema.safeParse({ ...ok, appliedVersions: { aggregate: 4, scope: null } }).success, false, 'versions are strings');
  assert.equal(commandResultSchema.safeParse({ ...ok, appliedVersions: { aggregate: '04', scope: null } }).success, false);
  assert.equal(commandResultSchema.safeParse({ ...ok, extra: 1 }).success, false);
  assert.equal(commandResultSchema.safeParse({ ...ok, warnings: [{ code: 'lower' }] }).success, false);
  assert.ok(typeof zodViolations === 'function');
});
