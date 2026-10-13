import { Fragment } from 'react';
import { DataTable, ProgressBar, StatusBadge, typeClass, type DataTableColumn } from '../../design-system';
import type { DelayReasonCategory } from '../../types/schedule';
import type { GprRowViewModel } from '../../view-models/schedule';
import type { GprActions } from './actions';
import { ReasonPanel } from './ReasonPanel';
import rowStyles from './GprRow.module.css';

/**
 * The schedule table of ONE object: Work / zone / executor / planned quantity / planned start and finish / actual progress / state / delay.
 * Built on the design system's `DataTable` (frame, title, states) with the schedule's own rows.
 *
 * Plan and fact are separate figures: the percentage done sits beside «План на дату», never as a difference between them; the Internal СК
 * accepted quantity is its own captioned line, never merged into the fact. A delay is never a colour alone — it always carries
 * «Есть отставание» and a number of days. Nothing here derives a state from a date or a quantity: it presents what the backend decided.
 */
export const scheduleColumns: DataTableColumn[] = [
  { key: 'work', header: 'Работа / участок', width: 'fill' },
  { key: 'executor', header: 'Исполнитель', width: 140 },
  { key: 'plan', header: 'План, объём', width: 108, align: 'end' },
  // A date is "дд.мм.гггг" (≈ 80px at body size) inside 12px + 12px of cell padding: 100px left 76px of text and broke it mid-date.
  // The fixed tracks total 900px, so at the 1440px desktop width the table fits its card without a scroll of its own.
  { key: 'start', header: 'Начало', width: 112 },
  { key: 'finish', header: 'Окончание', width: 112 },
  { key: 'fact', header: 'Факт', width: 140 },
  { key: 'state', header: 'Состояние', width: 160 },
  { key: 'delay', header: 'Отставание', width: 104 },
  { key: 'chevron', header: '', width: 24 },
];

export interface ScheduleTableProps {
  rows: GprRowViewModel[];
  categories: DelayReasonCategory[];
  asOf: string;
  actions?: GprActions;
  onSelectWork: (workId: string) => void;
}

function ScheduleRow({ row, onSelectWork }: { row: GprRowViewModel; onSelectWork: (workId: string) => void }) {
  const cell = [rowStyles.cell, typeClass('body')].join(' ');
  const activate = () => onSelectWork(row.workId);
  return (
    <tr
      role="row"
      data-tone={row.needsAttention ? 'attention' : undefined}
      className={[rowStyles.row, rowStyles.interactive, row.needsAttention ? rowStyles.attention : ''].filter(Boolean).join(' ')}
      onClick={activate}
    >
      <td role="cell" data-label="Работа / участок" className={rowStyles.cell}>
        <div className={rowStyles.identity}>
          <span>
            <span className={[rowStyles.sequence, typeClass('meta')].join(' ')}>{row.sequence}</span>
            <button
              type="button"
              className={[rowStyles.activator, rowStyles.name, typeClass('body-strong')].join(' ')}
              onClick={(event) => {
                event.stopPropagation();
                activate();
              }}
            >
              {row.name}
            </button>
          </span>
          {row.zone ? <span className={[rowStyles.meta, typeClass('meta')].join(' ')}>{row.zone}</span> : null}
          {row.followsNote ? <span className={[rowStyles.meta, typeClass('meta')].join(' ')}>{row.followsNote}</span> : null}
          {row.shift ? <span className={[rowStyles.meta, typeClass('meta')].join(' ')}>{row.shift}</span> : null}
          {row.splitNote ? <span className={[rowStyles.meta, typeClass('meta')].join(' ')}>{row.splitNote}</span> : null}
        </div>
      </td>
      <td role="cell" data-label="Исполнитель" className={cell}>
        {row.executor}
      </td>
      <td role="cell" data-label="План, объём" className={[cell, rowStyles.alignEnd].join(' ')}>
        {row.plan}
      </td>
      <td role="cell" data-label="Начало" className={[cell, rowStyles.nowrap].join(' ')}>
        {row.plannedStart}
      </td>
      <td role="cell" data-label="Окончание" className={[cell, rowStyles.nowrap].join(' ')}>
        {row.plannedFinish}
      </td>
      <td role="cell" data-label="Факт" className={cell}>
        <div className={rowStyles.progress}>
          <span className={typeClass('metric-md')}>{row.progress.formatted}</span>
          <ProgressBar value={row.progress.value} label={`${row.name}${row.zone ? ', ' + row.zone : ''}: выполнение`} decorative />
          <span className={[rowStyles.meta, typeClass('meta')].join(' ')}>Факт РП: {row.fact}</span>
          <span className={[rowStyles.meta, typeClass('meta')].join(' ')}>План на дату: {row.planOnDate}</span>
          {row.scAccepted ? <span className={[rowStyles.meta, typeClass('meta')].join(' ')}>Принято СК: {row.scAccepted}</span> : null}
        </div>
      </td>
      <td role="cell" data-label="Состояние" className={cell}>
        <div className={rowStyles.stateStack}>
          <StatusBadge variant={row.state.variant}>{row.state.label}</StatusBadge>
          {row.delayNote ? <span className={[rowStyles.meta, typeClass('meta')].join(' ')}>{row.delayNote}</span> : null}
          {row.openReasonCount > 0 ? <span className={[rowStyles.meta, typeClass('meta')].join(' ')}>Причин указано: {row.openReasonCount}</span> : null}
        </div>
      </td>
      <td role="cell" data-label="Отставание" className={[cell, rowStyles.nowrap].join(' ')}>
        {row.delay ?? '—'}
      </td>
      <td role="cell" data-label="" className={[rowStyles.cell, rowStyles.chevron].join(' ')}>
        <span aria-hidden="true">›</span>
      </td>
    </tr>
  );
}

export function ScheduleTable({ rows, categories, asOf, actions, onSelectWork }: ScheduleTableProps) {
  return (
    <DataTable
      columns={scheduleColumns}
      title="Позиции графика"
      context={`${rows.length} позиций · расчёт на ${asOf}`}
      stackOnNarrow
      state={rows.length === 0 ? 'Empty' : 'Default'}
      emptyLabel="В утверждённом графике нет позиций"
    >
      {rows.map((row) => (
        <Fragment key={row.entryId}>
          <ScheduleRow row={row} onSelectWork={onSelectWork} />
          {row.reasons.length > 0 || row.canRecordReason ? (
            <tr role="row" data-tone={row.needsAttention ? 'attention' : undefined} className={rowStyles.detailRow}>
              <td role="cell" data-label="" colSpan={scheduleColumns.length - 1} className={rowStyles.detailCell}>
                <ReasonPanel row={row} categories={categories} actions={actions} />
              </td>
              <td role="cell" data-label="" aria-hidden="true" />
            </tr>
          ) : null}
        </Fragment>
      ))}
    </DataTable>
  );
}
