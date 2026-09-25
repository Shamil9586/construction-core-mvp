/**
 * F7 — the one existing session artifact, in one place.
 *
 * The backend issues an opaque bearer token (`session()`,
 * apps/backend/src/security.ts) and never sees where the client keeps it. The
 * legacy entry keeps it in `sessionStorage['session']` (main.tsx: `api()`,
 * `Login`, logout), and so does the Bitrix24 launch page the backend itself
 * serves (auth.controller.ts `launchHtml`). The internal Core application reuses
 * exactly that key rather than inventing a second store, so one browser tab
 * holds one session whichever entry created it, and ending it in either entry
 * ends it for both.
 *
 * Nothing here decides whether a token is still valid — only the backend can
 * (`GET /me`, see sessionClient.ts). An empty or whitespace-only value is read
 * as "no token": it is not a credential, and sending it would only turn a
 * missing session into a confusing expired one.
 *
 * Reading is guarded because it happens during the first render: a browser
 * that blocks site storage throws on access, and an exception there would
 * leave a blank page. It reads as "no session" instead, so the user gets the
 * sign-in state; storing then fails visibly in the sign-in form.
 */
export const SESSION_STORAGE_KEY = 'session';

export function readSessionToken(): string | null {
  let token: string | null;
  try {
    token = sessionStorage.getItem(SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
  return token !== null && token.trim() !== '' ? token : null;
}

export function storeSessionToken(token: string): void {
  sessionStorage.setItem(SESSION_STORAGE_KEY, token);
}

export function clearSessionToken(): void {
  sessionStorage.removeItem(SESSION_STORAGE_KEY);
}
