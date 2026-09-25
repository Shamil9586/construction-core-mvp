import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Snapshot } from '../types/api';
import type { DataProvider } from './DataProvider';
import { AuthenticationError } from '../auth/AuthenticationError';

/**
 * The data boundary's runtime home.
 *
 * `SnapshotProvider` fetches once, through whichever `DataProvider` it is
 * given, and exposes the result to every route below it via `useSnapshot`.
 * Route containers never import a provider directly — only this context —
 * so the provider is free to change (mock today, a real API call once a
 * backend-wiring pass is authorised) without touching adapters, view-models,
 * screens or routes.
 */
export type SnapshotState =
  | { status: 'Loading' }
  | { status: 'Ready'; snapshot: Snapshot }
  | { status: 'Error'; message: string };

const SnapshotContext = createContext<SnapshotState | undefined>(undefined);

export interface SnapshotProviderProps {
  provider: DataProvider;
  /**
   * F7 — where a session failure goes instead of becoming a data `Error`. A
   * provider that rejects with `AuthenticationError` (HTTP 401: the session
   * ended) is not reporting broken data, so when this handler is supplied the
   * state stays `Loading` and the handler is called; the session layer above
   * then replaces this whole subtree with its expired-session state. Every
   * other rejection still becomes `Error`, exactly as before.
   */
  onAuthenticationError?: (error: AuthenticationError) => void;
  children: ReactNode;
}

export function SnapshotProvider({ provider, onAuthenticationError, children }: SnapshotProviderProps) {
  const [state, setState] = useState<SnapshotState>({ status: 'Loading' });

  // Held in a ref so a new callback identity on re-render never re-runs the
  // fetch below — the snapshot is still fetched once per provider (F5/F6).
  const onAuthenticationErrorRef = useRef(onAuthenticationError);
  useEffect(() => {
    onAuthenticationErrorRef.current = onAuthenticationError;
  }, [onAuthenticationError]);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'Loading' });

    provider
      .getSnapshot()
      .then((snapshot) => {
        if (!cancelled) setState({ status: 'Ready', snapshot });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const handleAuthenticationError = onAuthenticationErrorRef.current;
        if (error instanceof AuthenticationError && handleAuthenticationError) {
          handleAuthenticationError(error);
          return;
        }
        setState({
          status: 'Error',
          message: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [provider]);

  return <SnapshotContext.Provider value={state}>{children}</SnapshotContext.Provider>;
}

export function useSnapshot(): SnapshotState {
  const state = useContext(SnapshotContext);
  if (!state) {
    throw new Error('useSnapshot must be used within a SnapshotProvider');
  }
  return state;
}
