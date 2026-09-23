import { typeClass } from '../../tokens';
import styles from './Breadcrumb.module.css';

/**
 * Navigation / Breadcrumb
 *
 * A trail of `<button>`s, standard `nav > ol > li` breadcrumb markup so the
 * trail, not just its final label, is what assistive technology announces. Each
 * item calls `onSelect` with nothing else — no `href`, no route template — so an
 * object's or a work's identity is never stored here. A screen builds the trail
 * on every render and closes over the real id in the handler it hands this
 * component:
 *
 *   items={[
 *     { label: 'Объекты', onSelect: () => onNavigate('/objects') },
 *     { label: object.name, onSelect: () => onNavigate(`/objects/${object.id}`) },
 *     { label: work.name },  // current — no onSelect, not interactive
 *   ]}
 *
 * `object.id` and `work.id` live in that closure, not in a prop this component
 * parses or defaults — there is nothing here for a stale or hardcoded identifier
 * to hide behind.
 *
 * The last item is always rendered as the current page (`aria-current="page"`,
 * not a button) regardless of whether it carries `onSelect`, since a trail's own
 * last step is never itself a place to navigate to.
 */

export interface BreadcrumbItem {
  label: string;
  /** Omitted on the current step — it is not interactive. */
  onSelect?: () => void;
}

export interface BreadcrumbProps {
  items: BreadcrumbItem[];
  /** Accessible name for the `<nav>` landmark, distinct from `Sidebar`'s. */
  navLabel?: string;
  className?: string;
}

export function Breadcrumb({
  items,
  navLabel = 'Хлебные крошки',
  className,
}: BreadcrumbProps) {
  const classes = [styles.breadcrumb, className].filter(Boolean).join(' ');

  return (
    <nav className={classes} aria-label={navLabel}>
      <ol className={styles.list}>
        {items.map((item, index) => {
          const isLast = index === items.length - 1;
          const isCurrent = isLast || !item.onSelect;

          return (
            <li key={`${index}-${item.label}`} className={styles.entry}>
              {isCurrent ? (
                <span
                  className={[styles.current, typeClass('ui')].join(' ')}
                  aria-current={isLast ? 'page' : undefined}
                >
                  {item.label}
                </span>
              ) : (
                <button
                  type="button"
                  className={[styles.crumb, typeClass('ui')].join(' ')}
                  onClick={item.onSelect}
                >
                  {item.label}
                </button>
              )}
              {!isLast ? (
                <span className={styles.separator} aria-hidden="true">
                  /
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
