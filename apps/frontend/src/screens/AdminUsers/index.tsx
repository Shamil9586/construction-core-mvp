import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppShell, Button, DataTable, PageHeader, StatusBadge, typeClass } from '../../design-system';
import type { DataTableColumn } from '../../design-system';
import type { AdminAssignableRole } from '../../auth/internalRoles';
import {
  ASSIGNABLE_ROLE_OPTIONS,
  BITRIX_STATE_LABEL,
  CORE_STATUS_LABEL,
  DEFAULT_QUERY,
  EMPTY_FILTERS,
  EMPTY_TEXT,
  NO_RESULTS_TEXT,
  REGISTRY_TABS,
  SORT_LABEL,
  applyRegistry,
  bitrixStateOf,
  filtersActive,
  registryOptions,
  rowInTab,
  sortOptionsFor,
  tabCounts,
  type AdminUserRow,
  type CoreAccessStatus,
  type RegistryQuery,
  type RegistrySort,
  type RegistryTab,
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
  | { status: 'Loaded'; truncated: boolean };

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

/** Columns per tab — the registry asks a different question in each. */
const COLUMNS: Record<RegistryTab, DataTableColumn[]> = {
  core: [
    { key: 'employee', header: 'Сотрудник', width: 'fill' },
    { key: 'role', header: 'Роль в Core', width: 220 },
    { key: 'status', header: 'Статус', width: 200 },
    { key: 'actions', header: 'Действия', width: 120, align: 'end' },
  ],
  notInCore: [
    { key: 'employee', header: 'Сотрудник', width: 'fill' },
    { key: 'bitrix', header: 'Статус Bitrix24', width: 220 },
    { key: 'actions', header: 'Действия', width: 120, align: 'end' },
  ],
  inactive: [
    { key: 'employee', header: 'Сотрудник', width: 'fill' },
    { key: 'core', header: 'Состояние Core', width: 240 },
    { key: 'bitrix', header: 'Статус Bitrix24', width: 200 },
    { key: 'actions', header: 'Действия', width: 120, align: 'end' },
  ],
};
const PAGE_SIZE = 50;

/** Below 640px (the shell's drawer breakpoint) rows collapse into compact cards instead of a scrolling table. */
function useNarrow(): boolean {
  const query = '(max-width: 639px)';
  const [narrow, setNarrow] = useState(() => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false));
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia(query);
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
}

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

interface MenuAction { key: string; label: string; onSelect: () => void }

/**
 * Compact ⋯ menu (one per row). The list is positioned `fixed` from the trigger so the table viewport's own scrolling
 * never clips it; Escape, an outside click, scrolling and resizing close it. A row with no valid action gets no menu at all.
 */
function RowMenu({ name, actions, disabled }: { name: string; actions: MenuAction[]; disabled: boolean }) {
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const open = at !== null;
  useEffect(() => {
    if (!open) return;
    first.current?.focus({ preventScroll: true });
    const close = () => setAt(null);
    const away = (e: MouseEvent) => { if (root.current && !root.current.contains(e.target as Node)) close(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { close(); trigger.current?.focus(); } };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    window.addEventListener('resize', close);
    const onScroll = (e: Event) => { if (!(root.current && e.target instanceof Node && root.current.contains(e.target))) close(); };
    // Scroll events are dispatched a frame late: the scroll that brought the trigger into view must not close the list it just opened.
    const armScroll = window.setTimeout(() => window.addEventListener('scroll', onScroll, true), 150);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); window.removeEventListener('resize', close); window.clearTimeout(armScroll); window.removeEventListener('scroll', onScroll, true); };
  }, [open]);
  if (actions.length === 0) return null;
  return (
    <div className={styles.menuRoot} ref={root}>
      <button
        ref={trigger}
        type="button"
        className={styles.menuButton}
        aria-label={`Действия: ${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={(e) => {
          if (open) { setAt(null); return; }
          const r = e.currentTarget.getBoundingClientRect();
          // Open below the trigger; flip above when the list (≈ 44px per item) would run off the bottom of the viewport.
          const height = actions.length * 44 + 10;
          const below = r.bottom + 4;
          setAt({ top: below + height > window.innerHeight ? Math.max(8, r.top - height - 4) : below, right: Math.max(8, window.innerWidth - r.right) });
        }}
      >
        ⋯
      </button>
      {at ? (
        <div className={styles.menu} role="menu" aria-label={`Действия: ${name}`} style={{ top: at.top, right: at.right }}>
          {actions.map((a, i) => (
            <button key={a.key} ref={i === 0 ? first : undefined} type="button" role="menuitem" className={styles.menuItem} onClick={() => { setAt(null); a.onSelect(); }}>
              {a.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const coreStateText = (row: AdminUserRow) => (row.core ? 'Есть в Core' : 'Нет в Core');

export function AdminUsersScreen(props: AdminUsersScreenProps) {
  const { sidebar, rows, core, directory, notice, busy } = props;
  const [panel, setPanel] = useState<Panel | null>(null);
  const [query, setQuery] = useState<RegistryQuery>(DEFAULT_QUERY);
  const [shown, setShown] = useState(PAGE_SIZE);
  const narrow = useNarrow();

  const patch = (change: Partial<RegistryQuery>) => { setQuery((q) => ({ ...q, ...change })); setShown(PAGE_SIZE); };
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

  const counts = useMemo(() => tabCounts(rows), [rows]);
  const options = useMemo(() => registryOptions(rows, query.tab), [rows, query.tab]);
  const visible = useMemo(() => applyRegistry(rows, query), [rows, query]);
  const page = visible.slice(0, shown);
  const columns = COLUMNS[query.tab];

  const selectTab = (tab: RegistryTab) => {
    closePanel();
    // Filter values belong to a tab (its own departments / roles / positions); search text carries over.
    setQuery((q) => ({ ...q, tab, ...EMPTY_FILTERS, sort: sortOptionsFor(tab).includes(q.sort) ? q.sort : 'name-asc' }));
    setShown(PAGE_SIZE);
  };

  const directoryLoading = directory.status === 'Loading';
  const loading = core.status === 'Loading' || directoryLoading;
  const needsDirectory = query.tab !== 'core';
  const directoryMissing = needsDirectory && directory.status === 'Error';
  const searching = query.search.trim() !== '' || filtersActive(query);
  const emptyLabel = directoryMissing
    ? 'Список сотрудников Bitrix24 недоступен'
    : searching && rows.some((r) => rowInTab(r, query.tab)) ? NO_RESULTS_TEXT : EMPTY_TEXT[query.tab];

  /** Existing actions only (same semantics and authorization); their availability rules are unchanged. */
  const actionsFor = (row: AdminUserRow) => {
    const list: MenuAction[] = [];
    if (!row.core) {
      // Not in Core: the existing safe add workflow, offered only for an employee ACTIVE in Bitrix24.
      if (!row.bitrixInactive) list.push({ key: 'add', label: 'Добавить в Core', onSelect: () => open(row, 'add') });
    } else if (!row.core.external) {
      list.push({ key: 'role', label: 'Изменить роль', onSelect: () => open(row, 'role') });
      list.push(row.core.isActive
        ? { key: 'off', label: 'Отключить доступ', onSelect: () => open(row, 'deactivate') }
        : { key: 'on', label: 'Включить доступ', onSelect: () => open(row, 'reactivate') });
    }
    if (row.core?.external) return <span className={[typeClass('label'), styles.secondary].join(' ')}>Внешний участник</span>;
    return <RowMenu name={row.displayName} actions={list} disabled={busy} />;
  };

  const identity = (row: AdminUserRow) => (
    <>
      <span className={typeClass('body-strong')}>{row.displayName}</span>
      {row.email ? <div className={[typeClass('label'), styles.secondary].join(' ')}>{row.email}</div> : null}
      <div className={[typeClass('label'), styles.secondary].join(' ')}>ID Bitrix24: {row.bitrixUserId}</div>
      {row.bitrixInactive && query.tab === 'core' ? <div className={styles.rowBadge}><StatusBadge variant="Attention">Сотрудник неактивен в Bitrix24</StatusBadge></div> : null}
      {row.missingInDirectory ? <div className={styles.rowBadge}><StatusBadge variant="Attention">Не найден в Bitrix24</StatusBadge></div> : null}
    </>
  );
  const bitrixBadge = (row: AdminUserRow) => {
    const state = bitrixStateOf(row);
    return <StatusBadge variant={state === 'active' ? 'OnTrack' : state === 'inactive' ? 'Attention' : 'Neutral'}>{BITRIX_STATE_LABEL[state]}</StatusBadge>;
  };
  const coreBadge = (row: AdminUserRow) => <StatusBadge variant={STATUS_VARIANT[row.status]}>{CORE_STATUS_LABEL[row.status]}</StatusBadge>;
  const coreState = (row: AdminUserRow) => (
    <>
      <StatusBadge variant={row.core ? 'Attention' : 'Neutral'}>{coreStateText(row)}</StatusBadge>
      {row.core ? <div className={[typeClass('label'), styles.secondary].join(' ')}>{row.core.roleLabel} · {CORE_STATUS_LABEL[row.status]}</div> : null}
    </>
  );

  const cells = (row: AdminUserRow): ReactNode[] => {
    const who = <td key="e" className={styles.cell}>{identity(row)}</td>;
    const actions = <td key="a" className={[styles.cell, styles.alignEnd].join(' ')}>{actionsFor(row)}</td>;
    if (query.tab === 'core') return [who, <td key="r" className={styles.cell}><span className={typeClass('body')}>{row.core?.roleLabel}</span></td>, <td key="s" className={styles.cell}>{coreBadge(row)}</td>, actions];
    if (query.tab === 'notInCore') return [who, <td key="b" className={styles.cell}>{bitrixBadge(row)}</td>, actions];
    return [who, <td key="c" className={styles.cell}>{coreState(row)}</td>, <td key="b" className={styles.cell}>{bitrixBadge(row)}</td>, actions];
  };

  const panelFor = (row: AdminUserRow) =>
    panel?.key === row.key ? (
      <ActionPanel key={`${row.key}-${panel.mode}`} row={row} mode={panel.mode} busy={busy} onCancel={closePanel} onSubmit={(role) => submit(row, panel.mode, role)} />
    ) : null;

  return (
    <AppShell sidebar={sidebar}>
      <PageHeader
        eyebrow="Администрирование"
        title="Пользователи и доступ"
        description="Сотрудники портала Bitrix24 и их доступ в Core. Роль и доступ в Core назначает только администратор; данные Bitrix24 — справочные."
      />

      <div className={styles.messages}>
        {notice ? (
          <div className={[styles.banner, notice.kind === 'error' ? styles.bannerError : styles.bannerSuccess].join(' ')} role={notice.kind === 'error' ? 'alert' : 'status'}>
            <span className={typeClass('body')}>{notice.text}</span>
            <button type="button" className={styles.linkButton} onClick={props.onDismissNotice}>Закрыть</button>
          </div>
        ) : null}
        {core.status === 'Error' ? (
          <div className={[styles.banner, styles.bannerError].join(' ')} role="alert">
            <span className={typeClass('body')}>Не удалось загрузить пользователей Core: {core.message}</span>
            <button type="button" className={styles.linkButton} onClick={props.onRetry}>Повторить</button>
          </div>
        ) : null}
        {directory.status === 'Error' ? (
          <div className={[styles.banner, styles.bannerError].join(' ')} role="alert">
            <span className={typeClass('body')}>Не удалось загрузить сотрудников из Bitrix24: {directory.message}. Список сотрудников недоступен, показаны только пользователи Core.</span>
            <button type="button" className={styles.linkButton} onClick={props.onRetry}>Повторить</button>
          </div>
        ) : null}
        {directory.status === 'Loaded' && directory.truncated ? (
          <div className={[styles.banner, styles.bannerWarning].join(' ')} role="status">
            <span className={typeClass('body')}>Bitrix24 вернул неполный список сотрудников — часть сотрудников не показана.</span>
          </div>
        ) : null}
      </div>

      {core.status === 'Error' ? null : (
        <>
          <div className={styles.toolbar}>
            <div className={styles.searchField}>
              <label htmlFor="registry-search" className={styles.srOnly}>Поиск</label>
              <input
                id="registry-search"
                type="search"
                className={styles.input}
                placeholder="Поиск по ФИО или e-mail"
                value={query.search}
                onChange={(e) => patch({ search: e.target.value })}
                autoComplete="off"
              />
            </div>
            <div role="tablist" aria-label="Списки сотрудников" className={styles.tabs}>
              {REGISTRY_TABS.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  role="tab"
                  aria-selected={query.tab === tab.key}
                  className={[styles.tab, query.tab === tab.key ? styles.tabActive : ''].join(' ')}
                  onClick={() => selectTab(tab.key)}
                >
                  {tab.label}{loading || (tab.key !== 'core' && directory.status !== 'Loaded') ? '' : ` (${counts[tab.key]})`}
                </button>
              ))}
            </div>
            <div className={styles.filters}>
              <div className={styles.field}>
                <label htmlFor="filter-role" className={typeClass('label')}>Роль в Core</label>
                <select id="filter-role" className={styles.input} value={query.role} disabled={options.roles.length === 0} onChange={(e) => patch({ role: e.target.value })}>
                  <option value="">Все</option>
                  {options.roles.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>
              <div className={styles.field}>
                <label htmlFor="registry-sort" className={typeClass('label')}>Сортировка</label>
                <select id="registry-sort" className={styles.input} value={query.sort} onChange={(e) => patch({ sort: e.target.value as RegistrySort })}>
                  {sortOptionsFor(query.tab).map((k) => <option key={k} value={k}>{SORT_LABEL[k]}</option>)}
                </select>
              </div>
              {filtersActive(query) ? <button type="button" className={styles.linkButton} onClick={() => patch({ ...EMPTY_FILTERS })}>Сбросить фильтры</button> : null}
            </div>
          </div>

          <div className={styles.tableSpacing} role="tabpanel" aria-label={REGISTRY_TABS.find((t) => t.key === query.tab)?.label}>
            {narrow && !loading && visible.length > 0 ? (
              <>
                <ul className={styles.cards} aria-label="Сотрудники">
                  {page.map((row) => (
                    <li key={row.key} className={styles.card}>
                      {identity(row)}
                      <div className={styles.cardStates}>
                        {query.tab === 'core' ? <><span className={typeClass('body')}>{row.core?.roleLabel}</span>{coreBadge(row)}</> : null}
                        {query.tab === 'notInCore' ? bitrixBadge(row) : null}
                        {query.tab === 'inactive' ? <>{coreState(row)}{bitrixBadge(row)}</> : null}
                      </div>
                      <div className={styles.cardActions}>{actionsFor(row)}</div>
                      {panelFor(row)}
                    </li>
                  ))}
                </ul>
                <p className={typeClass('label')}>Показано {page.length} из {visible.length}</p>
              </>
            ) : (
              <DataTable
                columns={columns}
                title={REGISTRY_TABS.find((t) => t.key === query.tab)?.label ?? 'Сотрудники'}
                context={loading ? undefined : `${visible.length} записей`}
                state={loading ? 'Loading' : visible.length === 0 ? 'Empty' : 'Default'}
                emptyLabel={emptyLabel}
              >
                {page.flatMap((row) => {
                  const rowNode = <tr key={row.key} className={styles.row}>{cells(row)}</tr>;
                  const p = panelFor(row);
                  return p ? [rowNode, <tr key={`${row.key}-panel`} className={styles.panelRow}><td className={styles.cell} colSpan={columns.length}>{p}</td></tr>] : [rowNode];
                })}
              </DataTable>
            )}
            {!loading && visible.length > shown ? (
              <div className={styles.more}>
                <span className={typeClass('label')}>Показано {shown} из {visible.length}</span>
                <Button variant="Secondary" onClick={() => setShown((n) => n + PAGE_SIZE)}>Показать ещё</Button>
              </div>
            ) : null}
            {narrow && !loading && visible.length === 0 ? <p className={typeClass('body')} role="status">{emptyLabel}</p> : null}
          </div>
        </>
      )}
    </AppShell>
  );
}
