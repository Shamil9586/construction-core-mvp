import { useCallback, useState } from 'react';
import type { AddScheduleEntryInput, ApproveScheduleInput, EditScheduleEntryInput, RecordDelayReasonInput, ResponsibleOptions } from '../../types/schedule';

export type { ResponsibleOptions };

/**
 * GPR-1 — the schedule screen's write side. Every handler returns a `Promise` that rejects with the backend's own message on failure; the
 * calling form shows that message inline and leaves its fields as the user left them. The route container refetches the schedule on success,
 * so the screen never patches its own copy of authoritative data.
 *
 * Omitted entirely (no real session — the demo runtime) the screen renders read-only: no forms, no buttons.
 */
export interface GprActions {
  onCreateDraft: () => Promise<void>;
  onAddEntry: (input: AddScheduleEntryInput) => Promise<void>;
  onEditEntry: (entryId: string, input: EditScheduleEntryInput) => Promise<void>;
  onRemoveEntry: (entryId: string, version: number) => Promise<void>;
  onDiscardDraft: (version: number) => Promise<void>;
  onApprove: (input: ApproveScheduleInput) => Promise<void>;
  onRecordReason: (input: RecordDelayReasonInput) => Promise<void>;
  onResolveReason: (reasonId: string, version: number, comment?: string) => Promise<void>;
  /** Lazily fetched when a delay-reason form opens: who a reason can be about. */
  loadResponsibleOptions: () => Promise<ResponsibleOptions>;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Не удалось выполнить действие';
}

/** pending / error bookkeeping shared by every form: `run` resolves `true` when the action succeeded. */
export function useAsyncAction(): { pending: boolean; error: string | null; run: (action: () => Promise<void>) => Promise<boolean>; setError: (message: string | null) => void } {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (action: () => Promise<void>): Promise<boolean> => {
    setPending(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (failure) {
      setError(errorMessage(failure));
      return false;
    } finally {
      setPending(false);
    }
  }, []);
  return { pending, error, run, setError };
}
