import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { typeClass } from '../../tokens';
import styles from './Button.module.css';

/**
 * Controls / Button
 *
 * A plain <button> with the design system's appearance. It performs no action of
 * its own — no navigation, no submission, no workflow step. The caller supplies
 * `onClick`.
 *
 * Built on the native element deliberately: Enter and Space activate it, the
 * disabled state is conveyed to assistive technology rather than imitated, and
 * the focus ring lands on something that was always focusable. A clickable div
 * would need all three rebuilt, and would get at least one of them wrong.
 */

export type ButtonVariant = 'Primary' | 'Secondary';
export type ButtonWidth = 'Hug' | 'Fill';
export type ButtonArrow = 'none' | 'forward' | 'back';

export interface ButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'> {
  children: ReactNode;
  variant?: ButtonVariant;
  width?: ButtonWidth;
  /** Trailing `→` or leading `←`, per the label. */
  arrow?: ButtonArrow;
  /** Replaces the arrow with a spinner; the label stays and the button is inert. */
  loading?: boolean;
  className?: string;
}

const ARROW: Record<Exclude<ButtonArrow, 'none'>, string> = {
  forward: '→',
  back: '←',
};

export function Button({
  children,
  variant = 'Primary',
  width = 'Hug',
  arrow = 'none',
  loading = false,
  disabled = false,
  type = 'button',
  className,
  ...rest
}: ButtonProps) {
  const classes = [
    styles.button,
    variant === 'Primary' ? styles.primary : styles.secondary,
    width === 'Fill' ? styles.fill : styles.hug,
    typeClass('ui-strong'),
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const icon = loading ? (
    <span className={styles.icon} aria-hidden="true">
      <span className={styles.spinner} />
    </span>
  ) : arrow !== 'none' ? (
    <span className={styles.icon} aria-hidden="true">
      {ARROW[arrow]}
    </span>
  ) : null;

  return (
    <button
      {...rest}
      type={type}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {arrow === 'back' && icon}
      <span className={styles.label}>{children}</span>
      {arrow !== 'back' && icon}
    </button>
  );
}
