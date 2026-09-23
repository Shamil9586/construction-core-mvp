import type { ReactNode } from 'react';
import type { StatusVariant } from '../../tokens';
import { typeClass } from '../../tokens';
import styles from './StatusBadge.module.css';

/**
 * Data / StatusBadge
 *
 * Five visual appearances and a label. The component chooses neither: the caller
 * supplies both, having decided them in a view-model from `scheduleStatus`,
 * `blockers` or another confirmed source. Nothing here inspects data, and no
 * colour is turned into a meaning.
 *
 * The label is required rather than optional, which is the one product rule this
 * component does enforce: colour accompanies a status and never replaces it
 * (Design Rules §16). It matters more here than anywhere else, because `Delayed`
 * and `Attention` are deliberately the same amber — without the words they are
 * not merely hard to tell apart, they are identical.
 *
 * `Blocked` deserves saying out loud, because it is the variant most likely to be
 * wired up wrongly. It is a visual variant and nothing more. It must not be
 * derived from a colour — not from `scheduleStatus === 'RED'`, not from a `RED`
 * severity on an attention signal, not from a red anything. A blocked state is a
 * claim about the work and requires explicit business data to support it:
 * `works[].blockers[]`, which carries the named reason. Red means large schedule
 * variance; blocked means something is standing in the way. Treating the first as
 * the second invents a rule the product model does not have, and does it in the
 * place a director is most likely to act on.
 */

export interface StatusBadgeProps {
  /** Which of the five appearances to render. A visual choice, not a verdict. */
  variant: StatusVariant;
  /** The status text. Required — a badge without a label is not a valid state. */
  children: ReactNode;
  className?: string;
}

const variantClass: Record<StatusVariant, string> = {
  OnTrack: styles.onTrack ?? '',
  Delayed: styles.delayed ?? '',
  Attention: styles.attention ?? '',
  Blocked: styles.blocked ?? '',
  Neutral: styles.neutral ?? '',
};

export function StatusBadge({ variant, children, className }: StatusBadgeProps) {
  const classes = [
    styles.badge,
    variantClass[variant],
    typeClass('label-strong'),
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return <span className={classes}>{children}</span>;
}
