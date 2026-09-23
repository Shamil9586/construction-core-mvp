/**
 * C01 — Company Control Center.
 *
 * Executive overview: the portfolio, each object's physical readiness and
 * schedule state, and an attention queue worded for a director rather than for
 * a site engineer. Design Rules keep АОСР, ИД, СДО and financial-closing detail
 * off this screen — those are `readiness`/`blockers` facts, not this view's
 * business — and the attention text never names a specific work or trade: it
 * says what kind of problem the object has, not which finish work is behind.
 */

import type { ObjectSummary, Work } from '../types/api';
import { formatPercent, joinMeta } from '../formatters';
import { aggregateScheduleStatus, scheduleStatusPresentation, type StatusPresentation } from './status';

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
  /** Pure schedule aggregate for the object's works — never the mixed `healthStatus`. */
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
  const portfolio: C01PortfolioRow[] = objects.map((object) => {
    const objectWorks = works.filter((work) => work.objectId === object.id);
    const status = scheduleStatusPresentation(aggregateScheduleStatus(objectWorks.map((w) => w.scheduleStatus)));

    return {
      id: object.id,
      name: object.name,
      meta: joinMeta(object.externalCode, object.address),
      responsible: joinMeta('РП', object.responsible),
      smr: formatPercent(object.actualProgress),
      smrProgress: object.actualProgress,
      status,
    };
  });

  const attention: C01AttentionItem[] = [];
  for (const object of objects) {
    const objectWorks = works.filter((work) => work.objectId === object.id);
    const blocked = objectWorks.some((work) => work.blockers.length > 0);
    const aggregate = aggregateScheduleStatus(objectWorks.map((w) => w.scheduleStatus));

    let reason: C01AttentionReason | null = null;
    if (blocked) reason = 'Blocked';
    else if (aggregate === 'RED') reason = 'ScheduleDelay';
    else if (aggregate === 'YELLOW') reason = 'ScheduleRisk';

    if (reason === null) continue;

    attention.push({
      objectId: object.id,
      objectName: object.name,
      status: reason === 'Blocked' ? { variant: 'Blocked', label: 'Заблокировано' } : scheduleStatusPresentation(aggregate),
      reason,
      message: attentionMessage(reason),
    });
  }
  attention.sort((a, b) => ATTENTION_RANK[a.reason] - ATTENTION_RANK[b.reason]);

  return { portfolio, attention };
}

/**
 * Shown when the attention queue is empty. Deliberately not `NO_DATA_TEXT`
 * ("Нет данных") — an empty queue is a real, positive finding (every object was
 * checked and none qualified), not an absence of measurement, and the two must
 * not read the same way.
 */
export const C01_ATTENTION_EMPTY_LABEL = 'Проблем по графику производства работ не выявлено';
