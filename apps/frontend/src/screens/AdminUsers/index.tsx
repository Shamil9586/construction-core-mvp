import { useState, type ReactNode } from 'react';
import { AppShell, Button, DataTable, PageHeader, StatusBadge, typeClass } from '../../design-system';
import type { DataTableColumn } from '../../design-system';
import type { AdminAssignableRole } from '../../auth/internalRoles';
import {
  ASSIGNABLE_ROLE_OPTIONS,
  CORE_STATUS_LABEL,
  type AdminUserRow,
  type CoreAccessStatus,
} from '../../view-models/adminUsers';
import styles from './AdminUsers.module.css';

/**
 * «Пользователи и доступ» (`/admin/users`, PBX-2) — ADMIN only.
 *
 * Bitrix24 supplies who the employee is (name, id, position, departments,
 * ACTIVE); Core alone decides whether they are a Core user and with which role.
 * Position and departments are shown as context and are never an input to a role.
 * A role is only ever set by an explicit choice in the panel below a row.
 */

export type AdminUsersLoad =
  | { status: 'Loading' }
  | { status: 'Error'; message: string }
  | { status: 'Loaded' };

export type DirectoryLoad =
  | { status: 'Loading' }
  | { status: 'Error'; message: string }
  | { status: 'Loaded'; truncated: boolean; departmentsAvailable: boolean };

export interface AdminUsersNotice {
  kind: 'success' | 'error';
  text: string;
}

export interface AdminUsersScreenProps {
  sidebar: ReactNode;
  rows: AdminUserRow[];
  core: AdminUsersLoad;
  directory: DirectoryLoad;
  notice: AdminUsersNotice | null;
  /** A Core mutation is in flight. */
  busy: boolean;
  onRetry: () => void;
  onDismissNotice: () => void;
  /** Each resolves `true` when Core accepted the change (the panel then closes). */
  onAdd: (bitrixUserId: string, role: AdminAssignableRole) => Promise<boolean>;
  onChangeRole: (coreUserId: string, role: AdminAssignableRole) => Promise<boolean>;
  onDeactivate: (coreUserId: string) => Promise<boolean>;
  onReactivate: (coreUserId: string, role: AdminAssignableRole | null) => Promise<boolean>;
}

const columns: DataTableColumn[] = [
  { key: 'employee', header: 'Сотрудник', width: 'fill' },
  { key: 'position', header: 'Должность в Bitrix24', width: 200 },
  { key: 'departments', header: 'Подразделение', width: 200 },
  { key: 'status', header: 'Доступ в Core', width: 180 },
  { key: 'role', header: 'Роль в Core', width: 190 },
  { key: 'actions', header: 'Действия', width: 260, align: 'end' },
];

const STATUS_VARIANT: Record<CoreAccessStatus, 'Neutral' | 'OnTrack' | 'Attention'> = {
  NotInCore: 'Neutral',
  Active: 'OnTrack',
  Disabled: 'Attention',
};

type PanelMode = 'add' | 'role' | 'deactivate' | 'reactivate';
interface Panel {
  key: string;
  mode: PanelMode;
}

function ActionPanel({
  row,
  mode,
  busy,
  onCancel,
  onSubmit,
}: {
  row: AdminUserRow;
  mode: PanelMode;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (role: AdminAssignableRole | null) => Promise<boolean>;
}) {
  const current = row.core?.role;
  const currentAssignable = ASSIGNABLE_ROLE_OPTIONS.some((option) => option.value === current);
  const [role, setRole] = useState<string>(mode === 'role' && currentAssignable ? (current as string) : '');
  const selectId = `role-select-${row.key}`;

  const needsRole = mode === 'add' || mode === 'role';
  const canSubmit = !busy && (!needsRole || (role !== '' && (mode === 'add' || role !== current)));
  const submitLabel = {
    add: 'Добавить',
    role: 'Сохранить роль',
    deactivate: 'Отключить доступ',
    reactivate: 'Включить доступ',
  }[mode];

  return (
    <div className={styles.panel} role="group" aria-label={`Действие: ${row.displayName}`}>
      {mode === 'deactivate' ? (
        <p className={typeClass('body')}>
          Доступ к Core будет отключён, все активные сессии сотрудника завершены. Учётная запись в Bitrix24 не
          изменяется. После включения доступа потребуется новый вход через Bitrix24.
        </p>
      ) : null}
      {mode === 'reactivate' ? (
        <p className={typeClass('body')}>
          Будет восстановлена прежняя роль{row.core ? ` «${row.core.roleLabel}»` : ''}, если не выбрана другая.
          Прежние сессии не восстанавливаются — потребуется новый вход через Bitrix24.
        </p>
      ) : null}
      {mode === 'add' ? (
        <p className={typeClass('body')}>
          Роль в Core назначается только вручную; должность и подразделение в Bitrix24 на неё не влияют.
        </p>
      ) : null}
      {needsRole || mode === 'reactivate' ? (
        <div className={styles.field}>
          <label htmlFor={selectId} className={typeClass('label')}>
            {mode === 'reactivate' ? 'Другая роль (необязательно)' : 'Роль в Core'}
          </label>
          <select
            id={selectId}
            className={styles.input}
            value={role}
            onChange={(event) => setRole(event.target.value)}
            disabled={busy}
          >
            <option value="">
              {mode === 'reactivate' ? `Прежняя роль: ${row.core?.roleLabel ?? ''}` : 'Выберите роль'}
            </option>
            {ASSIGNABLE_ROLE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <div className={styles.panelActions}>
        <Button
          loading={busy}
          disabled={!canSubmit}
          onClick={() => {
            void onSubmit(role === '' ? null : (role as AdminAssignableRole));
          }}
        >
          {submitLabel}
        </Button>
        <Button variant="Secondary" disabled={busy} onClick={onCancel}>
          Отмена
        </Button>
      </div>
    </div>
  );
}

export function AdminUsersScreen(props: AdminUsersScreenProps) {
  const { sidebar, rows, core, directory, notice, busy } = props;
  const [panel, setPanel] = useState<Panel | null>(null);

  const closePanel = () => setPanel(null);
  const submit = async (row: AdminUserRow, mode: PanelMode, role: AdminAssignableRole | null) => {
    let ok = false;
    if (mode === 'add' && role) ok = await props.onAdd(row.bitrixUserId, role);
    else if (mode === 'role' && role && row.core) ok = await props.onChangeRole(row.core.id, role);
    else if (mode === 'deactivate' && row.core) ok = await props.onDeactivate(row.core.id);
    else if (mode === 'reactivate' && row.core) ok = await props.onReactivate(row.core.id, role);
    if (ok) closePanel();
    return ok;
  };

  const open = (row: AdminUserRow, mode: PanelMode) => setPanel({ key: row.key, mode });

  const isDirectoryLoaded = directory.status === 'Loaded';
  const tableState = core.status === 'Loading' || directory.status === 'Loading' ? 'Loading' : 'Default';
  const emptyDirectory = isDirectoryLoaded && rows.length === 0;

  return (
    <AppShell sidebar={sidebar}>
      <PageHeader
        eyebrow="Администрирование"
        title="Пользователи и доступ"
        description="Сотрудники портала Bitrix24 и их доступ в Core. Роль и доступ в Core назначает только администратор; данные Bitrix24 — справочные."
      />

      <div className={styles.messages}>
        {notice ? (
          <div
            className={[styles.banner, notice.kind === 'error' ? styles.bannerError : styles.bannerSuccess].join(' ')}
            role={notice.kind === 'error' ? 'alert' : 'status'}
          >
            <span className={typeClass('body')}>{notice.text}</span>
            <button type="button" className={styles.linkButton} onClick={props.onDismissNotice}>
              Закрыть
            </button>
          </div>
        ) : null}
        {core.status === 'Error' ? (
          <div className={[styles.banner, styles.bannerError].join(' ')} role="alert">
            <span className={typeClass('body')}>Не удалось загрузить пользователей Core: {core.message}</span>
            <button type="button" className={styles.linkButton} onClick={props.onRetry}>
              Повторить
            </button>
          </div>
        ) : null}
        {directory.status === 'Error' ? (
          <div className={[styles.banner, styles.bannerError].join(' ')} role="alert">
            <span className={typeClass('body')}>
              Не удалось загрузить сотрудников из Bitrix24: {directory.message}. Список сотрудников недоступен, показаны
              только пользователи Core.
            </span>
            <button type="button" className={styles.linkButton} onClick={props.onRetry}>
              Повторить
            </button>
          </div>
        ) : null}
        {directory.status === 'Loaded' && directory.truncated ? (
          <div className={[styles.banner, styles.bannerWarning].join(' ')} role="status">
            <span className={typeClass('body')}>Bitrix24 вернул неполный список сотрудников — часть сотрудников не показана.</span>
          </div>
        ) : null}
        {directory.status === 'Loaded' && !directory.departmentsAvailable ? (
          <div className={[styles.banner, styles.bannerWarning].join(' ')} role="status">
            <span className={typeClass('body')}>Названия подразделений недоступны — показаны их номера.</span>
          </div>
        ) : null}
      </div>

      {core.status === 'Error' ? null : (
        <div className={styles.tableSpacing}>
          <DataTable
            columns={columns}
            title="Сотрудники и доступ"
            context={tableState === 'Loading' ? undefined : `${rows.length} записей`}
            state={tableState === 'Loading' ? 'Loading' : emptyDirectory ? 'Empty' : 'Default'}
            emptyLabel="В Bitrix24 нет сотрудников, и в Core нет пользователей"
          >
            {rows.flatMap((row) => {
              const isOpen = panel?.key === row.key;
              const label = row.displayName;
              const rowNode = (
                <tr key={row.key} className={styles.row}>
                  <td className={styles.cell}>
                    <span className={typeClass('body-strong')}>{row.displayName}</span>
                    <div className={[typeClass('label'), styles.secondary].join(' ')}>ID Bitrix24: {row.bitrixUserId}</div>
                    {row.bitrixInactive ? (
                      <div className={styles.rowBadge}>
                        <StatusBadge variant="Attention">Сотрудник неактивен в Bitrix24</StatusBadge>
                      </div>
                    ) : null}
                    {row.missingInDirectory ? (
                      <div className={styles.rowBadge}>
                        <StatusBadge variant="Attention">Не найден в Bitrix24</StatusBadge>
                      </div>
                    ) : null}
                  </td>
                  <td className={styles.cell}>
                    <span className={[typeClass('body'), styles.secondary].join(' ')}>{row.position ?? '—'}</span>
                  </td>
                  <td className={styles.cell}>
                    <span className={[typeClass('body'), styles.secondary].join(' ')}>
                      {row.departments.length > 0 ? row.departments.join(', ') : '—'}
                    </span>
                  </td>
                  <td className={styles.cell}>
                    <StatusBadge variant={STATUS_VARIANT[row.status]}>{CORE_STATUS_LABEL[row.status]}</StatusBadge>
                  </td>
                  <td className={styles.cell}>
                    {row.core ? (
                      <>
                        <span className={typeClass('body')}>{row.core.roleLabel}</span>
                      </>
                    ) : (
                      <span className={[typeClass('body'), styles.secondary].join(' ')}>—</span>
                    )}
                  </td>
                  <td className={[styles.cell, styles.alignEnd].join(' ')}>
                    <div className={styles.rowActions}>
                      {!row.core ? (
                        <Button variant="Secondary" disabled={busy} aria-label={`Добавить в Core: ${label}`} onClick={() => open(row, 'add')}>
                          Добавить в Core
                        </Button>
                      ) : row.core.external ? (
                        <span className={[typeClass('label'), styles.secondary].join(' ')}>Внешний участник — вне этого раздела</span>
                      ) : row.core.isActive ? (
                        <>
                          <Button variant="Secondary" disabled={busy} aria-label={`Изменить роль: ${label}`} onClick={() => open(row, 'role')}>
                            Изменить роль
                          </Button>
                          <Button variant="Secondary" disabled={busy} aria-label={`Отключить доступ: ${label}`} onClick={() => open(row, 'deactivate')}>
                            Отключить доступ
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button variant="Secondary" disabled={busy} aria-label={`Включить доступ: ${label}`} onClick={() => open(row, 'reactivate')}>
                            Включить доступ
                          </Button>
                          <Button variant="Secondary" disabled={busy} aria-label={`Изменить роль: ${label}`} onClick={() => open(row, 'role')}>
                            Изменить роль
                          </Button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
              if (!isOpen || !panel) return [rowNode];
              return [
                rowNode,
                <tr key={`${row.key}-panel`} className={styles.panelRow}>
                  <td className={styles.cell} colSpan={columns.length}>
                    <ActionPanel
                      key={`${row.key}-${panel.mode}`}
                      row={row}
                      mode={panel.mode}
                      busy={busy}
                      onCancel={closePanel}
                      onSubmit={(role) => submit(row, panel.mode, role)}
                    />
                  </td>
                </tr>,
              ];
            })}
          </DataTable>
        </div>
      )}
    </AppShell>
  );
}
