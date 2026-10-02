import type { UserSummary } from '../types/api';
import { parseResponse } from '../http';
import { readSessionToken } from '../auth/sessionToken';
import { isSdoRole } from '../auth/internalRoles';

/**
 * `GET /users` — a plain read (no more than `OBJECT_VIEW`). Mirrors
 * `documentationApi.ts`'s own `post<T>` pattern for the GET side.
 *
 * PILOT-W01 UI03: the former tenant-wide PTO list (`listActivePtoUsers`) that fed the
 * package-create responsible picker is gone — PTO eligibility is now object-scoped and
 * server-authoritative (`GET works/:id/pto-assignment`).
 */
async function get<T>(path: string): Promise<T> {
  const token = readSessionToken();
  const response = await fetch(`/api/${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return parseResponse(response) as Promise<T>;
}

/**
 * F8.3 — the SDO Case responsible-assignment picker's own data source
 * (`ensure(responsible.role === 'SDO' && responsible.isActive, ...)`,
 * `service.ts`).
 */
export async function listActiveSdoUsers(): Promise<UserSummary[]> {
  const users = await get<UserSummary[]>('users');
  return users.filter((user) => isSdoRole(user.role));
}
