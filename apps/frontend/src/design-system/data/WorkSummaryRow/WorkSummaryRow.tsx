import { typeClass } from '../../tokens';
import { StatusBadge } from '../StatusBadge';
import type { DataTableColumn } from '../DataTable';
import type { RowStatus, RowTone } from '../DataTable';
import rowStyles from '../DataTable/TableRow.module.css';

/**
 * Cards / WorkSummaryCard — the production row.
 *
 * Plan and fact are two columns, two props and two strings. There is no third
 * column holding their difference and no prop that would let one be computed,
 * which is the product rule made structural rather than merely documented
 * (Design Rules §7). A shortfall is read by looking across at the status, not by
 * subtracting.
 *
 * Confirmed volume is absent for a different reason: the domain model has no way
 * to express it, and a column standing ready for a figure that cannot exist would
 * suggest otherwise.
 *
 * The СМР percentage is readiness of execution. It is not acceptance, and a row
 * showing 100% is not saying the work was accepted — that belongs to a contour
 * this component knows nothing about.
 */

export interface WorkSummaryRowProps {
  /** Work name. Also the accessible name of the row's control. */
  name: string;
  /** Who is carrying it out, as a display string. */
  performer?: string;
  /** Planned volume with its unit, already formatted — "1 000 м²", or "—". */
  plan: string;
  /**
   * Volume actually performed, already formatted. "0 м²" is a measured zero and
   * "—" is nothing reported; the caller has decided which, because only the
   * caller knows.
   */
  fact: string;
  /** Readiness of execution, already formatted — "50%", or "—". */
  smr: string;
  /** The row's «График» cell: compliance with the deadlines, decided by the caller from the schedule. */
  status: RowStatus;
  /**
   * GPR-UX-D01 — the work's actual physical state in its own «Выполнение» cell, apart from the schedule cell, with an optional operational
   * blocker beside it. Present only with `workSummaryExecutionColumns`; without it the row is the original six-column row.
   */
  execution?: { state: RowStatus; blocker?: RowStatus | null };
  tone?: RowTone;
  interactive?: boolean;
  onActivate?: () => void;
  className?: string;
}

/** The column set, declared beside the row it belongs to. */
export const workSummaryColumns: DataTableColumn[] = [
  { key: 'work', header: 'Работа / Исполнитель', width: 'fill' },
  { key: 'plan', header: 'План', width: 120, align: 'end' },
  { key: 'fact', header: 'Факт', width: 120, align: 'end' },
  { key: 'smr', header: 'СМР', width: 100, align: 'end' },
  { key: 'schedule', header: 'График', width: 180 },
  { key: 'chevron', header: '', width: 24 },
];

/** The column set of a row that carries `execution`: the original columns with «Выполнение» before «График». */
export const workSummaryExecutionColumns: DataTableColumn[] = [
  ...workSummaryColumns.slice(0, 4),
  { key: 'execution', header: 'Выполнение', width: 160 },
  ...workSummaryColumns.slice(4),
];

export function WorkSummaryRow({
  name,
  performer,
  plan,
  fact,
  smr,
  status,
  execution,
  tone = 'Neutral',
  interactive = false,
  onActivate,
  className,
}: WorkSummaryRowProps) {
  const rowClasses = [
    rowStyles.row,
    tone === 'Attention' ? rowStyles.attention : '',
    interactive ? rowStyles.interactive : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const activate = () => {
    if (interactive) onActivate?.();
  };

  return (
    <tr role="row" data-tone={tone === 'Attention' ? 'attention' : undefined} className={rowClasses} onClick={interactive ? activate : undefined}>
      <td role="cell" data-label="Работа / Исполнитель" className={rowStyles.cell}>
        <div className={rowStyles.primary}>
          {interactive ? (
            <button
              type="button"
              className={[
                rowStyles.activator,
                rowStyles.name,
                typeClass('body-strong'),
              ].join(' ')}
              onClick={(event) => {
                event.stopPropagation();
                activate();
              }}
            >
              {name}
            </button>
          ) : (
            <span className={[rowStyles.name, typeClass('body-strong')].join(' ')}>
              {name}
            </span>
          )}

          {performer ? (
            <span className={[rowStyles.meta, typeClass('meta')].join(' ')}>
              {performer}
            </span>
          ) : null}
        </div>
      </td>

      <td role="cell" data-label="План" className={[rowStyles.cell, rowStyles.alignEnd, typeClass('body')].join(' ')}>
        {plan}
      </td>

      <td role="cell" data-label="Факт" className={[rowStyles.cell, rowStyles.alignEnd, typeClass('body')].join(' ')}>
        {fact}
      </td>

      <td role="cell" data-label="СМР"
        className={[rowStyles.cell, rowStyles.alignEnd, typeClass('metric-md')].join(' ')}
      >
        {smr}
      </td>

      {execution ? (
        <td role="cell" data-label="Выполнение" className={rowStyles.cell}>
          <div className={rowStyles.badges}>
            <StatusBadge variant={execution.state.variant}>{execution.state.label}</StatusBadge>
            {execution.blocker ? (
              <StatusBadge variant={execution.blocker.variant}>{execution.blocker.label}</StatusBadge>
            ) : null}
          </div>
        </td>
      ) : null}

      <td role="cell" data-label="График" className={rowStyles.cell}>
        <StatusBadge variant={status.variant}>{status.label}</StatusBadge>
      </td>

      {/*
        The cell stays in the accessibility tree so the row keeps the same cell
        count as the table has columns — hiding a whole <td> makes "column 4 of 4"
        navigation disagree with the header row. Only the glyph is decorative.
      */}
      <td role="cell" data-label="" className={[rowStyles.cell, rowStyles.chevron].join(' ')}>
        {interactive ? <span aria-hidden="true">›</span> : null}
      </td>
    </tr>
  );
}
