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
  status: RowStatus;
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

export function WorkSummaryRow({
  name,
  performer,
  plan,
  fact,
  smr,
  status,
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
    <tr className={rowClasses} onClick={interactive ? activate : undefined}>
      <td className={rowStyles.cell}>
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

      <td className={[rowStyles.cell, rowStyles.alignEnd, typeClass('body')].join(' ')}>
        {plan}
      </td>

      <td className={[rowStyles.cell, rowStyles.alignEnd, typeClass('body')].join(' ')}>
        {fact}
      </td>

      <td
        className={[rowStyles.cell, rowStyles.alignEnd, typeClass('metric-md')].join(' ')}
      >
        {smr}
      </td>

      <td className={rowStyles.cell}>
        <StatusBadge variant={status.variant}>{status.label}</StatusBadge>
      </td>

      {/*
        The cell stays in the accessibility tree so the row keeps the same cell
        count as the table has columns — hiding a whole <td> makes "column 4 of 4"
        navigation disagree with the header row. Only the glyph is decorative.
      */}
      <td className={[rowStyles.cell, rowStyles.chevron].join(' ')}>
        {interactive ? <span aria-hidden="true">›</span> : null}
      </td>
    </tr>
  );
}
