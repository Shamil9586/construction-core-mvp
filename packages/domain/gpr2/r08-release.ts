/** Offline R08 candidate. A release is evaluated for one target scope, never for a whole Work by accident. */
export type InternalScPolicy = 'REQUIRED' | 'NOT_REQUIRED';
export type ReleaseReason = 'ASSIGNMENT_MISSING' | 'PREDECESSOR_RP_MISSING' |
  'INTERNAL_SC_MISSING' | 'CRITICAL_ISSUE' | 'CURE_PENDING' | 'EVIDENCE_MISSING' | 'POLICY_UNKNOWN';

export type ReleaseRequirement = {
  id: string;
  targetAreaId: string;
  targetExecutionUnitId: string;
  sourceAreaId: string;
  sourceExecutionUnitId: string;
  requiresInternalSc: boolean;
  cureThroughLocalDate: string | null;
};

export type ReleaseEvidence = {
  requirementId: string;
  sourceAreaId: string;
  sourceExecutionUnitId: string;
  rpConfirmed: boolean;
  internalScConfirmed: boolean;
  evidenceKnown: boolean;
};

export type ReleaseIssue = { areaId: string | null; executionUnitId: string | null; critical: boolean; open: boolean };

export function evaluateZonalRelease(input: {
  targetAreaId: string;
  targetExecutionUnitId: string;
  assigned: boolean;
  /** Explicitly established target AreaScope/WEU association, never inferred from free-text location. */
  scopeKnown: boolean;
  policy: InternalScPolicy | null;
  requirements: ReleaseRequirement[] | null;
  evidence: ReleaseEvidence[];
  issues: ReleaseIssue[];
  localDate: string;
}): { allowed: boolean; reasons: ReleaseReason[]; requirementIds: string[] } {
  const reasons = new Set<ReleaseReason>();
  if (!input.assigned) reasons.add('ASSIGNMENT_MISSING');
  if (!input.scopeKnown) reasons.add('EVIDENCE_MISSING');
  if (!input.policy) reasons.add('POLICY_UNKNOWN');
  // Null means legacy or incomplete mapping. Empty is a positively established absence of prerequisites.
  if (input.requirements === null) reasons.add('EVIDENCE_MISSING');
  const scoped = (input.requirements ?? []).filter(r => r.targetAreaId === input.targetAreaId && r.targetExecutionUnitId === input.targetExecutionUnitId);
  for (const r of scoped) {
    const e = input.evidence.find(x => x.requirementId === r.id && x.sourceAreaId === r.sourceAreaId && x.sourceExecutionUnitId === r.sourceExecutionUnitId);
    if (!e?.evidenceKnown) { reasons.add('EVIDENCE_MISSING'); continue; }
    if (!e.rpConfirmed) reasons.add('PREDECESSOR_RP_MISSING');
    if (r.requiresInternalSc && input.policy === 'REQUIRED' && !e.internalScConfirmed) reasons.add('INTERNAL_SC_MISSING');
    if (r.cureThroughLocalDate && input.localDate < r.cureThroughLocalDate) reasons.add('CURE_PENDING');
  }
  for (const issue of input.issues) {
    if (!issue.critical || !issue.open) continue;
    if ((issue.areaId === null && issue.executionUnitId === null) ||
      (issue.areaId === input.targetAreaId && (issue.executionUnitId === null || issue.executionUnitId === input.targetExecutionUnitId)))
      reasons.add('CRITICAL_ISSUE');
  }
  return { allowed: reasons.size === 0, reasons: [...reasons], requirementIds: scoped.map(r => r.id) };
}
