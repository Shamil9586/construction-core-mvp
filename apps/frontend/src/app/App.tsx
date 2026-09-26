import { BrowserRouter } from 'react-router-dom';
import { AppRoutes } from './AppRoutes';
import { SnapshotProvider } from '../data/SnapshotContext';
import { resolveCoreRuntime, type CoreRuntime } from './coreRuntime';
import { CoreRuntimeProvider, type CoreRuntimeInfo } from './CoreRuntimeContext';
import { SessionGate } from './SessionGate';
import { ConfigurationErrorScreen } from './AuthStatus';

/**
 * `basename` is client-side routing only: once the F5 bundle is already
 * running, it tells `BrowserRouter` that every real URL — the segment the
 * browser's history actually holds — is rooted under `/app.html`, so the
 * route templates themselves (`/company`, `/object/:objectId`, ...) can stay
 * exactly the plain paths `ROUTE_PATHS` declares. It does *not* make any
 * server answer a fresh GET for a path like `/app.html/company` with this
 * entry — that is a separate concern: a dev-server URL rewrite ahead of
 * Vite's own SPA fallback (`apps/frontend/vite-plugins/f5AppHtmlFallback.ts`,
 * wired in `vite.config.ts`; F5-01, Work review), and — for a built bundle —
 * the `/app.html` handle in `infra/Caddyfile` (F7). Client routing decides
 * what a URL *means* once this bundle is running; serving decides *which*
 * bundle a fresh request gets in the first place — the two do not overlap.
 */
const APP_BASENAME = '/app.html';

/**
 * F6 — which `DataProvider` backs this application instance, decided once at
 * module load from build-time configuration (`VITE_DATA_PROVIDER`), not
 * inside the component: the choice is an application-bootstrap concern, not
 * render state. `import.meta.env.DEV` — Vite's own flag, not a test-only
 * stand-in — is what lets an unset value default to mock only under the dev
 * server (F6-01 corrective; see selectDataProvider.ts).
 *
 * F7: the decision itself is unchanged and still fails closed, but a
 * misconfiguration is now resolved into a `ConfigurationError` the app
 * renders (`resolveCoreRuntime`), instead of a module-load throw that left a
 * built bundle on a blank page.
 */
const runtime = resolveCoreRuntime(import.meta.env.VITE_DATA_PROVIDER, import.meta.env.DEV);

const UNCONFIGURED_RUNTIME: CoreRuntimeInfo = { dataSource: 'unconfigured', session: null };
const MOCK_RUNTIME: CoreRuntimeInfo = { dataSource: 'mock', session: null };

/**
 * Application composition — the root the F5 objective describes:
 * Application → Routing → Data Boundary → Adapters → View Models → Screens.
 * `SnapshotProvider` is the data boundary's runtime home; `AppRoutes` is the
 * routing layer; each route container inside it runs the existing F4
 * adapters and mounts the existing F4 screens unchanged.
 *
 * F7 adds the runtime in front of the data boundary. The router is now the
 * outermost layer, so the requested URL survives any session state — a deep
 * link opened while signed out lands on that same screen once signed in.
 */
export function App() {
  return (
    <BrowserRouter basename={APP_BASENAME}>
      <CoreRuntimeRoot runtime={runtime} />
    </BrowserRouter>
  );
}

function CoreRuntimeRoot({ runtime }: { runtime: CoreRuntime }) {
  if (runtime.kind === 'ConfigurationError') {
    return (
      <CoreRuntimeProvider value={UNCONFIGURED_RUNTIME}>
        <ConfigurationErrorScreen message={runtime.message} />
      </CoreRuntimeProvider>
    );
  }

  // Explicitly requested demo fixtures (F5/F6): no backend, so no session to
  // establish. The footer says so, and nothing here is reachable from the
  // real data source — the two branches never share a provider.
  if (runtime.dataSource === 'mock') {
    return (
      <CoreRuntimeProvider value={MOCK_RUNTIME}>
        <SnapshotProvider provider={runtime.provider}>
          <AppRoutes />
        </SnapshotProvider>
      </CoreRuntimeProvider>
    );
  }

  return (
    <SessionGate>
      {(session) => (
        <SnapshotProvider provider={runtime.provider} onAuthenticationError={session.onAuthenticationError}>
          <AppRoutes />
        </SnapshotProvider>
      )}
    </SessionGate>
  );
}
