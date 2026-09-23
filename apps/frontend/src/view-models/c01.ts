/**
 * C01 — Company Control Center.
 *
 * Executive overview: the portfolio, each object's physical readiness, and an
 * attention queue worded for a director rather than for a site engineer.
 * Design Rules keep АОСР, ИД, СДО and financial-closing detail off this
 * screen — those are `readiness`/`blockers` facts, not this view's business —
 * and the attention text never names a specific work or trade: it says what
 * kind of problem the object has, not which finish work is behind.
 *
 * Corrective note, first pass (Work review, F4 patch 1): the portfolio badge
 * and the attention gate used to run on a frontend-computed worst-wins
 * aggregate of `Work[].scheduleStatus` — removed for inventing a business
 * rule the backend does not have.
 *
 * Corrective note, second pass (Work review, F4 patch 2): the replacement,
 * `healthStatusPresentation(object.healthStatus)`, was itself still wrong for
 * a *schedule*-labelled badge — `healthStatus` mixes in critical/overdue
 * issues, staleness and late ИД/СДО, so presenting it as schedule state
 * over-claims what the value confirms. The portfolio badge now uses
 * `NO_SCHEDULE_STATUS` unconditionally (see `view-models/status.ts`) — there
 * is no API field for a confirmed per-object schedule status today, so
 * nothing is shown in its place. Separately, gating the attention loop on
 * `healthStatus === 'GRAY'` had a real bug: a work can carry `blockers` with
 * `delayDays === 0` (per `ObjectHealthService`'s own `blocked` signal
 * definition) without forcing `healthStatus` to `RED`, so an object could
 * have a confirmed blocker and still read `GRAY` — which used to skip it
 * entirely, silently hiding a real problem behind "insufficient data". Every
 * object's `blockers` and `scheduleStatus` are now checked directly and
 * unconditionally, never gated on `healthStatus`. "Insufficient data" is now
 * its own, independent fact: an object counts as unevaluated only when *none*
 * of its own works carry a real (non-`GRAY`) `scheduleStatus` reading *and*
 * it has no confirmed problem either — never as a side effect of a mixed
 * field being `GRAY`.
 */

import type { ObjectSummary, Work } from '../types/api';
import { formatPercent, joinMeta } from '../formatters';
import { NO_SCHEDULE_STATUS, scheduleStatusPresentation, type StatusPresentation } from './status';

export interface C01PortfolioRow {
  id: string;
  name: string;
  /** "CC-024 · ул. Строителей, 12" */
  meta: string;
  /** "РП · Сергей Волков" */
  responsible: string;
  /** Physical readiness, already formatted — "62%", or "—" when unmeasured. */
  smr: string;
  smrProgress: number | null;
  /**
   * `NO_SCHEDULE_STATUS`, always — no API field gives a confirmed per-object
   * schedule status, and `healthStatus` mixes in quality/ИД/СДО signals a
   * "График" column must not claim. See `view-models/status.ts`.
   */
  status: StatusPresentation;
}

export type C01AttentionReason = 'ScheduleDelay' | 'ScheduleRisk' | 'Blocked';

export interface C01AttentionItem {
  objectId: string;
  objectName: string;
  /** The specific reason's own presentation — never a mixed object status. */
  status: StatusPresentation;
  reason: C01AttentionReason;
  /** Management-worded sentence. Never names a work, a trade or a finish type. */
  message: string;
}

export interface C01ViewModel {
  portfolio: C01PortfolioRow[];
  attention: C01AttentionItem[];
  /**
   * Objects with no confirmed problem *and* no real (non-`GRAY`) schedule
   * reading on any of their works — genuinely nothing to evaluate, not a
   * side effect of a mixed field reading `GRAY`. A problem always takes
   * precedence: an object with a confirmed blocker or a RED/YELLOW work is
   * never counted here even if most of its other works are unmeasured.
   */
  unevaluatedObjectCount: number;
}

/**
 * One sentence per reason, chosen from a closed set. This is the whole of the
 * "management wording" rule made structural: there is no path from a work's
 * name, contractor or finish type into this text, because the function never
 * receives them — only the reason it already classified from confirmed fields.
 */
function attentionMessage(reason: C01AttentionReason): string {
  switch (reason) {
    case 'Blocked':
      return 'Есть технологическая блокировка производства работ';
    case 'ScheduleDelay':
      return 'Есть отставание по графику производства работ';
    case 'ScheduleRisk':
      return 'Есть риск отставания по графику производства работ';
    default:
      return 'Требует внимания';
  }
}

/** The reason's own presentation — a real per-work signal, not the object's mixed status. */
function attentionStatus(reason: C01AttentionReason): StatusPresentation {
  switch (reason) {
    case 'Blocked':
      return { variant: 'Blocked', label: 'Заблокировано' };
    case 'ScheduleDelay':
      return scheduleStatusPresentation('RED');
    case 'ScheduleRisk':
      return scheduleStatusPresentation('YELLOW');
    default:
      return NO_SCHEDULE_STATUS;
  }
}

const ATTENTION_RANK: Record<C01AttentionReason, number> = {
  Blocked: 0,
  ScheduleDelay: 1,
  ScheduleRisk: 2,
};

export function buildC01ViewModel(objects: ObjectSummary[], works: Work[]): C01ViewModel {
  const portfolio: C01PortfolioRow[] = objects.map((object) => ({
    id: object.id,
    name: object.name,
    meta: joinMeta(object.externalCode, object.address),
    responsible: joinMeta('РП', object.responsible),
    smr: formatPercent(object.actualProgress),
    smrProgress: object.actualProgress,
    status: NO_SCHEDULE_STATUS,
  }));

  const attention: C01AttentionItem[] = [];
  let unevaluatedObjectCount = 0;

  for (const object of objects) {
    const objectWorks = works.filter((work) => work.objectId === object.id);
    const blocked = objectWorks.some((work) => work.blockers.length > 0);
    const hasRed = objectWorks.some((work) => work.scheduleStatus === 'RED');
    const hasYellow = objectWorks.some((work) => work.scheduleStatus === 'YELLOW');
    // A real reading exists for this object as soon as one work's schedule
    // status is anything other than GRAY — including GREEN, which is not a
    // "problem" but is still evidence the object was actually evaluated.
    const hasScheduleReading = objectWorks.some(
      (work) => work.scheduleStatus === 'RED' || work.scheduleStatus === 'YELLOW' || work.scheduleStatus === 'GREEN',
    );

    let reason: C01AttentionReason | null = null;
    if (blocked) reason = 'Blocked';
    else if (hasRed) reason = 'ScheduleDelay';
    else if (hasYellow) reason = 'ScheduleRisk';

    if (reason !== null) {
      attention.push({
        objectId: object.id,
        objectName: object.name,
        status: attentionStatus(reason),
        reason,
        message: attentionMessage(reason),
      });
    } else if (!hasScheduleReading) {
      unevaluatedObjectCount += 1;
    }
  }
  attention.sort((a, b) => ATTENTION_RANK[a.reason] - ATTENTION_RANK[b.reason]);

  return { portfolio, attention, unevaluatedObjectCount };
}

/**
 * Shown when the portfolio is non-empty, the attention queue is empty *and*
 * every object had an evaluable schedule reading. A real, positive finding —
 * not the same claim as "no data" — so it must never be the fallback for an
 * empty queue on its own; the screen only reaches for this when
 * `unevaluatedObjectCount` is also zero and there is at least one object.
 */
export const C01_ATTENTION_EMPTY_LABEL = 'Проблем по графику производства работ не выявлено';

/**
 * Shown whenever at least one object could not be evaluated — independently
 * of whether the queue also has confirmed items, so a portfolio that is both
 * "two objects behind schedule" and "one object with no data yet" says both,
 * rather than the second fact disappearing behind the first.
 */
export const C01_INSUFFICIENT_DATA_LABEL = 'Недостаточно данных для оценки графика по части объектов';

/**
 * Shown when the portfolio itself is empty. Distinct from both labels above:
 * an empty portfolio was not evaluated and found clean, and it is not a
 * measurement gap on real objects — there is simply nothing to evaluate.
 */
export const C01_NO_OBJECTS_LABEL = 'Нет объектов для оценки графика';
