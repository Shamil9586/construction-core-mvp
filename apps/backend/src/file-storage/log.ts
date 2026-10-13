import { BitrixRestError } from '../bitrix';
import { StorageError } from './types';

/**
 * Structured storage logging, same shape as the rest of the backend (one JSON line per event on stdout/stderr).
 * Only an allowlist of identifier fields is ever written, so an OAuth token, a tokenised DOWNLOAD_URL, a request body
 * or a Bitrix error description cannot reach the log even by accident.
 */
const ALLOWED = new Set(['provider', 'operation', 'tenantId', 'fileId', 'externalFileId', 'externalFolderId', 'documentId', 'packageId', 'aosrId', 'documentVersionId', 'versionNumber', 'sizeBytes', 'attempt', 'scope', 'errorType', 'code', 'causeCode', 'httpStatus', 'retryable', 'outcome']);

export function storageLog(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown> = {}) {
    const rec: Record<string, unknown> = { level, component: 'file-storage', event };
    for (const [k, v] of Object.entries(fields)) if (ALLOWED.has(k) && v !== undefined && v !== null) rec[k] = v;
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(JSON.stringify(rec));
}

/** Sanitized view of an error: class, structured code and HTTP status only — never `message`, response body or URL. */
export function describeError(e: any): { errorType?: string; code?: string; httpStatus?: number; retryable?: boolean } {
    if (e instanceof StorageError) return { errorType: 'StorageError', code: e.code, httpStatus: e.getStatus(), retryable: e.retryable };
    if (e instanceof BitrixRestError) return { errorType: 'BitrixRestError', code: e.code, httpStatus: e.httpStatus ?? undefined };
    return { errorType: e?.constructor?.name, code: typeof e?.code === 'string' ? e.code : e?.name };
}
