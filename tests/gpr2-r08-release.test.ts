import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateZonalRelease, type ReleaseRequirement } from '../packages/domain/gpr2/r08-release';

const requirements: ReleaseRequirement[] = [
  { id: 'r1', targetAreaId: 'a1', targetExecutionUnitId: 'u1', sourceAreaId: 's1', sourceExecutionUnitId: 'p1', requiresInternalSc: true, cureUntil: null },
  { id: 'r2', targetAreaId: 'a2', targetExecutionUnitId: 'u2', sourceAreaId: 's2', sourceExecutionUnitId: 'p2', requiresInternalSc: true, cureUntil: '2026-11-06T12:00:00Z' },
];
const evidence = [
  { requirementId: 'r1', sourceAreaId: 's1', sourceExecutionUnitId: 'p1', rpConfirmed: true, internalScConfirmed: true, evidenceKnown: true },
  { requirementId: 'r2', sourceAreaId: 's2', sourceExecutionUnitId: 'p2', rpConfirmed: false, internalScConfirmed: false, evidenceKnown: true },
];
const base = { targetAreaId: 'a1', targetExecutionUnitId: 'u1', assigned: true, scopeKnown: true, policy: 'REQUIRED' as const, requirements, evidence, issues: [], now: '2026-11-05T12:00:00Z' };

test('R08 A11: blocked adjacent unit does not block a ready target', () => {
  assert.deepEqual(evaluateZonalRelease(base), { allowed: true, reasons: [], requirementIds: ['r1'] });
  assert.deepEqual(evaluateZonalRelease({ ...base, targetAreaId: 'a2', targetExecutionUnitId: 'u2' }).reasons,
    ['PREDECESSOR_RP_MISSING', 'INTERNAL_SC_MISSING', 'CURE_PENDING']);
});
test('R08: whole-object critical issue applies to both; scoped issue only to its target', () => {
  assert.deepEqual(evaluateZonalRelease({ ...base, issues: [{ areaId: null, executionUnitId: null, critical: true, open: true }] }).reasons, ['CRITICAL_ISSUE']);
  assert.equal(evaluateZonalRelease({ ...base, issues: [{ areaId: 'a2', executionUnitId: 'u2', critical: true, open: true }] }).allowed, true);
});
test('R08: unknown policy, legacy mapping and source ambiguity fail closed', () => {
  assert.deepEqual(evaluateZonalRelease({ ...base, policy: null, requirements: null, evidence: [] }).reasons, ['POLICY_UNKNOWN', 'EVIDENCE_MISSING']);
  assert.deepEqual(evaluateZonalRelease({ ...base, evidence: [] }).reasons, ['EVIDENCE_MISSING']);
  assert.deepEqual(evaluateZonalRelease({ ...base, scopeKnown: false, requirements: [] }).reasons, ['EVIDENCE_MISSING']);
});
test('R08: NOT_REQUIRED skips internal SC only; missing RP and cure remain blockers', () => {
  const x = evaluateZonalRelease({ ...base, policy: 'NOT_REQUIRED', evidence: [{ ...evidence[0], internalScConfirmed: false }] });
  assert.equal(x.allowed, true);
  assert.deepEqual(evaluateZonalRelease({ ...base, policy: 'NOT_REQUIRED', evidence: [{ ...evidence[0], rpConfirmed: false }] }).reasons, ['PREDECESSOR_RP_MISSING']);
});
test('R08: cure is elapsed 172800 seconds, not local calendar days or a DST shortcut', () => {
  const r={...requirements[0],cureUntil:'2026-03-31T10:00:00Z'};
  const input={...base,requirements:[r]};
  assert.deepEqual(evaluateZonalRelease({...input,now:'2026-03-31T09:59:59Z'}).reasons,['CURE_PENDING']);
  assert.equal(evaluateZonalRelease({...input,now:'2026-03-31T10:00:00Z'}).allowed,true);
});
