/**
 * Schedule-status vocabulary shared by C01, O01 and W01.
 *
 * This module does not import the design system. The data chain and the
 * presentation chain meet only at the screen (see `design-system/README.md`), so
 * a view-model produces a plain, self-describing shape rather than a
 * design-system prop type. `ScheduleVariant` mirrors `StatusVariant`'s literal
 * values structurally — a screen can pass a `StatusPresentation` anywhere a
 * `RowStatus` is expected without an adapter — but the two are declared
 * independently on purpose, so this layer never has a reason to import from
 * `design-system`.
 */

import type { ScheduleStatus, Work } from '../types/api';

export type ScheduleVariant = 'OnTrack' | 'Delayed' | 'Attention' | 'Blocked' | 'Neutral';

export interface StatusPresentation {
  variant: ScheduleVariant;
  label: string;
}

/**
 * `scheduleStatus` is a degree of schedule variance, not a business verdict —
 * the visual label is chosen here, once, from the confirmed value. `RED` reads
 * as `Delayed` ("Есть отставание"); `YELLOW` is a smaller variance that has not
 * become a real delay yet, so it reads as `Attention` ("Требует внимания") and
 * shares the amber with `Delayed` by design (D-07). An unrecognised value falls
 * back to `Neutral` rather than throwing — `ScheduleStatus` is a `Known<T>` union
 * because the column is plain `text`, not a CHECK constraint.
 */
export function scheduleStatusPresentation(status: ScheduleStatus): StatusPresentation {
  switch (status) {
    case 'GREEN':
      return { variant: 'OnTrack', label: 'По графику' };
    case 'YELLOW':
      return { variant: 'Attention', label: 'Требует внимания' };
    case 'RED':
      return { variant: 'Delayed', label: 'Есть отставание' };
    case 'GRAY':
      return { variant: 'Neutral', label: 'Нет данных' };
    default:
      return { variant: 'Neutral', label: 'Нет данных' };
  }
}

/**
 * Worst-wins aggregation of several works' `scheduleStatus` into one figure for
 * their object, mirroring `ObjectHealthService`'s own precedence (RED > YELLOW >
 * GRAY > GREEN) but restricted to schedule alone — no critical issues, no
 * staleness, no late ИД/СДО folded in. `ObjectSummary.healthStatus` already
 * mixes those in deliberately; a pure schedule figure is what O01's "plan/fact
 * schedule state" needs to stay a single, uncontaminated contour, and it is not
 * a field the API returns directly (only per-work `scheduleStatus` is).
 */
export function aggregateScheduleStatus(statuses: ScheduleStatus[]): ScheduleStatus {
  if (statuses.includes('RED')) return 'RED';
  if (statuses.includes('YELLOW')) return 'YELLOW';
  if (statuses.length === 0 || statuses.includes('GRAY')) return 'GRAY';
  return 'GREEN';
}

/**
 * A work's own status presentation. `Blocked` overrides the schedule colour
 * because it is a different, stronger claim with its own confirmed source —
 * `work.blockers`, the named reasons — never derived from `scheduleStatus`
 * itself (Design Rules; see `StatusBadge`'s own documentation for why this
 * matters more here than anywhere else).
 */
export function workStatusPresentation(work: Pick<Work, 'scheduleStatus' | 'blockers'>): StatusPresentation {
  if (work.blockers.length > 0) return { variant: 'Blocked', label: 'Заблокировано' };
  return scheduleStatusPresentation(work.scheduleStatus);
}
