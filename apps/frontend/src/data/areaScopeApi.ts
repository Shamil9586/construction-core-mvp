import { readSessionToken } from '../auth/sessionToken';
import type { ApiViolation, AreaScopeCreatePayload, AreaScopePage, AreaScopeRead, CommandResult } from '../types/areaScope';

/**
 * GPR-2 R05 S2 — client for the AreaScope routes of ONE object. Real backend only; the server owns every rule (measurement pairing,
 * parent/child compatibility, object ownership), this module only sends the request and types the answer.
 *
 * It does not use the shared `parseResponse` (frozen, and it reduces an error to a message string): a `/v2` error carries `code`, `details`
 * and `requestId`, and the screen needs them. A non-JSON error body is never shown — only the status is kept.
 */
export class AreaScopeApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly details: unknown;
  readonly requestId: string | undefined;
  constructor(status: number, message: string, code?: string, details?: unknown, requestId?: string) {
    super(message);
    this.name = 'AreaScopeApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

/** A cursor repeated, the page budget ran out or a page was malformed: the tree would be partial, so nothing is shown. */
export class AreaScopePaginationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AreaScopePaginationError';
  }
}

export const AREA_SCOPE_PAGE_LIMIT = 200;
/** Hard ceiling on pages followed in one load; reaching it fails closed instead of showing a truncated tree. */
export const AREA_SCOPE_MAX_PAGES = 200;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isStringOrNull = (value: unknown): value is string | null => value === null || typeof value === 'string';

function toItem(value: unknown): AreaScopeRead {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !isStringOrNull(value.parentId) ||
    typeof value.kind !== 'string' ||
    typeof value.code !== 'string' ||
    typeof value.name !== 'string' ||
    !isStringOrNull(value.measureQuantity) ||
    !isStringOrNull(value.measureUnit) ||
    typeof value.lifecycle !== 'string'
  ) {
    throw new AreaScopePaginationError('Неверный ответ сервера: искажённая запись зоны.');
  }
  return {
    id: value.id,
    parentId: value.parentId,
    kind: value.kind,
    code: value.code,
    name: value.name,
    measureQuantity: value.measureQuantity,
    measureUnit: value.measureUnit,
    lifecycle: value.lifecycle,
    version: typeof value.version === 'number' ? value.version : 0,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
  };
}

function toPage(body: unknown): AreaScopePage {
  // nextCursor must be present and be a string or an explicit null; a missing
  // field could hide a truncated page, so it fails closed.
  if (
    !isRecord(body) ||
    !Array.isArray(body.items) ||
    !Object.prototype.hasOwnProperty.call(body, 'nextCursor') ||
    !isStringOrNull(body.nextCursor)
  ) {
    throw new AreaScopePaginationError('Неверный ответ сервера: искажённая страница списка зон.');
  }
  return { items: body.items.map(toItem), nextCursor: body.nextCursor };
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = readSessionToken();
  return token ? { ...extra, Authorization: `Bearer ${token}` } : extra;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function failFrom(response: Response): Promise<AreaScopeApiError> {
  const body = await readJson(response);
  const record = isRecord(body) ? body : {};
  const message = typeof record.message === 'string' && record.message.trim() ? record.message.trim() : `HTTP ${response.status}`;
  const requestId = typeof record.requestId === 'string' ? record.requestId : (response.headers.get('x-request-id') ?? undefined);
  return new AreaScopeApiError(
    response.status,
    message,
    typeof record.code === 'string' ? record.code : undefined,
    record.details,
    requestId,
  );
}

const base = (objectId: string) => `/api/v2/objects/${encodeURIComponent(objectId)}/area-scopes`;

/** One page. `signal` aborts a load the screen no longer wants. */
export async function getAreaScopePage(objectId: string, cursor: string | null, signal?: AbortSignal): Promise<AreaScopePage> {
  const params = new URLSearchParams({ limit: String(AREA_SCOPE_PAGE_LIMIT) });
  if (cursor) params.set('cursor', cursor);
  const response = await fetch(`${base(objectId)}?${params.toString()}`, { headers: authHeaders(), signal });
  if (!response.ok) throw await failFrom(response);
  const body = await readJson(response);
  if (body === undefined) throw new AreaScopePaginationError('Неверный ответ сервера: ожидался JSON.');
  return toPage(body);
}

/**
 * Follows every cursor until it is null. A repeated cursor or an exhausted page budget throws instead of returning what was collected so
 * far: a partial tree would read as a complete one.
 */
export async function listAllAreaScopes(objectId: string, signal?: AbortSignal): Promise<AreaScopeRead[]> {
  const items: AreaScopeRead[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < AREA_SCOPE_MAX_PAGES; page += 1) {
    const result = await getAreaScopePage(objectId, cursor, signal);
    items.push(...result.items);
    if (result.nextCursor === null) return items;
    if (seen.has(result.nextCursor)) throw new AreaScopePaginationError('Сервер повторил курсор страницы: список зон неполный и не показан.');
    seen.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new AreaScopePaginationError('Список зон слишком длинный: загрузка остановлена, дерево не показано.');
}

export function newIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

/** `Idempotency-Key` is required by the route. The caller owns the key so a retry of the SAME payload can reuse it. */
export async function createAreaScope(objectId: string, payload: AreaScopeCreatePayload, idempotencyKey: string): Promise<CommandResult> {
  const response = await fetch(base(objectId), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey }),
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw await failFrom(response);
  const body = await readJson(response);
  if (!isRecord(body)) throw new AreaScopePaginationError('Неверный ответ сервера: ожидался JSON.');
  return body as unknown as CommandResult;
}

/** Violations the server named, narrowed to the two strings the screen can translate. */
export function violationsOf(details: unknown): ApiViolation[] {
  if (!isRecord(details) || !Array.isArray(details.violations)) return [];
  return details.violations.flatMap((entry) =>
    isRecord(entry) && typeof entry.path === 'string' && typeof entry.rule === 'string' ? [{ path: entry.path, rule: entry.rule }] : [],
  );
}
