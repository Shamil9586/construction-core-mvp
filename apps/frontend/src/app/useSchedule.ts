import { useCallback, useEffect, useState } from 'react';
import { ScheduleForbiddenError, getObjectSchedule, getWorkSchedule } from '../data/scheduleApi';
import type { ObjectSchedule, ScheduleLoad, WorkSchedule } from '../types/schedule';

/**
 * GPR-1 — loads one object's (or one work's) schedule on demand. Called unconditionally, before any early return, per the Rules of Hooks;
 * `enabled` is false for the demo runtime (no real session, so no backend to ask) and the result is then `Hidden`.
 *
 * `reload` re-runs the same fetch after a mutation. The previous value stays on screen while it runs — a refresh must not blank the table the
 * user is working in — and a failed refresh keeps the last good value rather than replacing it with an error.
 */
function useScheduleLoad<T>(key: string | undefined, enabled: boolean, fetcher: (id: string) => Promise<T>): { load: ScheduleLoad<T>; reload: () => void } {
  const [load, setLoad] = useState<ScheduleLoad<T>>({ status: 'Loading' });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    if (!enabled || !key) {
      setLoad({ status: 'Hidden' });
      return;
    }
    let cancelled = false;
    setLoad((previous) => (previous.status === 'Loaded' ? previous : { status: 'Loading' }));
    fetcher(key).then(
      (value) => {
        if (!cancelled) setLoad({ status: 'Loaded', value });
      },
      (error: unknown) => {
        if (cancelled) return;
        if (error instanceof ScheduleForbiddenError) setLoad({ status: 'Hidden' });
        else setLoad((previous) => (previous.status === 'Loaded' ? previous : { status: 'Error', message: error instanceof Error ? error.message : String(error) }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, enabled, tick, fetcher]);

  return { load, reload };
}

export function useObjectSchedule(objectId: string | undefined, enabled: boolean): { load: ScheduleLoad<ObjectSchedule>; reload: () => void } {
  return useScheduleLoad(objectId, enabled, getObjectSchedule);
}

export function useWorkSchedule(workId: string | undefined, enabled: boolean): { load: ScheduleLoad<WorkSchedule>; reload: () => void } {
  return useScheduleLoad(workId, enabled, getWorkSchedule);
}
