import { Navigate, Route, Routes } from 'react-router-dom';
import { ROUTE_PATHS } from './routePaths';
import { CompanyRoute } from './routes/CompanyRoute';
import { ObjectRoute } from './routes/ObjectRoute';
import { WorkRoute } from './routes/WorkRoute';
import { PtoRoute } from './routes/PtoRoute';
import { PackageDetailRoute } from './routes/PackageDetailRoute';
import { RouteNotFound } from './RouteStatus';

/**
 * The routing layer itself: maps a URL shape to a route container. No
 * business logic lives here — each element below only reads its own params
 * and hands them to its container; deciding what an object or a work *is*
 * happens in the adapters those containers call, not in this file.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route path={ROUTE_PATHS.root} element={<Navigate to={ROUTE_PATHS.company} replace />} />
      <Route path={ROUTE_PATHS.company} element={<CompanyRoute />} />
      <Route path={ROUTE_PATHS.object} element={<ObjectRoute />} />
      <Route path={ROUTE_PATHS.work} element={<WorkRoute />} />
      <Route path={ROUTE_PATHS.pto} element={<PtoRoute />} />
      <Route path={ROUTE_PATHS.package} element={<PackageDetailRoute />} />
      <Route path="*" element={<RouteNotFound label="Страница не найдена" />} />
    </Routes>
  );
}
