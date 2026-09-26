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
 */

export interface DataTableColumn {
  key: string;
  /** Column heading. Empty for the chevron column, which has nothing to announce. */
  header: string;
  /** `'fill'` takes the remaining width; a number is a fixed pixel track. */
  width: 'fill' | number;
  align?: 'start' | 'end';
}

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
}: DataTableProps) {
  const classes = [styles.root, className].filter(Boolean).join(' ');

  return (
    <div className={classes}>
      <table className={styles.table}>
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

        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
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

        <tbody>
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
  );
}
