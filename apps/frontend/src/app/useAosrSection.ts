import { useCallback, useEffect, useState } from 'react';
import { getAosrPackageView, getPackageQuantity, type AosrPackageView, type PackageQuantityView } from '../data/aosrApi';

/**
 * ID-AUTO-1 — loads the package's AOSR section and its current/historical quantity. A failed or pending
 * fetch leaves the matching field null: the section then renders nothing for it, never a guess.
 */
export function useAosrSection(packageId: string | undefined, enabled: boolean): { view: AosrPackageView | null; quantity: PackageQuantityView | null; error: string | null; reload: () => void } {
  const [view, setView] = useState<AosrPackageView | null>(null);
  const [quantity, setQuantity] = useState<PackageQuantityView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    if (!enabled || !packageId) {
      setView(null);
      setQuantity(null);
      return;
    }
    let cancelled = false;
    Promise.all([getAosrPackageView(packageId), getPackageQuantity(packageId)])
      .then(([v, q]) => {
        if (cancelled) return;
        setView(v);
        setQuantity(q);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Не удалось загрузить АОСР');
      });
    return () => {
      cancelled = true;
    };
  }, [packageId, enabled, tick]);

  return { view, quantity, error, reload };
}
