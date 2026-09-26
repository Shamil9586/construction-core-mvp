import type { ReactNode } from 'react';
import { typeClass } from '../../tokens';
import styles from './PageHeader.module.css';

/**
 * Navigation / PageHeader
 *
 * The screen title block: an optional eyebrow, the one `<h1>` the screen gets,
 * an optional description, and a right-aligned actions slot. It renders exactly
 * what it is given — no route, no count, no status computed from data, mirroring
 * how `DataTable`'s caption takes a finished `title`/`context` pair rather than
 * deriving either from its rows.
 */

export interface PageHeaderProps {
  /** The screen's one heading. */
  title: string;
  /** Category label above the title, e.g. "ОБЪЕКТ". */
  eyebrow?: string;
  /** Supporting line below the title. */
  description?: string;
  /** Right-aligned slot — buttons, a status badge, a tag. */
  actions?: ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  eyebrow,
  description,
  actions,
  className,
}: PageHeaderProps) {
  const classes = [styles.header, className].filter(Boolean).join(' ');

  return (
    <div className={classes}>
      <div className={styles.stack}>
        {eyebrow ? (
          <span className={[styles.eyebrow, typeClass('eyebrow')].join(' ')}>
            {eyebrow}
          </span>
        ) : null}
        <h1 className={[styles.title, typeClass('heading-page')].join(' ')}>{title}</h1>
        {description ? (
          <p className={[styles.description, typeClass('body')].join(' ')}>
            {description}
          </p>
        ) : null}
      </div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </div>
  );
}
