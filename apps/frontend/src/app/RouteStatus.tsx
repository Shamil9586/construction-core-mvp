import { AppShell, typeClass } from '../design-system';
import { AppSidebar } from './AppSidebar';

/**
 * Shared, minimal states a route container reaches before it has a
 * `ViewModel` to hand a screen: still loading the snapshot, the snapshot
 * failed, or a route param does not match anything in it. Each still mounts
 * `AppShell`/`AppSidebar` so navigation never disappears out from under the
 * user — only `<main>`'s content differs from a real screen.
 */

export function RouteLoading() {
  return (
    <AppShell sidebar={<AppSidebar />}>
      <p className={typeClass('body')}>Загрузка…</p>
    </AppShell>
  );
}

export function RouteError({ message }: { message: string }) {
  return (
    <AppShell sidebar={<AppSidebar />}>
      <p className={typeClass('body')}>Не удалось загрузить данные: {message}</p>
    </AppShell>
  );
}

export function RouteNotFound({ label }: { label: string }) {
  return (
    <AppShell sidebar={<AppSidebar />}>
      <p className={typeClass('body')}>{label}</p>
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
      <p className={typeClass('body')}>{label}</p>
    </AppShell>
  );
}
