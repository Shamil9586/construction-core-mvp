/**
 * Construction Core — shapes of the existing backend contracts.
 *
 * These describe what the API returns *today*, verified against the controllers,
 * `ReadService.snapshot()`, the domain services and `infra/001_initial.sql`.
 * Nothing here is aspirational: fields the model cannot currently express —
 * confirmed СК volume, zones, finish type, work layers, sequences — are absent on
 * purpose and are added only after a backend decision. A type that promises a
 * field the server never sends is worse than no type at all, because it makes the
 * gap invisible to everyone downstream.
 *
 * `apps/backend/src/db.ts` converts every column from snake_case to camelCase
 * (`camel()`), so the names below are the camelCase ones the client receives.
 */

export type Uuid = string;

/** A calendar date, "YYYY-MM-DD". A `DATE` column, deliberately not an instant. */
export type CivilDate = string;

/** An instant, ISO 8601 with a zone. */
export type Timestamp = string;

/** A `numeric` column. Arrives as a string; use decimal.js for arithmetic. */
export type Numeric = string;

/**
 * Several status columns are plain `text` with no CHECK constraint, so the
 * database does not actually restrict them. The unions below list the values the
 * code produces, and the `(string & {})` arm records that the column can hold
 * something else. Keep autocomplete, do not gain false confidence: a view-model
 * switching on one of these needs a path for an unrecognised value.
 */
type Known<T extends string> = T | (string & {});

/* ---------------------------------------------------------------------- *
 * Closed sets — produced by domain services or constrained by the schema  *
 * ---------------------------------------------------------------------- */

export type Role =
  | 'GENERAL_DIRECTOR'
  | 'TECHNICAL_DIRECTOR'
  | 'PROJECT_MANAGER'
  | 'CONSTRUCTION_CONTROL'
  | 'PTO'
  | 'SDO'
  | 'DEPARTMENT_HEAD'
  | 'ADMIN'
  | 'CONTRACTOR_VIEWER';

/**
 * Output of `ScheduleStatusService`. A degree of variance against the schedule —
 * `RED` means a large negative variance, not a blocked work. Blocking is a
 * separate signal, carried by `Work.blockers`.
 */
export type ScheduleStatus = 'GREEN' | 'YELLOW' | 'RED' | 'GRAY';

/**
 * Output of `ObjectHealthService`. This deliberately mixes contours — late ИД
 * (`ptoLate`) and late СДО (`sdoLate`) raise it to `YELLOW` — so it describes
 * overall attention, not schedule state, and must not be presented as one.
 */
export type HealthStatus = 'GREEN' | 'YELLOW' | 'RED' | 'GRAY';

/** Constrained by a CHECK on `issues.severity`. */
export type IssueSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/** Constrained by a CHECK on `monthly_plans.plan_type`. */
export type PlanType = 'INTERMEDIATE' | 'FINAL';

/** Constrained by a CHECK on `work_dependencies.dependency_type`. */
export type DependencyType = 'FINISH_TO_START';

/** Constrained by a CHECK on `inspections.inspection_type` (F8.1). */
export type InspectionType = Known<'INTERNAL_SC' | 'CUSTOMER_SC'>;

/** Constrained by a CHECK on `portion_quantity_confirmations.source` (F8.1). */
export type PortionConfirmationSource = Known<'RP_FACT' | 'INTERNAL_SC' | 'CUSTOMER_SC'>;

/**
 * F8.1-02 corrective (Independent Review) — an execution unit's coverage by
 * accepted portions: `PortionCompletionService.unitCoverage()`'s own output
 * (packages/domain), never a plain boolean. `NONE`/`PARTIAL`/`COMPLETE` are
 * a closed set the backend actually enforces (unlike `InspectionStatus` and
 * friends, which are `Known<T>` because their DB columns are unconstrained
 * text) — validateSnapshot.ts hard-rejects anything else, it does not fall
 * back to a neutral reading.
 */
export type ScCoverageStatus = 'NONE' | 'PARTIAL' | 'COMPLETE';

/* ---------------------------------------------------------------------- *
 * Conventional sets — text columns, not database-constrained              *
 * ---------------------------------------------------------------------- */

export type ObjectStatus = Known<
  'ACTIVE' | 'PLANNED' | 'DELAYED' | 'COMPLETED' | 'SUSPENDED' | 'AT_RISK' | 'ARCHIVED'
>;
export type WorkStatus = Known<'PLANNED' | 'ACTIVE' | 'COMPLETED'>;
export type InspectionStatus = Known<
  'WAITING' | 'IN_REVIEW' | 'ISSUES_FOUND' | 'REINSPECTION' | 'ACCEPTED' | 'REJECTED'
>;
export type IssueStatus = Known<'OPEN' | 'READY_FOR_VERIFICATION' | 'CLOSED'>;
export type PackageStatus = Known<'DRAFT' | 'IN_PROGRESS' | 'READY' | 'TRANSFERRED_TO_SDO'>;
export type DocumentStatus = Known<'DRAFT' | 'APPROVED'>;
export type SdoStatus = Known<'TRANSFERRED' | 'CALCULATED' | 'READY_TO_CLOSE' | 'CLOSED'>;
export type ContractorStatus = Known<'ACTIVE'>;

/* ---------------------------------------------------------------------- *
 * Entities                                                                *
 * ---------------------------------------------------------------------- */

/** Fields every tenant-scoped row carries. */
export interface Versioned {
  id: Uuid;
  tenantId: Uuid;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  version: number;
}

/** `GET /me` — the authenticated actor. */
export interface Actor {
  id: Uuid;
  tenantId: Uuid;
  role: Role;
  name: string;
  contractorId?: Uuid;
}

/**
 * `GET /health` — public, unauthenticated (health.controller.ts). `authMode` is
 * the backend's own `AUTH_MODE`; `createApp()` refuses to start with anything
 * but `mock` or `bitrix`, and refuses `mock` under `NODE_ENV=production`
 * (apps/backend/src/main.ts). It is the existing way for a client to tell a
 * mock-auth test environment from the Bitrix24 production one.
 */
export interface HealthResponse {
  status: string;
  authMode: Known<'mock' | 'bitrix'>;
  databaseMode: string;
}

/**
 * `POST /auth/mock` — the value of `session()` (apps/backend/src/security.ts):
 * a new opaque bearer token and the actor it belongs to. Only served when the
 * backend runs with `AUTH_MODE=mock`.
 */
export interface SessionGrant {
  token: string;
  user: { id: Uuid; name: string; role: Role; tenantId: Uuid };
}

/** `POST /auth/logout` — deletes the caller's own `sessions` row. */
export interface LogoutResponse {
  loggedOut: true;
}

/** `GET /users` — deliberately a narrow projection, not the full user row. */
export interface UserSummary {
  id: Uuid;
  name: string;
  role: Role;
  bitrixUserId: string | null;
}

export interface Contractor extends Versioned {
  name: string;
  inn: string | null;
  contactData: string | null;
  status: ContractorStatus;
}

/** `GET /objects/:id/contractors` — a row of the `object_contractors_active` view. */
export interface ObjectContractorLink extends Versioned {
  objectId: Uuid;
  contractorId: Uuid;
  removedAt: Timestamp | null;
  removedBy: Uuid | null;
  contractorName: string;
}

/**
 * An object as `ReadService.snapshot()` returns it: the `objects` row, the project
 * manager's name, the current contractor assignment, and aggregates.
 *
 * `actualProgress` and `plannedProgress` are averages of the object's works
 * weighted by `estimatedCost`. They derive only from physical quantities and
 * dates — ИД, СДО and financial closing do not enter the calculation.
 *
 * `contractValue`, `closed` and `potential` are stripped for `CONTRACTOR_VIEWER`,
 * which is why they are optional.
 */
export interface ObjectSummary extends Versioned {
  externalCode: string;
  source: string;
  name: string;
  address: string;
  customerName: string | null;
  organizationName: string | null;
  projectManagerId: Uuid;
  startDate: CivilDate;
  plannedFinishDate: CivilDate;
  actualFinishDate: CivilDate | null;
  status: ObjectStatus;
  healthStatus: HealthStatus;
  responsible: string;
  contractorIds: Uuid[];
  contractors: string[];
  actualProgress: number | null;
  plannedProgress: number | null;
  contractValue?: Numeric;
  closed?: Numeric;
  potential?: Numeric;
}

/** The closing funnel for one work, from `PotentialClosingService`. */
export interface WorkFinancial {
  physical: Numeric;
  closed: Numeric;
  potential: Numeric;
  buckets: {
    notAccepted: Numeric;
    pto: Numeric;
    ready: Numeric;
    sdo: Numeric;
    calculated: Numeric;
  };
}

/**
 * A work as the snapshot returns it: the `works` row, joined names, flags from
 * `work_types`, and the derived schedule fields.
 *
 * `blockers` carries ready-made reasons a work cannot proceed — an unfinished
 * predecessor, no СК clearance, a critical issue, a missing required document.
 * This, not a colour, is the source for a blocked state.
 *
 * `estimatedCost`, `closed` and `financial` are stripped for `CONTRACTOR_VIEWER`.
 */
export interface Work extends Versioned {
  objectId: Uuid;
  workTypeId: Uuid;
  contractorId: Uuid;
  responsibleUserId: Uuid;
  name: string;
  unit: string;
  plannedQuantity: Numeric;
  actualQuantity: Numeric;
  plannedStartDate: CivilDate;
  plannedFinishDate: CivilDate;
  actualStartDate: CivilDate | null;
  actualFinishDate: CivilDate | null;
  status: WorkStatus;
  categoryId: Uuid;
  requiresInspection: boolean;
  requiresMaterials: boolean;
  contractor: string;
  responsible: string;
  lastReportedAt: Timestamp | null;
  plannedProgress: number | null;
  actualProgress: number | null;
  variance: number | null;
  delayDays: number;
  scheduleStatus: ScheduleStatus;
  accepted: boolean;
  docsReady: boolean;
  blockers: string[];
  stale: boolean;
  estimatedCost?: Numeric;
  closed?: Numeric;
  financial?: WorkFinancial;
  /**
   * F8.1 — whether every portion of every execution unit on this work has a
   * separate, accepted Customer SC inspection. `null` when the work has no
   * execution units at all (F8.1 does not apply to it); never derived from
   * `accepted` (Internal SC), which is a different control with its own
   * confirmation history (F8.1 clarification 2). Optional only so existing
   * object literals typed as `Work` (demo fixtures, tests predating F8.1)
   * need no change — a real snapshot always sends it.
   */
  customerScAccepted?: boolean | null;
}

/** `GET /works/:id/progress` — append-only, immutable by database trigger. */
export interface WorkProgressEntry extends Versioned {
  objectWorkId: Uuid;
  quantityDelta: Numeric;
  totalQuantity: Numeric;
  progressPercent: Numeric | null;
  reportedAt: Timestamp;
  /** The author of the record. A raw id — join against `GET /users` for a name. */
  reportedBy: Uuid;
  comment: string | null;
}

/**
 * A construction-control inspection.
 *
 * Note what is not here: a confirmed quantity. `POST /inspections/:id/accept`
 * takes only a version and a comment, so acceptance is a decision about the work
 * as a whole and the system cannot express "498 of the 500 reported".
 */
export interface Inspection extends Versioned {
  objectId: Uuid;
  objectWorkId: Uuid;
  requestedBy: Uuid;
  requestedAt: Timestamp;
  inspectorId: Uuid | null;
  status: InspectionStatus;
  inspectionDate: Timestamp | null;
  decision: string | null;
  comment: string | null;
  acceptedAt: Timestamp | null;
  /**
   * F8.1 — `null` for a whole-work inspection (every inspection predating
   * F8.1, and any work with no execution units); set for one raised against
   * a single Quantity Portion. Optional for the same reason as
   * `Work.customerScAccepted` — a real snapshot always sends it.
   */
  portionId?: Uuid | null;
  /** F8.1 — defaults to `INTERNAL_SC` at the database for every pre-F8.1 row. */
  inspectionType?: InspectionType;
}

export interface Issue extends Versioned {
  inspectionId: Uuid;
  title: string;
  description: string | null;
  severity: IssueSeverity;
  responsibleUserId: Uuid;
  dueDate: CivilDate;
  status: IssueStatus;
  resolvedAt: Timestamp | null;
  resolvedBy: Uuid | null;
  verifiedAt: Timestamp | null;
  verifiedBy: Uuid | null;
  /** Joined in the snapshot from the parent inspection. */
  objectId: Uuid;
  objectWorkId: Uuid;
  responsible: string;
}

export interface ExecutivePackage extends Versioned {
  objectId: Uuid;
  objectWorkId: Uuid;
  status: PackageStatus;
  createdBy: Uuid;
  completedAt: Timestamp | null;
}

export interface ExecutiveDocument extends Versioned {
  objectId: Uuid;
  objectWorkId: Uuid;
  type: string;
  number: string;
  documentDate: CivilDate;
  status: DocumentStatus;
  fileId: Uuid | null;
  draftContent: string | null;
  createdBy: Uuid;
  approvedBy: Uuid | null;
  approvedAt: Timestamp | null;
}

export interface SdoCase extends Versioned {
  objectId: Uuid;
  objectWorkId: Uuid;
  executiveDocumentPackageId: Uuid;
  status: SdoStatus;
  ptoTransferredAt: Timestamp | null;
  ptoTransferredBy: Uuid;
  sdoResponsibleId: Uuid | null;
  estimatedValue: Numeric | null;
  calculatedValue: Numeric | null;
  acceptedClosingValue: Numeric | null;
  calculatedAt: Timestamp | null;
  closedAt: Timestamp | null;
  comment: string | null;
}

export interface FinancialClosing extends Versioned {
  objectId: Uuid;
  sdoCaseId: Uuid;
  period: string;
  amount: Numeric;
  closingDate: CivilDate;
  createdBy: Uuid;
  idempotencyKey: Uuid;
}

export interface MonthlyPlan extends Versioned {
  objectId: Uuid;
  period: string;
  plannedValue: Numeric;
  planType: PlanType;
}

export interface WorkDependency extends Versioned {
  predecessorWorkId: Uuid;
  successorWorkId: Uuid;
  dependencyType: DependencyType;
  requiresAcceptance: boolean;
  requiresDocument: boolean;
}

export interface InspectionPhoto extends Versioned {
  inspectionId: Uuid;
  issueId: Uuid | null;
  attachmentId: Uuid;
  uploadedBy: Uuid;
  metadata: unknown;
}

/**
 * F8.1 — a Work Execution Unit: the concrete production unit within a work
 * (`work type; finishing type; layer structure; execution conditions;
 * location; contractor; measurement unit; planned quantity`, Domain Contract
 * v1.0). `finishTypeId`/`executionConditions`/`location` are frequently
 * absent — a unit does not always narrow every attribute.
 *
 * `actualQuantity` is not a stored column: `ReadService.snapshot()` derives
 * it as the sum of its portions' latest RP_FACT confirmations (F8.1 decision
 * 2 — no conflicting stored totals). There is no `workTypeId`/`finishTypeId`
 * name here because `GET /dictionaries` does not join one; resolving it is a
 * capability this snapshot does not have yet, not a value this particular
 * unit happens to be missing.
 */
export interface WorkExecutionUnit extends Versioned {
  objectWorkId: Uuid;
  workTypeId: Uuid;
  finishTypeId: Uuid | null;
  executionConditions: string | null;
  location: string | null;
  contractorId: Uuid;
  unit: string;
  plannedQuantity: Numeric;
  actualQuantity: Numeric;
  /** F8.1-02 corrective — coverage by accepted portions; see `ScCoverageStatus`. */
  internalScStatus: ScCoverageStatus;
  customerScStatus: ScCoverageStatus;
}

/** F8.1 — one ordered layer of a Work Execution Unit's composition. */
export interface ExecutionUnitLayer extends Versioned {
  executionUnitId: Uuid;
  sortOrder: number;
  name: string;
}

/**
 * F8.1 — a Quantity Portion: a measurable part of a Work Execution Unit that
 * can be presented, inspected and tracked independently (Domain Contract
 * v1.0). The three confirmation fields are `ReadService.snapshot()`'s own
 * derived read of `portion_quantity_confirmations`' latest row per source —
 * RP fact, Internal SC and Customer SC never overwrite one another (F8.1
 * "Quantity confirmation history"), so all three can disagree and all three
 * are shown, never merged into one number.
 */
export interface QuantityPortion extends Versioned {
  executionUnitId: Uuid;
  label: string;
  plannedQuantity: Numeric;
  rpFactQuantity: Numeric | null;
  internalScAccepted: boolean;
  internalScConfirmedQuantity: Numeric | null;
  customerScAccepted: boolean;
  customerScConfirmedQuantity: Numeric | null;
}

/**
 * F8.1 — one row of a Quantity Portion's append-only confirmation history
 * (`POST portions/:id/fact`, or one accepted inspection's confirmed
 * quantity). Immutable by database trigger, same as `WorkProgressEntry`.
 */
export interface PortionQuantityConfirmation extends Versioned {
  portionId: Uuid;
  source: PortionConfirmationSource;
  quantity: Numeric;
  inspectionId: Uuid | null;
  recordedBy: Uuid;
  recordedAt: Timestamp;
  comment: string | null;
}

export interface RiskSettings extends Versioned {
  yellowVariance: Numeric;
  redVariance: Numeric;
  staleDays: number;
  ptoDays: number;
  sdoDays: number;
  escalateTechnicalDays: number;
  escalateDirectorDays: number;
}

export interface WorkCategory extends Versioned {
  parentId: Uuid | null;
  name: string;
  code: string;
  sortOrder: number;
  isActive: boolean;
}

export interface WorkType extends Versioned {
  categoryId: Uuid;
  name: string;
  unit: string;
  requiresInspection: boolean;
  requiresExecutiveDocs: boolean;
  requiresMaterials: boolean;
  isActive: boolean;
}

/* ---------------------------------------------------------------------- *
 * Dashboard                                                               *
 * ---------------------------------------------------------------------- */

export type AttentionEntityType = Known<'Work' | 'Issue' | 'Package' | 'SdoCase'>;

/**
 * One attention signal.
 *
 * The list mixes levels: alongside object-level schedule problems it carries
 * individual СК issues, ИД packages and СДО cases. Design Rules §4 keeps those
 * off C01, so a view-model selects and aggregates before anything is rendered.
 */
export interface AttentionSignal {
  entityType: AttentionEntityType;
  entityId: Uuid;
  objectId: Uuid;
  objectName: string | undefined;
  contractor: string;
  title: string;
  reason: string;
  severity: Known<'RED' | 'YELLOW' | 'GRAY'>;
  daysOverdue: number;
  moneyImpact: Numeric;
  responsible: string;
  recommendedAction: string;
}

export interface DashboardProjection {
  activeObjects: number;
  greenObjects: number;
  yellowObjects: number;
  redObjects: number;
  grayObjects: number;
  /** A count of works, not of objects. */
  delayedWorks: number;
  openInspectionIssues: number;
  criticalInspectionIssues: number;
  awaitingInspection: number;
  ptoBacklog: number;
  sdoBacklog: number;
  plannedClosing: Numeric;
  closedThisMonth: Numeric;
  potentialClosing: Numeric;
  forecastClosing: Numeric;
  readyToClose: Numeric;
  buckets: {
    notAccepted: Numeric;
    pto: Numeric;
    ready: Numeric;
    sdo: Numeric;
    calculated: Numeric;
  };
  attentionRequired: AttentionSignal[];
}

/* ---------------------------------------------------------------------- *
 * Responses                                                               *
 * ---------------------------------------------------------------------- */

/**
 * `GET /snapshot`.
 *
 * `CONTRACTOR_VIEWER` receives a reduced payload — objects and works without
 * money, no dashboard, no inspections, packages, sdo or closings. The narrowed
 * fields are optional here rather than modelled as a separate union, because the
 * response carries no discriminant to switch on; the caller knows the role.
 */
export interface Snapshot {
  objects: ObjectSummary[];
  works: Work[];
  contractors: Contractor[];
  dependencies: WorkDependency[];
  inspections?: Inspection[];
  issues?: Issue[];
  packages?: ExecutivePackage[];
  documents?: ExecutiveDocument[];
  sdo?: SdoCase[];
  closings?: FinancialClosing[];
  dashboard?: DashboardProjection;
  monthlyPlans?: MonthlyPlan[];
  risk?: RiskSettings;
  photos?: InspectionPhoto[];
  /** F8.1 — omitted for `CONTRACTOR_VIEWER`, same as `inspections`/`issues`. */
  executionUnits?: WorkExecutionUnit[];
  executionUnitLayers?: ExecutionUnitLayer[];
  portions?: QuantityPortion[];
  portionConfirmations?: PortionQuantityConfirmation[];
}

/** `GET /objects/:id` — note it carries no ИД, СДО or closing data. */
export interface ObjectDetail {
  object: ObjectSummary | undefined;
  works: Work[];
}

/** `GET /dictionaries`. */
export interface Dictionaries {
  categories: WorkCategory[];
  workTypes: WorkType[];
}

export interface Material extends Versioned {
  name: string;
  manufacturer: string | null;
  brand: string | null;
  type: string | null;
}

export interface MaterialBatch extends Versioned {
  materialId: Uuid;
  batchNumber: string;
  supplier: string | null;
  deliveryDate: CivilDate | null;
  objectId: Uuid;
}

export interface MaterialDocument extends Versioned {
  materialBatchId: Uuid;
  type: string;
  number: string;
  validFrom: CivilDate | null;
  validUntil: CivilDate | null;
  fileId: Uuid;
}

/** Ties a batch to a work — the route from a work to its materials. */
export interface WorkMaterialLink extends Versioned {
  objectWorkId: Uuid;
  materialBatchId: Uuid;
  quantity: Numeric;
}

/** `GET /materials`. Requires `PTO_VIEW`, which every viewing role holds. */
export interface MaterialsResponse {
  materials: Material[];
  batches: MaterialBatch[];
  documents: MaterialDocument[];
  links: WorkMaterialLink[];
}
