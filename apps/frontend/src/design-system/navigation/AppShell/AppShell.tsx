import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
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
 *
 * F11.1 — below the narrow-viewport breakpoint (AppShell.module.css), `aside`
 * no longer reserves `--cc-sidebar-width`: it is hidden, and the exact same
 * `sidebar` node is rendered a second time inside a native `<dialog>`, opened
 * on demand as an off-canvas drawer by a menu trigger. Desktop/tablet — `aside`
 * always visible at `--cc-sidebar-width` — is unchanged (F11-D01, Option A).
 * Only one of the two is ever reachable at a time, so nothing here duplicates
 * `Sidebar`/`AppSidebar` or the role filtering already inside whatever
 * `sidebar` is — both are the caller's unmodified node, mounted twice.
 *
 * `<dialog>` + `showModal()` is deliberate, not a hand-rolled overlay: the
 * browser provides top-layer stacking, a `::backdrop`, focus containment and
 * Escape-to-close natively, which is the "smallest standards-based
 * implementation" this slice asks for rather than a bespoke focus trap.
 */

export interface AppShellProps {
  /** Rendered inside `<aside>` — typically `Sidebar`. Also rendered inside the narrow-viewport drawer; see the F11.1 note above. */
  sidebar: ReactNode;
  /** Rendered inside `<header>`. Omitted entirely when there is no top bar. */
  topbar?: ReactNode;
  /** Rendered inside `<main>` — breadcrumb, page header and screen content. */
  children: ReactNode;
  /** id placed on `<main>`, the skip link's target. */
  mainId?: string;
  /** Visible only once focused — lets keyboard use bypass the navigation. */
  skipLabel?: string;
  /** Accessible name of the narrow-viewport button that opens the Sidebar drawer. */
  menuLabel?: string;
  /** Accessible name of the Sidebar drawer itself. */
  drawerLabel?: string;
  /** Accessible name of the drawer's own close button. */
  closeDrawerLabel?: string;
  className?: string;
}

export function AppShell({
  sidebar,
  topbar,
  children,
  mainId = 'cc-main-content',
  skipLabel = 'Перейти к содержимому',
  menuLabel = 'Открыть меню навигации',
  drawerLabel = 'Меню навигации',
  closeDrawerLabel = 'Закрыть меню',
  className,
}: AppShellProps) {
  const classes = [SCOPE_CLASS, styles.shell, className].filter(Boolean).join(' ');
  const drawerId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // `drawerOpen` only mirrors the dialog's own open/closed state, for the
  // trigger's aria-expanded — showModal()/close() are what actually move it
  // in and out of the top layer.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (drawerOpen && !dialog.open) dialog.showModal();
    else if (!drawerOpen && dialog.open) dialog.close();
  }, [drawerOpen]);

  // Every way the drawer can close — its own button, a backdrop click, a
  // Sidebar item, Escape (handled natively, no keydown listener needed), or
  // the breakpoint guard below — ends in the browser dispatching `close` on
  // the dialog. Reacting to that one event, rather than each caller of
  // `closeDrawer` separately, is what keeps focus handling correct regardless
  // of which path closed it.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const handleClose = () => {
      setDrawerOpen(false);
      const trigger = triggerRef.current;
      // The explicit mobile close paths return focus to the trigger — but
      // only while it is still visible. `offsetParent === null` is true
      // exactly when an element (or an ancestor) is `display: none`, which
      // is exactly what AppShell.module.css does to it at >=640px: a hidden
      // trigger can never legitimately be "the final focus target" (F11.1-01
      // corrective) — nothing could see a ring on it — so a breakpoint-driven
      // closure leaves focus wherever the browser's own dialog-close
      // restoration puts it instead of forcing it here.
      if (trigger && trigger.offsetParent !== null) trigger.focus();
    };
    dialog.addEventListener('close', handleClose);
    return () => dialog.removeEventListener('close', handleClose);
  }, []);

  // F11.1-01 corrective — an open drawer must not survive a resize back into
  // desktop/tablet layout: at that width `aside` (the permanent Sidebar) is
  // visible again, so a still-open modal `<dialog>` would sit on top of it,
  // backdrop and all, blocking the very Sidebar F11-D01 says desktop/tablet
  // must use normally. `(min-width: 640px)` is the exact complement of
  // AppShell.module.css's `@media (max-width: 639px)` — the two must be kept
  // in sync, one breakpoint, expressed once on each side because a media
  // query condition cannot reference the other's custom property.
  useEffect(() => {
    const desktopQuery = window.matchMedia('(min-width: 640px)');
    const closeIfDesktop = (query: MediaQueryList | MediaQueryListEvent) => {
      if (query.matches) setDrawerOpen(false);
    };
    desktopQuery.addEventListener('change', closeIfDesktop);
    return () => desktopQuery.removeEventListener('change', closeIfDesktop);
  }, []);

  function closeDrawer(): void {
    setDrawerOpen(false);
  }

  return (
    <div className={classes}>
      <a href={`#${mainId}`} className={styles.skipLink}>
        {skipLabel}
      </a>

      <aside className={styles.aside}>{sidebar}</aside>

      <dialog
        ref={dialogRef}
        id={drawerId}
        className={styles.drawer}
        aria-label={drawerLabel}
        aria-modal="true"
        onClick={(event) => {
          // A click on the ::backdrop reports the dialog element itself as
          // the target (the backdrop has no element of its own); a click on
          // any real content inside always targets that descendant instead,
          // so this only ever fires for a genuine outside click.
          if (event.target === dialogRef.current) closeDrawer();
        }}
      >
        <div className={styles.drawerHeader}>
          <button
            type="button"
            autoFocus
            className={styles.drawerClose}
            onClick={closeDrawer}
            aria-label={closeDrawerLabel}
          >
            <span aria-hidden="true" className={styles.drawerCloseGlyph}>
              ×
            </span>
          </button>
        </div>
        {/*
          Closing on any click inside the drawer's own content — a Sidebar
          item, the sign-out button in its footer — is what satisfies
          "navigating through a sidebar item closes the drawer" without this
          component parsing what a route or a nav item is: it never inspects
          `sidebar`, only the fact that something inside it was activated.
        */}
        <div className={styles.drawerBody} onClick={closeDrawer}>
          {sidebar}
        </div>
      </dialog>

      <div className={styles.workspace}>
        {/*
          Hidden above the breakpoint by AppShell.module.css alone — no prop,
          no viewport check here. Always mounted so its accessible name and
          keyboard reachability do not depend on a resize event ever firing.
        */}
        <div className={styles.mobileBar}>
          <button
            ref={triggerRef}
            type="button"
            className={styles.menuTrigger}
            aria-haspopup="dialog"
            aria-expanded={drawerOpen}
            aria-controls={drawerId}
            aria-label={menuLabel}
            onClick={() => setDrawerOpen(true)}
          >
            <span aria-hidden="true" className={styles.menuTriggerGlyph} />
          </button>
        </div>

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
