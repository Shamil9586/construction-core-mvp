import type { UserSummary } from '../types/api';
import { parseResponse } from '../http';
import { readSessionToken } from '../auth/sessionToken';

/**
 * F8.2.1-04 (Corrective Patch) — `GET /users` already exists and already
 * requires no more than `OBJECT_VIEW` (every internal role, `users.controller.ts`),
 * so this is a read, not a new backend capability. Its one caller today is
 * the ADMIN responsible-picker (`app/useActivePtoUsers.ts`): ADMIN has
 * `DOCUMENTATION_MANAGE` but is not itself a PTO user, so it cannot default
 * to `session.user.id` the way a PTO session does — it must choose an
 * active PTO user from this list instead. Mirrors `documentationApi.ts`'s
 * own `post<T>` pattern for the GET side.
 */
async function get<T>(path: string): Promise<T> {
  const token = readSessionToken();
  const response = await fetch(`/api/${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return parseResponse(response) as Promise<T>;
}

export async function listActivePtoUsers(): Promise<UserSummary[]> {
  const users = await get<UserSummary[]>('users');
  return users.filter((user) => user.role === 'PTO');
}
