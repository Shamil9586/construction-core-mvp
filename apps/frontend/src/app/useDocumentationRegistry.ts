import { useCallback, useEffect, useState } from 'react';
import { getObjectDocumentationRegistry, registryQueryString, type DocumentationRegistryPayload, type RegistryQuery } from '../data/documentationRegistryApi';

export type DocumentationRegistryLoad =
  | { status: 'Loading' }
  | { status: 'Error'; message: string }
  /** `refreshing`: a newer query is in flight; the previous answer stays on screen (no flicker) until it lands. */
  | { status: 'Ready'; payload: DocumentationRegistryPayload; refreshing: boolean };

/**
 * ID-AUTO-2 — one request per (object, filters) for the whole registry: the server aggregates, the browser never calls a package or an
 * AOSR individually. A failed or superseded request never leaves stale data labelled as current: a stale answer is dropped, and an error
 * replaces the screen content with the error state.
 */
export function useDocumentationRegistry(objectId: string | undefined, query: RegistryQuery, enabled: boolean): { load: DocumentationRegistryLoad; reload: () => void } {
  const [load, setLoad] = useState<DocumentationRegistryLoad>({ status: 'Loading' });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((value) => value + 1), []);
  const key = registryQueryString(query);

  useEffect(() => {
    if (!enabled || !objectId) return;
    let cancelled = false;
    setLoad((previous) => (previous.status === 'Ready' && previous.payload.objectId === objectId ? { ...previous, refreshing: true } : { status: 'Loading' }));
    getObjectDocumentationRegistry(objectId, query)
      .then((payload) => {
        if (!cancelled) setLoad({ status: 'Ready', payload, refreshing: false });
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoad({ status: 'Error', message: error instanceof Error ? error.message : 'Не удалось загрузить реестр ИД' });
      });
    return () => {
      cancelled = true;
    };
    // `key` is the serialised query; the object identity of `query` changes on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectId, enabled, key, tick]);

  return { load, reload };
}
