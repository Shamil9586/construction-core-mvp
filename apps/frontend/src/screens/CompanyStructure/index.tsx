import { useState, type ReactNode } from 'react';
import { AppShell, Button, PageHeader, StatusBadge, typeClass } from '../../design-system';
import type { OrgEmployee, OrgFunctionCode, OrgFunctionGroup, OrgHistoryEntry, OrgManager, OrgStructure } from '../../data/orgStructureApi';
import {
  DIFFERENT_TEAM_LABEL,
  FUNCTION_ORDER,
  FUNCTION_TITLE,
  NO_MANAGER_LABEL,
  historyLine,
  managerCountLabel,
  objectRelationText,
  reasonIsValid,
  roleLabel,
  targetManagers,
} from '../../view-models/orgStructure';
import styles from './CompanyStructure.module.css';

/**
 * «Структура компании» (`/company-structure`, ORG-1) — Руководство, ПТО, Строительный контроль, СДО, Руководители
 * проектов as readable cards (no table scrolling, stacks on a phone). Three independent facts are kept apart for every
 * employee: «Роль» (Core role), «Организационно» (who they report to) and «На объектах» (object assignments). An
 * organizational manager that differs from the object lead is a valid state, labelled — never an error.
 *
 * DEPUTY_DIRECTOR / ADMIN get назначить / перевести / завершить, with an explicit mandatory reason for transfer and end;
 * GENERAL_DIRECTOR sees the same overview with no controls; a functional head receives only their own team. None of the
 * controls changes a Core role or an object assignment, and the backend enforces every rule independently.
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
  onEnd: (fn: OrgFunctionCode, employee: OrgEmployee, reason: string) => Promise<boolean>;
  onLoadHistory: (fn: OrgFunctionCode, memberUserId: string) => Promise<OrgHistoryEntry[]>;
}

type Mode = null | 'assign' | 'transfer' | 'end';
type HistoryState = { status: 'Closed' } | { status: 'Loading' } | { status: 'Error'; message: string } | { status: 'Loaded'; entries: OrgHistoryEntry[] };

function EmployeeBlock({ fn, group, employee, canManage, busy, managerName, props }: { fn: OrgFunctionCode; group: OrgFunctionGroup; employee: OrgEmployee; canManage: boolean; busy: boolean; managerName: string | null; props: CompanyStructureScreenProps }) {
  const [mode, setMode] = useState<Mode>(null);
  const [manager, setManager] = useState('');
  const [reason, setReason] = useState('');
  const [history, setHistory] = useState<HistoryState>({ status: 'Closed' });
  const options = targetManagers(group, employee.orgManagerUserId);
  const prefix = `org-${fn}-${employee.userId}`;
  const close = () => { setMode(null); setManager(''); setReason(''); };
  const toggleHistory = () => {
    if (history.status !== 'Closed') { setHistory({ status: 'Closed' }); return; }
    setHistory({ status: 'Loading' });
    props.onLoadHistory(fn, employee.userId).then(
      (entries) => setHistory({ status: 'Loaded', entries }),
      (error: unknown) => setHistory({ status: 'Error', message: error instanceof Error ? error.message : String(error) }),
    );
  };
  const assigned = employee.orgManagerUserId !== null;

  return (
    <li className={styles.employee} aria-label={employee.name}>
      <div className={styles.cardHead}>
        <span className={typeClass('body-strong')}>{employee.name}</span>
        {!employee.isActive ? <StatusBadge variant="Attention">Доступ отключён</StatusBadge> : !employee.roleMatches ? <StatusBadge variant="Attention">Роль изменена</StatusBadge> : null}
      </div>
      <span className={[typeClass('label'), styles.secondary].join(' ')}>Роль: {roleLabel(employee.role)}</span>
      <span className={[typeClass('label'), styles.secondary].join(' ')}>Организационно: {assigned ? `команда: ${managerName ?? '—'}` : NO_MANAGER_LABEL}</span>
      <div>
        <span className={[typeClass('label'), styles.secondary].join(' ')}>На объектах: {employee.objects.length === 0 ? 'нет' : employee.objects.length}</span>
        {employee.objects.length > 0 ? (
          <ul className={styles.objects}>
            {employee.objects.map((o) => (
              <li key={`${o.relation}-${o.objectId}`} className={typeClass('body')}>
                «{o.name}» — {objectRelationText(o)}
                {o.differentOrgTeam ? <> <StatusBadge variant="Neutral">{DIFFERENT_TEAM_LABEL}</StatusBadge></> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className={styles.actions}>
        {canManage && !assigned ? <Button variant="Secondary" disabled={busy || options.length === 0} onClick={() => setMode('assign')}>Назначить руководителя</Button> : null}
        {canManage && assigned && employee.assignment ? (
          <>
            <Button variant="Secondary" disabled={busy || options.length === 0} onClick={() => setMode('transfer')}>Перевести к другому руководителю</Button>
            <Button variant="Secondary" disabled={busy} onClick={() => setMode('end')}>Завершить членство</Button>
          </>
        ) : null}
        {assigned || history.status !== 'Closed' ? <Button variant="Secondary" onClick={toggleHistory}>{history.status === 'Closed' ? 'История изменений' : 'Скрыть историю'}</Button> : null}
      </div>
      {canManage && mode !== null ? (
        <div className={styles.form} role="group" aria-label={mode === 'assign' ? 'Назначить руководителя' : mode === 'transfer' ? 'Перевести к другому руководителю' : 'Завершить членство'}>
          {mode !== 'end' ? (
            <div className={styles.field}>
              <label htmlFor={`${prefix}-manager`} className={typeClass('label')}>Руководитель</label>
              <select id={`${prefix}-manager`} className={styles.input} value={manager} onChange={(e) => setManager(e.target.value)} disabled={busy}>
                <option value="">Выберите руководителя</option>
                {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          ) : null}
          {mode !== 'assign' ? (
            <div className={styles.field}>
              <label htmlFor={`${prefix}-reason`} className={typeClass('label')}>Причина (обязательна)</label>
              <input id={`${prefix}-reason`} className={styles.input} value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy} />
            </div>
          ) : null}
          <p className={[typeClass('label'), styles.secondary].join(' ')}>Роль в системе и назначения на объекты не меняются.</p>
          <div className={styles.actions}>
            <Button
              loading={busy}
              disabled={busy || (mode !== 'end' && !manager) || (mode !== 'assign' && !reasonIsValid(reason))}
              onClick={() => {
                const done = mode === 'assign' ? props.onAssign(fn, employee.userId, manager) : mode === 'transfer' ? props.onTransfer(fn, employee, manager, reason.trim()) : props.onEnd(fn, employee, reason.trim());
                void done.then((ok) => { if (ok) close(); });
              }}
            >
              {mode === 'assign' ? 'Назначить' : mode === 'transfer' ? 'Перевести' : 'Завершить членство'}
            </Button>
            <Button variant="Secondary" disabled={busy} onClick={close}>Отмена</Button>
          </div>
        </div>
      ) : null}
      {history.status === 'Loading' ? <p className={typeClass('label')} aria-live="polite">Загрузка истории…</p> : null}
      {history.status === 'Error' ? <p className={typeClass('label')} role="alert">Не удалось загрузить историю: {history.message}</p> : null}
      {history.status === 'Loaded' ? (
        history.entries.length === 0 ? <p className={[typeClass('label'), styles.secondary].join(' ')}>Организационных назначений ещё не было.</p> : (
          <ol className={styles.history} aria-label={`История изменений: ${employee.name}`}>
            {history.entries.map((h) => (
              <li key={h.assignmentId} className={typeClass('label')}>
                {historyLine(h)}
                <div className={styles.secondary}>
                  Назначил: {h.startedByName}{h.endedAt ? ` · завершил: ${h.endedByName ?? '—'}${h.reason ? ` · причина: ${h.reason}` : ''}` : ''}
                </div>
              </li>
            ))}
          </ol>
        )
      ) : null}
    </li>
  );
}

function ManagerCard({ fn, group, manager, canManage, busy, props }: { fn: OrgFunctionCode; group: OrgFunctionGroup; manager: OrgManager; canManage: boolean; busy: boolean; props: CompanyStructureScreenProps }) {
  return (
    <section className={styles.card} aria-label={`${FUNCTION_TITLE[fn]}: ${manager.name}`}>
      <div className={styles.cardHead}>
        <h3 className={typeClass('body-strong')}>{manager.name}</h3>
        {!manager.isActive ? <StatusBadge variant="Attention">Руководитель недоступен</StatusBadge> : !manager.roleMatches ? <StatusBadge variant="Attention">Роль изменена</StatusBadge> : null}
      </div>
      <span className={[typeClass('label'), styles.secondary].join(' ')}>{roleLabel(manager.role)}</span>
      <span className={typeClass('label')}>{managerCountLabel(manager, fn)}</span>
      {manager.ledObjects.length > 0 ? (
        <div>
          <span className={[typeClass('label'), styles.secondary].join(' ')}>Ведёт объекты:</span>
          <ul className={styles.objects}>{manager.ledObjects.map((o) => <li key={o.objectId} className={typeClass('body')}>«{o.name}»</li>)}</ul>
        </div>
      ) : null}
      {!manager.isActive && manager.orgMembers.length > 0 ? (
        <div className={[styles.banner, styles.bannerWarning].join(' ')} role="status">
          <span className={typeClass('body')}>Сотрудники не переведены автоматически — выберите нового руководителя для каждого.</span>
        </div>
      ) : null}
      {manager.orgMembers.length === 0 ? <span className={[typeClass('body'), styles.secondary].join(' ')}>Команда пуста</span> : (
        <ul className={styles.list} aria-label={`Сотрудники: ${manager.name}`}>
          {manager.orgMembers.map((e) => <EmployeeBlock key={e.userId} fn={fn} group={group} employee={e} canManage={canManage} busy={busy} managerName={manager.name} props={props} />)}
        </ul>
      )}
    </section>
  );
}

function FunctionSection({ group, canManage, ownTeamOnly, busy, props }: { group: OrgFunctionGroup; canManage: boolean; ownTeamOnly: boolean; busy: boolean; props: CompanyStructureScreenProps }) {
  const fn = group.functionCode;
  return (
    <section className={styles.group} aria-label={FUNCTION_TITLE[fn]}>
      <h2 className={[typeClass('heading-section'), styles.groupTitle].join(' ')}>{FUNCTION_TITLE[fn]}</h2>
      {group.unresolved.length > 0 ? (
        <div className={[styles.banner, styles.bannerWarning].join(' ')} role="status">
          <div>
            <div className={typeClass('body-strong')}>Требуют решения ({group.unresolved.length})</div>
            <ul className={styles.list}>
              {group.unresolved.map((u) => (
                <li key={`${u.kind}-${u.memberUserId}`} className={typeClass('body')}>
                  {u.memberName} · руководитель: {u.managerName} — {u.kind === 'MANAGER_UNAVAILABLE' ? 'руководитель недоступен, сотрудник ждёт решения' : 'сотрудник недоступен, закройте его назначение'}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
      <div className={styles.cards}>
        {group.managers.length === 0 ? <p className={[typeClass('body'), styles.secondary].join(' ')}>Руководителей пока нет</p> : null}
        {group.managers.map((m) => <ManagerCard key={m.userId} fn={fn} group={group} manager={m} canManage={canManage} busy={busy} props={props} />)}
        {!ownTeamOnly ? (
          <section className={styles.card} aria-label={`${FUNCTION_TITLE[fn]}: ${NO_MANAGER_LABEL}`}>
            <h3 className={typeClass('body-strong')}>{NO_MANAGER_LABEL}</h3>
            {group.unassigned.length === 0 ? <span className={[typeClass('body'), styles.secondary].join(' ')}>Все активные сотрудники закреплены за руководителем</span> : (
              <ul className={styles.list}>
                {group.unassigned.map((e) => <EmployeeBlock key={e.userId} fn={fn} group={group} employee={e} canManage={canManage} busy={busy} managerName={null} props={props} />)}
              </ul>
            )}
          </section>
        ) : null}
      </div>
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
        description="Организационная подчинённость сотрудников. Роль в системе, организационная команда и назначения на объекты независимы: перевод к другому руководителю не меняет ни роль, ни состав объектов."
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
          {structure.scope === 'OWN_TEAM' ? <p className={[typeClass('body'), styles.secondary].join(' ')}>Показана только ваша организационная команда.</p> : null}
          {structure.management ? (
            <section className={styles.group} aria-label="Руководство">
              <h2 className={[typeClass('heading-section'), styles.groupTitle].join(' ')}>Руководство</h2>
              <div className={styles.cards}>
                {structure.management.deputies.length === 0 ? <p className={[typeClass('body'), styles.secondary].join(' ')}>Заместитель директора не назначен</p> : null}
                {structure.management.deputies.map((d) => (
                  <section key={d.userId} className={styles.card} aria-label={`Руководство: ${d.name}`}>
                    <div className={styles.cardHead}>
                      <h3 className={typeClass('body-strong')}>{d.name}</h3>
                      {!d.isActive ? <StatusBadge variant="Attention">Доступ отключён</StatusBadge> : null}
                    </div>
                    <span className={[typeClass('label'), styles.secondary].join(' ')}>{roleLabel('DEPUTY_DIRECTOR')}</span>
                    <span className={typeClass('label')}>Руководителей проектов в подчинении: {d.projectManagerCount}</span>
                  </section>
                ))}
              </div>
            </section>
          ) : null}
          {groups.map((g) => <FunctionSection key={g.functionCode} group={g} canManage={structure.canManage} ownTeamOnly={structure.scope === 'OWN_TEAM'} busy={busy} props={props} />)}
        </>
      ) : null}
    </AppShell>
  );
}
