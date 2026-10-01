import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AppShell, Button, PageHeader, StatusBadge, typeClass } from '../../design-system';
import type { OrgEmployee, OrgFunctionCode, OrgFunctionGroup, OrgHistoryEntry, OrgManager, OrgStructure } from '../../data/orgStructureApi';
import {
  ACTION_LABEL,
  FUNCTION_ORDER,
  FUNCTION_TITLE,
  NO_HEAD_LABEL,
  UNASSIGNED_GROUP_LABEL,
  departmentHeads,
  employeeActions,
  hasActiveHead,
  hasLocalHead,
  historyLine,
  positionTitle,
  projectManagers,
  reasonIsValid,
  targetManagers,
  unassignedEmployees,
  visibleUnresolved,
  type EmployeeAction,
} from '../../view-models/orgStructure';
import styles from './CompanyStructure.module.css';

/**
 * «Структура компании» (`/company-structure`, ORG-1) — organizational structure ONLY: who works in the company, in which
 * unit, and who their immediate manager is. It is not an object-assignment screen: no object information appears here.
 *
 *   Руководство (Генеральный директор, Заместитель директора — once)
 *   Производственный блок: ПТО · Строительный контроль · СДО (head card, employees below) · Руководители проектов (flat list)
 *
 * Employee operations live behind a compact ⋯ menu in business language. Changing a manager asks for a mandatory reason and
 * sends the exact assignment id + version read. Nothing here changes a Core role or an object assignment; the backend
 * enforces every rule independently.
 */
export type CompanyStructureLoad = { status: 'Loading' } | { status: 'Error'; message: string } | { status: 'Loaded'; structure: OrgStructure };
export interface CompanyStructureNotice { kind: 'success' | 'error'; text: string }

export interface CompanyStructureScreenProps {
  sidebar: ReactNode;
  load: CompanyStructureLoad;
  notice: CompanyStructureNotice | null;
  busy: boolean;
  onRetry: () => void;
  onDismissNotice: () => void;
  onAssign: (fn: OrgFunctionCode, memberUserId: string, managerUserId: string) => Promise<boolean>;
  onTransfer: (fn: OrgFunctionCode, employee: OrgEmployee, managerUserId: string, reason: string) => Promise<boolean>;
  onLoadHistory: (fn: OrgFunctionCode, memberUserId: string) => Promise<OrgHistoryEntry[]>;
}

type HistoryState = { status: 'Closed' } | { status: 'Loading' } | { status: 'Error'; message: string } | { status: 'Loaded'; entries: OrgHistoryEntry[] };

/** Compact ⋯ menu: closes on Escape / outside click; items are plain buttons with role=menuitem. */
function ActionsMenu({ label, actions, disabled, onSelect }: { label: string; actions: EmployeeAction[]; disabled: boolean; onSelect: (a: EmployeeAction) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  if (actions.length === 0) return null;
  return (
    <div className={styles.menuRoot} ref={root}>
      <button type="button" className={styles.menuButton} aria-label={`Действия: ${label}`} aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen((v) => !v)}>⋯</button>
      {open ? (
        <div className={styles.menu} role="menu" aria-label={`Действия: ${label}`}>
          {actions.map((a) => <button key={a} type="button" role="menuitem" className={styles.menuItem} onClick={() => { setOpen(false); onSelect(a); }}>{ACTION_LABEL[a]}</button>)}
        </div>
      ) : null}
    </div>
  );
}

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  // Focus the first field once on open (not on every render — that would steal focus while typing).
  useEffect(() => { box.current?.querySelector<HTMLElement>('select,input')?.focus(); }, []);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') close.current(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, []);
  return (
    <div className={styles.overlay}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-label={title} ref={box}>
        <h2 className={typeClass('heading-card')}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div className={styles.fact}><span className={[typeClass('label'), styles.secondary].join(' ')}>{label}</span><span className={typeClass('body')}>{value}</span></div>;
}

function ManagerDialog({ mode, fn, group, employee, currentManagerName, busy, props, onClose }: { mode: 'assign' | 'change-manager'; fn: OrgFunctionCode; group: OrgFunctionGroup; employee: OrgEmployee; currentManagerName: string | null; busy: boolean; props: CompanyStructureScreenProps; onClose: () => void }) {
  const [manager, setManager] = useState('');
  const [reason, setReason] = useState('');
  const change = mode === 'change-manager';
  const options = targetManagers(group, employee.orgManagerUserId);
  const title = change ? 'Сменить руководителя' : 'Назначить руководителя';
  return (
    <Dialog title={title} onClose={onClose}>
      <Fact label="Сотрудник" value={employee.name} />
      <Fact label="Подразделение" value={FUNCTION_TITLE[fn]} />
      {change ? <Fact label="Текущий руководитель" value={currentManagerName ?? '—'} /> : null}
      <div className={styles.field}>
        <label htmlFor="org-dialog-manager" className={typeClass('label')}>{change ? 'Новый руководитель' : 'Руководитель'}</label>
        <select id="org-dialog-manager" className={styles.input} value={manager} onChange={(e) => setManager(e.target.value)} disabled={busy}>
          <option value="">Выберите руководителя</option>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      {change ? (
        <div className={styles.field}>
          <label htmlFor="org-dialog-reason" className={typeClass('label')}>Причина</label>
          <input id="org-dialog-reason" className={styles.input} value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy} aria-required="true" />
        </div>
      ) : null}
      <div className={styles.actions}>
        <Button variant="Secondary" disabled={busy} onClick={onClose}>Отмена</Button>
        <Button
          loading={busy}
          disabled={busy || !manager || (change && !reasonIsValid(reason))}
          onClick={() => {
            const done = change ? props.onTransfer(fn, employee, manager, reason.trim()) : props.onAssign(fn, employee.userId, manager);
            void done.then((ok) => { if (ok) onClose(); });
          }}
        >
          {title}
        </Button>
      </div>
    </Dialog>
  );
}

function EmployeeRow({ fn, group, employee, managerName, canManage, busy, props }: { fn: OrgFunctionCode; group: OrgFunctionGroup; employee: OrgEmployee; managerName: string | null; canManage: boolean; busy: boolean; props: CompanyStructureScreenProps }) {
  const [dialog, setDialog] = useState<'assign' | 'change-manager' | null>(null);
  const [history, setHistory] = useState<HistoryState>({ status: 'Closed' });
  const actions = employeeActions({ fn, canManage, employee, hasTargets: targetManagers(group, employee.orgManagerUserId).length > 0 });
  const select = (a: EmployeeAction) => {
    if (a === 'assign' || a === 'change-manager') { setDialog(a); return; }
    if (history.status !== 'Closed') { setHistory({ status: 'Closed' }); return; }
    setHistory({ status: 'Loading' });
    props.onLoadHistory(fn, employee.userId).then(
      (entries) => setHistory({ status: 'Loaded', entries }),
      (error: unknown) => setHistory({ status: 'Error', message: error instanceof Error ? error.message : String(error) }),
    );
  };
  return (
    <li className={styles.employee} aria-label={employee.name}>
      <div className={styles.employeeMain}>
        <div className={styles.identity}>
          <span className={typeClass('body-strong')}>{employee.name}</span>
          <span className={[typeClass('label'), styles.secondary].join(' ')}>{positionTitle(employee.role)}</span>
        </div>
        {!employee.isActive ? <StatusBadge variant="Attention">Доступ отключён</StatusBadge> : !employee.roleMatches ? <StatusBadge variant="Attention">Должность изменена</StatusBadge> : null}
        <ActionsMenu label={employee.name} actions={actions} disabled={busy} onSelect={select} />
      </div>
      {history.status === 'Loading' ? <p className={typeClass('label')} aria-live="polite">Загрузка истории…</p> : null}
      {history.status === 'Error' ? <p className={typeClass('label')} role="alert">Не удалось загрузить историю: {history.message}</p> : null}
      {history.status === 'Loaded' ? (
        history.entries.length === 0 ? <p className={[typeClass('label'), styles.secondary].join(' ')}>Изменений пока не было.</p> : (
          <ol className={styles.history} aria-label={`История изменений: ${employee.name}`}>
            {history.entries.map((h) => (
              <li key={h.assignmentId} className={typeClass('label')}>
                {historyLine(h)}
                <div className={styles.secondary}>Назначил: {h.startedByName}{h.endedAt ? ` · завершил: ${h.endedByName ?? '—'}${h.reason ? ` · причина: ${h.reason}` : ''}` : ''}</div>
              </li>
            ))}
          </ol>
        )
      ) : null}
      {dialog ? <ManagerDialog mode={dialog} fn={fn} group={group} employee={employee} currentManagerName={managerName} busy={busy} props={props} onClose={() => setDialog(null)} /> : null}
    </li>
  );
}

function HeadCard({ fn, group, head, canManage, busy, props }: { fn: OrgFunctionCode; group: OrgFunctionGroup; head: OrgManager; canManage: boolean; busy: boolean; props: CompanyStructureScreenProps }) {
  return (
    <section className={styles.head} aria-label={`${FUNCTION_TITLE[fn]}: ${head.name}`}>
      <div className={styles.headTop}>
        <div className={styles.identity}>
          <h4 className={typeClass('heading-card')}>{head.name}</h4>
          <span className={[typeClass('body'), styles.secondary].join(' ')}>{positionTitle(head.role)}</span>
        </div>
        {!head.isActive ? <StatusBadge variant="Attention">Руководитель недоступен</StatusBadge> : !head.roleMatches ? <StatusBadge variant="Attention">Должность изменена</StatusBadge> : null}
      </div>
      {!head.isActive && head.orgMembers.length > 0 ? (
        <div className={[styles.banner, styles.bannerWarning].join(' ')} role="status">
          <span className={typeClass('body')}>Сотрудники не переведены автоматически — выберите нового руководителя для каждого.</span>
        </div>
      ) : null}
      <div className={styles.staff}>
        <span className={[typeClass('label'), styles.secondary].join(' ')}>Сотрудники</span>
        {head.orgMembers.length === 0 ? <span className={[typeClass('body'), styles.secondary].join(' ')}>Сотрудников пока нет</span> : (
          <ul className={styles.list} aria-label={`Сотрудники: ${head.name}`}>
            {head.orgMembers.map((e) => <EmployeeRow key={e.userId} fn={fn} group={group} employee={e} managerName={head.name} canManage={canManage} busy={busy} props={props} />)}
          </ul>
        )}
      </div>
    </section>
  );
}

function FunctionSection({ group, canManage, ownTeamOnly, busy, props }: { group: OrgFunctionGroup; canManage: boolean; ownTeamOnly: boolean; busy: boolean; props: CompanyStructureScreenProps }) {
  const fn = group.functionCode;
  const unresolved = visibleUnresolved(group);
  const title = <h3 className={[typeClass('heading-section'), styles.groupTitle].join(' ')}>{FUNCTION_TITLE[fn]}</h3>;

  if (!hasLocalHead(fn)) {
    const people = projectManagers(group);
    return (
      <section className={styles.group} aria-label={FUNCTION_TITLE[fn]}>
        {title}
        {people.length === 0 ? <p className={[typeClass('body'), styles.secondary].join(' ')}>Руководителей проектов пока нет</p> : (
          <ul className={[styles.list, styles.flat].join(' ')}>
            {people.map((e) => <EmployeeRow key={e.userId} fn={fn} group={group} employee={e} managerName={null} canManage={false} busy={busy} props={props} />)}
          </ul>
        )}
      </section>
    );
  }

  const heads = departmentHeads(group);
  const loose = ownTeamOnly ? [] : unassignedEmployees(group);
  return (
    <section className={styles.group} aria-label={FUNCTION_TITLE[fn]}>
      {title}
      {unresolved.length > 0 ? (
        <div className={[styles.banner, styles.bannerWarning].join(' ')} role="status">
          <div>
            <div className={typeClass('body-strong')}>Требуют решения ({unresolved.length})</div>
            <ul className={styles.list}>
              {unresolved.map((u) => (
                <li key={`${u.kind}-${u.memberUserId}`} className={typeClass('body')}>
                  {u.memberName} — {u.kind === 'MANAGER_UNAVAILABLE' ? `руководитель ${u.managerName} недоступен, сотрудник ждёт решения` : 'сотрудник недоступен, закройте его назначение'}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
      {!hasActiveHead(group) && !ownTeamOnly ? (
        <div className={[styles.banner, styles.bannerWarning].join(' ')} role="status">
          <span className={typeClass('body')}>{NO_HEAD_LABEL}</span>
          {canManage ? <span className={[typeClass('label')].join(' ')}>Начальника подразделения назначает администратор в разделе «Пользователи и доступ»</span> : null}
        </div>
      ) : null}
      <div className={styles.heads}>
        {heads.map((h) => <HeadCard key={h.userId} fn={fn} group={group} head={h} canManage={canManage} busy={busy} props={props} />)}
      </div>
      {loose.length > 0 ? (
        <section className={styles.exception} aria-label={`${FUNCTION_TITLE[fn]}: ${UNASSIGNED_GROUP_LABEL}`}>
          <h4 className={typeClass('body-strong')}>{UNASSIGNED_GROUP_LABEL}</h4>
          <ul className={styles.list}>
            {loose.map((e) => <EmployeeRow key={e.userId} fn={fn} group={group} employee={e} managerName={null} canManage={canManage} busy={busy} props={props} />)}
          </ul>
        </section>
      ) : null}
    </section>
  );
}

export function CompanyStructureScreen(props: CompanyStructureScreenProps) {
  const { sidebar, load, notice, busy } = props;
  const structure = load.status === 'Loaded' ? load.structure : null;
  const groups = structure ? FUNCTION_ORDER.flatMap((fn) => structure.functions.filter((g) => g.functionCode === fn)) : [];

  return (
    <AppShell sidebar={sidebar}>
      <PageHeader
        eyebrow="Организация"
        title="Структура компании"
        description="Кто работает в компании, в каком подразделении и кто их непосредственный руководитель."
      />
      <div className={styles.messages}>
        {notice ? (
          <div className={[styles.banner, notice.kind === 'error' ? styles.bannerError : styles.bannerSuccess].join(' ')} role={notice.kind === 'error' ? 'alert' : 'status'}>
            <span className={typeClass('body')}>{notice.text}</span>
            <button type="button" className={styles.linkButton} onClick={props.onDismissNotice}>Закрыть</button>
          </div>
        ) : null}
        {load.status === 'Error' ? (
          <div className={[styles.banner, styles.bannerError].join(' ')} role="alert">
            <span className={typeClass('body')}>Не удалось загрузить структуру: {load.message}</span>
            <button type="button" className={styles.linkButton} onClick={props.onRetry}>Повторить</button>
          </div>
        ) : null}
      </div>
      {load.status === 'Loading' ? <p className={typeClass('body')} aria-live="polite">Загрузка…</p> : null}
      {structure ? (
        <>
          {structure.scope === 'OWN_TEAM' ? <p className={[typeClass('body'), styles.secondary].join(' ')}>Показана только ваша команда.</p> : null}
          {structure.management ? (
            <section className={styles.group} aria-label="Руководство">
              <h2 className={[typeClass('heading-section'), styles.groupTitle].join(' ')}>Руководство</h2>
              <ul className={[styles.list, styles.leaders].join(' ')}>
                {structure.management.leaders.length === 0 ? <li className={[typeClass('body'), styles.secondary].join(' ')}>Руководство не назначено</li> : null}
                {structure.management.leaders.map((l) => (
                  <li key={l.userId} className={styles.leader} aria-label={l.name}>
                    <span className={typeClass('body-strong')}>{l.name}</span>
                    <span className={[typeClass('label'), styles.secondary].join(' ')}>{positionTitle(l.role)}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <section className={styles.block} aria-label="Производственный блок">
            <h2 className={[typeClass('heading-section'), styles.groupTitle].join(' ')}>Производственный блок</h2>
            {groups.map((g) => <FunctionSection key={g.functionCode} group={g} canManage={structure.canManage} ownTeamOnly={structure.scope === 'OWN_TEAM'} busy={busy} props={props} />)}
          </section>
        </>
      ) : null}
    </AppShell>
  );
}
