import type { Snapshot } from '../types/api';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isObjectArray(value: unknown): value is Array<Record<string, unknown>> {
  return Array.isArray(value) && value.every(isPlainObject);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function hasStringField(record: Record<string, unknown>, field: string): boolean {
  return isString(record[field]);
}

function isStringOrNull(value: unknown): value is string | null {
  return isString(value) || value === null;
}

function hasStringOrNullField(record: Record<string, unknown>, field: string): boolean {
  return isStringOrNull(record[field]);
}

const MALFORMED_SNAPSHOT_MESSAGE = 'Неверный ответ сервера: искажённый снимок данных.';

function fail(): never {
  throw new Error(MALFORMED_SNAPSHOT_MESSAGE);
}

/**
 * F6-02 corrective, second pass (Work re-review) — the first pass checked
 * only the top-level collections and the two identity fields (`id`,
 * `objectId`) routing keys off. That left every other field the builders and
 * screens actually read unguarded: a `work.blockers` that is missing, `null`
 * or a non-array object still passed straight through, and
 * `workStatusPresentation()` (`view-models/status.ts`, called by every one
 * of C01/O01/W01) then throws reading `.length` on it — past `Ready`, with
 * no `RouteError` for it. The same crash class applies wherever a screen
 * renders a field directly as a JSX child (`work.blockers.map(reason =>
 * <li>{reason}</li>)` in W01/O01 — an object element there throws the same
 * way) or passes it to `joinMeta` (`c01.ts`: `joinMeta(object.externalCode,
 * object.address)`), which calls `.trim()` on it.
 *
 * The fields below were found by reading the four files that actually
 * consume a `Snapshot` record — `view-models/c01.ts`, `o01.ts`, `w01.ts` and
 * the shared `status.ts` — not guessed:
 *
 *   - `blockers` — iterated (`.length`, `.map`) and each element rendered
 *     directly as JSX in W01/O01, so it must be an array of strings.
 *   - `id`/`objectId`/`objectWorkId` — the identity/linkage fields routing
 *     and `WorkRoute`/`buildW01ViewModel`'s inspection matching key off.
 *   - `name`/`externalCode`/`address`/`responsible` (objects) and
 *     `name`/`contractor`/`unit` (works) — rendered directly as JSX text or
 *     passed to `joinMeta`; a non-string here throws the same way `blockers`
 *     does.
 *   - `customerName`/`organizationName` (objects) — `string | null` in the
 *     type (`ReadService.snapshot()`'s `SELECT o.*` always selects these
 *     columns, so the backend never omits the key — only its value can be
 *     `null`). `o01.ts` reads them through `?? NO_DATA_DASH`, which only
 *     replaces `null`/`undefined`; a truthy non-string (`{}`, `[]`) passes
 *     straight through into `O01Details`, typed `string`, and
 *     `screens/O01/index.tsx` renders it directly as a JSX child — the same
 *     crash class as `blockers`, just reachable through `??` instead of
 *     `.length`. A string or `null` is accepted; anything else, including a
 *     missing key, is rejected — a missing key on a column the backend
 *     always selects is a transport defect, not a legitimate narrow
 *     response, the same reasoning `inspections` below already uses.
 *   - `status` (inspections) — the field `confirmationFromInspectionStatus`
 *     switches on; required to be a string so a genuinely truncated
 *     inspection record cannot pass silently, this does not check *which*
 *     string.
 *
 * Deliberately unchecked: `scheduleStatus` (works) and `status` values
 * themselves are `Known<T>` unions specifically because the columns behind
 * them are unconstrained text, and `scheduleStatusPresentation`/
 * `confirmationFromInspectionStatus` already have a documented, deliberate
 * `default` arm that reads an unrecognised value as neutral rather than an
 * error (see `status.ts`'s own corrective notes) — hard-rejecting them here
 * would fight that existing, accepted design, not extend it. Percentages,
 * quantities, dates and `lastReportedAt` are read through helpers
 * (`formatters/*`, `??`, `!== null`) that already handle `null`/`undefined`/
 * an unexpected value without throwing — unchanged, and not re-validated
 * here. `requestedAt` (inspections) is a sort key only, not an identity or
 * status field, and a wrong value there cannot crash or corrupt identity —
 * only reorder a list — so it is left alone too.
 */
export function validateSnapshot(value: unknown): Snapshot {
  if (!isPlainObject(value)) fail();

  if (!isObjectArray(value.objects)) fail();
  for (const object of value.objects) {
    if (!hasStringField(object, 'id')) fail();
    if (!hasStringField(object, 'name')) fail();
    if (!hasStringField(object, 'externalCode')) fail();
    if (!hasStringField(object, 'address')) fail();
    if (!hasStringField(object, 'responsible')) fail();
    if (!hasStringOrNullField(object, 'customerName')) fail();
    if (!hasStringOrNullField(object, 'organizationName')) fail();
  }

  if (!isObjectArray(value.works)) fail();
  for (const work of value.works) {
    if (!hasStringField(work, 'id')) fail();
    if (!hasStringField(work, 'objectId')) fail();
    if (!hasStringField(work, 'name')) fail();
    if (!hasStringField(work, 'contractor')) fail();
    if (!hasStringField(work, 'unit')) fail();
    if (!isStringArray(work.blockers)) fail();
  }

  if (!isObjectArray(value.contractors)) fail();
  if (!isObjectArray(value.dependencies)) fail();

  // Required for this internal-only provider even though the general
  // Snapshot type marks it optional (CONTRACTOR_VIEWER omits it entirely,
  // out of F6 scope) — see the module doc comment.
  if (!isObjectArray(value.inspections)) fail();
  for (const inspection of value.inspections) {
    if (!hasStringField(inspection, 'objectWorkId')) fail();
    if (!hasStringField(inspection, 'status')) fail();
  }

  // F8.1 — unlike `inspections` above, left genuinely optional: absent
  // entirely passes (a pre-F8.1 fixture, or any other snapshot fixture
  // written before these four collections existed, is not a transport
  // defect), but a *present* value is still checked, for the same two
  // reasons `blockers` and `customerName`/`organizationName` are above —
  // `label` and `unit` are rendered directly as JSX text
  // (screens/W01/ExecutionSection.tsx), and `location`/`executionConditions`
  // go through `joinMeta`, which calls `.trim()` on each non-null part.
  // Quantities and the two accepted flags are read through
  // `formatMeasure`/truthiness, already null/wrong-type safe, and so stay
  // unchecked — the same line `scheduleStatus` and `plannedProgress` already
  // draw above. A real backend response always includes them (possibly
  // empty) for every internal role, so this costs nothing there.
  if (value.executionUnits !== undefined) {
    if (!isObjectArray(value.executionUnits)) fail();
    for (const unit of value.executionUnits) {
      if (!hasStringField(unit, 'id')) fail();
      if (!hasStringField(unit, 'objectWorkId')) fail();
      if (!hasStringField(unit, 'unit')) fail();
      if (!hasStringOrNullField(unit, 'location')) fail();
      if (!hasStringOrNullField(unit, 'executionConditions')) fail();
    }
  }

  if (value.portions !== undefined) {
    if (!isObjectArray(value.portions)) fail();
    for (const portion of value.portions) {
      if (!hasStringField(portion, 'id')) fail();
      if (!hasStringField(portion, 'executionUnitId')) fail();
      if (!hasStringField(portion, 'label')) fail();
    }
  }

  return value as unknown as Snapshot;
}
