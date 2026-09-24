import { BrowserRouter } from 'react-router-dom';
import { AppRoutes } from './AppRoutes';
import { SnapshotProvider } from '../data/SnapshotContext';
import { selectDataProvider } from '../data/selectDataProvider';

/**
 * `basename` is client-side routing only: once the F5 bundle is already
 * running, it tells `BrowserRouter` that every real URL — the segment the
 * browser's history actually holds — is rooted under `/app.html`, so the
 * route templates themselves (`/company`, `/object/:objectId`, ...) can stay
 * exactly the plain paths `ROUTE_PATHS` declares. It does *not* make any
 * server answer a fresh GET for a path like `/app.html/company` with this
 * entry — that is a separate concern, a dev-server URL rewrite ahead of
 * Vite's own SPA fallback (`apps/frontend/vite-plugins/f5AppHtmlFallback.ts`,
 * wired in `vite.config.ts`; F5-01, Work review). Client routing decides
 * what a URL *means* once this bundle is running; serving decides *which*
 * bundle a fresh request gets in the first place — the two do not overlap.
 */
const APP_BASENAME = '/app.html';

/**
 * F6 — which `DataProvider` backs this application instance, decided once at
 * module load from build-time configuration (`VITE_DATA_PROVIDER`), not
 * inside the component: the choice is an application-bootstrap concern, not
 * render state, and a misconfigured value should fail the app immediately
 * rather than on some later render.
 */
const dataProvider = selectDataProvider(import.meta.env.VITE_DATA_PROVIDER);

/**
 * Application composition — the root the F5 objective describes:
 * Application → Routing → Data Boundary → Adapters → View Models → Screens.
 * `SnapshotProvider` is the data boundary's runtime home; `AppRoutes` is the
 * routing layer; each route container inside it runs the existing F4
 * adapters and mounts the existing F4 screens unchanged.
 */
export function App() {
  return (
    <SnapshotProvider provider={dataProvider}>
      <BrowserRouter basename={APP_BASENAME}>
        <AppRoutes />
      </BrowserRouter>
    </SnapshotProvider>
  );
}
