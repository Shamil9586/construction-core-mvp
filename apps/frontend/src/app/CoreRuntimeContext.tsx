import { createContext, useContext } from 'react';
import type { SessionUser } from '../auth/sessionClient';
import type { RuntimeDataSourceState } from './coreRuntime';

/**
 * F7 — what the application chrome needs to know about the running
 * application: where its data comes from, and, when a session exists, whose it
 * is and how to end it. `AppSidebar` reads this to fill `Sidebar`'s existing
 * `footer` slot, so every screen, route status and session state gets the same
 * truthful footer without any of them passing props for it — and neither
 * `Sidebar` nor `AppShell` changes.
 */
export interface CoreSessionInfo {
  user: SessionUser;
  /** Russian label for an internal role; `null` for a role Core does not serve. */
  roleLabel: string | null;
  /** Ends the session through the existing `POST /api/auth/logout`. Rejects if the server could not. */
  signOut: () => Promise<void>;
}

export interface CoreRuntimeInfo {
  dataSource: RuntimeDataSourceState;
  session: CoreSessionInfo | null;
}

const CoreRuntimeContext = createContext<CoreRuntimeInfo | undefined>(undefined);

export const CoreRuntimeProvider = CoreRuntimeContext.Provider;

export function useCoreRuntime(): CoreRuntimeInfo {
  const info = useContext(CoreRuntimeContext);
  if (!info) {
    throw new Error('useCoreRuntime must be used within a CoreRuntimeProvider');
  }
  return info;
}
