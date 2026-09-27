import { AppShell, typeClass } from '../design-system';
import { AppSidebar } from './AppSidebar';

/**
 * Shared, minimal states a route container reaches before it has a
 * `ViewModel` to hand a screen: still loading the snapshot, the snapshot
 * failed, or a route param does not match anything in it. Each still mounts
 * `AppShell`/`AppSidebar` so navigation never disappears out from under the
 * user — only `<main>`'s content differs from a real screen.
 *
 * F11.4 — each of these fully replaces what a screen's own `PageHeader`
 * would give the page: its one `<h1>`. Without it, landing here (a direct
 * link, a refresh, or a client-side navigation to a state instead of a
 * screen) put no heading at all in the page. Using `typeClass('body')`
 * rather than `heading-page` keeps the plain, quiet visual weight these
 * messages already had — the type scale's own margin-included discipline
 * (typography.css) means the element swap changes nothing else.
 *
 * `aria-live` (polite for Loading/NotFound/Forbidden, assertive for Error)
 * marks each of these as a live region per the WAI-ARIA specification, which
 * is how a screen reader is SPECIFIED to treat a same-route content change —
 * a mutation's own `refetch()` (`useRefetchSnapshot`) briefly setting the
 * same route back to `Loading`, for instance, with no navigation and so no
 * focus change of its own. This repo's Playwright suite proves the DOM/ARIA
 * side of that (the attribute is present, correctly valued, and does not
 * replace the element's own heading role); it cannot independently prove
 * that a given browser/assistive-technology combination actually voices the
 * change — that is inherent to testing ARIA live regions via a DOM API, not
 * a gap specific to this component. Deliberately `aria-live`, not
 * `role="status"`/`role="alert"`: an explicit `role` replaces an element's
 * native role rather than adding to it, so putting one on this `<h1>` would
 * expose it as a status/alert region instead of a heading — losing the one
 * thing this comment's first paragraph exists to guarantee.
 */

export function RouteLoading() {
  return (
    <AppShell sidebar={<AppSidebar />}>
      <h1 aria-live="polite" className={typeClass('body')}>
        Загрузка…
      </h1>
    </AppShell>
  );
}

export function RouteError({ message }: { message: string }) {
  return (
    <AppShell sidebar={<AppSidebar />}>
      <h1 aria-live="assertive" className={typeClass('body')}>
        Не удалось загрузить данные: {message}
      </h1>
    </AppShell>
  );
}

export function RouteNotFound({ label }: { label: string }) {
  return (
    <AppShell sidebar={<AppSidebar />}>
      <h1 aria-live="polite" className={typeClass('body')}>
        {label}
      </h1>
    </AppShell>
  );
}

/**
 * F8.2.1 — a role this route is confirmed to exclude (SDO on `/pto` or
 * `/pto/package/:id`, per `canAccessDocumentation`), distinct from
 * `RouteNotFound`: the destination exists, this session simply has no access
 * to it, so the message says that rather than implying the data itself is
 * missing.
 */
export function RouteForbidden({ label }: { label: string }) {
  return (
    <AppShell sidebar={<AppSidebar />}>
      <h1 aria-live="polite" className={typeClass('body')}>
        {label}
      </h1>
    </AppShell>
  );
}
