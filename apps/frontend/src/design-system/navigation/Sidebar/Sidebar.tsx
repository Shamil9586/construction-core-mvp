import type { ReactNode } from 'react';
import { typeClass } from '../../tokens';
import styles from './Sidebar.module.css';

/**
 * Navigation / Sidebar
 *
 * The nav rail rendered inside `AppShell`'s `<aside>`. It holds no route table
 * and calls no router: `activeKey` says which item is current and `onNavigate`
 * is called with an item's `key` on activation, exactly like `ObjectRow` takes
 * `onActivate` rather than deciding for itself what "open" means. A screen — or
 * a thin routing adapter above it — owns the mapping from `key` to a URL and
 * supplies both props from `useLocation`/`useNavigate`, so this component never
 * needs to change when the router does.
 *
 * Items are real `<button>`s rather than `<a>`s, the same choice `ObjectRow`
 * made for its row activator and for the same reason: the design system depends
 * on tokens and nothing else, and a `Link` would pull `react-router-dom` in.
 * Enter and Space still work, because that comes free with the element.
 *
 * Focus uses `--cc-focus-ring-inverse` (D-04) — the ordinary ring is 2.0:1
 * against the navy background, and keyboard navigation on every screen starts
 * here.
 */

export interface NavItem {
  /** Opaque to this component — passed back to `onNavigate` unchanged. */
  key: string;
  label: string;
  /** Decorative; the label alone is the accessible name. */
  icon?: ReactNode;
}

export interface SidebarProps {
  items: NavItem[];
  /** `key` of the current item. No item is marked current if nothing matches. */
  activeKey: string;
  onNavigate: (key: string) => void;
  /** Product mark, rendered above the caption and the list. */
  brand?: ReactNode;
  /** One label above the list, e.g. "ПРОИЗВОДСТВЕННЫЙ КОНТРОЛЬ". */
  caption?: string;
  /** Rendered at the bottom of the rail, e.g. an environment note. */
  footer?: ReactNode;
  /** Accessible name for the `<nav>` landmark, distinct from `Breadcrumb`'s. */
  navLabel?: string;
  className?: string;
}

export function Sidebar({
  items,
  activeKey,
  onNavigate,
  brand,
  caption,
  footer,
  navLabel = 'Основная навигация',
  className,
}: SidebarProps) {
  const classes = [styles.sidebar, className].filter(Boolean).join(' ');

  return (
    <div className={classes}>
      {brand ? <div className={styles.brand}>{brand}</div> : null}

      {caption ? (
        <div className={[styles.caption, typeClass('eyebrow')].join(' ')}>{caption}</div>
      ) : null}

      <nav className={styles.nav} aria-label={navLabel}>
        <ul className={styles.list}>
          {items.map((item) => {
            const active = item.key === activeKey;
            return (
              <li key={item.key}>
                <button
                  type="button"
                  className={[
                    styles.item,
                    active ? styles.itemActive : '',
                    typeClass(active ? 'ui-strong' : 'ui'),
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => onNavigate(item.key)}
                >
                  {item.icon ? (
                    <span className={styles.icon} aria-hidden="true">
                      {item.icon}
                    </span>
                  ) : null}
                  <span className={styles.label}>{item.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      {footer ? (
        <div className={[styles.footer, typeClass('meta')].join(' ')}>{footer}</div>
      ) : null}
    </div>
  );
}
