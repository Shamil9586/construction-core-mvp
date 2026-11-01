import { useCallback, useEffect, useRef, useState } from 'react';
import { AreaScopeApiError, createAreaScope, listAllAreaScopes, newIdempotencyKey, violationsOf } from '../data/areaScopeApi';
import type { AreaScopeCreatePayload, AreaScopeRead } from '../types/areaScope';
import { describeApiError, type ErrorView } from '../view-models/areaScope';

/**
 * GPR-2 R05 S2 — loads ALL pages of ONE object's AreaScopes and runs the create command.
 *
 * `enabled` is false for any viewer the screen is not offered to; the hook then makes no request at all. A result is kept only for the
 * object it was fetched for, so stepping from one object to another never shows the previous object's tree.
 */
export type AreaScopeLoad =
  | { status: 'Idle' }
  | { status: 'Loading' }
  | { status: 'Ready'; items: AreaScopeRead[] }
  | { status: 'Unavailable'; error: ErrorView }
  | { status: 'Error'; error: ErrorView };

interface Keyed {
  key: string | undefined;
  load: AreaScopeLoad;
}

function errorView(error: unknown): ErrorView {
  if (error instanceof AreaScopeApiError) return describeApiError(error, violationsOf(error.details));
  return { kind: 'other', message: error instanceof Error ? error.message : String(error), lines: [], reference: null };
}

export function useAreaScopes(objectId: string | undefined, enabled: boolean): { load: AreaScopeLoad; reload: () => void } {
  const [state, setState] = useState<Keyed>({ key: undefined, load: { status: 'Idle' } });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    if (!enabled || !objectId) {
      setState({ key: objectId, load: { status: 'Idle' } });
      return undefined;
    }
    const controller = new AbortController();
    // Same object: keep the tree on screen while it refreshes. Another object: start from Loading.
    setState((previous) => (previous.key === objectId && previous.load.status === 'Ready' ? previous : { key: objectId, load: { status: 'Loading' } }));
    listAllAreaScopes(objectId, controller.signal).then(
      (items) => {
        if (!controller.signal.aborted) setState({ key: objectId, load: { status: 'Ready', items } });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        const view = errorView(error);
        setState({ key: objectId, load: view.kind === 'unavailable' ? { status: 'Unavailable', error: view } : { status: 'Error', error: view } });
      },
    );
    return () => controller.abort();
  }, [objectId, enabled, tick]);

  return { load: state.key === objectId ? state.load : { status: 'Loading' }, reload };
}

export type CreateState = { status: 'Idle' } | { status: 'Submitting' } | { status: 'Error'; error: ErrorView } | { status: 'Saved'; code: string };

/**
 * One create command per submit. The Idempotency-Key is bound to the exact payload: resubmitting the SAME payload (a retry after a failure
 * whose outcome is unknown) reuses the key, a changed payload gets a new one, and a success clears it. The key is never regenerated behind
 * the user's back.
 */
export function useAreaScopeCreate(objectId: string | undefined, onSaved: () => void): {
  state: CreateState;
  submit: (payload: AreaScopeCreatePayload) => Promise<boolean>;
  reset: () => void;
} {
  const [state, setState] = useState<CreateState>({ status: 'Idle' });
  const attempt = useRef<{ objectId: string; fingerprint: string; key: string } | null>(null);
  const inFlight = useRef(false);

  const submit = useCallback(
    async (payload: AreaScopeCreatePayload): Promise<boolean> => {
      if (!objectId || inFlight.current) return false;
      const fingerprint = JSON.stringify(payload);
      if (!attempt.current || attempt.current.objectId !== objectId || attempt.current.fingerprint !== fingerprint) {
        attempt.current = { objectId, fingerprint, key: newIdempotencyKey() };
      }
      inFlight.current = true;
      setState({ status: 'Submitting' });
      try {
        await createAreaScope(objectId, payload, attempt.current.key);
        attempt.current = null;
        setState({ status: 'Saved', code: payload.code });
        onSaved();
        return true;
      } catch (error: unknown) {
        setState({ status: 'Error', error: errorView(error) });
        return false;
      } finally {
        inFlight.current = false;
      }
    },
    [objectId, onSaved],
  );

  const reset = useCallback(() => setState({ status: 'Idle' }), []);
  return { state, submit, reset };
}
