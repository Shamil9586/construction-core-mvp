import type { ReactNode } from 'react';
import { AppShell, DataTable, PageHeader, StatusBadge, typeClass } from '../../design-system';
import type { DataTableColumn } from '../../design-system';
import type { P01PackageRow, P01ViewModel } from '../../view-models/p01';
import { P01_NO_PACKAGES_FOR_OBJECT_LABEL, P01_NO_PACKAGES_LABEL } from '../../view-models/p01';
import styles from './P01.module.css';

/**
 * P01 — PTO Workspace.
 *
 * F8.2 MVP: a package list, filterable by object, showing status, the
 * responsible PTO employee and how many Quantity Portions each package
 * currently covers. Reuses `AppShell`/`PageHeader`/`DataTable`/`StatusBadge`
 * exactly as C01/O01/W01 do; the object filter is a plain `<select>` styled
 * with the same `--cc-*` tokens `ExecutionSection.tsx` (F8.1) already uses
 * for its own local form controls — the design system has no select control
 * to build this from, the same reason that screen's controls are local too.
 *
 * Read-only by design: F8.2's Foundation scope for this screen is display
 * only (package existence, status, covered portions, responsible PTO) —
 * creating or editing a package, linking a portion, or changing status are
 * PTO actions the Foundation contract does not ask P01's own UI to expose
 * yet; the backend routes exist (documentation.controller.ts) for a later
 * pass to wire up.
 */

const documentationPackageColumns: DataTableColumn[] = [
  { key: 'work', header: 'Работа', width: 'fill' },
  { key: 'object', header: 'Объект', width: 240 },
  { key: 'status', header: 'Статус', width: 220 },
  { key: 'responsible', header: 'Ответственный ПТО', width: 200 },
  { key: 'portions', header: 'Участки', width: 100, align: 'end' },
];

function PackageRow({ row }: { row: P01PackageRow }) {
  return (
    <tr className={styles.row}>
      <td className={styles.cell}>
        <span className={typeClass('body-strong')}>{row.workName}</span>
      </td>
      <td className={styles.cell}>
        <span className={[typeClass('body'), styles.secondary].join(' ')}>{row.objectName}</span>
      </td>
      <td className={styles.cell}>
        <StatusBadge variant={row.status.variant}>{row.status.label}</StatusBadge>
      </td>
      <td className={styles.cell}>
        <span className={typeClass('body')}>{row.responsible}</span>
      </td>
      <td className={[styles.cell, styles.alignEnd].join(' ')}>
        <span className={typeClass('body')}>{row.coveredPortionCount || '—'}</span>
      </td>
    </tr>
  );
}

export interface P01Props {
  viewModel: P01ViewModel;
  sidebar: ReactNode;
  topbar?: ReactNode;
  /** `null` (the default control state) means "all objects" — no filter applied. */
  selectedObjectId: string | null;
  onSelectObjectFilter: (objectId: string | null) => void;
  className?: string;
}

export function PtoWorkspace({
  viewModel,
  sidebar,
  topbar,
  selectedObjectId,
  onSelectObjectFilter,
  className,
}: P01Props) {
  const rows =
    selectedObjectId === null
      ? viewModel.packages
      : viewModel.packages.filter((row) => row.objectId === selectedObjectId);

  const emptyLabel = selectedObjectId === null ? P01_NO_PACKAGES_LABEL : P01_NO_PACKAGES_FOR_OBJECT_LABEL;

  return (
    <AppShell sidebar={sidebar} topbar={topbar} className={className}>
      <PageHeader
        eyebrow="ПТО"
        title="Исполнительная документация"
        description="Пакеты документации по объектам: статус, покрытые участки, ответственный ПТО."
      />

      <div className={styles.filterRow}>
        <label className={[styles.filterLabel, typeClass('label')].join(' ')} htmlFor="p01-object-filter">
          Объект
        </label>
        <select
          id="p01-object-filter"
          className={styles.filterSelect}
          value={selectedObjectId ?? ''}
          onChange={(event) => onSelectObjectFilter(event.target.value === '' ? null : event.target.value)}
        >
          <option value="">Все объекты</option>
          {viewModel.objectOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
      </div>

      <DataTable
        columns={documentationPackageColumns}
        title="Пакеты исполнительной документации"
        context={`${rows.length} из ${viewModel.packages.length} пакетов`}
        state={rows.length === 0 ? 'Empty' : 'Default'}
        emptyLabel={emptyLabel}
      >
        {rows.map((row) => (
          <PackageRow key={row.id} row={row} />
        ))}
      </DataTable>
    </AppShell>
  );
}
