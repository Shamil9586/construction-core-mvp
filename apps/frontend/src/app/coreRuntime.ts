import type { DataProvider } from '../data/DataProvider';
import { mockDataProvider } from '../data/mockDataProvider';
import { realDataProvider } from '../data/realDataProvider';
import { selectDataProvider } from '../data/selectDataProvider';

/**
 * F7 — the application's runtime configuration, resolved once at bootstrap.
 *
 * `selectDataProvider` (F6) is unchanged and still the one place that decides
 * mock vs real, failing closed: unset outside the dev server and any
 * unrecognised value throw. Before F7 that throw happened at module load in
 * App.tsx, so a misconfigured *built* bundle rendered nothing at all — a blank
 * page, with the reason only in the browser console. This wrapper turns the
 * same throw into a `ConfigurationError` the application renders visibly.
 *
 * It is a wrapper around the decision, not a second decision: an error never
 * resolves to a provider, and nothing here can reach `mockDataProvider` except
 * `selectDataProvider` returning it for an explicit (or dev-server default)
 * mock configuration. A provider this code does not recognise is itself a
 * configuration error rather than being labelled one way or the other.
 */
export type CoreDataSource = 'real' | 'mock';

export type CoreRuntime =
  | { kind: 'Configured'; dataSource: CoreDataSource; provider: DataProvider }
  | { kind: 'ConfigurationError'; message: string };

export const UNRECOGNISED_PROVIDER_MESSAGE = 'Unrecognised data provider — expected the real or the mock provider.';

export function resolveCoreRuntime(rawMode: string | undefined, isDevelopment: boolean): CoreRuntime {
  let provider: DataProvider;
  try {
    provider = selectDataProvider(rawMode, isDevelopment);
  } catch (error: unknown) {
    return {
      kind: 'ConfigurationError',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (provider === realDataProvider) return { kind: 'Configured', dataSource: 'real', provider };
  if (provider === mockDataProvider) return { kind: 'Configured', dataSource: 'mock', provider };
  return { kind: 'ConfigurationError', message: UNRECOGNISED_PROVIDER_MESSAGE };
}

/**
 * The runtime note in the sidebar footer. It states where the data on screen
 * comes from — replacing F5's fixed «F5 · типизированные демо-данные», which
 * stayed on screen even over real backend data. `real` says only "the
 * server": whether that server holds production or seeded test records is not
 * something the client can know, so it does not claim either.
 */
export type RuntimeDataSourceState = CoreDataSource | 'unconfigured';

export const DATA_SOURCE_LABELS: Record<RuntimeDataSourceState, string> = {
  real: 'Источник данных: сервер',
  mock: 'Источник данных: встроенные демо-данные',
  unconfigured: 'Источник данных: не настроен',
};
