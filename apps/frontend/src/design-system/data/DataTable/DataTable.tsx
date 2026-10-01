import type { ReactNode } from 'react';
import { typeClass } from '../../tokens';
import { Button } from '../../controls/Button';
import styles from './DataTable.module.css';

/**
 * Data / Table
 *
 * A titled surface holding a stack of rows. It lays out columns and renders the
 * four states; it does not fetch, sort, filter, search or paginate, and it holds
 * no opinion about what a row means. Those are screen concerns, and several of
 * them are not in the product at all.
 *
 * Built on a real `<table>` so the column headers, the row grouping and the
 * cell-to-header association come from the platform rather than from ARIA
 * patched on afterwards. `table-layout: fixed` with a `<colgroup>` is what makes
 * "widths are set once per table" true in practice: every row inherits the same
 * track, so a long name wraps in its own column instead of shoving the numbers
 * sideways.
 *
 * F11.2 — that guarantee only held while the table's own width had room for
 * every column's declared track. Below that, `table-layout: fixed` clamped the
 * one flexible ('fill') column toward zero rather than shrinking the fixed
 * ones, which is what produced both failure shapes F11.0 found: an
 * unwrapped single-word header (`Работа`, `Объект`) painting past its own
 * cell into the next one once its column had no room left, and — for a row
 * whose cell *does* wrap (`ObjectRow`, via `TableRow.module.css`) — a column
 * squeezed to nothing forcing every word onto its own line. `.viewport`
 * below is the fix: a scroll container that belongs to the table alone, with
 * `<table>` given a `min-width` computed from its own column contract
 * (fixed tracks unchanged, `MIN_FILL_COLUMN_WIDTH` as the fill column's
 * floor) so no column, fixed or flexible, is ever asked to render narrower
 * than its own budget — the table scrolls instead, and nothing about
 * `<main>` or the page has to.
 */

export interface DataTableColumn {
  key: string;
  /** Column heading. Empty for the chevron column, which has nothing to announce. */
  header: string;
  /** `'fill'` takes the remaining width; a number is a fixed pixel track. */
  width: 'fill' | number;
  align?: 'start' | 'end';
}

/**
 * The floor the one 'fill' column never renders narrower than. It is sized so
 * an ordinary construction word stays whole and the column wraps only between
 * words, never inside one (F11.2-01).
 *
 * Derived from the widest consumer's real rendering: P01/SDO render the
 * primary name at 14px semibold inside 16px + 16px of cell padding, so 192px
 * leaves 160px of text — enough for every ordinary term measured up to 19
 * letters (электрооборудования 157px, водонепроницаемого 153px,
 * металлоконструкций 150px; the fixture's железобетонного is 124px). C01/O01
 * set names at 14px regular in 12px + 12px padding, which leaves 168px.
 * `overflow-wrap: break-word` on the cells stays only as the last resort for
 * a token longer than that.
 */
const MIN_FILL_COLUMN_WIDTH = 192;

export type DataTableState = 'Default' | 'Loading' | 'Empty' | 'Error';

export interface DataTableProps {
  columns: DataTableColumn[];
  /** Visible title, and the table's accessible name. */
  title: string;
  /** Category, type and coverage, e.g. "Отделочные работы · 3 из 12 работ объекта". */
  context?: string;
  state?: DataTableState;
  /** Shown when there is nothing to list. Never a zero. */
  emptyLabel?: string;
  errorLabel?: string;
  retryLabel?: string;
  onRetry?: () => void;
  /** How many placeholder rows to show while loading. */
  skeletonRows?: number;
  /** Rows — `ObjectRow`, `WorkSummaryRow`, or another row of the same column set. */
  children?: ReactNode;
  className?: string;
  /**
   * Below the narrow breakpoint, lay each row out as a stacked, labelled card
   * instead of scrolling a wide table sideways — so the figures that sit past
   * the first column are not hidden off-screen. Presentation only: the same
   * cells, the same order, the same values. Rows that support it carry a
   * `data-label` per cell; header text stays available to assistive technology.
   */
  stackOnNarrow?: boolean;
}

export function DataTable({
  columns,
  title,
  context,
  state = 'Default',
  emptyLabel = 'Записей нет',
  errorLabel = 'Не удалось загрузить данные',
  retryLabel = 'Повторить',
  onRetry,
  skeletonRows = 3,
  children,
  className,
  stackOnNarrow = false,
}: DataTableProps) {
  const classes = [styles.root, stackOnNarrow ? styles.stackable : '', className]
    .filter(Boolean)
    .join(' ');

  const fixedColumnWidth = columns.reduce(
    (total, column) => total + (column.width === 'fill' ? 0 : column.width),
    0,
  );
  const tableMinWidth = fixedColumnWidth + MIN_FILL_COLUMN_WIDTH;

  return (
    <div className={classes}>
      <div
        className={styles.viewport}
        role="region"
        aria-label={title}
        tabIndex={0}
      >
        <table
          role="table"
          className={styles.table}
          style={{ minWidth: `${tableMinWidth}px` }}
        >
          <caption className={styles.caption}>
            <span className={[styles.title, typeClass('heading-card')].join(' ')}>
              {title}
            </span>
            {context ? (
              <span className={[styles.context, typeClass('label')].join(' ')}>
                {context}
              </span>
            ) : null}
          </caption>

          <colgroup>
            {columns.map((column) => (
              <col
                key={column.key}
                style={
                  column.width === 'fill'
                    ? undefined
                    : { width: `${column.width}px` }
                }
              />
            ))}
          </colgroup>

          <thead role="rowgroup">
            <tr role="row">
              {columns.map((column) => (
                <th
                  key={column.key}
                  role="columnheader"
                  scope="col"
                  className={[
                    styles.headerCell,
                    column.align === 'end' ? styles.headerAlignEnd : '',
                    typeClass('eyebrow'),
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>

          <tbody role="rowgroup">
            {state === 'Loading'
              ? Array.from({ length: skeletonRows }, (_, index) => (
                  <tr key={`skeleton-${index}`}>
                    {columns.map((column) => (
                      <td key={column.key} className={styles.skeletonCell}>
                        {column.header ? (
                          <div className={styles.skeletonBar} aria-hidden="true" />
                        ) : null}
                      </td>
                    ))}
                  </tr>
                ))
              : null}

            {state === 'Empty' ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className={[styles.stateCell, typeClass('body')].join(' ')}
                >
                  {emptyLabel}
                </td>
              </tr>
            ) : null}

            {state === 'Error' ? (
              <tr>
                <td colSpan={columns.length} className={styles.stateCell}>
                  <div className={styles.stateStack}>
                    <span className={typeClass('body')}>{errorLabel}</span>
                    {onRetry ? (
                      <Button variant="Secondary" onClick={onRetry}>
                        {retryLabel}
                      </Button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ) : null}

            {state === 'Default' ? children : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
