import type { ReactNode } from 'react';
import { SCOPE_CLASS } from '../../tokens';
import styles from './AppShell.module.css';

/**
 * Navigation / AppShell
 *
 * The four landmarks — `aside`, `header`, `main`, and the `nav` a `sidebar` slot
 * renders inside it — laid out and given the design system's appearance. Nothing
 * here knows what a route is. It takes finished content for each region and
 * renders it; which screen is active, what the URL says, and how `objectId` or
 * `workId` survive a transition are entirely the caller's concern; a routing
 * layer (react-router or otherwise) wraps this component from outside rather
 * than living inside it, matching how `Sidebar` takes `onNavigate` rather than
 * calling `useNavigate` itself.
 *
 * `SCOPE_CLASS` is applied at this root rather than per-screen: AppShell is
 * meant to sit once at the top of the real application, so every screen mounted
 * inside it inherits the type-scale baseline and tabular figures without asking
 * for them again.
 *
 * The legacy stylesheet carries bare `aside`, `header`, `main` rules (fixed
 * width, fixed height, hardcoded padding — see `apps/frontend/src/style.css`).
 * Every property those rules set is re-declared here on the equivalent class, the
 * same discipline the type scale uses against bare `h1`/`h2`/`small`, so this
 * shell renders identically whether or not that sheet is loaded.
 *
 * AppShell does not size itself to the viewport — it fills whatever height its
 * mounting context gives it (`height: 100%`). Mounted at the application root,
 * that context is `html, body, #root { height: 100% }`; inside a bounded
 * container, such as this gallery, it fills exactly that box. Either way `aside`
 * and `main` scroll independently rather than the document scrolling as a whole.
 */

export interface AppShellProps {
  /** Rendered inside `<aside>` — typically `Sidebar`. */
  sidebar: ReactNode;
  /** Rendered inside `<header>`. Omitted entirely when there is no top bar. */
  topbar?: ReactNode;
  /** Rendered inside `<main>` — breadcrumb, page header and screen content. */
  children: ReactNode;
  /** id placed on `<main>`, the skip link's target. */
  mainId?: string;
  /** Visible only once focused — lets keyboard use bypass the navigation. */
  skipLabel?: string;
  className?: string;
}

export function AppShell({
  sidebar,
  topbar,
  children,
  mainId = 'cc-main-content',
  skipLabel = 'Перейти к содержимому',
  className,
}: AppShellProps) {
  const classes = [SCOPE_CLASS, styles.shell, className].filter(Boolean).join(' ');

  return (
    <div className={classes}>
      <a href={`#${mainId}`} className={styles.skipLink}>
        {skipLabel}
      </a>

      <aside className={styles.aside}>{sidebar}</aside>

      <div className={styles.workspace}>
        {topbar ? (
          <header className={styles.header}>
            {/*
              A plain wrapper, never the caller's content as a direct child of
              <header>. Legacy hides a bare `header > span` under 760px
              (`header>span{display:none}`) — a child combinator survives even
              though a class always beats an element selector on the properties
              both sides set, because that rule is the only one that mentions
              `display` on such a span at all. Nothing the caller passes here is
              ever a direct child of the real element, so that selector can never
              match.
            */}
            <div className={styles.headerInner}>{topbar}</div>
          </header>
        ) : null}

        {/*
          tabIndex={-1}: not a normal tab stop, but focusable once the skip link
          moves here, which is what makes the jump land keyboard focus instead of
          only scrolling the viewport.
        */}
        <main id={mainId} tabIndex={-1} className={styles.main}>
          {children}
        </main>
      </div>
    </div>
  );
}
