import type {
  AddScheduleEntryInput,
  ApproveScheduleInput,
  EditScheduleEntryInput,
  ObjectSchedule,
  RecordDelayReasonInput,
  ResponsibleOptions,
  ScheduleEntryState,
  WorkSchedule,
} from '../types/schedule';
import type { UserSummary, Uuid } from '../types/api';
import { parseResponse } from '../http';
import { readSessionToken } from '../auth/sessionToken';

/**
 * GPR-1 — the API client of the Production Schedule. Like `documentationApi.ts` / `executionUnitsApi.ts` it is not a `DataProvider` method:
 * there is no mock side (the demo runtime has no schedule to serve), the schedule is read per OBJECT on demand rather than riding the
 * company-wide snapshot, and every call needs a real session.
 *
 * Reads are validated before they reach a screen (`isObjectSchedule` / `isWorkSchedule`): a response that is not the documented read
 * model — a proxy page, a partial object, the schedule of another object — is an error, never rendered and never authoritative.
 * A 403 is its own outcome (`ScheduleForbiddenError`): the role or the object does not allow reading the schedule, so the block is simply
 * absent — not "no data".
 */
export class ScheduleForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScheduleForbiddenError';
  }
}

function headers(json: boolean): Record<string, string> {
  const token = readSessionToken();
  return { ...(json ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`/api/${path}`, { headers: headers(false) });
  if (response.status === 403) {
    let message = 'Нет доступа к графику';
    try {
      const body = (await response.json()) as { message?: unknown };
      if (typeof body.message === 'string' && body.message.trim()) message = body.message.trim();
    } catch {
      // a non-JSON 403 keeps the generic message
    }
    throw new ScheduleForbiddenError(message);
  }
  return parseResponse(response) as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, { method: 'POST', headers: headers(true), body: JSON.stringify(body) });
  return parseResponse(response) as Promise<T>;
}

// ---- response guards ---------------------------------------------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isCivil = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const STATES: readonly ScheduleEntryState[] = ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'DELAYED'];

function isEntry(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isString(value.entryId) && isString(value.itemId) && isString(value.objectWorkId) && typeof value.workName === 'string' &&
    isCivil(value.plannedStart) && isCivil(value.plannedFinish) && isNumber(value.sequence) && isNumber(value.plannedProgress) &&
    typeof value.state === 'string' && (STATES as readonly string[]).includes(value.state) && isNumber(value.delayDays) &&
    typeof value.unit === 'string' && typeof value.plannedQuantity === 'string' && typeof value.executor === 'string' &&
    Array.isArray(value.delayReasons)
  );
}

function isAccess(value: unknown): boolean {
  return isRecord(value) && ['canEdit', 'canApprove', 'canRecordDelayReason', 'canCreateDraft', 'canManageCategories'].every((k) => typeof value[k] === 'boolean');
}

function isConclusion(value: unknown): boolean {
  return (
    isRecord(value) && (value.status === 'NO_BASELINE' || value.status === 'ON_TRACK' || value.status === 'DELAYED') &&
    ['entryCount', 'delayedCount', 'maxDelayDays', 'unscheduledCount', 'openDelayReasonCount'].every((k) => isNumber(value[k])) &&
    isRecord(value.expected)
  );
}

export function isObjectSchedule(value: unknown, expectedObjectId: string): value is ObjectSchedule {
  if (!isRecord(value)) return false;
  if (value.objectId !== expectedObjectId || !isCivil(value.asOf) || value.progressSource !== 'RP_FACT') return false;
  if (!isAccess(value.access) || !isConclusion(value.conclusion)) return false;
  if (!Array.isArray(value.entries) || !value.entries.every(isEntry)) return false;
  if (!Array.isArray(value.history) || !Array.isArray(value.unscheduled) || !Array.isArray(value.availableScopes)) return false;
  if (!Array.isArray(value.delayReasonCategories) || !value.delayReasonCategories.every((c) => isRecord(c) && isString(c.code) && typeof c.name === 'string')) return false;
  if (value.current !== null && !(isRecord(value.current) && isString(value.current.revisionId) && isNumber(value.current.revisionNo))) return false;
  if (value.draft !== null && !(isRecord(value.draft) && isString(value.draft.revisionId) && isNumber(value.draft.version) && Array.isArray(value.draft.entries) && Array.isArray(value.draft.changes))) return false;
  return true;
}

export function isWorkSchedule(value: unknown, expectedWorkId: string): value is WorkSchedule {
  if (!isRecord(value)) return false;
  if (value.objectWorkId !== expectedWorkId || !isString(value.objectId) || !isCivil(value.asOf) || value.progressSource !== 'RP_FACT') return false;
  if (typeof value.hasBaseline !== 'boolean' || !Array.isArray(value.entries) || !value.entries.every(isEntry)) return false;
  if (value.summary === null) return true;
  return isRecord(value.summary) && isCivil(value.summary.plannedStart) && isCivil(value.summary.plannedFinish) && isNumber(value.summary.delayDays) && isNumber(value.summary.entryCount) &&
    (value.summary.state === null || (typeof value.summary.state === 'string' && (STATES as readonly string[]).includes(value.summary.state)));
}

// ---- reads ---------------------------------------------------------------------------------------------------------------------------

export async function getObjectSchedule(objectId: Uuid): Promise<ObjectSchedule> {
  const result = await get<unknown>(`objects/${objectId}/schedule`);
  if (!isObjectSchedule(result, objectId)) throw new Error('Неверный ответ сервера: график объекта');
  return result;
}

export async function getWorkSchedule(workId: Uuid): Promise<WorkSchedule> {
  const result = await get<unknown>(`works/${workId}/schedule`);
  if (!isWorkSchedule(result, workId)) throw new Error('Неверный ответ сервера: график работы');
  return result;
}

// ---- writes — preparing, approving, explaining ---------------------------------------------------------------------------------------

const base = (objectId: Uuid): string => `objects/${objectId}/schedule`;

export function createScheduleDraft(objectId: Uuid): Promise<unknown> {
  return post(`${base(objectId)}/draft`, {});
}

export function addScheduleEntry(objectId: Uuid, input: AddScheduleEntryInput): Promise<unknown> {
  return post(`${base(objectId)}/draft/entries`, input);
}

export function editScheduleEntry(objectId: Uuid, entryId: Uuid, input: EditScheduleEntryInput): Promise<unknown> {
  return post(`${base(objectId)}/draft/entries/${entryId}/edit`, input);
}

export function removeScheduleEntry(objectId: Uuid, entryId: Uuid, version: number): Promise<unknown> {
  return post(`${base(objectId)}/draft/entries/${entryId}/remove`, { version });
}

export function discardScheduleDraft(objectId: Uuid, version: number): Promise<unknown> {
  return post(`${base(objectId)}/draft/discard`, { version });
}

export function approveScheduleDraft(objectId: Uuid, input: ApproveScheduleInput): Promise<unknown> {
  return post(`${base(objectId)}/draft/approve`, input);
}

export function recordDelayReason(objectId: Uuid, input: RecordDelayReasonInput): Promise<unknown> {
  return post(`${base(objectId)}/delay-reasons`, input);
}

export function resolveDelayReason(objectId: Uuid, reasonId: Uuid, version: number, comment?: string): Promise<unknown> {
  return post(`${base(objectId)}/delay-reasons/${reasonId}/resolve`, { version, ...(comment ? { comment } : {}) });
}

/**
 * Who a delay reason can be about: the active internal people (`GET /users`, a plain read) and the contractors currently working on THIS
 * object (`GET /objects/:id/contractors`). The backend re-checks both on record — a contractor not on the object is refused.
 */
export async function listResponsibleOptions(objectId: Uuid): Promise<ResponsibleOptions> {
  const [users, contractors] = await Promise.all([
    get<UserSummary[]>('users'),
    get<{ contractorId: Uuid; contractorName: string }[]>(`objects/${objectId}/contractors`),
  ]);
  return {
    people: users.filter((user) => user.role !== 'CONTRACTOR_VIEWER').map((user) => ({ id: user.id, name: user.name })).sort((a, b) => a.name.localeCompare(b.name, 'ru')),
    contractors: contractors.map((link) => ({ id: link.contractorId, name: link.contractorName })),
  };
}
