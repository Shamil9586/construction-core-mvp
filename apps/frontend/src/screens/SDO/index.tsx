import type { ReactNode } from 'react';
import { AppShell, DataTable, PageHeader, StatusBadge, typeClass } from '../../design-system';
import type { DataTableColumn } from '../../design-system';
import type { SdoActiveCaseRow, SdoUpcomingRow, SdoWorkspaceViewModel } from '../../view-models/sdoWorkspace';
import styles from './SDO.module.css';

/**
 * SDO workspace (`/sdo`) — SDO/ADMIN only (`canAccessSdoWorkspace`,
 * `auth/internalRoles.ts`). Two tables, mirroring P01's own shape
 * (`screens/P01/index.tsx`): "Upcoming packages" (readiness, not yet an
 * active Case) and "Active SDO Cases" (every Case that exists). Neither
 * table offers a "Передать в СДО" action — that stays PTO's own action on
 * Package Detail, which this workspace's audience (SDO) has no access to at
 * all; ADMIN, which has both, still uses Package Detail for it, not a
 * second copy of the same form here.
 */

const upcomingColumns: DataTableColumn[] = [
  { key: 'work', header: 'Работа', width: 'fill' },
  { key: 'object', header: 'Объект', width: 200 },
  { key: 'readiness', header: 'Готовность', width: 160 },
  { key: 'missing', header: 'Не хватает', width: 320 },
  { key: 'responsible', header: 'Ответственный ПТО', width: 180 },
];

const activeCaseColumns: DataTableColumn[] = [
  { key: 'work', header: 'Работа', width: 'fill' },
  { key: 'object', header: 'Объект', width: 200 },
  { key: 'status', header: 'Статус', width: 200 },
  { key: 'responsible', header: 'Ответственный СДО', width: 200 },
  { key: 'amount', header: 'Сумма закрытия', width: 180 },
  { key: 'actions', header: '', width: 140, align: 'end' },
];

function UpcomingRow({ row }: { row: SdoUpcomingRow }) {
  return (
    <tr className={styles.row}>
      <td className={styles.cell}>
        <span className={typeClass('body-strong')}>{row.workName}</span>
      </td>
      <td className={styles.cell}>
        <span className={[typeClass('body'), styles.secondary].join(' ')}>{row.objectName}</span>
      </td>
      <td className={styles.cell}>
        <StatusBadge variant={row.ready ? 'OnTrack' : 'Neutral'}>
          {row.ready ? 'Готово к передаче' : 'Не готово'}
        </StatusBadge>
      </td>
      <td className={styles.cell}>
        {row.missingReasons.length > 0 ? (
          <ul className={styles.reasonList}>
            {row.missingReasons.map((reason) => (
              <li key={reason} className={typeClass('body')}>
                {reason}
              </li>
            ))}
          </ul>
        ) : (
          <span className={[typeClass('body'), styles.secondary].join(' ')}>—</span>
        )}
      </td>
      <td className={styles.cell}>
        <span className={typeClass('body')}>{row.responsible}</span>
      </td>
    </tr>
  );
}

function ActiveCaseRow({ row, onOpenCase }: { row: SdoActiveCaseRow; onOpenCase: (caseId: string) => void }) {
  return (
    <tr className={styles.row}>
      <td className={styles.cell}>
        <span className={typeClass('body-strong')}>{row.workName}</span>
      </td>
      <td className={styles.cell}>
        <span className={[typeClass('body'), styles.secondary].join(' ')}>{row.objectName}</span>
      </td>
      <td className={styles.cell}>
        <StatusBadge variant={row.hasAttention ? 'Blocked' : row.status.variant}>{row.status.label}</StatusBadge>
      </td>
      <td className={styles.cell}>
        <span className={typeClass('body')}>{row.responsible}</span>
      </td>
      <td className={styles.cell}>
        <span className={typeClass('body-strong')}>{row.totalAmount}</span>
      </td>
      <td className={[styles.cell, styles.alignEnd].join(' ')}>
        <div className={styles.rowActionStack}>
          <button type="button" className={styles.actionButton} onClick={() => onOpenCase(row.id)}>
            Открыть
          </button>
        </div>
      </td>
    </tr>
  );
}

export interface SdoWorkspaceProps {
  viewModel: SdoWorkspaceViewModel;
  sidebar: ReactNode;
  topbar?: ReactNode;
  onOpenCase: (caseId: string) => void;
  className?: string;
}

export function SdoWorkspace({ viewModel, sidebar, topbar, onOpenCase, className }: SdoWorkspaceProps) {
  return (
    <AppShell sidebar={sidebar} topbar={topbar} className={className}>
      <PageHeader
        eyebrow="СДО"
        title="Рабочая область СДО"
        description="Пакеты исполнительной документации до готовности к закрытию и открытые дела СДО."
      />

      <div className={styles.tableSpacing}>
        <DataTable
          columns={upcomingColumns}
          title="Предстоящие пакеты"
          context={`${viewModel.upcoming.length} пакетов`}
          state={viewModel.upcoming.length === 0 ? 'Empty' : 'Default'}
          emptyLabel="Нет пакетов, ожидающих передачи в СДО"
        >
          {viewModel.upcoming.map((row) => (
            <UpcomingRow key={row.documentationPackageId} row={row} />
          ))}
        </DataTable>
      </div>

      <div className={styles.tableSpacing}>
        <DataTable
          columns={activeCaseColumns}
          title="Дела СДО"
          context={`${viewModel.activeCases.length} дел`}
          state={viewModel.activeCases.length === 0 ? 'Empty' : 'Default'}
          emptyLabel="Нет открытых дел СДО"
        >
          {viewModel.activeCases.map((row) => (
            <ActiveCaseRow key={row.id} row={row} onOpenCase={onOpenCase} />
          ))}
        </DataTable>
      </div>
    </AppShell>
  );
}
