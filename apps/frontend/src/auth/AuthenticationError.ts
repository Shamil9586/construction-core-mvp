import { httpErrorMessage } from '../http';

/**
 * F7 — an authentication failure, kept distinct from a data failure.
 *
 * The existing backend answers HTTP 401 from exactly one place,
 * `authenticate()` (apps/backend/src/security.ts): «Требуется вход» when no
 * bearer token was sent, «Сессия истекла» when the token is unknown, expired,
 * or belongs to a deactivated user. Missing permission is a 403 from a
 * different function (`requirePermission`) and is *not* this error. So a 401 on
 * an authenticated request is an unambiguous statement about the session, never
 * about the data — which is what lets Core show a sign-in state instead of
 * «Не удалось загрузить данные» (the pre-F7 behaviour, which presented an
 * expired session as a broken data source).
 *
 * The message is the backend's own business message, extracted by the frozen
 * `httpErrorMessage` (http.ts) exactly as `parseResponse` would have extracted
 * it — so an existing assertion on the message text (`'Сессия истекла'`) still
 * holds; only the type is new.
 */
export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

/** Builds the error from a 401 response, reading its body once. */
export async function authenticationErrorFrom(response: Response): Promise<AuthenticationError> {
  const body = await response.text();
  return new AuthenticationError(
    httpErrorMessage(response.status, response.headers.get('content-type') ?? '', body),
  );
}
