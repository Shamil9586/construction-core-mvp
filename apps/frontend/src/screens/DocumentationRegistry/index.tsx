import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { AppShell, Breadcrumb, DataTable, PageHeader, StatusBadge, typeClass } from '../../design-system';
import type { DataTableColumn } from '../../design-system';
import type { RegistryQuery } from '../../data/documentationRegistryApi';
import {
  EXTERNAL_NO_AOSR_TEXT, METHOD_FILTER_OPTIONS, REGISTRY_ASSIGNED_ONLY_TEXT, REGISTRY_EMPTY_TEXT, REGISTRY_NO_MATCH_TEXT, REGISTRY_TITLE, STATUS_FILTER_OPTIONS,
  isFiltered, packagesCountText,
} from '../../view-models/documentationRegistry';
import type {
  BlockerLink, RegistryAosrViewModel, RegistryArchivedRowViewModel, RegistryReasonViewModel, RegistryRowViewModel, RegistryViewModel,
} from '../../view-models/documentationRegistry';
import styles from './DocumentationRegistry.module.css';

/**
 * ID-AUTO-2 — «Реестр ИД»: the documentary register of ONE object.
 *
 * The overview / control surface for a PTO engineer or head. It renders what the server decided — readiness, its reasons, the counts and
 * the filtering — and restates no rule (see `view-models/documentationRegistry.ts`). It does not replace the package screen: a row, a
 * blocker or an act opens the existing package detail (`actions.onOpenPackage`), at the section that fixes the blocker.
 *
 * `actions` omitted (a read-only role) renders the same register without links — never a control the package screen would refuse.
 * One row = one active package; the archive is a separate, opt-in list. Narrow screens stack each row into labelled blocks (the F11
 * pattern `DataTable` already provides) instead of scrolling a wide table.
 */

const columns: DataTableColumn[] = [
  { key: 'work', header: 'Работа и участок', width: 'fill' },
  { key: 'state', header: 'Статус и способ АОСР', width: 184 },
  { key: 'readiness', header: 'Готовность ИД', width: 296 },
  { key: 'responsible', header: 'Ответственный ПТО', width: 152 },
  // The shared stacked layout hides a row's LAST cell below 640px (it is the decorative chevron of an interactive row), so this column carries
  // nothing but that glyph; every control lives in a cell that stays visible.
  { key: 'chevron', header: '', width: 24 },
];

export interface RegistryActionHandlers {
  onOpenPackage: (packageId: string, link?: BlockerLink) => void;
}

export type RegistryScreenState =
  | { status: 'Loading' }
  | { status: 'Error'; message: string }
  | { status: 'Ready'; viewModel: RegistryViewModel; refreshing: boolean };

export interface DocumentationRegistryProps {
  state: RegistryScreenState;
  /** The filters as the screen holds them (they live in the URL). */
  query: RegistryQuery;
  onQueryChange: (next: RegistryQuery) => void;
  onRetry: () => void;
  sidebar: ReactNode;
  topbar?: ReactNode;
  objectName: string | null;
  onNavigateHome: () => void;
  onOpenObject: () => void;
  actions?: RegistryActionHandlers;
  className?: string;
}

function ReasonList({ reasons, packageId, actions }: { reasons: RegistryReasonViewModel[]; packageId: string; actions?: RegistryActionHandlers }) {
  return (
    <ul className={styles.reasonList}>
      {reasons.map((reason) => (
        <li key={reason.key} className={typeClass('body')}>
          <span>{reason.text}</span>
          {reason.link && actions ? (
            <>
              {' '}
              <button type="button" className={styles.linkButton} onClick={() => actions.onOpenPackage(packageId, reason.link ?? undefined)}>
                {reason.link.label}
              </button>
            </>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function AosrRegister({ row, actions }: { row: RegistryRowViewModel; actions?: RegistryActionHandlers }) {
  // A grid of `div`s with explicit ARIA table roles, not a nested <table>: DataTable's stacked-layout rules address table elements by tag
  // and would otherwise reach into this register (hiding its last cell, doubling its labels).
  return (
    <section className={styles.detailBlock} aria-label={`Реестр АОСР: ${row.workName}, ${row.scopeText}`}>
      <h3 className={[styles.detailTitle, typeClass('label-strong')].join(' ')}>Реестр АОСР · {row.aosrs.length}</h3>
      <div role="table" aria-label={`АОСР пакета: ${row.workName}, ${row.scopeText}`} className={styles.aosrTable}>
        <div role="row" className={[styles.aosrHead, styles.aosrGrid].join(' ')}>
          {['№', 'Скрытые работы', 'Даты работ', 'DOCX', 'Схема', 'Готовность'].map((title) => (
            <span key={title} role="columnheader" className={typeClass('eyebrow')}>{title}</span>
          ))}
        </div>
        {row.aosrs.map((aosr) => (
          <AosrRow key={aosr.id} aosr={aosr} packageId={row.packageId} actions={actions} />
        ))}
      </div>
    </section>
  );
}

function AosrRow({ aosr, packageId, actions }: { aosr: RegistryAosrViewModel; packageId: string; actions?: RegistryActionHandlers }) {
  return (
    <div role="row" className={[styles.aosrRow, styles.aosrGrid].join(' ')}>
      <div role="cell" data-label="Номер" className={[typeClass('body-strong'), aosr.hasNumber ? '' : styles.secondary].join(' ')}>{aosr.numberText}</div>
      <div role="cell" data-label="Скрытые работы">
        <span className={typeClass('body-strong')}>{aosr.title}</span>
        <span className={[styles.secondary, typeClass('meta'), styles.block].join(' ')}>{aosr.zonesText}</span>
        {aosr.details.length > 0 || aosr.generationIssues.length > 0 ? (
          <details className={styles.aosrDetails}>
            <summary className={typeClass('meta')}>Подробнее</summary>
            {aosr.generationIssues.length > 0 ? (
              <div>
                <span className={typeClass('label-strong')}>Не заполнено для формирования</span>
                <ul className={styles.plainList}>
                  {aosr.generationIssues.map((issue) => (
                    <li key={issue} className={typeClass('meta')}>{issue}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {aosr.details.map((entry) => (
              <div key={entry.label}>
                <span className={typeClass('label-strong')}>{entry.label}</span>
                <p className={[styles.detailText, typeClass('meta')].join(' ')}>{entry.value}</p>
              </div>
            ))}
          </details>
        ) : null}
      </div>
      <div role="cell" data-label="Даты работ" className={typeClass('body')}>{aosr.workDatesText}</div>
      <div role="cell" data-label="DOCX"><StatusBadge variant={aosr.docx.variant}>{aosr.docx.label}</StatusBadge></div>
      <div role="cell" data-label="Схема" className={[typeClass('body'), aosr.schemeCovered ? '' : styles.attentionText].join(' ')}>{aosr.schemeText}</div>
      <div role="cell" data-label="Готовность">
        <StatusBadge variant={aosr.ready ? 'OnTrack' : 'Attention'}>{aosr.readinessLabel}</StatusBadge>
        {!aosr.ready && aosr.generationIssues.length > 0 ? (
          <span className={[styles.secondary, typeClass('meta'), styles.block].join(' ')}>Не заполнено: {aosr.generationIssues.length}</span>
        ) : null}
        {actions && !aosr.ready ? (
          <button type="button" className={[styles.linkButton, styles.block].join(' ')} onClick={() => actions.onOpenPackage(packageId, { label: 'Открыть АОСР', focus: 'aosr', aosrId: aosr.id })}>
            Открыть АОСР
          </button>
        ) : null}
      </div>
    </div>
  );
}

function PackageRows({ row, actions }: { row: RegistryRowViewModel; actions?: RegistryActionHandlers }) {
  const [open, setOpen] = useState(false);
  const detailId = `registry-detail-${row.packageId}`;
  const openPackage = () => actions?.onOpenPackage(row.packageId);
  // controls nested in an interactive row must not also trigger the row's own open
  const inner = (handler: () => void) => (event: MouseEvent) => {
    event.stopPropagation();
    handler();
  };
  return (
    <>
      <tr role="row" className={[styles.row, actions ? styles.interactive : ''].join(' ')} onClick={actions ? openPackage : undefined}>
        <td role="cell" data-label="Работа и участок" className={styles.cell}>
          <div className={styles.primary}>
            {actions ? (
              <button type="button" className={[styles.activator, typeClass('body-strong')].join(' ')} onClick={inner(openPackage)}>
                {row.workName}
              </button>
            ) : (
              <span className={typeClass('body-strong')}>{row.workName}</span>
            )}
            <span className={[typeClass('body'), row.scopeMissing ? styles.attentionText : ''].join(' ')}>
              {row.scopeText}
              {row.quantityText ? ` · ${row.quantityText}` : ''}
            </span>
            {row.quantitySourceText ? <span className={[styles.secondary, typeClass('meta')].join(' ')}>{row.quantitySourceText}</span> : null}
            <span className={[styles.secondary, typeClass('meta')].join(' ')}>
              Обновлено {row.lastUpdateText} · {row.lastUpdateKindText}
            </span>
          </div>
        </td>
        <td role="cell" data-label="Статус и способ АОСР" className={styles.cell}>
          <div className={styles.primary}>
            <span><StatusBadge variant={row.status.variant}>{row.status.label}</StatusBadge></span>
            <span className={[typeClass('body'), row.methodDeclared ? '' : styles.attentionText].join(' ')}>{row.methodText}</span>
            {row.aosrCountText ? <span className={[styles.secondary, typeClass('meta')].join(' ')}>{row.aosrCountText}</span> : null}
          </div>
        </td>
        <td role="cell" data-label="Готовность ИД" className={styles.cell}>
          <div className={styles.primary}>
            <span><StatusBadge variant={row.ready ? 'OnTrack' : 'Attention'}>{row.readinessLabel}</StatusBadge></span>
            {row.previewReasons.length > 0 ? (
              <ul className={styles.reasonList}>
                {row.previewReasons.map((reason) => (
                  <li key={reason.key} className={typeClass('meta')}>{reason.text}</li>
                ))}
              </ul>
            ) : null}
            {row.hiddenReasonCount > 0 && !open ? <span className={[styles.secondary, typeClass('meta')].join(' ')}>и ещё {row.hiddenReasonCount}</span> : null}
            {row.expandable ? (
              <button
                type="button"
                className={styles.linkButton}
                aria-expanded={open}
                aria-controls={detailId}
                aria-label={`${open ? 'Свернуть' : 'Показать'} акты и замечания: ${row.workName}, ${row.scopeText}`}
                onClick={inner(() => setOpen((value) => !value))}
              >
                {open ? 'Свернуть' : 'Подробнее'}
              </button>
            ) : null}
          </div>
        </td>
        <td role="cell" data-label="Ответственный ПТО" className={[styles.cell, typeClass('body')].join(' ')}>{row.responsible}</td>
        <td role="cell" data-label="" className={[styles.cell, styles.chevron].join(' ')}>
          {actions ? <span aria-hidden="true">›</span> : null}
        </td>
      </tr>
      {open ? (
        <tr role="row" id={detailId} className={styles.detailRow}>
          <td role="cell" data-label="" colSpan={columns.length - 1} className={styles.detailCell}>
            <div className={styles.detailInner}>
            {row.reasons.length > 0 ? (
              <section className={styles.detailBlock} aria-label="Что нужно устранить">
                <h3 className={[styles.detailTitle, typeClass('label-strong')].join(' ')}>Что нужно устранить</h3>
                <ReasonList reasons={row.reasons} packageId={row.packageId} actions={actions} />
              </section>
            ) : null}
            {row.aosrs.length > 0 ? <AosrRegister row={row} actions={actions} /> : null}
            {row.externalNoAosr ? <p className={[styles.secondary, typeClass('meta')].join(' ')}>{EXTERNAL_NO_AOSR_TEXT}. {row.schemesText}.</p> : null}
            </div>
          </td>
          {/* the shared stacked layout hides a row's last cell; the detail lives in the cell before it */}
          <td role="cell" data-label="" aria-hidden="true" />
        </tr>
      ) : null}
    </>
  );
}

function ArchivedList({ rows, actions }: { rows: RegistryArchivedRowViewModel[]; actions?: RegistryActionHandlers }) {
  return (
    <section className={styles.archive} aria-label="Архивные пакеты">
      <h2 className={[styles.archiveTitle, typeClass('heading-card')].join(' ')}>Архивные пакеты · {rows.length}</h2>
      <p className={[styles.secondary, typeClass('meta')].join(' ')}>Только для просмотра. Архивные пакеты не входят в готовность, нагрузку и счётчики.</p>
      {rows.length === 0 ? <p className={typeClass('body')}>Архивных пакетов нет.</p> : null}
      <ul className={styles.archiveList}>
        {rows.map((row) => (
          <li key={row.packageId} className={styles.archiveItem}>
            <div className={styles.primary}>
              {actions ? (
                <button type="button" className={[styles.activator, typeClass('body-strong')].join(' ')} onClick={() => actions.onOpenPackage(row.packageId)}>
                  {row.workName}
                </button>
              ) : (
                <span className={typeClass('body-strong')}>{row.workName}</span>
              )}
              <span className={typeClass('body')}>
                {row.scopeText}
                {row.quantityText ? ` · ${row.quantityText}` : ''} · {row.responsible}
              </span>
              <span className={[styles.secondary, typeClass('meta')].join(' ')}>{row.archivedText} · {row.reasonText}</span>
            </div>
            <StatusBadge variant="Neutral">{row.status.label}</StatusBadge>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Filters({ viewModel, query, onQueryChange, busy }: { viewModel: RegistryViewModel; query: RegistryQuery; onQueryChange: (next: RegistryQuery) => void; busy: boolean }) {
  // The search box is typed into freely and committed to the URL after a short pause, so each keystroke is not a request.
  const [text, setText] = useState(query.q ?? '');
  const [committed, setCommitted] = useState(query.q ?? '');
  if ((query.q ?? '') !== committed) {
    // the URL changed from outside (reset, back button): follow it
    setCommitted(query.q ?? '');
    setText(query.q ?? '');
  }
  const commit = (value: string) => {
    setCommitted(value.trim());
    onQueryChange({ ...query, q: value.trim() || undefined });
  };
  // each keystroke is not a request: commit once typing pauses
  useEffect(() => {
    if (text.trim() === committed) return;
    const timer = setTimeout(() => commit(text), 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  const set = (patch: Partial<RegistryQuery>) => onQueryChange({ ...query, ...patch });
  return (
    <form className={styles.filters} role="search" aria-label="Фильтры реестра" aria-busy={busy} onSubmit={(event) => { event.preventDefault(); commit(text); }}>
      <label className={styles.field}>
        <span className={[styles.fieldLabel, typeClass('label')].join(' ')}>Поиск: работа, участок, АОСР</span>
        <input
          type="search"
          className={styles.control}
          value={text}
          placeholder="Например, штукатурка или 1 этаж"
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      <label className={styles.field}>
        <span className={[styles.fieldLabel, typeClass('label')].join(' ')}>Ответственный ПТО</span>
        <select className={styles.control} value={query.responsibleUserId ?? ''} onChange={(event) => set({ responsibleUserId: event.target.value || undefined })}>
          <option value="">Все</option>
          {viewModel.responsibleOptions.map((option) => (
            <option key={option.id} value={option.id}>{option.name}</option>
          ))}
        </select>
      </label>
      <label className={styles.field}>
        <span className={[styles.fieldLabel, typeClass('label')].join(' ')}>Статус пакета</span>
        <select className={styles.control} value={query.status ?? ''} onChange={(event) => set({ status: event.target.value || undefined })}>
          <option value="">Все</option>
          {STATUS_FILTER_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
      <label className={styles.field}>
        <span className={[styles.fieldLabel, typeClass('label')].join(' ')}>Готовность</span>
        <select className={styles.control} value={query.ready === undefined ? '' : String(query.ready)} onChange={(event) => set({ ready: event.target.value === '' ? undefined : event.target.value === 'true' })}>
          <option value="">Все</option>
          <option value="true">Готово</option>
          <option value="false">Не готово</option>
        </select>
      </label>
      <label className={styles.field}>
        <span className={[styles.fieldLabel, typeClass('label')].join(' ')}>Способ АОСР</span>
        <select className={styles.control} value={query.method ?? ''} onChange={(event) => set({ method: (event.target.value || undefined) as RegistryQuery['method'] })}>
          <option value="">Все</option>
          {METHOD_FILTER_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
      <div className={styles.filterTail}>
        <label className={styles.checkbox}>
          <input type="checkbox" checked={!!query.archived} onChange={(event) => set({ archived: event.target.checked || undefined })} />
          <span className={typeClass('body')}>Показать архивные{viewModel.archivedCount > 0 ? ` (${viewModel.archivedCount})` : ''}</span>
        </label>
        {isFiltered(query) ? (
          <button type="button" className={styles.secondaryButton} onClick={() => onQueryChange({ archived: query.archived })}>
            Сбросить фильтры
          </button>
        ) : null}
      </div>
    </form>
  );
}

export function DocumentationRegistry({ state, query, onQueryChange, onRetry, sidebar, topbar, objectName, onNavigateHome, onOpenObject, actions, className }: DocumentationRegistryProps) {
  const trail = [
    { label: 'Портфель', onSelect: onNavigateHome },
    ...(objectName ? [{ label: objectName, onSelect: onOpenObject }] : []),
    { label: REGISTRY_TITLE },
  ];

  return (
    <AppShell sidebar={sidebar} topbar={topbar} className={className}>
      <Breadcrumb items={trail} />
      <PageHeader
        eyebrow="ИСПОЛНИТЕЛЬНАЯ ДОКУМЕНТАЦИЯ"
        title={REGISTRY_TITLE}
        description={state.status === 'Ready' ? state.viewModel.description : (objectName ?? '')}
      />

      {state.status === 'Loading' ? (
        <DataTable columns={columns} title="Пакеты ИД объекта" state="Loading" />
      ) : state.status === 'Error' ? (
        <DataTable columns={columns} title="Пакеты ИД объекта" state="Error" errorLabel={`Не удалось загрузить реестр ИД: ${state.message}`} onRetry={onRetry} />
      ) : (
        <div aria-busy={state.refreshing}>
          {state.viewModel.assignedOnly ? <p className={[styles.notice, typeClass('body')].join(' ')}>{REGISTRY_ASSIGNED_ONLY_TEXT}</p> : null}

          <ul className={styles.summary} aria-label="Сводка по объекту">
            {state.viewModel.summary.map((tile) => (
              <li key={tile.key} className={styles.tile}>
                <span className={[styles.secondary, typeClass('label')].join(' ')}>{tile.label}</span>
                <span className={typeClass('metric-md')}>{tile.value}</span>
                <span className={[styles.secondary, typeClass('meta')].join(' ')}>{tile.note}</span>
              </li>
            ))}
          </ul>

          <Filters viewModel={state.viewModel} query={query} onQueryChange={onQueryChange} busy={state.refreshing} />

          <DataTable
            columns={columns}
            title="Пакеты ИД объекта"
            context={state.viewModel.filtered ? `${state.viewModel.matchedCount} из ${packagesCountText(state.viewModel.totalCount)}` : packagesCountText(state.viewModel.totalCount)}
            stackOnNarrow
            state={state.viewModel.rows.length === 0 ? 'Empty' : 'Default'}
            emptyLabel={state.viewModel.totalCount === 0 ? REGISTRY_EMPTY_TEXT : REGISTRY_NO_MATCH_TEXT}
          >
            {state.viewModel.rows.map((row) => (
              <PackageRows key={row.packageId} row={row} actions={actions} />
            ))}
          </DataTable>

          {state.viewModel.archivedRows ? <ArchivedList rows={state.viewModel.archivedRows} actions={actions} /> : null}
        </div>
      )}
    </AppShell>
  );
}
