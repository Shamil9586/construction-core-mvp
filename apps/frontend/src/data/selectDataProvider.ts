import type { DataProvider } from './DataProvider';
import { mockDataProvider } from './mockDataProvider';
import { realDataProvider } from './realDataProvider';

/**
 * F6 — explicit, application-level provider selection. This is the one place
 * that decides mock vs real; screens, routes, view-models and adapters stay
 * unaware the choice exists.
 *
 * F6-01 corrective (Work review): unset/empty/whitespace used to default to
 * mock in every environment, including a built, deployed bundle that simply
 * never had `VITE_DATA_PROVIDER` set — silently serving fixtures instead of
 * failing. `isDevelopment` (the caller passes Vite's own `import.meta.env.DEV`,
 * true only under the dev server, false in any built bundle) now draws that
 * line: the mock default is a development convenience — it keeps
 * `npm run test:ds` (Vite dev server only, no backend, see
 * playwright.ds.config.ts) and every existing F5 assertion about demo data
 * green without configuration — and nothing else. Outside development, an
 * unset/empty/whitespace value is a configuration error and throws; it does
 * not choose a side. An explicit "real" or "mock" always wins regardless of
 * environment. An unrecognised non-empty value always throws — the same
 * fail-closed shape `apps/backend/src/main.ts` already uses for `AUTH_MODE`.
 */
export function selectDataProvider(rawMode: string | undefined, isDevelopment: boolean): DataProvider {
  const mode = rawMode?.trim() ?? '';

  if (mode === 'real') return realDataProvider;
  if (mode === 'mock') return mockDataProvider;

  if (mode === '') {
    if (isDevelopment) return mockDataProvider;
    throw new Error(
      'VITE_DATA_PROVIDER is not set. Outside the Vite dev server, it must be set explicitly to ' +
        '"real" or "mock" at build time (see .env.example) — an unconfigured build never defaults to demo data.',
    );
  }

  throw new Error(`Unknown VITE_DATA_PROVIDER value: "${mode}". Expected "mock" or "real".`);
}
