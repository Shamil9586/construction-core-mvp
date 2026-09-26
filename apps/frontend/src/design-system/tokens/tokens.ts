/**
 * Construction Core — typed token references.
 *
 * Values live in `tokens.css`. This module holds the *names* of those custom
 * properties plus the few measurements that logic genuinely needs as numbers
 * (grid spans, used for width arithmetic).
 *
 * Keeping values in one place and references in another is deliberate. Declaring
 * `#245B85` in both a stylesheet and a TypeScript object guarantees they drift
 * apart eventually, and the drift is invisible until someone notices two shades
 * of the same blue on one screen. Here there is nothing to drift: TypeScript
 * knows variable names, CSS knows values.
 */

/** A reference to a CSS custom property, usable anywhere a colour is expected. */
export type TokenRef = `var(--cc-${string})`;

export const color = {
  background: {
    page: 'var(--cc-background-page)',
    surface: 'var(--cc-background-surface)',
    navigation: 'var(--cc-background-navigation)',
    selected: 'var(--cc-background-selected)',
    neutral: 'var(--cc-background-neutral)',
  },
  text: {
    primary: 'var(--cc-text-primary)',
    secondary: 'var(--cc-text-secondary)',
    onNavigation: 'var(--cc-text-on-navigation)',
    onNavigationMuted: 'var(--cc-text-on-navigation-muted)',
    onAction: 'var(--cc-text-on-action)',
    link: 'var(--cc-text-link)',
  },
  border: {
    default: 'var(--cc-border-default)',
    interactive: 'var(--cc-border-interactive)',
    navigation: 'var(--cc-border-navigation)',
  },
  action: {
    primary: 'var(--cc-action-primary)',
    primaryHover: 'var(--cc-action-primary-hover)',
    primaryPressed: 'var(--cc-action-primary-pressed)',
    surfaceHover: 'var(--cc-action-surface-hover)',
    navigationHover: 'var(--cc-action-navigation-hover)',
    navigationSelected: 'var(--cc-action-navigation-selected)',
  },
  focus: {
    ring: 'var(--cc-focus-ring)',
    ringInverse: 'var(--cc-focus-ring-inverse)',
  },
} as const satisfies Record<string, Record<string, TokenRef>>;

/**
 * The five visual status appearances of `Data / StatusBadge`.
 *
 * This is a *visual* vocabulary, not a business one. Nothing in the design system
 * decides which of these a given record deserves — that decision belongs to a
 * view-model, which reads confirmed data and existing domain rules.
 *
 * The three backend signals stay scoped and separate:
 *
 *   scheduleStatus  schedule state under the existing schedule contract
 *                   (ScheduleStatusService, variance against thresholds)
 *   healthStatus    an aggregated attention state that deliberately mixes
 *                   contours — late ИД and СДО raise it — and is therefore
 *                   never mapped automatically to a delay
 *   blockers        a separate confirmed source, carrying named reasons a work
 *                   cannot proceed
 *
 * No colour is converted into a business rule. `RED` is a degree of schedule
 * variance and does not mean "blocked"; deriving business meaning from a colour
 * code invents a rule the product model does not have.
 */
export type StatusVariant =
  | 'OnTrack'
  | 'Delayed'
  | 'Attention'
  | 'Blocked'
  | 'Neutral';

/** Fill and text custom properties for each visual status. */
export const statusToken: Record<StatusVariant, { fill: TokenRef; text: TokenRef }> = {
  OnTrack: { fill: 'var(--cc-status-on-track-fill)', text: 'var(--cc-status-on-track-text)' },
  Delayed: { fill: 'var(--cc-status-delayed-fill)', text: 'var(--cc-status-delayed-text)' },
  Attention: { fill: 'var(--cc-status-attention-fill)', text: 'var(--cc-status-attention-text)' },
  Blocked: { fill: 'var(--cc-status-blocked-fill)', text: 'var(--cc-status-blocked-text)' },
  Neutral: { fill: 'var(--cc-status-neutral-fill)', text: 'var(--cc-status-neutral-text)' },
};

/** The sixteen text styles. The class name is the token name, prefixed. */
export type TypographyStyle =
  | 'display'
  | 'metric-xl'
  | 'metric-lg'
  | 'metric-md'
  | 'heading-page'
  | 'heading-section'
  | 'heading-card'
  | 'body-lg'
  | 'body'
  | 'body-strong'
  | 'ui'
  | 'ui-strong'
  | 'label'
  | 'label-strong'
  | 'meta'
  | 'eyebrow';

/** Class name for a text style, e.g. `typeClass('body-strong') === 'cc-type-body-strong'`. */
export function typeClass(style: TypographyStyle): string {
  return `cc-type-${style}`;
}

/** Class that re-establishes the design-system baseline over a subtree. */
export const SCOPE_CLASS = 'ccScope';

/**
 * Grid spans in pixels. 12 columns of 77px with a 20px gutter, so
 * `n * 77 + (n - 1) * 20`. Block widths are whole spans (D-01).
 */
export const span = {
  s3: 271,
  s4: 368,
  s8: 756,
  s12: 1144,
} as const;

export type SpanName = keyof typeof span;

/** Layout constants needed as numbers rather than as CSS. */
export const layout = {
  sidebarWidth: 208,
  topbarHeight: 64,
  contentWidth: 1144,
  column: 77,
  gutter: 20,
  columns: 12,
} as const;

/** Width in pixels of a run of `n` grid columns. */
export function spanWidth(columns: number): number {
  return columns * layout.column + (columns - 1) * layout.gutter;
}
