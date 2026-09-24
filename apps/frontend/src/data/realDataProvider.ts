import type { Snapshot } from '../types/api';
import type { DataProvider } from './DataProvider';
import { parseResponse } from '../http';

/**
 * Real backend-backed `DataProvider` — `GET /api/snapshot`, the same endpoint
 * and bearer-token session the legacy entry already authenticates with
 * (`sessionStorage.getItem('session')`, see `main.tsx`'s `api()`). F5's
 * application composition has no login screen of its own, so this reuses
 * that existing, accepted session artifact rather than inventing a new auth
 * flow: a token must already be present in this browser tab (established via
 * the legacy entry, or a future dedicated login) for a call to succeed.
 *
 * `parseResponse` (frozen, `http.ts`) is the one place HTTP/JSON errors are
 * turned into a safe message — this provider does not add a second error
 * path. A rejection here is a real error: nothing here ever substitutes
 * `mockDataProvider`'s fixtures on failure.
 */
export const realDataProvider: DataProvider = {
  async getSnapshot(): Promise<Snapshot> {
    const token = sessionStorage.getItem('session') ?? '';
    const response = await fetch('/api/snapshot', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return (await parseResponse(response)) as Snapshot;
  },
};
