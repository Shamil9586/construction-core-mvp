/**
 * GPR-1 — Production Schedule («График производства работ»): the data chain between the schedule API and its three consumers.
 *
 *   * the Object's schedule screen (table, draft, delay reasons, history);
 *   * O01's «Состояние графика» card — the production-level conclusion «По графику» / «Есть отставание»;
 *   * W01's schedule summary of one Work.
 *
 * Everything decided here is a presentation choice over values the BACKEND has already derived from the approved dates and the RP fact:
 * the state, the delay in days, the planned progress, the conclusion. Nothing is recomputed from dates, no colour is chosen by a figure, and
 * nothing is invented to fill a gap — «—» is "nothing reported", a real 0 stays 0. Percentages are only ever `%` (never п.п.), and a plan
 * and a fact are shown side by side, never as their difference.
 *
 * Capability absent vs data absent: a role or runtime that cannot read the schedule gets NO block (`Hidden`); an object whose schedule is not
 * approved yet gets an explicit «График не утверждён» — a stated absence of a baseline, not a guess.
 */
import { NO_DATA_DASH, formatDate, formatPercent, formatQuantity, formatQuantityWithUnit } from '../formatters';
import type {
  DelayReasonCategory,
  ObjectSchedule,
  ObjectScheduleStatus,
  ScheduleAccess,
  ScheduleChange,
  ScheduleDelayKind,
  ScheduleDelayReason,
  ScheduleDraftEntry,
  ScheduleEntry,
  ScheduleEntryState,
  ScheduleLoad,
  WorkSchedule,
} from '../types/schedule';
import type { StatusPresentation } from './status';

// ---------------------------------------------------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------------------------------------------------

/** «1 день», «2 дня», «5 дней». */
export function formatDays(days: number): string {
  const n = Math.abs(Math.trunc(days));
  const last = n % 10, lastTwo = n % 100;
  const word = last === 1 && lastTwo !== 11 ? 'день' : last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14) ? 'дня' : 'дней';
  return `${n} ${word}`;
}

/** A signed shift: «+7 дн.», «−3 дн.». */
function formatShift(days: number): string {
  return `${days > 0 ? '+' : '−'}${Math.abs(days)} дн.`;
}

/**
 * The management state of one schedule entry. «В работе» and «Выполнено» are on-track facts; «Не начато» before the start date is simply
 * neutral; the delay carries the one amber shared with the rest of the product (D-07) and always its words.
 */
export function scheduleEntryStatePresentation(state: ScheduleEntryState | null): StatusPresentation {
  switch (state) {
    // An entry whose fact is unknown has no state: stated in words, never «Не начато» and never a delay (GPR1-UNKNOWN-01).
    case null:
      return { variant: 'Neutral', label: 'Факт не определён' };
    case 'NOT_STARTED':
      return { variant: 'Neutral', label: 'Не начато' };
    case 'IN_PROGRESS':
      return { variant: 'OnTrack', label: 'В работе' };
    case 'COMPLETED':
      return { variant: 'OnTrack', label: 'Выполнено' };
    case 'DELAYED':
      return { variant: 'Delayed', label: 'Есть отставание' };
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

/** The object-level conclusion. No baseline is `Neutral` and says so — it never reads as «По графику». */
export function objectScheduleStatusPresentation(status: ObjectScheduleStatus): StatusPresentation {
  switch (status) {
    case 'ON_TRACK':
      return { variant: 'OnTrack', label: 'По графику' };
    case 'DELAYED':
      return { variant: 'Delayed', label: 'Есть отставание' };
    case 'NO_BASELINE':
      return { variant: 'Neutral', label: 'График не утверждён' };
    case 'UNDETERMINED':
      return { variant: 'Neutral', label: 'Оценка невозможна: факт не определён' };
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

export function delayKindText(kind: ScheduleDelayKind | null): string | null {
  switch (kind) {
    case 'START':
      return 'Работа не начата в срок';
    case 'PROGRESS':
      return 'Выполнение отстаёт от планового графика';
    case 'FINISH':
      return 'Срок окончания наступил, работа не завершена';
    default:
      return null;
  }
}

const label = (workName: string, zone: string | null) => (zone ? `${workName} · ${zone}` : workName);

// ---------------------------------------------------------------------------------------------------------------------------------
// Delay reasons
// ---------------------------------------------------------------------------------------------------------------------------------

export interface ReasonViewModel {
  id: string;
  version: number;
  category: string;
  comment: string;
  /** «Записал: Иванов И. · 12.10.2026» — who and when. */
  provenance: string;
  /** «Ответственный: ООО «Подрядчик»» / «Ответственный: Иванов И.»; `null` when none was named. */
  responsible: string | null;
  /** How late the scope was when the reason was recorded. */
  evidence: string;
  open: boolean;
  statusLabel: string;
  /** «Закрыта: Иванов И. · 15.10.2026 — партия поставлена»; `null` while open. */
  resolution: string | null;
}

function buildReason(reason: ScheduleDelayReason): ReasonViewModel {
  const responsible = reason.responsibleUserName
    ? `Ответственный: ${reason.responsibleUserName}`
    : reason.responsibleContractorName
      ? `Ответственный: ${reason.responsibleContractorName} (подрядчик)`
      : null;
  const open = reason.status === 'OPEN';
  return {
    id: reason.id,
    version: reason.version,
    category: reason.categoryName,
    comment: reason.comment,
    provenance: `Записал: ${reason.recordedByName ?? NO_DATA_DASH} · ${formatDate(reason.recordedAt)}`,
    responsible,
    evidence: `На момент записи отставание — ${formatDays(reason.delayDaysAtRecord)}`,
    open,
    statusLabel: open ? 'Открыта' : 'Закрыта',
    resolution: open
      ? null
      : `Закрыта: ${reason.resolvedByName ?? NO_DATA_DASH} · ${formatDate(reason.resolvedAt)}${reason.resolutionComment ? ` — ${reason.resolutionComment}` : ''}`,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The schedule screen
// ---------------------------------------------------------------------------------------------------------------------------------

export interface GprRowViewModel {
  entryId: string;
  itemId: string;
  workId: string;
  sequence: string;
  name: string;
  zone: string | null;
  executor: string;
  plan: string;
  plannedStart: string;
  plannedFinish: string;
  /** Plan on the day, as a percentage — shown beside the fact, never subtracted from it. */
  planOnDate: string;
  progress: { value: number | null; formatted: string };
  /** The RP fact as a quantity; «—» when nothing was ever reported. */
  fact: string;
  /** Internal СК accepted quantity — its own line, its own caption, never merged into the fact. */
  scAccepted: string | null;
  state: StatusPresentation;
  needsAttention: boolean;
  /** «3 дня»; `null` unless delayed. */
  delay: string | null;
  delayNote: string | null;
  /** How far corrections moved the dates against the first approved plan. */
  shift: string | null;
  followsNote: string | null;
  splitNote: string | null;
  reasons: ReasonViewModel[];
  openReasonCount: number;
  /** A delay is real and the viewer may explain it. */
  canRecordReason: boolean;
  /**
   * The viewer may close an open reason — whatever the entry's state is NOW: a zone that has since caught up (or been re-planned) is no
   * longer delayed, and its explanation must not stay open for good just because the form for a NEW one has gone.
   */
  canResolveReason: boolean;
}

function buildRow(entry: ScheduleEntry, access: ScheduleAccess): GprRowViewModel {
  const state = scheduleEntryStatePresentation(entry.state);
  const shift = entry.baselineShift
    ? ['начало', 'окончание']
        .map((name, index) => ({ name, days: index === 0 ? entry.baselineShift!.startDays : entry.baselineShift!.finishDays }))
        .filter((part) => part.days !== 0)
        .map((part) => `${part.name} ${formatShift(part.days)}`)
        .join(', ')
    : null;
  const reasons = entry.delayReasons.map(buildReason);
  return {
    entryId: entry.entryId,
    itemId: entry.itemId,
    workId: entry.objectWorkId,
    sequence: String(entry.sequence),
    name: entry.workName,
    zone: entry.zone,
    executor: entry.executor,
    plan: formatQuantityWithUnit(entry.plannedQuantity, entry.unit),
    plannedStart: formatDate(entry.plannedStart),
    plannedFinish: formatDate(entry.plannedFinish),
    planOnDate: formatPercent(entry.plannedProgress),
    progress: { value: entry.factReported ? entry.actualProgress : null, formatted: entry.factReported ? formatPercent(entry.actualProgress) : NO_DATA_DASH },
    fact: entry.factReliability === 'UNKNOWN' ? 'Не определён' : entry.factReported ? formatQuantityWithUnit(entry.rpFactQuantity, entry.unit) : NO_DATA_DASH,
    scAccepted: entry.internalScAcceptedQuantity !== null ? formatQuantityWithUnit(entry.internalScAcceptedQuantity, entry.unit) : null,
    state,
    needsAttention: entry.state === 'DELAYED',
    delay: entry.state === 'DELAYED' ? formatDays(entry.delayDays) : null,
    delayNote: entry.state === 'DELAYED' ? delayKindText(entry.delayKind) : null,
    shift: shift ? `Относительно первого графика: ${shift}` : null,
    followsNote: entry.predecessorLabel
      ? `Следует за: ${entry.predecessorLabel}${entry.followsPredecessor === false ? ' · начало раньше окончания предшественника' : ''}`
      : null,
    splitNote: entry.workNowHasUnits ? 'У работы появились участки — разбейте график по участкам при ближайшей корректировке.' : null,
    reasons,
    openReasonCount: reasons.filter((reason) => reason.open).length,
    canRecordReason: access.canRecordDelayReason && entry.state === 'DELAYED',
    canResolveReason: access.canRecordDelayReason,
  };
}

/** One line per change, with the before and the after: «Окончание: 11.03.2026 → 18.03.2026». */
export function describeChange(change: ScheduleChange): string[] {
  const range = (s: { plannedStart: string; plannedFinish: string } | null) => (s ? `${formatDate(s.plannedStart)} — ${formatDate(s.plannedFinish)}` : NO_DATA_DASH);
  if (change.kind === 'ADDED') return [`Добавлено в график: ${range(change.after)}`];
  if (change.kind === 'REMOVED') return [`Убрано из графика (было ${range(change.before)})`];
  const lines: string[] = [];
  const { before, after } = change;
  if (before && after) {
    if (change.fields.includes('plannedStart')) lines.push(`Начало: ${formatDate(before.plannedStart)} → ${formatDate(after.plannedStart)}`);
    if (change.fields.includes('plannedFinish')) lines.push(`Окончание: ${formatDate(before.plannedFinish)} → ${formatDate(after.plannedFinish)}`);
    if (change.fields.includes('sequence')) lines.push(`Порядок: ${before.sequence} → ${after.sequence}`);
    if (change.fields.includes('predecessorItemId')) lines.push('Изменена последовательность («следует за»)');
  }
  return lines;
}

export interface ChangeViewModel {
  itemId: string;
  label: string;
  kind: 'ADDED' | 'REMOVED' | 'CHANGED';
  lines: string[];
}

const buildChange = (change: ScheduleChange): ChangeViewModel => ({ itemId: change.itemId, label: change.label || label(change.workName, change.zone), kind: change.kind, lines: describeChange(change) });

export interface DraftRowViewModel {
  entryId: string;
  itemId: string;
  version: number;
  name: string;
  zone: string | null;
  executor: string;
  plan: string;
  /** Raw civil dates and numbers for the editing controls — display strings would not round-trip. */
  start: string;
  finish: string;
  sequence: number;
  predecessorItemId: string | null;
  baselineText: string | null;
  change: 'ADDED' | 'CHANGED' | null;
  followsNote: string | null;
}

function buildDraftRow(entry: ScheduleDraftEntry): DraftRowViewModel {
  return {
    entryId: entry.entryId,
    itemId: entry.itemId,
    version: entry.version,
    name: entry.workName,
    zone: entry.zone,
    executor: entry.executor,
    plan: formatQuantityWithUnit(entry.plannedQuantity, entry.unit),
    start: entry.plannedStart,
    finish: entry.plannedFinish,
    sequence: entry.sequence,
    predecessorItemId: entry.predecessorItemId,
    baselineText: entry.baseline ? `Утверждено: ${formatDate(entry.baseline.plannedStart)} — ${formatDate(entry.baseline.plannedFinish)}` : null,
    change: entry.change,
    followsNote: entry.predecessorLabel
      ? `Следует за: ${entry.predecessorLabel}${entry.followsPredecessor === false ? ' · начало раньше окончания предшественника' : ''}`
      : null,
  };
}

export interface DraftViewModel {
  revisionNo: number;
  version: number;
  title: string;
  /** «Корректировка утверждённого графика (версия №1)» for a correction; `null` for the first schedule. */
  basedOn: string | null;
  isCorrection: boolean;
  rows: DraftRowViewModel[];
  /** What the approval would change against the approved schedule — the evidence the approver reads. */
  changes: ChangeViewModel[];
  /** The follows-selector's options: every other entry of the draft. */
  predecessorOptions: { value: string; label: string }[];
}

export interface ScopeOptionViewModel {
  value: string;
  workId: string;
  unitId: string | null;
  label: string;
  executor: string;
  plan: string;
  suggestedStart: string | null;
  suggestedFinish: string | null;
}

export interface HistoryViewModel {
  revisionNo: number;
  title: string;
  statusLabel: string;
  provenance: string;
  correctionReason: string | null;
  comment: string | null;
  changes: ChangeViewModel[];
}

export interface GprViewModel {
  objectId: string;
  objectName: string;
  /** The day plan versus fact is computed for. */
  asOf: string;
  conclusion: { presentation: StatusPresentation; text: string };
  /** The calendar's answers for the day: what should have started / be underway / be finished, and what is delayed. */
  expectation: { label: string; value: string; meta: string }[];
  baseline: { title: string; lines: string[] } | null;
  rows: GprRowViewModel[];
  unscheduled: string[];
  draft: DraftViewModel | null;
  availableScopes: ScopeOptionViewModel[];
  history: HistoryViewModel[];
  categories: DelayReasonCategory[];
  access: ScheduleAccess;
}

function conclusionText(schedule: ObjectSchedule): string {
  const c = schedule.conclusion;
  switch (c.status) {
    case 'NO_BASELINE':
      return 'Утверждённого графика производства работ по объекту нет — сроки не контролируются.';
    case 'DELAYED':
      return `Отстают позиции графика: ${c.delayedCount} из ${c.entryCount}. Наибольшее отставание — ${formatDays(c.maxDelayDays)}.`;
    case 'ON_TRACK':
      return `Отставаний нет. Позиций в графике: ${c.entryCount}, выполнено: ${c.completedCount}.`;
    case 'UNDETERMINED':
      return `Отставание не установлено, но и «по графику» утверждать нельзя: по позициям, где факт выполнения не определён (${c.unassessedCount ?? 0} из ${c.entryCount}), оценка невозможна.`;
    default: {
      const exhaustive: never = c.status;
      return exhaustive;
    }
  }
}

export function buildGprViewModel(schedule: ObjectSchedule): GprViewModel {
  const c = schedule.conclusion;
  const draft = schedule.draft;
  return {
    objectId: schedule.objectId,
    objectName: schedule.objectName,
    asOf: formatDate(schedule.asOf),
    conclusion: { presentation: objectScheduleStatusPresentation(c.status), text: conclusionText(schedule) },
    expectation: schedule.current
      ? [
          { label: 'Должно было начаться', value: String(c.expected.underway + c.expected.dueComplete), meta: 'позиций графика' },
          { label: 'Должно идти', value: String(c.expected.underway), meta: 'позиций графика' },
          { label: 'Должно быть завершено', value: String(c.expected.dueComplete), meta: 'позиций графика' },
          { label: 'Есть отставание', value: String(c.delayedCount), meta: 'позиций графика' },
        ]
      : [],
    baseline: schedule.current
      ? {
          title: `Утверждённый график — версия №${schedule.current.revisionNo}`,
          lines: [
            `Утверждён: ${formatDate(schedule.current.approvedAt)}${schedule.current.approvedByName ? `, ${schedule.current.approvedByName}` : ''}`,
            ...(schedule.current.basedOnRevisionNo !== null ? [`Корректировка версии №${schedule.current.basedOnRevisionNo}`] : []),
            ...(schedule.current.correctionReason ? [`Причина корректировки: ${schedule.current.correctionReason}`] : []),
            ...(schedule.current.approvalComment ? [`Комментарий: ${schedule.current.approvalComment}`] : []),
          ],
        }
      : null,
    rows: schedule.entries.map((entry) => buildRow(entry, schedule.access)),
    unscheduled: schedule.unscheduled.map((scope) => label(scope.workName, scope.zone)),
    draft: draft
      ? {
          revisionNo: draft.revisionNo,
          version: draft.version,
          title: `Черновик графика — версия №${draft.revisionNo}`,
          basedOn: draft.basedOnRevisionNo !== null ? `Корректировка утверждённого графика (версия №${draft.basedOnRevisionNo})` : null,
          isCorrection: draft.basedOnRevisionNo !== null,
          rows: draft.entries.map(buildDraftRow),
          changes: draft.changes.map(buildChange),
          predecessorOptions: draft.entries.map((entry) => ({ value: entry.itemId, label: label(entry.workName, entry.zone) })),
        }
      : null,
    availableScopes: schedule.availableScopes.map((scope) => ({
      value: scope.executionUnitId ?? scope.objectWorkId,
      workId: scope.objectWorkId,
      unitId: scope.executionUnitId,
      label: `${scope.executionUnitId ? label(scope.workName, scope.zone) : `${scope.workName} · вся работа`} — ${formatQuantity(scope.plannedQuantity)} ${scope.unit}`,
      executor: scope.executor,
      plan: formatQuantityWithUnit(scope.plannedQuantity, scope.unit),
      suggestedStart: scope.suggestedStart,
      suggestedFinish: scope.suggestedFinish,
    })),
    history: [...schedule.history].reverse().map((revision) => ({
      revisionNo: revision.revisionNo,
      title: `Версия №${revision.revisionNo}`,
      statusLabel: revision.status === 'APPROVED' ? 'Действует' : `Заменена версией №${revision.supersededByRevisionNo ?? '?'}`,
      provenance: `Утверждена: ${formatDate(revision.approvedAt)}${revision.approvedByName ? `, ${revision.approvedByName}` : ''} · подготовил: ${revision.createdByName ?? NO_DATA_DASH}`,
      correctionReason: revision.correctionReason,
      comment: revision.approvalComment,
      changes: revision.changes.map(buildChange),
    })),
    categories: schedule.delayReasonCategories,
    access: schedule.access,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// O01 — the Object overview's «Состояние графика»
// ---------------------------------------------------------------------------------------------------------------------------------

export interface O01DelayedItem {
  label: string;
  delay: string;
  /** Categories of the OPEN delay reasons — the "why", where somebody has recorded one. */
  reasons: string[];
}

export type O01ScheduleView =
  | { kind: 'Loading' }
  | { kind: 'Hidden' }
  | { kind: 'Error'; message: string }
  /** There is no approved schedule: stated as such, with a way in for those who prepare it. */
  | { kind: 'NoBaseline'; status: StatusPresentation; text: string; canPrepare: boolean }
  | { kind: 'Ready'; status: StatusPresentation; text: string; baseline: string; delayed: O01DelayedItem[]; notes: string[] };

const MAX_DELAYED_SHOWN = 3;

export function buildO01ScheduleView(load: ScheduleLoad<ObjectSchedule>): O01ScheduleView {
  if (load.status === 'Loading') return { kind: 'Loading' };
  if (load.status === 'Hidden') return { kind: 'Hidden' };
  if (load.status === 'Error') return { kind: 'Error', message: load.message };
  const schedule = load.value;
  const status = objectScheduleStatusPresentation(schedule.conclusion.status);
  if (schedule.conclusion.status === 'NO_BASELINE' || !schedule.current) {
    return {
      kind: 'NoBaseline',
      status,
      text: schedule.hasDraft ? 'График готовится: черновик ещё не утверждён, сроки не контролируются.' : 'Утверждённого графика производства работ нет — сроки не контролируются.',
      canPrepare: schedule.access.canEdit,
    };
  }
  const delayed = schedule.entries
    .filter((entry) => entry.state === 'DELAYED')
    .sort((a, b) => b.delayDays - a.delayDays || a.sequence - b.sequence)
    .slice(0, MAX_DELAYED_SHOWN)
    .map((entry) => ({
      label: label(entry.workName, entry.zone),
      delay: formatDays(entry.delayDays),
      reasons: [...new Set(entry.delayReasons.filter((reason) => reason.status === 'OPEN').map((reason) => reason.categoryName))],
    }));
  const notes: string[] = [];
  if (schedule.conclusion.delayedCount > delayed.length) notes.push(`и ещё ${schedule.conclusion.delayedCount - delayed.length} с отставанием`);
  if (schedule.conclusion.unscheduledCount > 0) notes.push(`Не включено в график: ${schedule.conclusion.unscheduledCount}`);
  return {
    kind: 'Ready',
    status,
    text: schedule.conclusion.status === 'DELAYED'
      ? `Отстают позиции графика: ${schedule.conclusion.delayedCount} из ${schedule.conclusion.entryCount}.`
      : schedule.conclusion.status === 'UNDETERMINED'
        ? `Отставание не установлено; по позициям с неопределённым фактом (${schedule.conclusion.unassessedCount ?? 0}) оценка графика невозможна.`
        : `Отставаний нет. Позиций в графике: ${schedule.conclusion.entryCount}.`,
    baseline: `График производства работ, версия №${schedule.current.revisionNo} · расчёт на ${formatDate(schedule.asOf)}`,
    delayed,
    notes,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// GPR-UX-D01 — per-work schedule compliance (O01's work list)
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * The state of a Work from the states of its entries (one per execution unit): any delay wins; otherwise the least advanced common state.
 * The same rule as `aggregateScheduleStates` in `packages/domain/schedule.ts` that the backend applies for W01's summary (parity pinned by
 * tests/gpr-ux-d01-viewmodel.test.ts) — restated here only because the frontend does not import the domain package.
 */
export function aggregateWorkEntryStates(states: (ScheduleEntryState | null)[]): ScheduleEntryState | null {
  if (states.length === 0) return null;
  if (states.includes('DELAYED')) return 'DELAYED';
  // an entry with an unknown fact (state null) makes the Work's state unknown too — it is never absorbed into «По графику»
  if (states.includes(null)) return null;
  if (states.every((state) => state === 'COMPLETED')) return 'COMPLETED';
  if (states.every((state) => state === 'NOT_STARTED')) return 'NOT_STARTED';
  return 'IN_PROGRESS';
}

/**
 * Schedule compliance of ONE work, as a claim about the deadlines and nothing else. It comes from the Object's approved GPR alone — never from
 * the legacy `work.scheduleStatus`. When the GPR cannot answer (loading, not offered to this viewer, failed, no approved baseline, work not in
 * it) the answer is an explicit absence in words, never «По графику» by default.
 */
export type WorkScheduleCompliance =
  | { kind: 'Loading'; presentation: StatusPresentation }
  | { kind: 'Unavailable'; presentation: StatusPresentation }
  | { kind: 'Error'; presentation: StatusPresentation }
  | { kind: 'NoBaseline'; presentation: StatusPresentation }
  | { kind: 'NotScheduled'; presentation: StatusPresentation }
  /** The work is in the schedule but a fact of one of its entries is unknown: no «По графику», no delay. */
  | { kind: 'Undetermined'; presentation: StatusPresentation }
  | { kind: 'OnSchedule'; presentation: StatusPresentation }
  | { kind: 'Delayed'; presentation: StatusPresentation };

const NEUTRAL = (text: string): StatusPresentation => ({ variant: 'Neutral', label: text });
export const COMPLIANCE_LOADING = NEUTRAL('Загрузка графика…');
export const COMPLIANCE_UNAVAILABLE = NEUTRAL('График недоступен');
export const COMPLIANCE_ERROR = NEUTRAL('График не загружен');
export const COMPLIANCE_NO_BASELINE = NEUTRAL('График не утверждён');
export const COMPLIANCE_NOT_SCHEDULED = NEUTRAL('Не включена в график');
export const COMPLIANCE_UNDETERMINED = NEUTRAL('Оценка невозможна: факт не определён');

/**
 * Compliance of every work of ONE object, from that object's schedule load. A schedule that belongs to another object (a stale value held
 * across a route change) is never used: it reads as `Loading`.
 */
export function buildObjectWorkCompliance(load: ScheduleLoad<ObjectSchedule> | undefined, objectId: string): (workId: string) => WorkScheduleCompliance {
  const constant = (value: WorkScheduleCompliance) => () => value;
  if (!load || load.status === 'Hidden') return constant({ kind: 'Unavailable', presentation: COMPLIANCE_UNAVAILABLE });
  if (load.status === 'Loading') return constant({ kind: 'Loading', presentation: COMPLIANCE_LOADING });
  if (load.status === 'Error') return constant({ kind: 'Error', presentation: COMPLIANCE_ERROR });
  const schedule = load.value;
  if (schedule.objectId !== objectId) return constant({ kind: 'Loading', presentation: COMPLIANCE_LOADING });
  if (schedule.conclusion.status === 'NO_BASELINE' || !schedule.current) return constant({ kind: 'NoBaseline', presentation: COMPLIANCE_NO_BASELINE });
  const statesByWork = new Map<string, (ScheduleEntryState | null)[]>();
  for (const entry of schedule.entries) statesByWork.set(entry.objectWorkId, [...(statesByWork.get(entry.objectWorkId) ?? []), entry.state]);
  return (workId) => {
    const states = statesByWork.get(workId) ?? [];
    const state = aggregateWorkEntryStates(states);
    if (state === null) return states.length === 0 ? { kind: 'NotScheduled', presentation: COMPLIANCE_NOT_SCHEDULED } : { kind: 'Undetermined', presentation: COMPLIANCE_UNDETERMINED };
    return state === 'DELAYED'
      ? { kind: 'Delayed', presentation: { variant: 'Delayed', label: 'Есть отставание' } }
      : { kind: 'OnSchedule', presentation: { variant: 'OnTrack', label: 'По графику' } };
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// W01 — one Work's schedule summary
// ---------------------------------------------------------------------------------------------------------------------------------

export type W01ScheduleView =
  | { kind: 'Loading' }
  | { kind: 'Hidden' }
  | { kind: 'Error'; message: string }
  /** The object has no approved schedule. */
  | { kind: 'NoBaseline'; canOpenObject: boolean }
  /** The object has an approved schedule, but this work is not in it. */
  | { kind: 'NotScheduled'; canOpenObject: boolean }
  | { kind: 'Ready'; canOpenObject: boolean; plannedStart: string; plannedFinish: string; state: StatusPresentation; delay: string | null; entryCount: number; zones: string };

export function buildW01ScheduleView(load: ScheduleLoad<WorkSchedule>, workId?: string): W01ScheduleView {
  if (load.status === 'Loading') return { kind: 'Loading' };
  if (load.status === 'Hidden') return { kind: 'Hidden' };
  if (load.status === 'Error') return { kind: 'Error', message: load.message };
  const schedule = load.value;
  // A summary that belongs to another work is never this work's (GPR-UX-D01): it reads as still loading.
  if (workId !== undefined && schedule.objectWorkId !== workId) return { kind: 'Loading' };
  // The backend says whether the object's whole schedule is open to this viewer (a PTO engineer with only this work's handoff reads the
  // work's summary but gets a 403 on the object's plan): the way in is offered only when it leads somewhere.
  const canOpenObject = schedule.canOpenObjectSchedule;
  if (!schedule.hasBaseline) return { kind: 'NoBaseline', canOpenObject };
  // `state: null` with `assessable: false` is a scheduled work whose fact is unknown — not a work outside the schedule.
  if (!schedule.summary || (schedule.summary.state === null && schedule.summary.assessable !== false)) return { kind: 'NotScheduled', canOpenObject };
  const zones = schedule.entries.map((entry) => entry.zone).filter((zone): zone is string => zone !== null);
  return {
    kind: 'Ready',
    canOpenObject,
    plannedStart: formatDate(schedule.summary.plannedStart),
    plannedFinish: formatDate(schedule.summary.plannedFinish),
    state: scheduleEntryStatePresentation(schedule.summary.state),
    delay: schedule.summary.state === 'DELAYED' ? formatDays(schedule.summary.delayDays) : null,
    entryCount: schedule.summary.entryCount,
    zones: zones.length ? zones.join(', ') : '',
  };
}

