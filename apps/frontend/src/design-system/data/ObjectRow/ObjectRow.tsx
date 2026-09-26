import { typeClass } from '../../tokens';
import { ProgressBar } from '../ProgressBar';
import { StatusBadge } from '../StatusBadge';
import type { DataTableColumn } from '../DataTable';
import type { RowStatus, RowTone } from '../DataTable';
import rowStyles from '../DataTable/TableRow.module.css';

/**
 * Cards / ObjectCard — the portfolio row.
 *
 * Named a row rather than a card because that is its form. The specification
 * calls it a card and warns in the same breath that the name must not turn it
 * into a tile (D-11); keeping the React name honest settles the question once.
 *
 * It renders what it is handed and computes nothing. The percentage arrives as a
 * finished string, so whether a missing figure reads as "—" or as a real "0%" was
 * decided upstream, where the difference between "not provided" and "measured
 * zero" is actually known.
 */

export interface ObjectRowProps {
  /** Object name. Also the accessible name of the row's control. */
  name: string;
  /** Code and address, e.g. "CC-024 · ул. Строителей, 12". */
  meta?: string;
  /** Person responsible, e.g. "РП · Сергей Волков". */
  responsible?: string;
  /**
   * Physical readiness of construction work, already formatted — "62%", or "—"
   * when it is not known. This column is readiness; it is not financial closing
   * and is never substituted by it.
   */
  smr: string;
  /** Value for the bar, or `null` when there is no measurement. */
  smrProgress: number | null;
  status: RowStatus;
  tone?: RowTone;
  interactive?: boolean;
  onActivate?: () => void;
  className?: string;
}

/**
 * The column set. Declared beside the row so the two cannot drift, and passed to
 * `DataTable`, which turns it into the single `<colgroup>` every row inherits.
 *
 * `СМР` and `График` are fixed tracks rather than content-sized: the
 * specification calls them hug, but a fixed table needs a number, and a fixed
 * number is what stops a long name in the first column from moving the figures.
 */
export const objectColumns: DataTableColumn[] = [
  { key: 'object', header: 'Объект / РП', width: 'fill' },
  { key: 'smr', header: 'СМР', width: 120, align: 'end' },
  { key: 'schedule', header: 'График', width: 165 },
  { key: 'chevron', header: '', width: 24 },
];

export function ObjectRow({
  name,
  meta,
  responsible,
  smr,
  smrProgress,
  status,
  tone = 'Neutral',
  interactive = false,
  onActivate,
  className,
}: ObjectRowProps) {
  const rowClasses = [
    rowStyles.row,
    rowStyles.rowTall,
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
                // The row carries the same click as a convenience; without this
                // the activation would fire twice for one press.
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

          {meta ? (
            <span className={[rowStyles.meta, typeClass('meta')].join(' ')}>
              {meta}
            </span>
          ) : null}

          {responsible ? (
            <span className={[rowStyles.meta, typeClass('meta')].join(' ')}>
              {responsible}
            </span>
          ) : null}
        </div>
      </td>

      <td className={[rowStyles.cell, rowStyles.alignEnd].join(' ')}>
        <div className={rowStyles.smr}>
          <span className={typeClass('metric-md')}>{smr}</span>
          {/*
            With no measurement the bar is left out entirely rather than drawn
            empty. The rule it serves — never show a bare empty track, because it
            reads as a confident zero — is already satisfied by the figure above
            it, and a "Нет данных" caption under a "—" would say the same thing
            twice in a row that has 120px to work with.
          */}
          {smrProgress === null ? null : (
            <ProgressBar value={smrProgress} label={name} decorative />
          )}
        </div>
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
