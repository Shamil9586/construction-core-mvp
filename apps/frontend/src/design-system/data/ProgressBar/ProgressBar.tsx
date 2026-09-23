import { typeClass } from '../../tokens';
import styles from './ProgressBar.module.css';

/**
 * Data / ProgressBar
 *
 * Shows how much of a planned volume has been done. That is the whole of it.
 *
 * The bar says nothing about quality, about acceptance, about whether the work is
 * late and about whether it is finished. A value of 100 renders as a full track
 * and nothing else — no completion styling, no tick, no change of colour — because
 * physical volume and completion are different claims, and the second one belongs
 * to a contour this component knows nothing about.
 *
 * `null` is a real state: progress is genuinely unknown when planned quantity is
 * zero or no fact has been reported. It renders as an empty track *with a caption*,
 * since a bare empty track would be read as a confident zero.
 */

export type ProgressBarSize = 'Inline' | 'Block';

export interface ProgressBarProps {
  /** Percentage done, or `null` when there is no measurement. */
  value: number | null;
  /** Accessible name — what this bar measures. Required. */
  label: string;
  /** `Inline` for a table row, `Block` to fill its container. */
  size?: ProgressBarSize;
  /** Caption shown in place of a value. */
  noDataLabel?: string;
  className?: string;
}

export function ProgressBar({
  value,
  label,
  size = 'Inline',
  noDataLabel = 'Нет данных',
  className,
}: ProgressBarProps) {
  const hasValue = value !== null && Number.isFinite(value);

  const classes = [
    styles.root,
    size === 'Block' ? styles.block : styles.inline,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  if (!hasValue) {
    return (
      <div className={classes}>
        <div className={styles.track} />
        <span className={[styles.noDataLabel, typeClass('label')].join(' ')}>
          {noDataLabel}
        </span>
      </div>
    );
  }

  // Clamped for the width only. `aria-valuenow` keeps the figure it was given, so
  // an out-of-range value stays visible to assistive technology instead of being
  // quietly rounded into something plausible.
  const width = Math.min(100, Math.max(0, value));

  return (
    <div className={classes}>
      <div
        className={styles.track}
        role="progressbar"
        aria-label={label}
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className={styles.fill} style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}
