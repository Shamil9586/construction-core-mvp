import type { Snapshot } from '../types/api';

/**
 * The application's data boundary — the one seam between screens and a data
 * source.
 *
 * `getSnapshot` returns exactly the shape `GET /snapshot` already sends (see
 * `types/api.ts`'s `Snapshot`), not an invented contract. Swapping
 * `mockDataProvider` (F5) for a real `fetch('/api/snapshot')`-backed
 * implementation is the only change a future backend-wiring pass needs to
 * make: adapters, view-models, screens and routes all depend on this
 * interface, never on where the data actually came from.
 */
export interface DataProvider {
  getSnapshot(): Promise<Snapshot>;
}
