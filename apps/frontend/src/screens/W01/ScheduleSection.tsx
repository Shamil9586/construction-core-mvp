import { Button, StatusBadge, typeClass } from '../../design-system';
import type { W01ScheduleView } from '../../view-models/schedule';
import styles from './ScheduleSection.module.css';

/**
 * GPR-1 — what the Object's production schedule says about THIS work: planned start and finish, the schedule state and the delay. A summary,
 * deliberately not the schedule itself — the full table lives on the Object's «График производства работ», one click away. It sits apart from
 * the work's execution, СК, ИД and СДО sections and feeds none of them (nor do they feed it).
 *
 * Not offered (`Hidden`: a role or runtime that cannot read the schedule) or still loading: nothing is rendered, not even a heading — absence
 * of the capability is not a statement about this work. A failed load is a quiet note, not a verdict.
 */
export interface ScheduleSectionProps {
  schedule?: W01ScheduleView;
  /** Opens «График производства работ» of the work's object. */
  onOpenSchedule?: () => void;
}

export function ScheduleSection({ schedule, onOpenSchedule }: ScheduleSectionProps) {
  if (!schedule || schedule.kind === 'Hidden' || schedule.kind === 'Loading') return null;
  if (schedule.kind === 'Error') {
    return <p className={[styles.note, typeClass('label')].join(' ')}>График производства работ не загружен: {schedule.message}</p>;
  }

  const open = onOpenSchedule ? (
    <div className={styles.actions}>
      <Button variant="Secondary" arrow="forward" onClick={onOpenSchedule}>
        График производства работ объекта
      </Button>
    </div>
  ) : null;

  return (
    <>
      <h2 className={[styles.groupTitle, typeClass('heading-card')].join(' ')}>График производства работ</h2>
      <section className={styles.section}>
        <div className={styles.card}>
          {schedule.kind === 'NoBaseline' ? (
            <span className={typeClass('body')}>График производства работ по объекту не утверждён — сроки работы не контролируются.</span>
          ) : schedule.kind === 'NotScheduled' ? (
            <span className={typeClass('body')}>Работа не включена в утверждённый график объекта.</span>
          ) : (
            <dl className={styles.list}>
              <div className={styles.item}>
                <dt className={[styles.label, typeClass('label')].join(' ')}>Плановое начало по графику</dt>
                <dd className={typeClass('body-strong')}>{schedule.plannedStart}</dd>
              </div>
              <div className={styles.item}>
                <dt className={[styles.label, typeClass('label')].join(' ')}>Плановое окончание по графику</dt>
                <dd className={typeClass('body-strong')}>{schedule.plannedFinish}</dd>
              </div>
              <div className={styles.item}>
                <dt className={[styles.label, typeClass('label')].join(' ')}>Состояние по графику</dt>
                <dd>
                  <StatusBadge variant={schedule.state.variant}>{schedule.state.label}</StatusBadge>
                </dd>
              </div>
              {schedule.delay ? (
                <div className={styles.item}>
                  <dt className={[styles.label, typeClass('label')].join(' ')}>Отставание</dt>
                  <dd className={typeClass('body-strong')}>{schedule.delay}</dd>
                </div>
              ) : null}
              <div className={styles.item}>
                <dt className={[styles.label, typeClass('label')].join(' ')}>Позиций в графике</dt>
                <dd className={typeClass('body-strong')}>
                  {schedule.entryCount}
                  {schedule.zones ? ` · ${schedule.zones}` : ''}
                </dd>
              </div>
            </dl>
          )}
          {open}
        </div>
      </section>
    </>
  );
}
