import { typeClass } from '../../tokens';
import styles from './PlanFact.module.css';

/**
 * Data / PlanFact
 *
 * Two to four figures side by side, each with its own caption and its own unit.
 *
 * Plan and fact stay separate, and the component has no way to make them
 * otherwise: it takes finished strings and lays them out. There is no prop for a
 * difference, no derived field, no arithmetic. That is the product rule made
 * structural — a gap is expressed by showing both figures and letting the status
 * beside them say what it means, not by subtracting one from the other and
 * renaming the result (Design Rules §7).
 *
 * The plan for the whole work and the plan as of today are two different figures
 * with two different captions. Passing them as two items is correct; merging them
 * into one is not.
 */

export interface PlanFactItem {
  /** What this figure is, e.g. "План на дату". */
  label: string;
  /** The figure, already formatted, e.g. "75%" or "500". */
  value: string;
  /** Unit and context, e.g. "м² · физически выполнено". */
  meta?: string;
}

export type PlanFactEmphasis = 'Equal' | 'LeadValue';

export interface PlanFactProps {
  items: PlanFactItem[];
  /** `LeadValue` renders the first figure larger than the rest. */
  emphasis?: PlanFactEmphasis;
  /** Defaults to the number of items. */
  columns?: 2 | 3 | 4;
  className?: string;
}

function columnClass(count: number): string {
  if (count <= 2) return styles.columns2 ?? '';
  if (count === 3) return styles.columns3 ?? '';
  return styles.columns4 ?? '';
}

export function PlanFact({
  items,
  emphasis = 'Equal',
  columns,
  className,
}: PlanFactProps) {
  const count = columns ?? items.length;

  const classes = [styles.root, columnClass(count), className]
    .filter(Boolean)
    .join(' ');

  return (
    <dl className={classes}>
      {items.map((item, index) => {
        const lead = emphasis === 'LeadValue' && index === 0;
        return (
          <div className={styles.item} key={`${item.label}-${index}`}>
            <dt className={[styles.label, typeClass('label')].join(' ')}>
              {item.label}
            </dt>
            <dd
              className={[
                styles.value,
                typeClass(lead ? 'metric-xl' : 'metric-lg'),
              ].join(' ')}
            >
              {item.value}
            </dd>
            {item.meta ? (
              <dd className={[styles.meta, typeClass('meta')].join(' ')}>
                {item.meta}
              </dd>
            ) : null}
          </div>
        );
      })}
    </dl>
  );
}
