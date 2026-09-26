import type { Snapshot } from '../types/api';
import type { DataProvider } from './DataProvider';
import { parseResponse } from '../http';
import { validateSnapshot } from './validateSnapshot';
import { authenticationErrorFrom } from '../auth/AuthenticationError';
import { readSessionToken } from '../auth/sessionToken';

/**
 * Real backend-backed `DataProvider` — `GET /api/snapshot`, the same endpoint
 * and bearer-token session the legacy entry already authenticates with
 * (`sessionStorage.getItem('session')`, see `main.tsx`'s `api()`). It reuses
 * that existing, accepted session artifact rather than inventing a new auth
 * flow. Before F7 the token could only come from the legacy entry; F7's
 * session bootstrap (app/SessionGate.tsx) now validates or establishes it
 * through the same existing endpoints first, so this provider only ever runs
 * for a session the backend has already accepted.
 *
 * `parseResponse` (frozen, `http.ts`) is the one place HTTP/JSON errors are
 * turned into a safe message; `validateSnapshot` (F6-02 corrective) is the
 * one place a structurally malformed *successful* response is turned into a
 * safe rejection instead of an untyped value trusted all the way to render.
 * This provider adds no third path: it only retrieves, parses and checks the
 * shape of what came back — no business-state derivation. A rejection here
 * is a real error: nothing here ever substitutes `mockDataProvider`'s
 * fixtures on failure.
 *
 * F7: the token is read through `auth/sessionToken.ts` (same key, same
 * artifact), and Core now establishes/validates it itself before this is
 * ever called (app/SessionGate.tsx). A 401 is classified *before*
 * `parseResponse` runs, as an `AuthenticationError` carrying the same
 * backend message: the session ended, the data did not fail, and the
 * application shows its expired-session state instead of «Не удалось
 * загрузить данные». Every other status still takes the unchanged F6 path.
 */
export const realDataProvider: DataProvider = {
  async getSnapshot(): Promise<Snapshot> {
    const token = readSessionToken();
    const response = await fetch('/api/snapshot', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (response.status === 401) throw await authenticationErrorFrom(response);
    return validateSnapshot(await parseResponse(response));
  },
};
