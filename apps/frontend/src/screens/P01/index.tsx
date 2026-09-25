import { useState, type ReactNode } from 'react';
import { AppShell, DataTable, PageHeader, StatusBadge, typeClass } from '../../design-system';
import type { DataTableColumn } from '../../design-system';
import type { P01WorkRow, P01ViewModel } from '../../view-models/p01';
import { P01_NO_WORKS_FOR_OBJECT_LABEL, P01_NO_WORKS_LABEL } from '../../view-models/p01';
import type { CreatePackageResponsible } from '../../data/documentationApi';
import styles from './P01.module.css';

/**
 * P01 — PTO Operations.
 *
 * F8.2.1 redesign: one row per work, not per package (see `view-models/p01.ts`
 * for why) — the PTO Attention Queue (Decision 4) and the former F8.2
 * package list are now the same table. A work with no package at all is a
 * real row here, not simply absent.
 *
 * `actions` follows the same convention `ExecutionSection.tsx` (F8.1)
 * established: `undefined` (no session, or a role other than PTO) renders
 * every row read-only, no buttons at all — RP/SC/other oversight roles see
 * status and the reason for attention, never a control to act on it (Decision
 * 3: only PTO creates or manages packages). When present, a row with no
 * package gets "Создать пакет"; a row with one gets "Открыть" *and*
 * "Создать ещё один пакет" (Corrective F8.2.1-03 — a work may have more than
 * one Documentation Package, so the create action is never withdrawn just
 * because one already exists), both navigating to the package detail route
 * (Step 4b) — the same destination and the same `documentationApi` functions
 * W01's own create/open actions (Step 4c) call, per Decision 1's
 * one-shared-implementation requirement.
 */

const workColumns: DataTableColumn[] = [
  { key: 'work', header: 'Работа', width: 'fill' },
  { key: 'object', header: 'Объект', width: 200 },
  { key: 'status', header: 'Статус ИД', width: 200 },
  { key: 'attention', header: 'Требует внимания', width: 260 },
  { key: 'responsible', header: 'Ответственный ПТО', width: 180 },
  { key: 'actions', header: '', width: 160, align: 'end' },
];

export interface P01ActionHandlers {
  /** Creates a package for a work, then navigates to its detail route. */
  onCreatePackage: (objectWorkId: string, responsibleUserId: string) => Promise<void>;
  onOpenPackage: (packageId: string) => void;
  /** F8.2.1-04 (Corrective Patch) — how the create action resolves its responsible PTO user: PTO defaults to itself, ADMIN must pick one. */
  responsible: CreatePackageResponsible;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Не удалось выполнить действие';
}

function CreatePackageButton({
  objectWorkId,
  onCreate,
  responsible,
  label = 'Создать пакет',
}: {
  objectWorkId: string;
  onCreate: (objectWorkId: string, responsibleUserId: string) => Promise<void>;
  responsible: CreatePackageResponsible;
  /** Corrective F8.2.1-03 — "Создать ещё один пакет" when the work already has one. */
  label?: string;
}) {
  const [selected, setSelected] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate(responsibleUserId: string) {
    setPending(true);
    setError(null);
    try {
      await onCreate(objectWorkId, responsibleUserId);
    } catch (submitError) {
      setError(errorMessage(submitError));
      setPending(false);
    }
  }

  // F8.2.1-04 — ADMIN is not itself a PTO user (the backend requires an
  // active PTO responsible), so it picks one here rather than the button
  // defaulting to `session.user.id` the way it safely can for PTO.
  if (responsible.mode === 'pick') {
    if (responsible.ptoUsers.length === 0) {
      return (
        <div className={styles.rowAction}>
          <span className={styles.errorText}>Нет активных сотрудников ПТО</span>
        </div>
      );
    }
    return (
      <div className={styles.rowAction}>
        <select
          className={styles.pickerSelect}
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
          disabled={pending}
          aria-label="Ответственный сотрудник ПТО"
        >
          <option value="">Выберите сотрудника ПТО…</option>
          {responsible.ptoUsers.map((user) => (
            <option key={user.id} value={user.id}>
              {user.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={styles.actionButton}
          onClick={() => handleCreate(selected)}
          disabled={pending || !selected}
        >
          {pending ? 'Создание…' : label}
        </button>
        {error ? <span className={styles.errorText}>{error}</span> : null}
      </div>
    );
  }

  return (
    <div className={styles.rowAction}>
      <button
        type="button"
        className={styles.actionButton}
        onClick={() => handleCreate(responsible.userId)}
        disabled={pending}
      >
        {pending ? 'Создание…' : label}
      </button>
      {error ? <span className={styles.errorText}>{error}</span> : null}
    </div>
  );
}

function WorkRow({ row, actions }: { row: P01WorkRow; actions?: P01ActionHandlers }) {
  return (
    <tr className={styles.row}>
      <td className={styles.cell}>
        <span className={typeClass('body-strong')}>{row.workName}</span>
      </td>
      <td className={styles.cell}>
        <span className={[typeClass('body'), styles.secondary].join(' ')}>{row.objectName}</span>
      </td>
      <td className={styles.cell}>
        {row.package ? (
          <StatusBadge variant={row.package.status.variant}>{row.package.status.label}</StatusBadge>
        ) : (
          <span className={[typeClass('body'), styles.secondary].join(' ')}>Пакет не создан</span>
        )}
      </td>
      <td className={styles.cell}>
        {row.attentionLevel ? (
          <span className={typeClass('body')}>
            {row.attentionLevel === 'RED' ? '🔴' : '🟡'} {row.attentionReason}
          </span>
        ) : (
          <span className={[typeClass('body'), styles.secondary].join(' ')}>—</span>
        )}
      </td>
      <td className={styles.cell}>
        <span className={typeClass('body')}>{row.package?.responsible ?? '—'}</span>
      </td>
      <td className={[styles.cell, styles.alignEnd].join(' ')}>
        {actions ? (
          <div className={styles.rowActionStack}>
            {row.package ? (
              <button
                type="button"
                className={styles.actionButton}
                onClick={() => actions.onOpenPackage(row.package!.id)}
              >
                Открыть
              </button>
            ) : null}
            <CreatePackageButton
              objectWorkId={row.objectWorkId}
              onCreate={actions.onCreatePackage}
              responsible={actions.responsible}
              label={row.package ? 'Создать ещё один пакет' : 'Создать пакет'}
            />
          </div>
        ) : null}
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
  /** Omitted (no session, or a role other than PTO) renders every row read-only. */
  actions?: P01ActionHandlers;
  className?: string;
}

export function PtoWorkspace({
  viewModel,
  sidebar,
  topbar,
  selectedObjectId,
  onSelectObjectFilter,
  actions,
  className,
}: P01Props) {
  const rows =
    selectedObjectId === null
      ? viewModel.rows
      : viewModel.rows.filter((row) => row.objectId === selectedObjectId);

  const emptyLabel = selectedObjectId === null ? P01_NO_WORKS_LABEL : P01_NO_WORKS_FOR_OBJECT_LABEL;

  return (
    <AppShell sidebar={sidebar} topbar={topbar} className={className}>
      <PageHeader
        eyebrow="ПТО"
        title="Операции ПТО"
        description="Работы по объектам: статус исполнительной документации, что требует внимания, ответственный ПТО."
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
        columns={workColumns}
        title="Очередь ПТО"
        context={`${rows.length} из ${viewModel.rows.length} работ`}
        state={rows.length === 0 ? 'Empty' : 'Default'}
        emptyLabel={emptyLabel}
      >
        {rows.map((row) => (
          <WorkRow key={row.objectWorkId} row={row} actions={actions} />
        ))}
      </DataTable>
    </AppShell>
  );
}
