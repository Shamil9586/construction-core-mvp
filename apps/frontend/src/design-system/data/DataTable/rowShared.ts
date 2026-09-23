import type { StatusVariant } from '../../tokens';

/**
 * Shared vocabulary for table rows.
 *
 * A row never decides its own status. The caller passes both the appearance and
 * the words, having chosen them in a view-model from confirmed data. In
 * particular `Blocked` is not inferred here, or anywhere in the design system,
 * from a colour or a severity.
 */
export interface RowStatus {
  variant: StatusVariant;
  /** The status text. Required — a fill without words is not a state. */
  label: string;
}

/** `Attention` marks the one row that needs it, never the whole table. */
export type RowTone = 'Neutral' | 'Attention';
