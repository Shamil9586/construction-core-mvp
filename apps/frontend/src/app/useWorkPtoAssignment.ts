import { useCallback, useEffect, useState } from 'react';
import { getPtoWorkAssignment, type PtoWorkAssignmentView } from '../data/documentationApi';

/** A response that is not the documented read model (e.g. an array or `{}` from a proxy/mock) is treated as "not loaded", never rendered. */
function isPtoWorkAssignmentView(value: unknown): value is PtoWorkAssignmentView {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v.eligible) &&
    typeof v.canAssign === 'boolean' &&
    typeof v.canReassign === 'boolean' &&
    typeof v.canCreatePackage === 'boolean' &&
    typeof v.packageCount === 'number' &&
    'assignment' in v &&
    'head' in v
  );
}

/**
 * PILOT-W01 UI03 — W01's PTO handoff read model (`GET works/:id/pto-assignment`), fetched only
 * for a real session that can see documentation. A failed or pending fetch leaves `view` null:
 * W01 then renders neither the handoff control nor the create-package action — it never falls
 * back to a client-side guess about who is eligible or assigned.
 */
export function useWorkPtoAssignment(workId: string | undefined, enabled: boolean): { view: PtoWorkAssignmentView | null; reload: () => void } {
  const [view, setView] = useState<PtoWorkAssignmentView | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    if (!enabled || !workId) {
      setView(null);
      return;
    }
    let cancelled = false;
    getPtoWorkAssignment(workId)
      .then((result) => {
        if (!cancelled) setView(isPtoWorkAssignmentView(result) ? result : null);
      })
      .catch(() => {
        if (!cancelled) setView(null);
      });
    return () => {
      cancelled = true;
    };
  }, [workId, enabled, tick]);

  return { view, reload };
}
