import { parseResponse } from '../http';
import { authenticationErrorFrom } from './AuthenticationError';
import { isInternalCoreRole, type InternalCoreRole } from './internalRoles';

/**
 * F7 — the internal Core application's client for the backend's EXISTING
 * authentication endpoints. No endpoint, token format or storage is new:
 *
 *   GET  /me           validate the tab's bearer token (the legacy entry's own check)
 *   GET  /health       public; reports the backend's AUTH_MODE
 *   POST /auth/mock    test sign-in, served only when AUTH_MODE=mock
 *   POST /auth/logout  delete the caller's own session row
 *
 * Every response goes through the frozen `parseResponse` (http.ts), so proxy
 * HTML, rate-limit text and upstream addresses never reach the screen. A 401
 * from a request that *carries* a session becomes an `AuthenticationError`
 * (see that file); every other failure stays a plain `Error`, so a network or
 * server fault is never mistaken for "signed out", and vice versa.
 *
 * The payloads are untyped JSON at runtime. Each function narrows what it
 * returns to exactly the fields Core reads and rejects anything else as
 * malformed — a user record without a name or role is not treated as a user.
 */

/** The actor behind a session, as far as Core needs it. */
export interface SessionUser {
  id: string;
  name: string;
  /**
   * Exactly as the backend sent it. `types/api.ts` lists the roles the backend
   * defines today, but the column is data, so this stays a string and is
   * classified by `classifyCoreRole` rather than trusted as a closed set.
   */
  role: string;
}

export interface SessionGrantResult {
  token: string;
  user: SessionUser;
}

export const MALFORMED_SESSION_MESSAGE = 'Неверный ответ сервера: искажённые данные сессии.';
export const MALFORMED_AUTH_MODE_MESSAGE = 'Неверный ответ сервера: режим входа не указан.';
export const NON_INTERNAL_ROLE_MESSAGE = 'Эта роль недоступна во внутреннем приложении.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function toSessionUser(value: unknown): SessionUser {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.name) ||
    !isNonEmptyString(value.role)
  ) {
    throw new Error(MALFORMED_SESSION_MESSAGE);
  }
  return { id: value.id, name: value.name, role: value.role };
}

/**
 * `GET /api/me` with the given token. Resolves with the actor; rejects with
 * `AuthenticationError` when the backend no longer accepts the token, and with
 * a plain `Error` for anything else (unreachable server, 5xx, 429, malformed
 * body) — none of which says anything about whether the session is valid.
 */
export async function fetchSessionUser(token: string): Promise<SessionUser> {
  const response = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } });
  if (response.status === 401) throw await authenticationErrorFrom(response);
  return toSessionUser(await parseResponse(response));
}

/**
 * `GET /api/health` → the backend's `authMode`, verbatim. The caller decides
 * what it means; only the exact value `"mock"` ever unlocks the test sign-in.
 */
export async function fetchAuthMode(): Promise<string> {
  const response = await fetch('/api/health');
  const body: unknown = await parseResponse(response);
  if (!isRecord(body) || !isNonEmptyString(body.authMode)) {
    throw new Error(MALFORMED_AUTH_MODE_MESSAGE);
  }
  return body.authMode;
}

/**
 * `POST /api/auth/mock` — the same request the legacy test sign-in sends. A
 * rejected key is the backend's own 401 «Неверный тестовый ключ», surfaced as a
 * plain `Error`: no session existed, so it is a failed sign-in, not an expired
 * one. The role is re-checked here, not only in the form, so no caller can ask
 * this client for an external-participant session.
 */
export async function signInWithMockKey(role: InternalCoreRole, key: string): Promise<SessionGrantResult> {
  if (!isInternalCoreRole(role)) throw new Error(NON_INTERNAL_ROLE_MESSAGE);

  const response = await fetch('/api/auth/mock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role, key }),
  });
  const body: unknown = await parseResponse(response);
  if (!isRecord(body) || !isNonEmptyString(body.token)) throw new Error(MALFORMED_SESSION_MESSAGE);
  return { token: body.token, user: toSessionUser(body.user) };
}

/**
 * `POST /api/auth/logout` with the session's own token — the same request the
 * legacy «Выйти» sends. A 401 means the backend already has no such session
 * (expired, or ended elsewhere), which is the state logout is trying to reach,
 * so it resolves. Any other failure rejects: the server-side session may still
 * be valid, and the caller must not report a sign-out that did not happen.
 */
export async function signOutSession(token: string): Promise<void> {
  const response = await fetch('/api/auth/logout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: '{}',
  });
  if (response.status === 401) {
    await response.text();
    return;
  }
  await parseResponse(response);
}
