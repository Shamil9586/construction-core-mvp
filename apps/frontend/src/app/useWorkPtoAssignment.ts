import { useCallback, useEffect, useState } from 'react';
import { getPtoWorkAssignment, type PtoWorkAssignmentView } from '../data/documentationApi';

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isIdName = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return isNonEmptyString(v.id) && typeof v.name === 'string';
};

/**
 * A response that is not the documented read model (e.g. an array or `{}` from a proxy/mock, a partial
 * object, or a view of another Work) is treated as "not loaded", never rendered and never authoritative.
 * PILOT-W01 UI04-F01 — validates the whole `PtoWorkAssignmentView` and binds it to the requested Work
 * (and Object, when known). The backend's `assignment` carries no `objectWorkId` of its own, so a nested
 * one is only checked if present.
 */
export function isPtoWorkAssignmentView(value: unknown, expectedWorkId: string, expectedObjectId?: string): value is PtoWorkAssignmentView {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (!isNonEmptyString(v.objectWorkId) || v.objectWorkId !== expectedWorkId) return false;
  if (!isNonEmptyString(v.objectId) || (expectedObjectId !== undefined && v.objectId !== expectedObjectId)) return false;
  if (!Array.isArray(v.eligible) || !v.eligible.every(isIdName)) return false;
  if (typeof v.canAssign !== 'boolean' || typeof v.canReassign !== 'boolean' || typeof v.canCreatePackage !== 'boolean') return false;
  if (typeof v.packageCount !== 'number' || !Number.isInteger(v.packageCount) || v.packageCount < 0) return false;
  if (!('head' in v) || (v.head !== null && !isIdName(v.head))) return false;
  if (!('assignment' in v)) return false;
  if (v.assignment !== null) {
    if (typeof v.assignment !== 'object' || Array.isArray(v.assignment)) return false;
    const a = v.assignment as Record<string, unknown>;
    if (!isNonEmptyString(a.id) || !isNonEmptyString(a.assigneeUserId)) return false;
    if (typeof a.assigneeName !== 'string' || typeof a.assignedByName !== 'string' || !isNonEmptyString(a.assignedAt)) return false;
    if (typeof a.version !== 'number' || !Number.isInteger(a.version)) return false;
    if ('objectWorkId' in a && a.objectWorkId !== expectedWorkId) return false;
  }
  return true;
}

/**
 * PILOT-W01 UI03 — W01's PTO handoff read model (`GET works/:id/pto-assignment`), fetched only
 * for a real session that can see documentation. A failed or pending fetch leaves `view` null:
 * W01 then renders neither the handoff control nor the create-package action — it never falls
 * back to a client-side guess about who is eligible or assigned.
 */
export function useWorkPtoAssignment(workId: string | undefined, enabled: boolean, objectId?: string): { view: PtoWorkAssignmentView | null; reload: () => void } {
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
        if (!cancelled) setView(isPtoWorkAssignmentView(result, workId, objectId) ? result : null);
      })
      .catch(() => {
        if (!cancelled) setView(null);
      });
    return () => {
      cancelled = true;
    };
  }, [workId, objectId, enabled, tick]);

  return { view, reload };
}
