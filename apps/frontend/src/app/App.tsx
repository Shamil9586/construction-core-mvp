import { BrowserRouter } from 'react-router-dom';
import { AppRoutes } from './AppRoutes';
import { SnapshotProvider } from '../data/SnapshotContext';
import { mockDataProvider } from '../data/mockDataProvider';

/**
 * `app.html` is served only at that exact path (same as `preview.html` — see
 * that entry's own comment on why it is not part of the production build).
 * `basename` keeps every route's real URL — the segment the browser's
 * history actually holds — rooted under `/app.html`, matching where the
 * dev server can serve this entry from; the route templates themselves
 * (`/company`, `/object/:objectId`, ...) stay exactly the plain paths
 * `ROUTE_PATHS` declares.
 */
const APP_BASENAME = '/app.html';

/**
 * Application composition — the root the F5 objective describes:
 * Application → Routing → Data Boundary → Adapters → View Models → Screens.
 * `SnapshotProvider` is the data boundary's runtime home; `AppRoutes` is the
 * routing layer; each route container inside it runs the existing F4
 * adapters and mounts the existing F4 screens unchanged.
 */
export function App() {
  return (
    <SnapshotProvider provider={mockDataProvider}>
      <BrowserRouter basename={APP_BASENAME}>
        <AppRoutes />
      </BrowserRouter>
    </SnapshotProvider>
  );
}
