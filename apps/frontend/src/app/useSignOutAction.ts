import { useState } from 'react';

export interface SignOutAction {
  run: () => void;
  pending: boolean;
  /** The server's reason when sign-out could not be completed; the session is then still active. */
  error: string | null;
}

/**
 * Wraps a session's `signOut` for a button: pending while the request is in
 * flight, and the failure reason kept on screen when the server could not end
 * the session — rather than clearing the token locally and reporting a
 * sign-out that did not happen server-side.
 */
export function useSignOutAction(signOut: () => Promise<void>): SignOutAction {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function run(): void {
    setPending(true);
    setError(null);
    signOut()
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        setPending(false);
      });
  }

  return { run, pending, error };
}
