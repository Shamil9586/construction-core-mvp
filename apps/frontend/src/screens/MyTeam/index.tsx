import { useState, type ReactNode } from 'react';
import { AppShell, Button, DataTable, PageHeader, StatusBadge, typeClass } from '../../design-system';
import type { DataTableColumn } from '../../design-system';
import type { Handover, MyTeam, ObjectTeamSummary } from '../../data/functionTeamsApi';
import { HANDOVER_STATUS_LABEL } from '../../view-models/teams';
import styles from './MyTeam.module.css';

/**
 * «Моя команда ПТО» (`/my-team`, PBX-3A). PTO_HEAD: «Моя команда ПТО» (organizational team) and
 * «Команда объекта» for every object the user CURRENTLY leads — add an engineer from the own
 * organizational team, remove any current engineer (inherited ones included). PTO engineer:
 * read-only view of own manager and own objects. Cross-team moves are a Deputy action and are
 * not offered here; the backend enforces every rule regardless of the controls rendered.
 */
export type MyTeamLoad = { status: 'Loading' } | { status: 'Error'; message: string } | { status: 'Loaded'; team: MyTeam };
export interface MyTeamNotice { kind: 'success' | 'error'; text: string }

export interface MyTeamScreenProps {
  sidebar: ReactNode;
  load: MyTeamLoad;
  userId: string;
  canManage: boolean;
  notice: MyTeamNotice | null;
  busy: boolean;
  onRetry: () => void;
  onDismissNotice: () => void;
  onAdd: (objectId: string, memberUserId: string) => Promise<boolean>;
  onRemove: (objectId: string, memberUserId: string) => Promise<boolean>;
  onAcknowledge: (handover: Handover) => Promise<boolean>;
}

const orgColumns: DataTableColumn[] = [
  { key: 'engineer', header: 'Инженер', width: 'fill' },
  { key: 'objects', header: 'Работает на объектах', width: 320 },
];
const memberColumns: DataTableColumn[] = [
  { key: 'engineer', header: 'Инженер', width: 'fill' },
  { key: 'origin', header: 'Организационная команда', width: 260 },
  { key: 'actions', header: 'Действия', width: 200, align: 'end' },
];

function ObjectTeamBlock({ team, object, canManage, busy, onAdd, onRemove }: { team: MyTeam; object: ObjectTeamSummary; canManage: boolean; busy: boolean; onAdd: MyTeamScreenProps['onAdd']; onRemove: MyTeamScreenProps['onRemove'] }) {
  const [candidate, setCandidate] = useState('');
  const onObject = new Set(object.members.map((m) => m.userId));
  const candidates = team.orgTeam.filter((m) => m.isActive && !onObject.has(m.userId));
  const selectId = `add-${object.objectId}`;
  return (
    <section className={styles.section} aria-label={`Команда объекта: ${object.name}`}>
      <div className={styles.sectionHead}>
        <div>
          <h2 className={typeClass('body-strong')}>Команда объекта: {object.name}</h2>
          <span className={[typeClass('label'), styles.secondary].join(' ')}>Начальник ПТО объекта: {object.lead?.name ?? 'не назначен'}</span>
        </div>
      </div>
      {canManage ? (
        <div className={styles.opForm}>
          <div className={styles.field}>
            <label htmlFor={selectId} className={typeClass('label')}>Добавить из моей команды</label>
            <select id={selectId} className={styles.input} value={candidate} onChange={(e) => setCandidate(e.target.value)} disabled={busy}>
              <option value="">{candidates.length === 0 ? 'Нет доступных инженеров' : 'Выберите инженера'}</option>
              {candidates.map((c) => <option key={c.userId} value={c.userId}>{c.name}</option>)}
            </select>
          </div>
          <Button variant="Secondary" disabled={busy || candidate === ''} aria-label={`Добавить на объект: ${object.name}`} onClick={() => { void onAdd(object.objectId, candidate).then((ok) => { if (ok) setCandidate(''); }); }}>Добавить на объект</Button>
        </div>
      ) : null}
      <div className={styles.section}>
        <DataTable columns={memberColumns} title="Инженеры ПТО на объекте" context={`${object.members.length} инженеров`} state={object.members.length === 0 ? 'Empty' : 'Default'} emptyLabel="На объекте нет инженеров ПТО">
          {object.members.map((m) => (
            <tr key={m.assignmentId} className={styles.row}>
              <td className={styles.cell}><span className={typeClass('body-strong')}>{m.name}</span>{!m.isActive ? <div><StatusBadge variant="Attention">Доступ отключён</StatusBadge></div> : null}</td>
              <td className={styles.cell}><span className={[typeClass('body'), styles.secondary].join(' ')}>{m.inherited ? `из команды: ${m.orgManagerName ?? '—'}` : 'моя команда'}</span></td>
              <td className={styles.cell}>{canManage ? <Button variant="Secondary" disabled={busy} aria-label={`Снять с объекта: ${m.name}, ${object.name}`} onClick={() => { void onRemove(object.objectId, m.userId); }}>Снять с объекта</Button> : null}</td>
            </tr>
          ))}
        </DataTable>
      </div>
    </section>
  );
}

export function MyTeamScreen(props: MyTeamScreenProps) {
  const { sidebar, load, canManage, notice, busy, userId } = props;
  return (
    <AppShell sidebar={sidebar}>
      <PageHeader eyebrow="ПТО" title="Моя команда ПТО" description={canManage ? 'Ваша организационная команда и команды ПТО на объектах, которые вы ведёте.' : 'Ваш начальник и объекты, на которых вы работаете.'} />
      <div className={styles.messages}>
        {notice ? (
          <div className={[styles.banner, notice.kind === 'error' ? styles.bannerError : styles.bannerSuccess].join(' ')} role={notice.kind === 'error' ? 'alert' : 'status'}>
            <span className={typeClass('body')}>{notice.text}</span>
            <button type="button" className={styles.linkButton} onClick={props.onDismissNotice}>Закрыть</button>
          </div>
        ) : null}
        {load.status === 'Error' ? (
          <div className={[styles.banner, styles.bannerError].join(' ')} role="alert">
            <span className={typeClass('body')}>Не удалось загрузить команду: {load.message}</span>
            <button type="button" className={styles.linkButton} onClick={props.onRetry}>Повторить</button>
          </div>
        ) : null}
      </div>
      {load.status === 'Loading' ? <p className={typeClass('body')} aria-live="polite">Загрузка…</p> : null}
      {load.status === 'Loaded' ? (
        <>
          {load.team.handovers.filter((h) => h.status === 'OPEN' && h.incomingUserId === userId).map((h) => (
            <div key={h.id} className={[styles.banner, styles.bannerWarning].join(' ')} role="status">
              <span className={typeClass('body')}>Передача дел по объекту «{h.objectName}»: {h.outgoingName} → вам. Данные остаются на объекте; подтвердите, что ознакомились.</span>
              <Button disabled={busy} aria-label={`Подтвердить передачу: ${h.objectName}`} onClick={() => { void props.onAcknowledge(h); }}>Подтвердить передачу</Button>
            </div>
          ))}
          {canManage ? (
            <section className={styles.section} aria-label="Моя команда ПТО">
              <DataTable columns={orgColumns} title="Моя команда ПТО" context={`${load.team.orgTeam.length} инженеров`} state={load.team.orgTeam.length === 0 ? 'Empty' : 'Default'} emptyLabel="В вашей команде пока нет инженеров">
                {load.team.orgTeam.map((m) => (
                  <tr key={m.assignmentId} className={styles.row}>
                    <td className={styles.cell}><span className={typeClass('body-strong')}>{m.name}</span>{!m.isActive ? <div><StatusBadge variant="Attention">Доступ отключён</StatusBadge></div> : null}</td>
                    <td className={styles.cell}><span className={[typeClass('body'), styles.secondary].join(' ')}>{m.onObjectIds.length === 0 ? 'ни на одном из моих объектов' : load.team.objects.filter((o) => m.onObjectIds.includes(o.objectId)).map((o) => o.name).join(', ')}</span></td>
                  </tr>
                ))}
              </DataTable>
            </section>
          ) : (
            <section className={styles.section}>
              <span className={typeClass('body')}>Начальник ПТО: {load.team.orgManager?.name ?? 'не назначен'}</span>
            </section>
          )}
          {load.team.objects.length === 0 ? <p className={typeClass('body')}>{canManage ? 'Вы пока не ведёте ни одного объекта.' : 'Вы пока не назначены ни на один объект.'}</p> : null}
          {load.team.objects.map((o) => <ObjectTeamBlock key={o.objectId} team={load.team} object={o} canManage={canManage} busy={busy} onAdd={props.onAdd} onRemove={props.onRemove} />)}
          {load.team.handovers.length > 0 ? (
            <section className={styles.section} aria-label="Мои передачи дел">
              <span className={typeClass('label')}>Мои передачи дел</span>
              <ul className={styles.list}>
                {load.team.handovers.map((h) => <li key={h.id} className={typeClass('body')}>«{h.objectName}»: {h.outgoingName} → {h.incomingName} · {HANDOVER_STATUS_LABEL[h.status]}</li>)}
              </ul>
            </section>
          ) : null}
        </>
      ) : null}
    </AppShell>
  );
}
