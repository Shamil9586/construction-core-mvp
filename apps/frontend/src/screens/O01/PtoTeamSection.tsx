import { useState } from 'react';
import { typeClass } from '../../design-system';
import type { ObjectPtoTeam } from '../../data/functionTeamsApi';
import styles from './O01.module.css';

/**
 * PBX-3A — «ПТО объекта» block on the object screen: current PTO_HEAD and current PTO engineers.
 * An engineer whose organizational manager differs from the object lead is a valid, inherited member
 * and is only annotated, never flagged. Assignment history is behind its own disclosure and is never
 * mixed into the current team.
 */
export type PtoTeamLoad = { status: 'Loading' } | { status: 'Error'; message: string } | { status: 'Loaded'; team: ObjectPtoTeam };

const date = (iso: string) => iso.slice(0, 10);

export function PtoTeamSection({ load }: { load: PtoTeamLoad }) {
  const [historyOpen, setHistoryOpen] = useState(false);
  return (
    <section className={styles.section} aria-label="ПТО объекта">
      <div className={styles.readinessCard}>
        <h2 className={[styles.detailLabel, typeClass('label')].join(' ')}>ПТО объекта</h2>
        {load.status === 'Loading' ? <span className={typeClass('body')}>Загрузка…</span> : null}
        {load.status === 'Error' ? <span className={typeClass('body')} role="alert">Не удалось загрузить команду ПТО: {load.message}</span> : null}
        {load.status === 'Loaded' ? (
          <>
            <dl className={styles.details}>
              <div className={styles.detailItem}>
                <dt className={[styles.detailLabel, typeClass('label')].join(' ')}>Начальник ПТО</dt>
                <dd className={[styles.detailValue, typeClass('body-strong')].join(' ')}>{load.team.current.lead ? load.team.current.lead.name : 'Не назначен'}</dd>
              </div>
              <div className={styles.detailItem}>
                <dt className={[styles.detailLabel, typeClass('label')].join(' ')}>Инженеры ПТО</dt>
                <dd className={[styles.detailValue, typeClass('body')].join(' ')}>
                  {load.team.current.members.length === 0 ? 'Не назначены' : (
                    <ul className={styles.teamList}>
                      {load.team.current.members.map((m) => (
                        <li key={m.assignmentId}>
                          {m.name}
                          {m.inherited && m.orgManagerName ? <span className={typeClass('label')}> · из команды: {m.orgManagerName}</span> : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </dd>
              </div>
            </dl>
            <button type="button" className={styles.historyToggle} aria-expanded={historyOpen} onClick={() => setHistoryOpen((v) => !v)}>
              {historyOpen ? 'Скрыть историю назначений' : 'История назначений'}
            </button>
            {historyOpen ? (
              <div aria-label="История назначений ПТО">
                {load.team.history.leads.length + load.team.history.members.length === 0 ? <span className={typeClass('body')}>История пуста</span> : (
                  <ul className={styles.teamList}>
                    {load.team.history.leads.map((h) => <li key={h.assignmentId} className={typeClass('body')}>Начальник ПТО: {h.name} · {date(h.startedAt)} — {date(h.endedAt)}</li>)}
                    {load.team.history.members.map((h) => <li key={h.assignmentId} className={typeClass('body')}>Инженер: {h.name} · {date(h.startedAt)} — {date(h.endedAt)}</li>)}
                  </ul>
                )}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}
