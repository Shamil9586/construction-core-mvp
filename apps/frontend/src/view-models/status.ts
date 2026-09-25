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
 * Corrective note, first pass (Work review, F4 patch 1): this module used to
 * also export `aggregateScheduleStatus`, a worst-wins reduction of several
 * works' `scheduleStatus` into one synthetic per-object figure. It was
 * removed for inventing a business rule the backend does not have, and for a
 * fallback that mapped an unrecognised status to `GREEN` — see the `default`
 * arms below, which all resolve to `Neutral` instead. That patch replaced it
 * with `healthStatusPresentation(object.healthStatus)`.
 *
 * Corrective note, second pass (Work review, F4 patch 2): using
 * `healthStatus` for a *schedule*-labelled badge was itself still wrong, and
 * this module's `healthStatusPresentation` is removed with it.
 * `ObjectHealthService` folds in critical/overdue issues, staleness and late
 * ИД/СДО alongside schedule variance by design — reading `RED` as "Есть
 * отставание" or `GREEN` as "По графику" asserts a schedule claim the value
 * does not confirm; it could be `RED` from a critical issue on an
 * on-schedule object, or `GREEN` while stale-but-not-yet-flagged. No API
 * field gives a confirmed *per-object* schedule status today, so C01's
 * portfolio row and O01's schedule card now use `NO_SCHEDULE_STATUS`
 * unconditionally for that one slot — a stated absence, not a guess. Per-work
 * `scheduleStatus` (`scheduleStatusPresentation`, `workStatusPresentation`)
 * is unaffected: it is a real, confirmed, already-per-work figure and was
 * never the problem.
 */

import type { DocumentationPackageStatus, ScheduleStatus, Work } from '../types/api';

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
 * The object-level "schedule state" badge C01's portfolio row and O01's
 * schedule card both need a value for, when no confirmed per-object schedule
 * field exists to source one from. Deliberately a constant, not a function —
 * there is no branch to take, because there is no input to branch on.
 */
export const NO_SCHEDULE_STATUS: StatusPresentation = { variant: 'Neutral', label: 'Нет данных' };

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

/**
 * F8.2 — a Documentation Package's own status, a distinct contour from
 * `scheduleStatus`/`ScCoverageStatus` (Design Rules: "Contours stay
 * separate... no combined 'Готово' indicator anywhere"). `DRAFT`/`PREPARING`
 * are in-progress and read `Neutral` — not yet a problem, not yet a result.
 * `RETURNED`/`CORRECTING` read `Attention`: the customer sent the package
 * back, or it is being corrected in response — real, current work to do,
 * same amber D-07 already reserves for that meaning elsewhere.
 * `READY_FOR_PRESENTATION`/`PRESENTED`/`ACCEPTED_BY_CUSTOMER` read `OnTrack`:
 * each is a genuine forward step, never a claim about the underlying work's
 * own physical readiness or SC acceptance (BR-02/BR-03) — this switches on
 * `DocumentationPackageStatus` alone.
 */
export function documentationPackageStatusPresentation(status: DocumentationPackageStatus): StatusPresentation {
  switch (status) {
    case 'DRAFT':
      return { variant: 'Neutral', label: 'Черновик' };
    case 'PREPARING':
      return { variant: 'Neutral', label: 'В подготовке' };
    case 'READY_FOR_PRESENTATION':
      return { variant: 'OnTrack', label: 'Готово к предъявлению' };
    case 'PRESENTED':
      return { variant: 'OnTrack', label: 'Предъявлено заказчику' };
    case 'RETURNED':
      return { variant: 'Attention', label: 'Возвращено заказчиком' };
    case 'CORRECTING':
      return { variant: 'Attention', label: 'Устраняются замечания' };
    case 'ACCEPTED_BY_CUSTOMER':
      return { variant: 'OnTrack', label: 'Принято заказчиком' };
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}
