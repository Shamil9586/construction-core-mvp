import type { DataProvider } from './DataProvider';
import { mockDataProvider } from './mockDataProvider';
import { realDataProvider } from './realDataProvider';

/**
 * F6 — explicit, application-level provider selection. This is the one place
 * that decides mock vs real; screens, routes, view-models and adapters stay
 * unaware the choice exists.
 *
 * Unset/empty defaults to mock — this keeps `npm run test:ds` (Vite dev
 * server only, no backend, see playwright.ds.config.ts) and every existing
 * F5 assertion about demo data green without configuration. A real
 * deployment must set `VITE_DATA_PROVIDER=real` explicitly (see
 * .env.example). Anything else is a misconfiguration, not a value to guess
 * at — it throws rather than silently choosing one side, the same fail-closed
 * shape `apps/backend/src/main.ts` already uses for `AUTH_MODE`.
 */
export function selectDataProvider(rawMode: string | undefined): DataProvider {
  const mode = rawMode?.trim() || 'mock';
  if (mode === 'mock') return mockDataProvider;
  if (mode === 'real') return realDataProvider;
  throw new Error(`Unknown VITE_DATA_PROVIDER value: "${mode}". Expected "mock" or "real".`);
}
