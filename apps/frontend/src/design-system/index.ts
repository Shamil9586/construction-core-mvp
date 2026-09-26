/**
 * Construction Core design system — public entry point.
 *
 * Importing this module loads the token layer and the type scale. The product
 * screens do not import it yet: F1 delivers components and their preview, and
 * wiring into the application shell happens at F3.
 *
 * The design system depends on its tokens and on nothing else — not on services,
 * not on API types, not on view-models, not on formatters, not on domain models
 * or business rules. Components take finished display strings and plain numbers
 * as props; what a value should say is decided in the data chain.
 */

import './tokens/tokens.css';
import './tokens/typography.css';

export * from './tokens';

export { StatusBadge } from './data/StatusBadge';
export type { StatusBadgeProps } from './data/StatusBadge';

export { ProgressBar } from './data/ProgressBar';
export type { ProgressBarProps, ProgressBarSize } from './data/ProgressBar';

export { PlanFact } from './data/PlanFact';
export type { PlanFactProps, PlanFactItem, PlanFactEmphasis } from './data/PlanFact';

export { LinkedStage } from './data/LinkedStage';
export type {
  LinkedStageProps,
  LinkedStageItem,
  LinkedStageSummary,
} from './data/LinkedStage';

export { DataTable } from './data/DataTable';
export type {
  DataTableProps,
  DataTableColumn,
  DataTableState,
  RowStatus,
  RowTone,
} from './data/DataTable';

export { ObjectRow, objectColumns } from './data/ObjectRow';
export type { ObjectRowProps } from './data/ObjectRow';

export { WorkSummaryRow, workSummaryColumns } from './data/WorkSummaryRow';
export type { WorkSummaryRowProps } from './data/WorkSummaryRow';

export { Button } from './controls/Button';
export type {
  ButtonProps,
  ButtonVariant,
  ButtonWidth,
  ButtonArrow,
} from './controls/Button';

export { AppShell } from './navigation/AppShell';
export type { AppShellProps } from './navigation/AppShell';

export { Sidebar } from './navigation/Sidebar';
export type { SidebarProps, NavItem } from './navigation/Sidebar';

export { Breadcrumb } from './navigation/Breadcrumb';
export type { BreadcrumbProps, BreadcrumbItem } from './navigation/Breadcrumb';

export { PageHeader } from './navigation/PageHeader';
export type { PageHeaderProps } from './navigation/PageHeader';
