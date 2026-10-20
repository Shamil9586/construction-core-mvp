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
 *
 * GPR-UX-D01: once the Object's production schedule (GPR) is approved, O01 and
 * W01 no longer read `work.scheduleStatus` at all. `workStatusPresentation` is
 * removed; schedule compliance comes from the GPR alone (`schedule.ts`) and the
 * physical execution state is shown separately (`workExecutionPresentation`
 * below). `scheduleStatusPresentation` stays for C01's portfolio.
 */

import Decimal from 'decimal.js';
import type { DocumentationPackageStatus, ScheduleStatus, SdoClosingStatus, Work } from '../types/api';

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
 * GPR-UX-D01 — the work's ACTUAL PHYSICAL execution state, the only thing the work list and the Work header say about "where the work is".
 * It never says anything about the schedule: once an object's production schedule (GPR) is approved, compliance with the deadlines is decided
 * by that schedule alone (`view-models/schedule.ts`), and the legacy `work.scheduleStatus` no longer produces a schedule verdict on O01 / W01
 * (it remains the input of C01's portfolio attention only).
 *
 * Derived from the production fact the snapshot already carries (the RP fact — the same source the schedule measures progress by), with the
 * distinction the fact model keeps: `lastReportedAt === null` means NOTHING was ever reported, which is not a reported zero — an unreported
 * work reads «Не начато» whatever `actualQuantity` happens to hold, and only a REPORTED positive fact is «В работе». «Выполнено» is a reported
 * fact that reaches the planned quantity (the schedule's own rule: fact ≥ plan > 0). Independent of СК, ПТО, ИД, СДО and financial closing.
 */
export type WorkExecutionState = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'UNKNOWN';

export function workExecutionState(work: Pick<Work, 'lastReportedAt' | 'actualQuantity' | 'plannedQuantity'>): WorkExecutionState {
  // The resolver could not state the quantity (`actualQuantity === null`): neither «Не начато» nor a figure — an unknown is not a zero.
  if (work.actualQuantity === null) return 'UNKNOWN';
  if (work.lastReportedAt === null) return 'NOT_STARTED';
  const fact = new Decimal(work.actualQuantity);
  const plan = new Decimal(work.plannedQuantity);
  if (plan.gt(0) && fact.gte(plan)) return 'COMPLETED';
  return fact.gt(0) ? 'IN_PROGRESS' : 'NOT_STARTED';
}

/** Colour never carries the schedule here: «Не начато» and «В работе» are neutral facts; «Выполнено» is the one positive physical fact. */
export function workExecutionPresentation(work: Pick<Work, 'lastReportedAt' | 'actualQuantity' | 'plannedQuantity'>): StatusPresentation {
  switch (workExecutionState(work)) {
    case 'COMPLETED':
      return { variant: 'OnTrack', label: 'Выполнено' };
    case 'IN_PROGRESS':
      return { variant: 'Neutral', label: 'В работе' };
    case 'UNKNOWN':
      return { variant: 'Neutral', label: 'Факт не определён' };
    default:
      return { variant: 'Neutral', label: 'Не начато' };
  }
}

/**
 * An operational blocker is its own claim with its own confirmed source — `work.blockers`, the named reasons — shown beside the execution
 * state, never as the schedule verdict and never derived from `scheduleStatus` (see `StatusBadge`'s own documentation for why).
 */
export function workBlockerPresentation(work: Pick<Work, 'blockers'>): StatusPresentation | null {
  return work.blockers.length > 0 ? { variant: 'Blocked', label: 'Заблокировано' } : null;
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

/**
 * F8.3 — the SDO Case's own status, a distinct contour from
 * `DocumentationPackageStatus`/`scheduleStatus` — this reads only the SDO
 * closing workflow, never the underlying work's physical readiness or the
 * package's own documentation status (BR-02/BR-03's own discipline,
 * extended to F8.3). `ON_RECONCILIATION` is genuinely in-progress work, not
 * yet a problem: `Neutral`. `ON_CORRECTION` reads `Attention` — real,
 * current work to do, the same amber `RETURNED`/`CORRECTING` already use
 * for the equivalent documentation-side meaning. `VERIFICATION_PASSED` and
 * `CLOSED` are both genuine forward steps: `OnTrack`.
 */
export function sdoClosingStatusPresentation(status: SdoClosingStatus): StatusPresentation {
  switch (status) {
    case 'ON_RECONCILIATION':
      return { variant: 'Neutral', label: 'На выверке' };
    case 'VERIFICATION_PASSED':
      return { variant: 'OnTrack', label: 'Выверка пройдена' };
    case 'ON_CORRECTION':
      return { variant: 'Attention', label: 'На корректировке' };
    case 'CLOSED':
      return { variant: 'OnTrack', label: 'Закрытие' };
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}
