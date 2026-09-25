/**
 * Routing foundation — path templates and builders, kept apart from both the
 * screens (which know nothing about URLs) and the route containers (which
 * know nothing about how a path string is assembled).
 *
 * `ROUTE_PATHS` holds the `<Route path>` templates react-router matches
 * against. `objectPath`/`workPath` build a real, navigable URL from an actual
 * id at call time — no identifier is ever hardcoded here, only the shape of
 * the URL.
 */
export const ROUTE_PATHS = {
  root: '/',
  company: '/company',
  object: '/object/:objectId',
  work: '/object/:objectId/work/:workId',
  /** F8.2 — P01, PTO Workspace: a separate top-level destination, not part of the object drill-down chain. */
  pto: '/pto',
  /** F8.2.1 — Documentation Package detail: reachable from both P01 and W01 (Decision 1, one shared destination). */
  package: '/pto/package/:packageId',
} as const;

export function objectPath(objectId: string): string {
  return `/object/${encodeURIComponent(objectId)}`;
}

export function workPath(objectId: string, workId: string): string {
  return `/object/${encodeURIComponent(objectId)}/work/${encodeURIComponent(workId)}`;
}

export function packagePath(packageId: string): string {
  return `/pto/package/${encodeURIComponent(packageId)}`;
}
