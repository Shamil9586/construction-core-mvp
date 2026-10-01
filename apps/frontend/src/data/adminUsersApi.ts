import { parseResponse } from '../http';
import { readSessionToken } from '../auth/sessionToken';
import type { AdminAssignableRole } from '../auth/internalRoles';

/**
 * PBX-2 — the «Пользователи и доступ» screen's own data source. Core users come
 * from `GET /admin/users`; the Bitrix employee list and departments come from
 * the accepted PBX-1 read-only directory routes. All three are ADMIN-only on
 * the backend, which enforces that independently of this client.
 */
export interface AdminCoreUser {
  id: string;
  name: string;
  role: string;
  bitrixUserId: string;
  /** Core-held address (may be absent). The Bitrix directory deliberately never supplies e-mail. */
  email?: string | null;
  isActive: boolean;
  version: number;
}

export interface BitrixEmployee {
  ID: string;
  NAME: string | null;
  LAST_NAME: string | null;
  SECOND_NAME?: string;
  ACTIVE: boolean;
  WORK_POSITION: string | null;
  UF_DEPARTMENT: number[];
}

export interface BitrixDepartment {
  ID: string;
  NAME: string | null;
}

export interface EmployeeDirectory {
  employees: BitrixEmployee[];
  truncated: boolean;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = readSessionToken();
  const response = await fetch(`/api/${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return parseResponse(response) as Promise<T>;
}

export async function listAdminUsers(): Promise<AdminCoreUser[]> {
  const result = await request<{ users: AdminCoreUser[] }>('GET', 'admin/users');
  return result.users;
}

export async function listBitrixEmployees(): Promise<EmployeeDirectory> {
  const result = await request<{ users: BitrixEmployee[]; truncated?: boolean }>('GET', 'bitrix/directory/users');
  return { employees: result.users, truncated: result.truncated === true };
}

export async function listBitrixDepartments(): Promise<BitrixDepartment[]> {
  const result = await request<{ departments: BitrixDepartment[] }>('GET', 'bitrix/directory/departments');
  return result.departments;
}

/** The name is read from Bitrix by the server; the client sends only identity and the chosen role. */
export function addCoreUser(bitrixUserId: string, role: AdminAssignableRole): Promise<AdminCoreUser> {
  return request<AdminCoreUser>('POST', 'admin/users', { bitrixUserId, role });
}

export function updateCoreUser(
  id: string,
  change: { role?: AdminAssignableRole; isActive?: boolean },
): Promise<AdminCoreUser> {
  return request<AdminCoreUser>('PATCH', `admin/users/${encodeURIComponent(id)}`, change);
}
