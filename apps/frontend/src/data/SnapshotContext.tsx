import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Snapshot } from '../types/api';
import type { DataProvider } from './DataProvider';

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
  children: ReactNode;
}

export function SnapshotProvider({ provider, children }: SnapshotProviderProps) {
  const [state, setState] = useState<SnapshotState>({ status: 'Loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'Loading' });

    provider
      .getSnapshot()
      .then((snapshot) => {
        if (!cancelled) setState({ status: 'Ready', snapshot });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: 'Error',
            message: error instanceof Error ? error.message : String(error),
          });
        }
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
