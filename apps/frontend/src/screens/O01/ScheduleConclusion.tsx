import { Button, StatusBadge, typeClass } from '../../design-system';
import type { O01ScheduleView } from '../../view-models/schedule';
import styles from './ScheduleConclusion.module.css';

/**
 * GPR-1 — the production-level conclusion inside O01's «Состояние графика» card: «По графику» / «Есть отставание» / «График не утверждён»,
 * from the Object's approved production schedule (never from `healthStatus`, which mixes in issues, staleness and late ИД / СДО).
 *
 * When the schedule is not offered (`Hidden`: a role or object that cannot read it, or the demo runtime) the card keeps the statement it
 * always made — no confirmed per-object conclusion exists for this viewer. Nothing here carries quality (СК), ИД or money: the delayed
 * positions are listed by name and days, with the categories of the delay reasons somebody has recorded.
 */
export interface ScheduleConclusionProps {
  schedule?: O01ScheduleView;
  /** Opens «График производства работ» of THIS object. */
  onOpenSchedule?: () => void;
}

const NO_CONFIRMED_CONCLUSION = 'Итоговый статус графика по объекту не определён: в данных нет подтверждённого значения.';

export function ScheduleConclusion({ schedule, onOpenSchedule }: ScheduleConclusionProps) {
  const note = [styles.note, typeClass('label')].join(' ');
  if (!schedule || schedule.kind === 'Hidden') return <span className={note}>{NO_CONFIRMED_CONCLUSION}</span>;
  if (schedule.kind === 'Loading') return <span className={note}>Загрузка графика производства работ…</span>;
  if (schedule.kind === 'Error') return <span className={note}>График производства работ не загружен: {schedule.message}</span>;

  const open = onOpenSchedule ? (
    <div className={styles.actions}>
      <Button variant="Secondary" arrow="forward" onClick={onOpenSchedule}>
        {schedule.kind === 'NoBaseline' && schedule.canPrepare ? 'Подготовить график' : 'График производства работ'}
      </Button>
    </div>
  ) : null;

  if (schedule.kind === 'NoBaseline') {
    return (
      <div className={styles.block}>
        <StatusBadge variant={schedule.status.variant}>{schedule.status.label}</StatusBadge>
        <span className={[styles.text, typeClass('body')].join(' ')}>{schedule.text}</span>
        {open}
      </div>
    );
  }
  return (
    <div className={styles.block}>
      <StatusBadge variant={schedule.status.variant}>{schedule.status.label}</StatusBadge>
      <span className={[styles.text, typeClass('body')].join(' ')}>{schedule.text}</span>
      {schedule.delayed.length > 0 ? (
        <ul className={styles.list} aria-label="Позиции с отставанием">
          {schedule.delayed.map((item) => (
            <li key={item.label} className={typeClass('body')}>
              <span className={typeClass('body-strong')}>{item.label}</span> — {item.delay}
              {item.reasons.length ? <span className={styles.reasons}>Причины: {item.reasons.join(', ')}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {schedule.notes.map((line) => (
        <span key={line} className={note}>
          {line}
        </span>
      ))}
      <span className={note}>{schedule.baseline}</span>
      {open}
    </div>
  );
}
