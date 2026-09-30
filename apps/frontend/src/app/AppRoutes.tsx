import { useEffect, useRef } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ROUTE_PATHS } from './routePaths';
import { CompanyRoute } from './routes/CompanyRoute';
import { ObjectRoute } from './routes/ObjectRoute';
import { WorkRoute } from './routes/WorkRoute';
import { PtoRoute } from './routes/PtoRoute';
import { PackageDetailRoute } from './routes/PackageDetailRoute';
import { SdoRoute } from './routes/SdoRoute';
import { SdoCaseDetailRoute } from './routes/SdoCaseDetailRoute';
import { AdminUsersRoute } from './routes/AdminUsersRoute';
import { TeamsRoute, MyTeamRoute } from './routes/TeamsRoute';
import { RouteNotFound } from './RouteStatus';

/**
 * F11.4 — every route container mounts its own `AppShell`/`<main
 * id="cc-main-content" tabIndex={-1}>` (the same element the skip link
 * already focuses), but a client-side navigation between two of them
 * unmounts the element that had focus without giving focus anywhere new;
 * left alone, it falls back to `document.body` — no longer anywhere in
 * reading order. Moving it to the new route's `<main>` is the same
 * "focus lands in the new content" behaviour the skip link already gives a
 * keyboard user, applied to every navigation instead of only the first one.
 *
 * Skipped on the very first render: the browser's own initial focus (page
 * start, before the skip link) is the correct starting point, not something
 * to override the moment the app mounts. Keyed on `pathname` alone, not the
 * full location — P01's own `?objectId=` filter (`PtoRoute.tsx`) changes
 * `search` without navigating anywhere, and must not yank focus off the
 * `<select>` the user is actively using.
 */
function useFocusMainOnNavigate(): void {
  const { pathname } = useLocation();
  const isFirstRender = useRef(true);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    document.getElementById('cc-main-content')?.focus();
  }, [pathname]);
}

/**
 * The routing layer itself: maps a URL shape to a route container. No
 * business logic lives here — each element below only reads its own params
 * and hands them to its container; deciding what an object or a work *is*
 * happens in the adapters those containers call, not in this file.
 */
export function AppRoutes() {
  useFocusMainOnNavigate();

  return (
    <Routes>
      <Route path={ROUTE_PATHS.root} element={<Navigate to={ROUTE_PATHS.company} replace />} />
      <Route path={ROUTE_PATHS.company} element={<CompanyRoute />} />
      <Route path={ROUTE_PATHS.object} element={<ObjectRoute />} />
      <Route path={ROUTE_PATHS.work} element={<WorkRoute />} />
      <Route path={ROUTE_PATHS.pto} element={<PtoRoute />} />
      <Route path={ROUTE_PATHS.package} element={<PackageDetailRoute />} />
      <Route path={ROUTE_PATHS.sdo} element={<SdoRoute />} />
      <Route path={ROUTE_PATHS.sdoCase} element={<SdoCaseDetailRoute />} />
      <Route path={ROUTE_PATHS.adminUsers} element={<AdminUsersRoute />} />
      <Route path={ROUTE_PATHS.teams} element={<TeamsRoute />} />
      <Route path={ROUTE_PATHS.myTeam} element={<MyTeamRoute />} />
      <Route path="*" element={<RouteNotFound label="Страница не найдена" />} />
    </Routes>
  );
}
