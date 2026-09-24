import type { Snapshot } from '../types/api';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isObjectArray(value: unknown): value is Array<Record<string, unknown>> {
  return Array.isArray(value) && value.every(isPlainObject);
}

function hasStringField(record: Record<string, unknown>, field: string): boolean {
  return typeof record[field] === 'string';
}

const MALFORMED_SNAPSHOT_MESSAGE = 'Неверный ответ сервера: искажённый снимок данных.';

/**
 * F6-02 corrective (Work review) — a `2xx` response with the wrong JSON
 * shape (`{}`, `null`, `{objects:{},works:[]}`) used to pass straight
 * through `realDataProvider.getSnapshot()` as a `Snapshot` via a bare `as`
 * assertion — a compile-time promise, not a runtime check — then crashed at
 * render inside CompanyRoute/ObjectRoute/WorkRoute: after the loading state,
 * outside any `catch`, with no `RouteError` for it.
 *
 * This checks exactly the structural skeleton those route containers and
 * their identity lookups (`objects.find(o => o.id === objectId)`,
 * `works.find(w => w.id === workId && w.objectId === objectId)`) depend on:
 * the required top-level collections are arrays, and every object/work
 * record carries the string `id` (and, for works, `objectId`) routing keys
 * off. It deliberately stops there — it does not re-validate every field the
 * F4 builders read, and it does not reject any value the `Snapshot` type
 * already allows to be `null` or an unrecognised status string; that
 * handling is unchanged and untouched.
 *
 * `realDataProvider` only ever serves internal (non-`CONTRACTOR_VIEWER`)
 * roles within F6's scope, and the backend always returns `inspections` as a
 * real array for those roles (`read-service.ts`). A missing or `null`
 * `inspections` here is therefore a contract violation, not the
 * `CONTRACTOR_VIEWER`-shaped narrow response — it is rejected rather than
 * left for `WorkRoute`'s `?? []` to read as "confirmed empty", so
 * "unavailable" can never be silently mistaken for "definitely none".
 *
 * The thrown message is fixed and generic — never the response body — the
 * same rule `http.ts`'s `httpErrorMessage` already follows for HTTP errors.
 */
export function validateSnapshot(value: unknown): Snapshot {
  if (!isPlainObject(value)) throw new Error(MALFORMED_SNAPSHOT_MESSAGE);

  if (!isObjectArray(value.objects) || !value.objects.every((o) => hasStringField(o, 'id'))) {
    throw new Error(MALFORMED_SNAPSHOT_MESSAGE);
  }
  if (
    !isObjectArray(value.works) ||
    !value.works.every((w) => hasStringField(w, 'id') && hasStringField(w, 'objectId'))
  ) {
    throw new Error(MALFORMED_SNAPSHOT_MESSAGE);
  }
  if (!isObjectArray(value.contractors)) throw new Error(MALFORMED_SNAPSHOT_MESSAGE);
  if (!isObjectArray(value.dependencies)) throw new Error(MALFORMED_SNAPSHOT_MESSAGE);
  // Required for this internal-only provider even though the general
  // Snapshot type marks it optional (CONTRACTOR_VIEWER omits it entirely,
  // out of F6 scope) — see the CONTRACTOR_VIEWER note above.
  if (!isObjectArray(value.inspections)) throw new Error(MALFORMED_SNAPSHOT_MESSAGE);

  return value as unknown as Snapshot;
}
