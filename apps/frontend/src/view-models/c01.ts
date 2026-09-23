/**
 * C01 — Company Control Center.
 *
 * Executive overview: the portfolio, each object's confirmed status and
 * physical readiness, and an attention queue worded for a director rather
 * than for a site engineer. Design Rules keep АОСР, ИД, СДО and
 * financial-closing detail off this screen — those are `readiness`/`blockers`
 * facts, not this view's business — and the attention text never names a
 * specific work or trade: it says what kind of problem the object has, not
 * which finish work is behind.
 *
 * Corrective note (Work review, F4 patch): the portfolio badge and the
 * attention gate used to run on a frontend-computed worst-wins aggregate of
 * `Work[].scheduleStatus`. Two findings removed that. First, presenting an
 * invented aggregate as an object's status is a frontend business rule the
 * product never authorised — `healthStatusPresentation(object.healthStatus)`
 * now supplies every object-level badge, sourced from the one status the
 * backend actually confirms. Second, an object with no evaluable schedule
 * data (`healthStatus === 'GRAY'`) used to fall out of the attention loop
 * silently, indistinguishable from an object that was checked and found fine
 * — `unevaluatedObjectCount` now carries that fact explicitly, and the screen
 * renders a different message for it (see `C01_INSUFFICIENT_DATA_LABEL`
 * below). The *reason* text for an object that does qualify still comes from
 * real per-work fields (`scheduleStatus`, `blockers`), checked for existence
 * rather than ranked into a synthetic value — the same "selects and
 * aggregates" derivation the architecture already asks a view-model to do for
 * this screen, just without ever materialising a fake status field.
 */

import type { ObjectSummary, Work } from '../types/api';
import { formatPercent, joinMeta } from '../formatters';
import { healthStatusPresentation, type StatusPresentation } from './status';

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
  /** The object's confirmed status — `ObjectSummary.healthStatus`, not a frontend aggregate. */
  status: StatusPresentation;
}

export type C01AttentionReason = 'ScheduleDelay' | 'ScheduleRisk' | 'Blocked';

export interface C01AttentionItem {
  objectId: string;
  objectName: string;
  status: StatusPresentation;
  reason: C01AttentionReason;
  /** Management-worded sentence. Never names a work, a trade or a finish type. */
  message: string;
}

export interface C01ViewModel {
  portfolio: C01PortfolioRow[];
  attention: C01AttentionItem[];
  /**
   * Objects `healthStatus` marks `GRAY` — no schedule statuses at all, or
   * stale ones (`ObjectHealthService`'s own definition). Excluded from
   * `attention` on purpose: an unevaluated object is not a confirmed problem
   * and must not be reported as one, but it is just as wrong to fold it into
   * "no problems found", which is what an empty `attention` array alone would
   * imply. The count is a separate, explicit fact the screen renders.
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
    status: healthStatusPresentation(object.healthStatus),
  }));

  const attention: C01AttentionItem[] = [];
  let unevaluatedObjectCount = 0;

  for (const object of objects) {
    if (object.healthStatus === 'GRAY') {
      unevaluatedObjectCount += 1;
      continue;
    }

    const objectWorks = works.filter((work) => work.objectId === object.id);
    const blocked = objectWorks.some((work) => work.blockers.length > 0);
    const hasRed = objectWorks.some((work) => work.scheduleStatus === 'RED');
    const hasYellow = objectWorks.some((work) => work.scheduleStatus === 'YELLOW');

    let reason: C01AttentionReason | null = null;
    if (blocked) reason = 'Blocked';
    else if (hasRed) reason = 'ScheduleDelay';
    else if (hasYellow) reason = 'ScheduleRisk';

    if (reason === null) continue;

    attention.push({
      objectId: object.id,
      objectName: object.name,
      status: reason === 'Blocked' ? { variant: 'Blocked', label: 'Заблокировано' } : healthStatusPresentation(object.healthStatus),
      reason,
      message: attentionMessage(reason),
    });
  }
  attention.sort((a, b) => ATTENTION_RANK[a.reason] - ATTENTION_RANK[b.reason]);

  return { portfolio, attention, unevaluatedObjectCount };
}

/**
 * Shown when the attention queue is empty *and* every object had evaluable
 * data. A real, positive finding — not the same claim as "no data" — so it
 * must never be the fallback for an empty queue on its own; the screen only
 * reaches for this when `unevaluatedObjectCount` is also zero.
 */
export const C01_ATTENTION_EMPTY_LABEL = 'Проблем по графику производства работ не выявлено';

/**
 * Shown whenever at least one object could not be evaluated — independently
 * of whether the queue also has confirmed items, so a portfolio that is both
 * "two objects behind schedule" and "one object with no data yet" says both,
 * rather than the second fact disappearing behind the first.
 */
export const C01_INSUFFICIENT_DATA_LABEL = 'Недостаточно данных для оценки графика по части объектов';
