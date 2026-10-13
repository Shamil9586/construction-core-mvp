/**
 * ID-AUTO-2 — «Реестр ИД» view-model: words, formats and link targets for what the server already decided.
 *
 * NO documentary rule lives here. Whether a package or an act is ready, why not, which acts a PTO engineer may see and how many packages
 * there are comes from the backend payload (`DocumentationRegistryPayload`); this module only chooses the Russian wording, formats
 * figures and dates, and maps a blocker's `target` to the section of the existing package screen that fixes it. Nothing here reads a
 * status, a revision count or a version to decide readiness — `readiness.ready` is rendered, never recomputed.
 */
import type {
  DocumentationRegistryPayload, RegistryAosrItem, RegistryArchivedItem, RegistryDocxState, RegistryLastUpdateKind, RegistryMethodFilter, RegistryPackageItem,
  RegistryQuery, RegistryReadinessReason, RegistryReadinessTarget,
} from '../data/documentationRegistryApi';
import type { DocumentationPackageStatus } from '../types/api';
import { documentationPackageStatusPresentation, type StatusPresentation } from './status';
import { AOSR_METHOD_UNSET_TEXT, METHOD_TEXT, SCOPE_NOT_SELECTED_TEXT, SOURCE_TEXT } from './packageIdentity';
import { formatDate, formatDateTime, formatQuantityWithUnit } from '../formatters';

export const REGISTRY_TITLE = 'Реестр ИД';
export const REGISTRY_EMPTY_TEXT = 'В этом объекте нет активных пакетов исполнительной документации.';
export const REGISTRY_NO_MATCH_TEXT = 'По выбранным условиям пакетов нет. Сбросьте фильтры, чтобы увидеть все пакеты объекта.';
export const REGISTRY_ASSIGNED_ONLY_TEXT = 'Показаны только работы, на которые вы назначены.';
export const READY_LABEL = 'Готово';
export const NOT_READY_LABEL = 'Не готово';
export const NO_NUMBER_TEXT = 'номер не присвоен';
/** The cell for an EXTERNAL package: zero Core acts is the method, not a defect. */
export const EXTERNAL_NO_AOSR_TEXT = 'АОСР ведутся вне Core';
const PREVIEW_REASONS = 2;

/** Which section of the existing package screen fixes a blocker. Serialised in the URL by the route container. */
export type PackageFocus = 'scope' | 'method' | 'aosr' | 'schemes';
export interface BlockerLink { label: string; focus: PackageFocus; aosrId?: string }

export interface RegistryReasonViewModel {
  key: string;
  text: string;
  /** Null when the viewer cannot open the package (read-only roles) — the reason is still shown, just without a link. */
  link: BlockerLink | null;
}

const DOCX_TEXT: Record<RegistryDocxState, { label: string; variant: StatusPresentation['variant'] }> = {
  NOT_GENERATED: { label: 'Не сформирован', variant: 'Neutral' },
  CURRENT: { label: 'Актуальный DOCX', variant: 'OnTrack' },
  OUTDATED: { label: 'Изменён после формирования', variant: 'Attention' },
};

const LAST_UPDATE_TEXT: Record<RegistryLastUpdateKind, string> = {
  PACKAGE_CREATED: 'Пакет создан',
  PACKAGE_CHANGED: 'Пакет изменён',
  STATUS_CHANGED: 'Изменён статус',
  METHOD_CHOSEN: 'Выбран способ подготовки АОСР',
  AOSR_CHANGED: 'Изменён АОСР',
  AOSR_GENERATED: 'Сформирован АОСР',
  SCHEME_UPLOADED: 'Загружена исполнительная схема',
  DOCUMENT_CHANGED: 'Изменён документ',
  CUSTOMER_QUANTITY_RECORDED: 'Зафиксирован объём, принятый заказчиком',
};

const SCOPE_LINK: BlockerLink = { label: 'Выбрать участок', focus: 'scope' };

/** Target -> where to go. Pure navigation; the target itself was chosen by the server. */
export function blockerLink(target: RegistryReadinessTarget): BlockerLink {
  switch (target.kind) {
    case 'SCOPE':
      return SCOPE_LINK;
    case 'METHOD':
      return { label: 'Выбрать способ подготовки', focus: 'method' };
    case 'AOSR_SECTION':
      return { label: 'К блоку АОСР', focus: 'aosr' };
    case 'AOSR':
      return { label: 'Открыть АОСР', focus: 'aosr', aosrId: target.aosrId };
    case 'SCHEMES':
      return { label: 'К исполнительным схемам', focus: 'schemes' };
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}

function reasonViewModels(reasons: RegistryReadinessReason[], canOpen: boolean, scopeKey: string): RegistryReasonViewModel[] {
  return reasons.map((reason, index) => ({ key: `${scopeKey}:${reason.code}:${reason.aosrId ?? ''}:${index}`, text: reason.message, link: canOpen ? blockerLink(reason.target) : null }));
}

export interface RegistryAosrViewModel {
  id: string;
  numberText: string;
  hasNumber: boolean;
  title: string;
  zonesText: string;
  workDatesText: string;
  docx: { label: string; variant: StatusPresentation['variant'] };
  schemeText: string;
  schemeCovered: boolean;
  ready: boolean;
  readinessLabel: string;
  reasons: RegistryReasonViewModel[];
  generationIssues: string[];
  details: { label: string; value: string }[];
  lastUpdateText: string;
}

export function buildRegistryAosrViewModel(aosr: RegistryAosrItem, canOpen: boolean): RegistryAosrViewModel {
  const dates = [aosr.startDate, aosr.endDate].map((d) => (d ? formatDate(d) : null));
  const workDatesText = dates[0] && dates[1] ? `${dates[0]} — ${dates[1]}` : dates[0] ? `с ${dates[0]}` : dates[1] ? `по ${dates[1]}` : 'Даты работ не указаны';
  const details = [
    { label: 'Проектная и рабочая документация', value: aosr.projectDocumentation },
    { label: 'Нормативные документы', value: aosr.normativeReferences },
    { label: 'Последующие работы', value: aosr.subsequentWork },
  ].flatMap((entry) => (entry.value && entry.value.trim() ? [{ label: entry.label, value: entry.value }] : []));
  const files = aosr.schemeCoverage.schemes.filter((scheme) => scheme.hasFile);
  return {
    id: aosr.id,
    numberText: aosr.number === null ? NO_NUMBER_TEXT : `№ ${aosr.number}`,
    hasNumber: aosr.number !== null,
    title: aosr.title,
    zonesText: aosr.zones.length ? aosr.zones.join(', ') : 'Участок не привязан',
    workDatesText,
    docx: DOCX_TEXT[aosr.docx.state],
    schemeText: files.length ? files.map((scheme) => scheme.title).join(', ') : 'Схема с файлом не привязана',
    schemeCovered: aosr.schemeCoverage.covered,
    ready: aosr.readiness.ready,
    readinessLabel: aosr.readiness.ready ? READY_LABEL : NOT_READY_LABEL,
    reasons: reasonViewModels(aosr.readiness.reasons, canOpen, aosr.id),
    generationIssues: aosr.generationIssues.map((issue) => issue.message),
    details,
    lastUpdateText: formatDateTime(aosr.lastUpdateAt),
  };
}

export interface RegistryRowViewModel {
  packageId: string;
  workName: string;
  scopeText: string;
  scopeMissing: boolean;
  quantityText: string | null;
  quantitySourceText: string | null;
  responsible: string;
  status: StatusPresentation;
  methodText: string;
  methodDeclared: boolean;
  /** "3 АОСР · сформировано 2" for a Core package; null when the count is not applicable (external / undeclared). */
  aosrCountText: string | null;
  externalNoAosr: boolean;
  schemesText: string;
  ready: boolean;
  readinessLabel: string;
  reasons: RegistryReasonViewModel[];
  previewReasons: RegistryReasonViewModel[];
  hiddenReasonCount: number;
  awaitingEngineerAction: boolean;
  lastUpdateText: string;
  lastUpdateKindText: string;
  aosrs: RegistryAosrViewModel[];
  /** Whether there is anything to expand: blockers or an AOSR register. */
  expandable: boolean;
}

export function buildRegistryRowViewModel(row: RegistryPackageItem, canOpen: boolean): RegistryRowViewModel {
  const reasons = reasonViewModels(row.readiness.reasons, canOpen, row.packageId);
  const quantity = row.scope.currentQuantity;
  const core = row.aosrMethod === 'CORE';
  return {
    packageId: row.packageId,
    workName: row.workName,
    scopeText: row.scope.hasScope && row.scope.zoneSummary ? row.scope.zoneSummary : SCOPE_NOT_SELECTED_TEXT,
    scopeMissing: !row.scope.hasScope,
    quantityText: quantity ? formatQuantityWithUnit(quantity.quantity, quantity.unit) : null,
    quantitySourceText: quantity ? SOURCE_TEXT[quantity.source] : null,
    responsible: row.responsible.name,
    status: documentationPackageStatusPresentation(row.status as DocumentationPackageStatus),
    methodText: row.aosrMethod ? METHOD_TEXT[row.aosrMethod] : AOSR_METHOD_UNSET_TEXT,
    methodDeclared: row.aosrMethod !== null,
    aosrCountText: core ? `${row.aosrCount} АОСР · сформировано ${row.aosrGeneratedCount}` : null,
    externalNoAosr: row.aosrMethod === 'EXTERNAL',
    schemesText: row.schemeCount === 0 ? 'Схем нет' : `Схем с файлом: ${row.schemeFileBackedCount} из ${row.schemeCount}`,
    ready: row.readiness.ready,
    readinessLabel: row.readiness.ready ? READY_LABEL : NOT_READY_LABEL,
    reasons,
    previewReasons: reasons.slice(0, PREVIEW_REASONS),
    hiddenReasonCount: Math.max(0, reasons.length - PREVIEW_REASONS),
    awaitingEngineerAction: row.awaitingEngineerAction,
    lastUpdateText: formatDateTime(row.lastUpdate.at),
    lastUpdateKindText: LAST_UPDATE_TEXT[row.lastUpdate.kind],
    aosrs: row.aosrs.map((aosr) => buildRegistryAosrViewModel(aosr, canOpen)),
    expandable: reasons.length > 0 || row.aosrs.length > 0,
  };
}

export interface RegistryArchivedRowViewModel {
  packageId: string;
  workName: string;
  scopeText: string;
  quantityText: string | null;
  responsible: string;
  status: StatusPresentation;
  methodText: string;
  archivedText: string;
  reasonText: string;
}

export function buildRegistryArchivedRowViewModel(row: RegistryArchivedItem): RegistryArchivedRowViewModel {
  const quantity = row.scope.currentQuantity;
  return {
    packageId: row.packageId,
    workName: row.workName,
    scopeText: row.scope.hasScope && row.scope.zoneSummary ? row.scope.zoneSummary : SCOPE_NOT_SELECTED_TEXT,
    quantityText: quantity ? formatQuantityWithUnit(quantity.quantity, quantity.unit) : null,
    responsible: row.responsible.name,
    status: documentationPackageStatusPresentation(row.status as DocumentationPackageStatus),
    methodText: row.aosrMethod ? METHOD_TEXT[row.aosrMethod] : AOSR_METHOD_UNSET_TEXT,
    archivedText: row.archivedByName ? `Архивирован: ${row.archivedByName}, ${formatDateTime(row.archivedAt)}` : `Архивирован ${formatDateTime(row.archivedAt)}`,
    reasonText: row.archiveReason ? `Причина: ${row.archiveReason}` : 'Причина не указана',
  };
}

export interface RegistrySummaryTile { key: 'active' | 'ready' | 'notReady' | 'awaiting'; label: string; value: string; note: string }

export interface RegistryViewModel {
  objectId: string;
  objectName: string;
  description: string;
  assignedOnly: boolean;
  summary: RegistrySummaryTile[];
  responsibleOptions: { id: string; name: string }[];
  matchedCount: number;
  totalCount: number;
  filtered: boolean;
  rows: RegistryRowViewModel[];
  archivedCount: number;
  archivedRows: RegistryArchivedRowViewModel[] | null;
}

export function buildRegistryViewModel(payload: DocumentationRegistryPayload, query: RegistryQuery, canOpen: boolean): RegistryViewModel {
  const s = payload.summary;
  return {
    objectId: payload.objectId,
    objectName: payload.objectName,
    description: payload.objectAddress ? `${payload.objectName} · ${payload.objectAddress}` : payload.objectName,
    assignedOnly: payload.worksScope === 'ASSIGNED_WORKS',
    summary: [
      { key: 'active', label: 'Активных пакетов', value: String(s.activePackages), note: 'без архивных' },
      { key: 'ready', label: READY_LABEL, value: String(s.ready), note: 'можно переходить к следующему этапу' },
      { key: 'notReady', label: NOT_READY_LABEL, value: String(s.notReady), note: 'есть что устранить' },
      { key: 'awaiting', label: 'Ждут действия инженера', value: String(s.awaitingEngineerAction), note: 'черновик, подготовка, замечания' },
    ],
    responsibleOptions: payload.filterOptions.responsible,
    matchedCount: payload.matchedCount,
    totalCount: s.activePackages,
    filtered: isFiltered(query),
    rows: payload.rows.map((row) => buildRegistryRowViewModel(row, canOpen)),
    archivedCount: payload.archivedCount,
    archivedRows: payload.archivedRows ? payload.archivedRows.map(buildRegistryArchivedRowViewModel) : null,
  };
}

/* ---------------------------------- filters in the URL ---------------------------------- */

const STATUS_VALUES = ['DRAFT', 'PREPARING', 'READY_FOR_PRESENTATION', 'PRESENTED', 'RETURNED', 'CORRECTING', 'ACCEPTED_BY_CUSTOMER'] as const;
const METHOD_VALUES: RegistryMethodFilter[] = ['CORE', 'EXTERNAL', 'UNSET'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const STATUS_FILTER_OPTIONS: { value: string; label: string }[] = STATUS_VALUES.map((value) => ({ value, label: documentationPackageStatusPresentation(value).label }));
/** Short filter wording; the row itself spells the method out in full (`METHOD_TEXT` / `AOSR_METHOD_UNSET_TEXT`). */
export const METHOD_FILTER_OPTIONS: { value: RegistryMethodFilter; label: string }[] = [
  { value: 'CORE', label: 'В Core' },
  { value: 'EXTERNAL', label: 'Вне Core' },
  { value: 'UNSET', label: 'Не выбран' },
];

/** "1 пакет" / "2 пакета" / "5 пакетов". */
export function packagesCountText(n: number): string {
  const word = n % 10 === 1 && n % 100 !== 11 ? 'пакет' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'пакета' : 'пакетов';
  return `${n} ${word}`;
}

/** Filters live in the URL (shareable, survive a refresh); anything that does not parse is ignored, never guessed. */
export function readRegistryQuery(params: URLSearchParams): RegistryQuery {
  const query: RegistryQuery = {};
  const responsible = params.get('responsible');
  if (responsible && UUID.test(responsible)) query.responsibleUserId = responsible;
  const status = params.get('status');
  if (status && (STATUS_VALUES as readonly string[]).includes(status)) query.status = status;
  const ready = params.get('ready');
  if (ready === 'true') query.ready = true;
  if (ready === 'false') query.ready = false;
  const method = params.get('method');
  if (method && (METHOD_VALUES as string[]).includes(method)) query.method = method as RegistryMethodFilter;
  const q = params.get('q');
  if (q && q.trim()) query.q = q.trim().slice(0, 200);
  if (params.get('archived') === '1') query.archived = true;
  return query;
}

export function writeRegistryQuery(query: RegistryQuery): URLSearchParams {
  const p = new URLSearchParams();
  if (query.responsibleUserId) p.set('responsible', query.responsibleUserId);
  if (query.status) p.set('status', query.status);
  if (query.ready !== undefined) p.set('ready', String(query.ready));
  if (query.method) p.set('method', query.method);
  if (query.q && query.q.trim()) p.set('q', query.q.trim());
  if (query.archived) p.set('archived', '1');
  return p;
}

/** "Showing the archive" is a view, not a filter on the working list — it does not count as a filter. */
export function isFiltered(query: RegistryQuery): boolean {
  return !!(query.responsibleUserId || query.status || query.ready !== undefined || query.method || (query.q && query.q.trim()));
}
