import { classifyCoreRole, type InternalCoreRole } from '../auth/internalRoles';
import type { SessionUser } from '../auth/sessionClient';
import { readSessionToken } from '../auth/sessionToken';

/**
 * F7 — the session states of the internal Core application (real data
 * source), kept in a plain module so the transitions that decide them can be
 * tested without rendering. SessionGate.tsx drives them.
 *
 *   Checking          a token is present; `GET /api/me` has not answered yet
 *   Unauthenticated   no token in this tab, or the user signed out
 *   SessionExpired    the backend rejected the token (HTTP 401) — at bootstrap
 *                     or on any later request; the dead token is removed
 *   CheckFailed       the check itself failed (network, 5xx, malformed) — it
 *                     says nothing about the session, so nothing is cleared
 *   Unavailable       a valid session whose role Core does not serve
 *                     (CONTRACTOR_VIEWER, or a role Core does not recognise)
 *   Authenticated     an internal user — the only state that mounts the data
 *                     boundary, so no data request is made without a session
 *                     the backend has accepted
 */
export type UnavailableAccess = 'External' | 'Unrecognized';

export type SessionState =
  | { status: 'Checking' }
  | { status: 'Unauthenticated'; reason: 'NoSession' | 'SignedOut' }
  | { status: 'SessionExpired' }
  | { status: 'CheckFailed'; message: string }
  | { status: 'Unavailable'; user: SessionUser; access: UnavailableAccess }
  | { status: 'Authenticated'; user: SessionUser; role: InternalCoreRole };

/**
 * The role gate (Architecture Decision 4), applied identically however a
 * session arrived — validated from a token already in the tab, or just
 * created by Core's test sign-in.
 */
export function sessionStateForUser(user: SessionUser): SessionState {
  const access = classifyCoreRole(user.role);
  if (access.kind === 'Internal') return { status: 'Authenticated', user, role: access.role };
  return { status: 'Unavailable', user, access: access.kind };
}

/** No token means no request at all: the state is known before anything is fetched. */
export function initialSessionState(): SessionState {
  return readSessionToken() ? { status: 'Checking' } : { status: 'Unauthenticated', reason: 'NoSession' };
}
