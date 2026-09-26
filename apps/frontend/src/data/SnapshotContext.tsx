import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
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

/**
 * F8.1 — a second, separate context for re-running the same fetch on demand,
 * so a mutation (recording RP fact, registering an Internal SC decision) can
 * make its effect visible without a full page reload. Kept apart from
 * `SnapshotState` rather than added as a field on it: every existing
 * `useSnapshot()` call site (C01, O01, W01's own read side) is untouched by
 * this, since nothing reads the new context until a caller asks for it.
 */
const SnapshotRefetchContext = createContext<(() => void) | undefined>(undefined);

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

  // F8.1 — a generation counter rather than the original single `cancelled`
  // flag, because `load` can now run more than once per mount (the initial
  // fetch, plus any number of manual refetches): only the most recently
  // started call may ever commit state, so an older in-flight response that
  // resolves after a newer one was already started must be ignored, not
  // just one that resolves after unmount.
  const generationRef = useRef(0);

  const load = useCallback(() => {
    const generation = ++generationRef.current;
    setState({ status: 'Loading' });

    provider
      .getSnapshot()
      .then((snapshot) => {
        if (generationRef.current !== generation) return;
        setState({ status: 'Ready', snapshot });
      })
      .catch((error: unknown) => {
        if (generationRef.current !== generation) return;
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
  }, [provider]);

  useEffect(() => {
    load();
    return () => {
      generationRef.current += 1;
    };
  }, [load]);

  return (
    <SnapshotContext.Provider value={state}>
      <SnapshotRefetchContext.Provider value={load}>{children}</SnapshotRefetchContext.Provider>
    </SnapshotContext.Provider>
  );
}

export function useSnapshot(): SnapshotState {
  const state = useContext(SnapshotContext);
  if (!state) {
    throw new Error('useSnapshot must be used within a SnapshotProvider');
  }
  return state;
}

/** F8.1 — re-runs the same `getSnapshot()` fetch; see `SnapshotRefetchContext` above. */
export function useRefetchSnapshot(): () => void {
  const load = useContext(SnapshotRefetchContext);
  if (!load) {
    throw new Error('useRefetchSnapshot must be used within a SnapshotProvider');
  }
  return load;
}
