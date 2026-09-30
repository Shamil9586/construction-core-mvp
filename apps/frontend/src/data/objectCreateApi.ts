import { parseResponse } from '../http';
import { readSessionToken } from '../auth/sessionToken';

/**
 * OBJ-1 — create-object form data. `GET /api/object-create-options` is a narrow,
 * tenant-scoped picker source (active PROJECT_MANAGERs + contractors) protected by the
 * create-object authority itself; it is NOT general user administration.
 */
export interface CreateOptionPerson {
  id: string;
  name: string;
}
export interface ObjectCreateOptions {
  projectManagers: CreateOptionPerson[];
  contractors: CreateOptionPerson[];
}
export interface ObjectCreateInput {
  externalCode: string;
  name: string;
  address: string;
  organizationName: string;
  customerName?: string;
  projectManagerId: string;
  startDate: string;
  plannedFinishDate: string;
  contractValue: string;
  contractorIds: string[];
}
export interface CreatedObject {
  id: string;
}

const headers = (): Record<string, string> => {
  const token = readSessionToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
};

export async function getObjectCreateOptions(): Promise<ObjectCreateOptions> {
  const response = await fetch('/api/object-create-options', { headers: headers() });
  return parseResponse(response) as Promise<ObjectCreateOptions>;
}

/** Rejects with `ObjectCreateError` so the form can tell a duplicate code (409) from other failures. */
export class ObjectCreateError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function createObject(input: ObjectCreateInput): Promise<CreatedObject> {
  const response = await fetch('/api/objects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers() },
    body: JSON.stringify(input),
  });
  try {
    return (await parseResponse(response)) as CreatedObject;
  } catch (error) {
    throw new ObjectCreateError(error instanceof Error ? error.message : String(error), response.status);
  }
}
