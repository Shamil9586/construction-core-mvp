/**
 * GPR-2 R05 — S2 «Зоны объекта». Wire types of the existing AreaScope read (D1 `area-scopes.list`) and create (`area-scope.create`) routes.
 * Kinds and units are the contract's closed sets for NEW nodes; a read may still carry a value this build does not know, so the read side
 * keeps `kind` / `measureUnit` as plain strings and the view-model falls back safely.
 */
export const AREA_SCOPE_KINDS = ['BUILDING', 'SECTION', 'FLOOR', 'ZONE', 'ROOM', 'SURFACE', 'OTHER'] as const;
export type AreaScopeKind = (typeof AREA_SCOPE_KINDS)[number];

export const AREA_SCOPE_UNITS = ['м', 'м²', 'м³', 'т', 'кг', 'шт', 'компл'] as const;
export type AreaScopeUnit = (typeof AREA_SCOPE_UNITS)[number];

export interface AreaScopeRead {
  id: string;
  parentId: string | null;
  kind: string;
  code: string;
  name: string;
  /** Decimal string — never a JavaScript number. */
  measureQuantity: string | null;
  measureUnit: string | null;
  lifecycle: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface AreaScopePage {
  items: AreaScopeRead[];
  nextCursor: string | null;
}

export interface AreaScopeCreatePayload {
  parentId?: string | null;
  kind: AreaScopeKind;
  code: string;
  name: string;
  measureQuantity?: string | null;
  measureUnit?: AreaScopeUnit | null;
}

export interface CommandResult {
  resultIds: string[];
  appliedVersions: unknown;
  warnings: unknown[];
}

export interface ApiViolation {
  path: string;
  rule: string;
}
