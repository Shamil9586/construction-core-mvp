import { useCallback, useEffect, useState } from 'react';
import { ScheduleForbiddenError, getObjectSchedule, getWorkSchedule } from '../data/scheduleApi';
import type { ObjectSchedule, ScheduleLoad, WorkSchedule } from '../types/schedule';
import { afterFailure, initialScheduleState, keepForSameKey, loadFor, type ScheduleState } from './scheduleLoadState';

/**
 * GPR-1 — loads one object's (or one work's) schedule on demand. Called unconditionally, before any early return, per the Rules of Hooks;
 * `enabled` is false for the demo runtime (no real session, so no backend to ask) and the result is then `Hidden`.
 *
 * `reload` re-runs the same fetch after a mutation. For the SAME object / work the previous value stays on screen while it runs — a refresh
 * must not blank the table the user is working in — and a failed refresh keeps the last good value rather than replacing it with an error.
 * A value is only ever shown for the key it was fetched for: when the key changes (history stepping from one object straight to another
 * reuses the same route element), the screen is `Loading` until the new key's schedule arrives — never the previous object's plan.
 */
function useScheduleLoad<T>(key: string | undefined, enabled: boolean, fetcher: (id: string) => Promise<T>): { load: ScheduleLoad<T>; reload: () => void } {
  const [state, setState] = useState<ScheduleState<T>>(() => initialScheduleState<T>(key, enabled));
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    if (!enabled || !key) {
      setState({ key, load: { status: 'Hidden' } });
      return;
    }
    let cancelled = false;
    setState((previous) => keepForSameKey(previous, key));
    fetcher(key).then(
      (value) => {
        if (!cancelled) setState({ key, load: { status: 'Loaded', value } });
      },
      (error: unknown) => {
        if (cancelled) return;
        if (error instanceof ScheduleForbiddenError) setState({ key, load: { status: 'Hidden' } });
        else setState((previous) => afterFailure(previous, key, error instanceof Error ? error.message : String(error)));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, enabled, tick, fetcher]);

  // Whatever the state holds, a value fetched for another key is not this screen's: it reads as `Loading` until the effect replaces it.
  return { load: loadFor(state, key), reload };
}

export function useObjectSchedule(objectId: string | undefined, enabled: boolean): { load: ScheduleLoad<ObjectSchedule>; reload: () => void } {
  return useScheduleLoad(objectId, enabled, getObjectSchedule);
}

export function useWorkSchedule(workId: string | undefined, enabled: boolean): { load: ScheduleLoad<WorkSchedule>; reload: () => void } {
  return useScheduleLoad(workId, enabled, getWorkSchedule);
}
