import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  QUANTITY, NORMATIVE, decimalOf, classifyPhysical, remainingQuantityOf, validateQuantityProjection, validateScheduleProjection, validateLaborCoverage, validateProjectionMeta,
  COMPARABLE_SCHEDULE_STATES, SCHEDULE_STATES, COVERAGE_STATES, isIsoTimestamp, isTimeZoneName,
  type QuantityProjection, type ScheduleProjection, type LaborCoverageProjection
} from '../packages/domain/gpr2';

/**
 * GPR-2 R01 corrective tests, finding R01-B07 — the read-contract validators refuse structurally contradictory projections and require the
 * metadata of TD §5.1 / §10.3 / §12.2. The three negative fixtures are the independent reviewer's own (review evidence, projection_probe.js):
 * each returned [] on the rejected candidate.
 */
const q = (s: string) => decimalOf(QUANTITY, s);
const n = (s: string) => decimalOf(NORMATIVE, s);
const U = (k: number) => `0000000${k}-0000-4000-8000-000000000000`.slice(-36);
const META = { calculationVersion: 'calc-r01', sourceVersion: 'src-1', sourceVersionIds: { quantity: U(7), calendar: U(2) }, computedAt: '2026-10-19T00:00:00Z' };

const sched = (over: Partial<ScheduleProjection> = {}): ScheduleProjection => ({
  baselineRevisionId: U(1), calendarVersionId: U(2), objectTimezone: 'Europe/Moscow', evaluatedThroughLocalDate: '2026-03-10', scheduleState: 'ON_PLAN', stateReason: null,
  operativeStart: '2026-03-01', operativeEnd: '2026-03-20', baselineQuantity: q('1000'), quantityBehind: q('0'), workingDayLag: n('0'), verdict: 'ON_PLAN', ...META, ...over
});
const labor = (over: Partial<LaborCoverageProjection> = {}): LaborCoverageProjection => ({
  coverageState: 'COMPLETE', plannedWorkerHours: n('100'), earnedWorkerHours: n('40'), objectPhysicalPercent: n('40'), ...META, ...over
});
const quantity = (over: Partial<QuantityProjection> = {}): QuantityProjection => {
  const current = over.currentQuantity ?? q('800'), fact = over.rpFactQuantity === undefined ? q('800') : over.rpFactQuantity;
  return { originalQuantity: q('1000'), originalProvenance: 'PROVEN', currentQuantity: current, currentQuantityVersionId: U(1), baselineQuantity: q('1000'), rpFactQuantity: fact,
    excludedQuantity: q('200'), addedQuantity: q('0'), remainingQuantity: remainingQuantityOf(current, fact), physicalState: classifyPhysical(current, fact), workPhysicalPercent: null, ...META, ...over };
};
const has = (list: string[], fragment: RegExp) => list.some(m => fragment.test(m));

// ---------------------------------------------------------------------------------------------------------------------------------
// The reviewer's three negative fixtures
// ---------------------------------------------------------------------------------------------------------------------------------

test('R01-B07 negative case 1: ON_PLAN with an entirely unknown baseline — no revision, calendar, timezone, evaluation date, dates or quantity — is refused (D14, §8.4)', () => {
  const reviewer = { baselineRevisionId: null, calendarVersionId: null, objectTimezone: null, evaluatedThroughLocalDate: null, scheduleState: 'ON_PLAN', stateReason: null, operativeStart: null,
    operativeEnd: null, baselineQuantity: null, quantityBehind: q('0'), workingDayLag: n('0'), verdict: 'ON_PLAN', ...META } as ScheduleProjection;
  const found = validateScheduleProjection(reviewer);
  assert.ok(found.length >= 7, 'every missing piece of the comparison is named: ' + found.length);
  for (const field of ['baselineRevisionId', 'calendarVersionId', 'objectTimezone', 'evaluatedThroughLocalDate', 'operativeStart', 'operativeEnd', 'baselineQuantity'])
    assert.ok(has(found, new RegExp(`ON_PLAN: ${field} is required`)), field);
  // the same projection with the baseline in place is fine, and the rule holds for every state that compares something with a baseline
  assert.deepEqual(validateScheduleProjection(sched()), []);
  const gaps = (state: string) => ({ ON_PLAN: { verdict: 'ON_PLAN' }, BEHIND: { verdict: 'BEHIND', quantityBehind: q('200'), workingDayLag: n('1') }, COMPLETED_ON_TIME: { verdict: 'COMPLETED_ON_TIME' },
    COMPLETED_LATE: { verdict: 'COMPLETED_LATE', workingDayLag: n('2') }, NOT_STARTED_BY_PLAN: { verdict: null } } as Record<string, Partial<ScheduleProjection>>)[state];
  for (const state of COMPARABLE_SCHEDULE_STATES) {
    const base = sched({ scheduleState: state, ...gaps(state) });
    assert.deepEqual(validateScheduleProjection(base), [], state + ' with a baseline is coherent');
    for (const field of ['baselineRevisionId', 'calendarVersionId', 'objectTimezone', 'evaluatedThroughLocalDate', 'operativeStart', 'operativeEnd', 'baselineQuantity'] as const)
      assert.ok(has(validateScheduleProjection({ ...base, [field]: null }), new RegExp(`${state}: ${field} is required`)), `${state} without ${field}`);
  }
  assert.deepEqual([...COMPARABLE_SCHEDULE_STATES].sort(), ['BEHIND', 'COMPLETED_LATE', 'COMPLETED_ON_TIME', 'NOT_STARTED_BY_PLAN', 'ON_PLAN']);
});

test('R01-B07 negative case 2: COMPLETE coverage, planned 100, earned UNKNOWN, percent 100 — refused; an unknown numerator is not 0 and not 100 % (K01, NULL ≠ 0)', () => {
  const reviewer = labor({ coverageState: 'COMPLETE', plannedWorkerHours: n('100'), earnedWorkerHours: null, objectPhysicalPercent: n('100') });
  const found = validateLaborCoverage(reviewer);
  assert.ok(has(found, /needs KNOWN earned worker hours/), found.join(' | '));
  // …but coverage COMPLETE with an unknown numerator is a legitimate state, and its percent is then null
  assert.deepEqual(validateLaborCoverage(labor({ earnedWorkerHours: null, objectPhysicalPercent: null })), [], 'unknown earned ⇒ percent null, not a number');
  // every numeric percent needs its whole basis
  assert.ok(has(validateLaborCoverage(labor({ plannedWorkerHours: null, objectPhysicalPercent: n('40') })), /positive planned worker-hours denominator|must state its planned/));
  assert.ok(has(validateLaborCoverage(labor({ earnedWorkerHours: null, objectPhysicalPercent: n('0') })), /KNOWN earned/), 'null earned is not an excuse for 0 either');
  for (const state of COVERAGE_STATES.filter(s => s !== 'COMPLETE'))
    assert.ok(has(validateLaborCoverage(labor({ coverageState: state, objectPhysicalPercent: n('100') })), /must be null unless coverage is COMPLETE/), state);
});

test('R01-B07 negative case 3: COMPLETE with planned 0 / earned 0 and a null percent — refused; the coherent state is ZERO_WORKER_DENOMINATOR, and no 0 % is fabricated', () => {
  const reviewer = labor({ coverageState: 'COMPLETE', plannedWorkerHours: n('0'), earnedWorkerHours: n('0'), objectPhysicalPercent: null });
  assert.ok(has(validateLaborCoverage(reviewer), /ZERO_WORKER_DENOMINATOR, not COMPLETE/));
  // the coherent form
  const zero = labor({ coverageState: 'ZERO_WORKER_DENOMINATOR', plannedWorkerHours: n('0'), earnedWorkerHours: n('0'), objectPhysicalPercent: null });
  assert.deepEqual(validateLaborCoverage(zero), []);
  assert.deepEqual(validateLaborCoverage({ ...zero, earnedWorkerHours: null }), [], 'earned may be unknown against a known zero plan');
  // …without any number standing in for the missing percent
  for (const fake of ['0', '100', '50']) assert.ok(validateLaborCoverage({ ...zero, objectPhysicalPercent: n(fake) }).length > 0, 'a zero denominator gives no ' + fake + ' %');
  // a zero denominator needs a KNOWN zero: an unknown total is a missing estimate, not a zero denominator
  assert.ok(has(validateLaborCoverage({ ...zero, plannedWorkerHours: null }), /KNOWN zero/));
  assert.ok(has(validateLaborCoverage({ ...zero, plannedWorkerHours: n('5') }), /KNOWN zero/));
  assert.ok(has(validateLaborCoverage({ ...zero, earnedWorkerHours: n('1') }), /nothing can be earned against a zero plan/));
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Positive examples
// ---------------------------------------------------------------------------------------------------------------------------------

test('R01-B07 positives: coherent projections of every schedule state and every coverage state are accepted', () => {
  const accepted: [string, ScheduleProjection][] = [
    ['NO_APPROVED_GPR', sched({ scheduleState: 'NO_APPROVED_GPR', baselineRevisionId: null, calendarVersionId: null, objectTimezone: null, evaluatedThroughLocalDate: null, operativeStart: null, operativeEnd: null, baselineQuantity: null, quantityBehind: null, workingDayLag: null, verdict: null, sourceVersionIds: {} })],
    ['NOT_INCLUDED', sched({ scheduleState: 'NOT_INCLUDED', stateReason: 'не включена в ГПР', operativeStart: null, operativeEnd: null, baselineQuantity: null, quantityBehind: null, workingDayLag: null, verdict: null })],
    ['REBASELINE_REQUIRED', sched({ scheduleState: 'REBASELINE_REQUIRED', quantityBehind: null, workingDayLag: null, verdict: null })],
    ['DATA_INCOMPLETE', sched({ scheduleState: 'DATA_INCOMPLETE', stateReason: 'нет календаря', quantityBehind: null, workingDayLag: null, verdict: null })],
    ['INTEGRITY_CONFLICT', sched({ scheduleState: 'INTEGRITY_CONFLICT', stateReason: 'факт выше задания', quantityBehind: null, workingDayLag: null, verdict: null })],
    ['NOT_STARTED_BY_PLAN (nulls)', sched({ scheduleState: 'NOT_STARTED_BY_PLAN', evaluatedThroughLocalDate: '2026-02-27', quantityBehind: null, workingDayLag: null, verdict: null })],
    ['NOT_STARTED_BY_PLAN (zeros)', sched({ scheduleState: 'NOT_STARTED_BY_PLAN', evaluatedThroughLocalDate: '2026-02-27', verdict: null })],
    ['ON_PLAN', sched()],
    ['BEHIND (§8.3 example: gap 200, lag 1)', sched({ scheduleState: 'BEHIND', verdict: 'BEHIND', quantityBehind: q('200'), workingDayLag: n('1') })],
    ['BEHIND (fractional lag)', sched({ scheduleState: 'BEHIND', verdict: 'BEHIND', quantityBehind: q('0.0001'), workingDayLag: n('0.000000000001') })],
    ['COMPLETED_ON_TIME', sched({ scheduleState: 'COMPLETED_ON_TIME', verdict: 'COMPLETED_ON_TIME' })],
    ['COMPLETED_LATE (§8.3 example: final lag 2)', sched({ scheduleState: 'COMPLETED_LATE', verdict: 'COMPLETED_LATE', workingDayLag: n('2') })],
    ['COMPLETED_COMPLETION_DATE_UNKNOWN', sched({ scheduleState: 'COMPLETED_COMPLETION_DATE_UNKNOWN', quantityBehind: q('0'), workingDayLag: null, verdict: null })]
  ];
  assert.deepEqual(accepted.map(([l]) => l.split(' ')[0]).filter((v, i, a) => a.indexOf(v) === i).sort(), [...SCHEDULE_STATES].sort(), 'every schedule state has a positive example');
  for (const [label, p] of accepted) assert.deepEqual(validateScheduleProjection(p), [], label);
  const coverage: [string, LaborCoverageProjection][] = [
    ['COMPLETE', labor()], ['COMPLETE 100 %', labor({ earnedWorkerHours: n('100'), objectPhysicalPercent: n('100') })], ['COMPLETE 0 %', labor({ earnedWorkerHours: n('0'), objectPhysicalPercent: n('0') })],
    ['COMPLETE, earned unknown', labor({ earnedWorkerHours: null, objectPhysicalPercent: null })],
    ...COVERAGE_STATES.filter(s => s !== 'COMPLETE').map(s => [s, labor({ coverageState: s, objectPhysicalPercent: null, ...(s === 'ZERO_WORKER_DENOMINATOR' ? { plannedWorkerHours: n('0'), earnedWorkerHours: n('0') } : {}), ...(s === 'EMPTY_SCOPE' ? { sourceVersionIds: {} } : {}) })] as [string, LaborCoverageProjection])
  ];
  assert.equal(new Set(coverage.map(([l]) => l.split(' ')[0].replace(',', ''))).size >= COVERAGE_STATES.length, true);
  for (const [label, p] of coverage) assert.deepEqual(validateLaborCoverage(p), [], label);
  assert.deepEqual(validateQuantityProjection(quantity()), []);
  assert.deepEqual(validateQuantityProjection(quantity({ rpFactQuantity: null })), [], 'an unproven fact is UNKNOWN, with its metadata');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// More structural contradictions
// ---------------------------------------------------------------------------------------------------------------------------------

test('R01-B07: verdict, lag and gap agree — ON_PLAN is a known zero, BEHIND a positive gap AND lag, COMPLETED_LATE a positive final lag, COMPLETED_ON_TIME a zero one; unknowns are not zeros', () => {
  const on = (over: Partial<ScheduleProjection>) => validateScheduleProjection(sched(over));
  assert.ok(has(on({ quantityBehind: null }), /ON_PLAN: quantityBehind and workingDayLag must both be 0/), 'ON_PLAN with an unknown gap is not "on plan"');
  assert.ok(has(on({ workingDayLag: null }), /ON_PLAN: quantityBehind and workingDayLag must both be 0/));
  assert.ok(has(on({ quantityBehind: q('1') }), /ON_PLAN/), 'a gap contradicts on plan');
  assert.ok(has(on({ workingDayLag: n('0.5') }), /ON_PLAN/));
  assert.ok(has(on({ scheduleState: 'BEHIND', verdict: 'BEHIND' }), /BEHIND: quantityBehind and workingDayLag must both be positive/), 'BEHIND with zero gap and lag');
  assert.ok(has(on({ scheduleState: 'BEHIND', verdict: 'BEHIND', quantityBehind: q('5'), workingDayLag: n('0') }), /BEHIND/));
  assert.ok(has(on({ scheduleState: 'BEHIND', verdict: 'BEHIND', quantityBehind: null, workingDayLag: n('1') }), /BEHIND/));
  assert.ok(has(on({ scheduleState: 'COMPLETED_ON_TIME', verdict: 'COMPLETED_ON_TIME', workingDayLag: n('1') }), /COMPLETED_ON_TIME: the final lag is 0/));
  assert.ok(has(on({ scheduleState: 'COMPLETED_ON_TIME', verdict: 'COMPLETED_ON_TIME', workingDayLag: null }), /COMPLETED_ON_TIME/), 'on time needs a PROVEN zero lag');
  assert.ok(has(on({ scheduleState: 'COMPLETED_LATE', verdict: 'COMPLETED_LATE', workingDayLag: n('0') }), /COMPLETED_LATE: the final lag is positive/));
  assert.ok(has(on({ scheduleState: 'COMPLETED_LATE', verdict: 'COMPLETED_LATE', workingDayLag: n('1'), quantityBehind: q('3') }), /COMPLETED_LATE/), 'a completed Work has nothing left behind');
  assert.ok(has(on({ scheduleState: 'NOT_STARTED_BY_PLAN', evaluatedThroughLocalDate: '2026-02-27', verdict: null, quantityBehind: q('1') }), /nothing can be behind before the planned start/));
  assert.ok(has(on({ scheduleState: 'ON_PLAN', verdict: null }), /the verdict is the state and must be present/));
  assert.ok(has(on({ baselineQuantity: q('0') }), /baselineQuantity must be positive/), 'Qb > 0');
});

test('R01-B07: identity and format — ids are uuids, the timezone is an IANA name, dates are real calendar days in order, decimals are canonical strings', () => {
  const bad = (over: Partial<ScheduleProjection>) => validateScheduleProjection(sched(over as any));
  assert.ok(has(bad({ baselineRevisionId: 'rev-1' }), /baselineRevisionId must be null or a uuid/));
  assert.ok(has(bad({ calendarVersionId: 5 as any }), /calendarVersionId must be null or a uuid/));
  for (const tz of ['Mars/Olympus', 'Moscow', '', 'UTC+3', 'Europe/', 'Europe/Moscow\n', 5 as any]) assert.ok(has(bad({ objectTimezone: tz }), /objectTimezone must be null or an IANA/), JSON.stringify(tz));
  for (const tz of ['Europe/Moscow', 'Asia/Yekaterinburg', 'UTC', 'America/Argentina/Buenos_Aires']) assert.equal(isTimeZoneName(tz), true, tz);
  for (const d of ['2026-02-30', '2026-13-01', '10.03.2026', '2026-3-1', 20260310 as any]) assert.ok(has(bad({ evaluatedThroughLocalDate: d }), /evaluatedThroughLocalDate must be null or a real calendar date/), JSON.stringify(d));
  assert.ok(has(bad({ operativeStart: '2026-03-21', operativeEnd: '2026-03-20' }), /operativeStart must not be after operativeEnd/));
  assert.deepEqual(bad({ operativeStart: '2026-03-20', operativeEnd: '2026-03-20' }), [], 'a one-day plan is valid');
  for (const d of ['1000', 1000 as any, '1000.00', '1e3', '-1.0000', '1000.00001']) assert.ok(has(bad({ baselineQuantity: d }), /baselineQuantity must be null or a canonical QUANTITY decimal/), JSON.stringify(d));
  assert.ok(has(bad({ workingDayLag: '1' as any }), /workingDayLag must be null or a canonical NORMATIVE decimal/), 'a non-canonical decimal is refused: the server writes the canonical form');
  assert.ok(has(bad({ workingDayLag: '-1.000000000000' as any }), /workingDayLag/), 'a lag is max(…, 0): never negative');
  assert.ok(has(bad({ quantityBehind: '-0.0001' as any }), /quantityBehind/));
  assert.deepEqual(validateScheduleProjection(null as any).length > 0, true);
});

test('R01-B07: every projection carries calculationVersion, sourceVersion, sourceVersionIds and computedAt (TD §5.1, §10.3, §12.2) — each is required and checked', () => {
  const metaOf = (over: object) => validateProjectionMeta({ ...META, ...over } as any);
  assert.deepEqual(validateProjectionMeta(META), []);
  assert.ok(has(validateProjectionMeta(undefined), /metadata .* is missing/));
  assert.ok(has(metaOf({ calculationVersion: '' }), /calculationVersion is required/));
  assert.ok(has(metaOf({ calculationVersion: undefined }), /calculationVersion is required/));
  assert.ok(has(metaOf({ sourceVersion: 'has space' }), /sourceVersion is required/));
  assert.ok(has(metaOf({ sourceVersionIds: undefined }), /sourceVersionIds is required/));
  assert.ok(has(metaOf({ sourceVersionIds: {} }), /at least one source version/));
  assert.deepEqual(validateProjectionMeta({ ...META, sourceVersionIds: {} }, { allowNoSources: true }), [], 'a state with nothing to derive from may name none');
  assert.ok(has(metaOf({ sourceVersionIds: { quantity: 'v1' } }), /every entry is a safe name and the uuid/));
  assert.ok(has(metaOf({ sourceVersionIds: { '<x>': U(1) } }), /safe name/));
  assert.ok(has(metaOf({ sourceVersionIds: [U(1)] }), /sourceVersionIds is required/));
  for (const at of ['2026-10-19', '2026-10-19T00:00:00', '2026-10-19 00:00:00Z', '2026-02-30T00:00:00Z', '2026-10-19T24:00:00Z', '2026-10-19T00:60:00Z', 'yesterday', 0 as any, null as any])
    assert.ok(has(metaOf({ computedAt: at }), /computedAt must be an ISO-8601 instant with an explicit offset/), JSON.stringify(at));
  for (const at of ['2026-10-19T00:00:00Z', '2026-10-19T03:00:00+03:00', '2026-10-19T00:00:00.123Z', '2026-10-19T00:00:00.123456789-05:30']) assert.equal(isIsoTimestamp(at), true, at);
  // all three projections require it
  assert.ok(has(validateScheduleProjection({ ...sched(), calculationVersion: undefined } as any), /calculationVersion/));
  assert.ok(has(validateLaborCoverage({ ...labor(), sourceVersionIds: undefined } as any), /sourceVersionIds/));
  assert.ok(has(validateQuantityProjection({ ...quantity(), computedAt: undefined } as any), /computedAt/));
  // a projection with no state-excuse still needs a source: NO_APPROVED_GPR and EMPTY_SCOPE are the only ones that may name none
  assert.ok(has(validateScheduleProjection(sched({ sourceVersionIds: {} })), /at least one source version/));
  assert.ok(has(validateLaborCoverage(labor({ sourceVersionIds: {} })), /at least one source version/));
  assert.ok(has(validateQuantityProjection(quantity({ sourceVersionIds: {} })), /at least one source version/));
});

test('R01-B07: the labor percent is bounded and exact at the edges — within 0…100, 0 earned is 0 %, earned = planned is 100 %, and a percent without a basis is refused', () => {
  assert.ok(has(validateLaborCoverage(labor({ objectPhysicalPercent: n('100.000000000001') })), /cannot exceed 100/));
  assert.ok(has(validateLaborCoverage(labor({ earnedWorkerHours: n('0'), objectPhysicalPercent: n('0.000000000001') })), /zero earned worker hours cannot give a non-zero percent/));
  assert.ok(has(validateLaborCoverage(labor({ earnedWorkerHours: n('100'), objectPhysicalPercent: n('99.999999999999') })), /earned = planned is exactly 100 %/));
  assert.ok(has(validateLaborCoverage(labor({ earnedWorkerHours: n('101'), objectPhysicalPercent: n('100') })), /earned worker hours cannot exceed planned/));
  assert.ok(has(validateLaborCoverage(labor({ objectPhysicalPercent: null })), /must carry the percent/), 'COMPLETE with a basis shows its number (§7.6)');
  assert.ok(has(validateLaborCoverage(labor({ plannedWorkerHours: '100' as any })), /plannedWorkerHours must be null or a canonical NORMATIVE decimal/));
  assert.ok(has(validateLaborCoverage(labor({ earnedWorkerHours: 40 as any })), /earnedWorkerHours must be null or a canonical/), 'a JSON number is not a decimal');
  assert.ok(has(validateLaborCoverage(labor({ objectPhysicalPercent: '-1.000000000000' as any })), /objectPhysicalPercent/));
  assert.deepEqual(validateLaborCoverage({ coverageState: 'NOPE' } as any), ['unknown coverageState']);
  assert.deepEqual(validateLaborCoverage(null as any), ['unknown coverageState']);
  // the old shape (one source token only) no longer passes
  const legacy: any = labor(); delete legacy.sourceVersionIds;
  assert.ok(validateLaborCoverage(legacy).length > 0);
});

test('R01-B07: the quantity projection keeps NULL ≠ 0 and gains its identity — the version id is a uuid, decimals are canonical, the percent is bounded', () => {
  assert.ok(has(validateQuantityProjection(quantity({ currentQuantityVersionId: 'v2' })), /currentQuantityVersionId must be the uuid/));
  assert.ok(has(validateQuantityProjection(quantity({ currentQuantity: '800' as any })), /currentQuantity/));
  assert.ok(has(validateQuantityProjection(quantity({ rpFactQuantity: '800' as any })), /rpFactQuantity must be null or a canonical QUANTITY/));
  assert.ok(has(validateQuantityProjection(quantity({ workPhysicalPercent: n('100.000000000001') })), /workPhysicalPercent must be null or a percent between 0 and 100/));
  assert.deepEqual(validateQuantityProjection(quantity({ workPhysicalPercent: n('100') })), [], 'OK with a percent in range');
  assert.ok(has(validateQuantityProjection(quantity({ rpFactQuantity: null, workPhysicalPercent: n('0') })), /workPhysicalPercent must be null unless physicalState is OK/), 'an unproven fact gives no 0 %');
  assert.ok(has(validateQuantityProjection(quantity({ originalQuantity: q('800'), originalProvenance: 'UNKNOWN_LEGACY' })), /UNKNOWN_LEGACY original must be null/));
  // garbage never throws out of a validator
  for (const junk of [null, undefined, {}, [], 'x', 5]) assert.doesNotThrow(() => { validateQuantityProjection(junk as any); validateScheduleProjection(junk as any); validateLaborCoverage(junk as any); }, JSON.stringify(junk));
});
