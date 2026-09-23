/**
 * Status vocabulary shared by C01, O01 and W01.
 *
 * This module does not import the design system. The data chain and the
 * presentation chain meet only at the screen (see `design-system/README.md`), so
 * a view-model produces a plain, self-describing shape rather than a
 * design-system prop type. `ScheduleVariant` mirrors `StatusVariant`'s literal
 * values structurally — a screen can pass a `StatusPresentation` anywhere a
 * `RowStatus` is expected without an adapter — but the two are declared
 * independently on purpose, so this layer never has a reason to import from
 * `design-system`.
 *
 * Corrective note (Work review, F4 patch): this module used to also export
 * `aggregateScheduleStatus`, a worst-wins reduction of several works'
 * `scheduleStatus` into one synthetic per-object figure. Two findings removed
 * it. First, it was a frontend-invented business rule — nothing in the backend
 * computes "an object's schedule status" as a single value, so presenting one
 * through `StatusBadge` made an invented figure look like a confirmed field.
 * Second, its own fallback (`return 'GREEN'`) mapped a genuinely unrecognised
 * status to a *positive* one, which is the specific failure mode `Known<T>`
 * unions exist to avoid — see the `default` arms below, which all resolve to
 * `Neutral` instead. Object-level status now comes only from
 * `ObjectSummary.healthStatus`, a field the backend actually computes.
 */

import type { HealthStatus, ScheduleStatus, Work } from '../types/api';

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
 * because the column is plain `text`, not a CHECK constraint — and never to
 * `OnTrack`: an unknown figure is not evidence of anything good.
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
 * `healthStatus` is `ObjectHealthService`'s own confirmed, already-computed
 * per-object figure — the only object-level status this module presents.
 * Kept as its own function, structurally identical to
 * `scheduleStatusPresentation` today, because the two read *different*
 * confirmed backend signals (schedule variance vs. mixed attention) that are
 * allowed to diverge in wording later; collapsing them into one function would
 * make that an accident of the current label choice rather than a decision.
 * Same rule as above: unrecognised or absent data resolves to `Neutral`, never
 * `OnTrack`.
 */
export function healthStatusPresentation(status: HealthStatus): StatusPresentation {
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
