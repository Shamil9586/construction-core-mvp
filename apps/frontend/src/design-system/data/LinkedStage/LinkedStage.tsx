import { typeClass } from '../../tokens';
import styles from './LinkedStage.module.css';

/**
 * Data / LinkedStage
 *
 * A stack of related records, each a caption and its state, optionally closed by
 * a summary figure.
 *
 * The relation it shows is visual: these records sit together and are read
 * together. It is not a sequence, not a pipeline and not a set of steps — nothing
 * here says one record follows from another, because in the product they do not.
 * ИД, СДО and financial closing are independent contours with their own states,
 * and a component that implied progression between them would contradict that
 * (Design Rules §14, §15; decision D-12 keeps this separate from `Sequence` for
 * exactly this reason).
 *
 * State text is supplied by the caller. The specification names five stage states
 * — Draft, InProgress, Ready, Closed, NotSubmitted — and assigns them no visual
 * difference in v1, so they arrive here as words, not as a variant this component
 * interprets. Nothing is inferred from them.
 */

export interface LinkedStageItem {
  /** What the record is about, e.g. "ИД по АОСР". */
  label: string;
  /** Its state, already worded, e.g. "Черновик · номер не присвоен". */
  state: string;
}

export interface LinkedStageSummary {
  label: string;
  /** The figure, already formatted, e.g. "2,0 млн ₽". */
  value: string;
}

export interface LinkedStageProps {
  items: LinkedStageItem[];
  summary?: LinkedStageSummary;
  className?: string;
}

export function LinkedStage({ items, summary, className }: LinkedStageProps) {
  const classes = [styles.root, className].filter(Boolean).join(' ');

  return (
    <dl className={classes}>
      {items.map((item, index) => (
        <div className={styles.row} key={`${item.label}-${index}`}>
          <dt className={[styles.label, typeClass('label')].join(' ')}>
            {item.label}
          </dt>
          <dd className={[styles.state, typeClass('label')].join(' ')}>
            {item.state}
          </dd>
        </div>
      ))}

      {summary ? (
        <div className={styles.summaryRow}>
          <dt className={[styles.label, typeClass('label')].join(' ')}>
            {summary.label}
          </dt>
          <dd
            className={[styles.summaryValue, typeClass('metric-lg')].join(' ')}
          >
            {summary.value}
          </dd>
        </div>
      ) : null}
    </dl>
  );
}
