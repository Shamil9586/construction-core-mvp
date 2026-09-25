import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AuthenticationError } from '../auth/AuthenticationError';
import { INTERNAL_ROLE_LABELS } from '../auth/internalRoles';
import { fetchSessionUser, signOutSession, type SessionGrantResult } from '../auth/sessionClient';
import { clearSessionToken, readSessionToken, storeSessionToken } from '../auth/sessionToken';
import { CoreRuntimeProvider, type CoreRuntimeInfo } from './CoreRuntimeContext';
import {
  CoreUnavailableScreen,
  SessionCheckFailedScreen,
  SessionCheckingScreen,
  SignInScreen,
} from './AuthStatus';
import { initialSessionState, sessionStateForUser, type SessionState } from './sessionState';

/**
 * F7 — the internal Core application's own session bootstrap (real data
 * source only; the mock data source has no backend and therefore no session).
 *
 * It reuses the existing session artifact and endpoints (auth/sessionClient.ts)
 * and keeps apart the outcomes that used to collapse into one
 * «Не удалось загрузить данные: …» — see sessionState.ts for each state.
 * Data-loading failures stay where they were (SnapshotContext → RouteError);
 * configuration failures never reach this component (App.tsx).
 */
export interface AuthenticatedSession {
  /** For the data boundary: a 401 on a data request ends the session into `SessionExpired`. */
  onAuthenticationError: (error: AuthenticationError) => void;
}

export interface SessionGateProps {
  children: (session: AuthenticatedSession) => ReactNode;
}

export function SessionGate({ children }: SessionGateProps) {
  const [state, setState] = useState<SessionState>(initialSessionState);

  useEffect(() => {
    if (state.status !== 'Checking') return undefined;

    const token = readSessionToken();
    if (!token) {
      setState({ status: 'Unauthenticated', reason: 'NoSession' });
      return undefined;
    }

    let cancelled = false;
    fetchSessionUser(token).then(
      (user) => {
        if (!cancelled) setState(sessionStateForUser(user));
      },
      (error: unknown) => {
        if (cancelled) return;
        if (error instanceof AuthenticationError) {
          clearSessionToken();
          setState({ status: 'SessionExpired' });
        } else {
          setState({ status: 'CheckFailed', message: error instanceof Error ? error.message : String(error) });
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [state.status]);

  const expire = useCallback((): void => {
    clearSessionToken();
    setState({ status: 'SessionExpired' });
  }, []);

  const signIn = useCallback((grant: SessionGrantResult): void => {
    storeSessionToken(grant.token);
    setState(sessionStateForUser(grant.user));
  }, []);

  // Server first, then local: if the backend could not end the session this
  // rejects, the token stays, and the caller shows why (useSignOutAction).
  const signOut = useCallback(async (): Promise<void> => {
    const token = readSessionToken();
    if (token) await signOutSession(token);
    clearSessionToken();
    setState({ status: 'Unauthenticated', reason: 'SignedOut' });
  }, []);

  const retry = useCallback((): void => {
    setState({ status: 'Checking' });
  }, []);

  const runtime = useMemo<CoreRuntimeInfo>(() => {
    if (state.status === 'Authenticated') {
      return { dataSource: 'real', session: { user: state.user, roleLabel: INTERNAL_ROLE_LABELS[state.role], signOut } };
    }
    if (state.status === 'Unavailable') {
      return { dataSource: 'real', session: { user: state.user, roleLabel: null, signOut } };
    }
    return { dataSource: 'real', session: null };
  }, [state, signOut]);

  let content: ReactNode;
  switch (state.status) {
    case 'Checking':
      content = <SessionCheckingScreen />;
      break;
    case 'Unauthenticated':
      content = <SignInScreen reason={state.reason} onSignedIn={signIn} />;
      break;
    case 'SessionExpired':
      content = <SignInScreen reason="Expired" onSignedIn={signIn} />;
      break;
    case 'CheckFailed':
      content = <SessionCheckFailedScreen message={state.message} onRetry={retry} />;
      break;
    case 'Unavailable':
      content = <CoreUnavailableScreen access={state.access} onSignOut={signOut} />;
      break;
    case 'Authenticated':
      content = children({ onAuthenticationError: expire });
      break;
    default: {
      const unreachable: never = state;
      content = unreachable;
    }
  }

  return <CoreRuntimeProvider value={runtime}>{content}</CoreRuntimeProvider>;
}
