import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { pool, one, transaction } from './db';
import { BitrixRestError, RealBitrixAdapter } from './bitrix';

/**
 * PBX-5A — Bitrix24 notification outbox: intent creation + one narrow delivery worker.
 *
 * Intent: created INSIDE the assignment transaction (team-service.ts leadChange()), after the new
 * object_function_lead_assignments row exists. No Bitrix I/O happens there.
 * Delivery: separate, sequential, one outbox row per cycle (FOR UPDATE SKIP LOCKED), backend installed OAuth
 * through RealBitrixAdapter.installedCall(). Every attempt for one row sends the SAME deterministic TAG
 * (provider-side replacement / duplicate-state suppression). Distributed exactly-once delivery between
 * PostgreSQL and Bitrix is NOT claimed: an accepted request whose response/commit is lost is retried.
 */
export const NOTIFICATION_TYPE = 'OBJECT_FUNCTION_LEAD_ASSIGNED';
export const BITRIX_NOTIFY_METHOD = 'im.notify.system.add';
export const bitrixTagFor = (sourceAssignmentId: string) => `CC5A:${sourceAssignmentId}`;
export const leadAssignedMessage = (objectName: string) => `Вы назначены начальником ПТО на объекте «${objectName}».`;

/** Called with the transaction client of the assignment; `assignment` is the NEW row returned by insert(). */
export async function createLeadAssignedIntent(c: any, tenantId: string, assignment: { id: string; objectId: string; leadUserId: string; functionCode: string }) {
    if (assignment.functionCode !== 'PTO')
        return null;
    const object = await one(c, 'SELECT name FROM objects WHERE tenant_id=$1 AND id=$2', [tenantId, assignment.objectId]);
    if (!object)
        throw new Error('PBX-5A: object not found in tenant');
    const tag = bitrixTagFor(assignment.id);
    const created = await one(c, `INSERT INTO bitrix_notification_outbox(tenant_id,notification_type,source_assignment_id,object_id,recipient_user_id,message,bitrix_tag)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (tenant_id,notification_type,source_assignment_id) DO NOTHING RETURNING *`, [tenantId, NOTIFICATION_TYPE, assignment.id, assignment.objectId, assignment.leadUserId, leadAssignedMessage(object.name), tag]);
    if (created)
        return created;
    const existing = await one(c, 'SELECT * FROM bitrix_notification_outbox WHERE tenant_id=$1 AND notification_type=$2 AND source_assignment_id=$3', [tenantId, NOTIFICATION_TYPE, assignment.id]);
    if (!existing || existing.objectId !== assignment.objectId || existing.recipientUserId !== assignment.leadUserId || existing.bitrixTag !== tag)
        throw new ConflictException('PBX-5A: существующее уведомление не соответствует назначению');
    return existing;
}

// ---------------------------------------------------------------------------------------------------------
// Failure classification (structured Bitrix codes only; never localized descriptions).
// ---------------------------------------------------------------------------------------------------------
export type Failure = { retry: boolean; code: string; httpStatus: number | null; delayMs?: number };
const TRANSIENT = new Set(['INTERNAL_SERVER_ERROR', 'ERROR_UNEXPECTED_ANSWER', 'QUERY_LIMIT_EXCEEDED', 'OPERATION_TIME_LIMIT']);
const PERMANENT = new Set(['WRONG_AUTH_TYPE', 'USER_ID_EMPTY', 'MESSAGE_EMPTY', 'INVALID_CREDENTIALS', 'insufficient_scope', 'user_access_error', 'ACCESS_DENIED', 'OVERLOAD_LIMIT', 'PORTAL_DELETED']);
const BASE_MS = 30_000, MAX_MS = 15 * 60_000, QUERY_LIMIT_BASE_MS = 60_000, QUERY_LIMIT_MAX_MS = 60 * 60_000, OPERATION_FALLBACK_MS = 10 * 60_000, OPERATION_MAX_MS = 60 * 60_000;
const grow = (base: number, cap: number, attempt: number) => Math.min(cap, base * 2 ** Math.min(Math.max(attempt - 1, 0), 20));
/** `attempt` = attempt number this failure belongs to (1-based). */
export function classifyFailure(e: any, attempt: number, now: number): Failure {
    if (e instanceof BitrixRestError) {
        const base = { code: e.code, httpStatus: e.httpStatus };
        if (e.code === 'expired_token')
            return { retry: false, ...base, code: 'OAUTH_EXPIRED' };
        if (PERMANENT.has(e.code))
            return { retry: false, ...base };
        if (e.code === 'QUERY_LIMIT_EXCEEDED')
            return { retry: true, ...base, delayMs: grow(QUERY_LIMIT_BASE_MS, QUERY_LIMIT_MAX_MS, attempt) };
        if (e.code === 'OPERATION_TIME_LIMIT') {
            const wait = e.operatingResetAt !== null ? e.operatingResetAt * 1000 - now + 1000 : NaN;
            return { retry: true, ...base, delayMs: Number.isFinite(wait) && wait > 0 && wait <= OPERATION_MAX_MS ? wait : OPERATION_FALLBACK_MS };
        }
        if (TRANSIENT.has(e.code) || (e.httpStatus !== null && (e.httpStatus >= 500 || e.httpStatus === 429)))
            return { retry: true, ...base, delayMs: grow(BASE_MS, MAX_MS, attempt) };
        return { retry: false, ...base, code: 'BITRIX_ERROR_UNCLASSIFIED' };
    }
    // Existing refresh path / installation binding failures: OAuth state is not usable.
    if (e instanceof UnauthorizedException)
        return { retry: false, code: 'OAUTH_STATE_INVALID', httpStatus: null };
    // Network error / timeout / anything not produced by a Bitrix answer: transient.
    return { retry: true, code: e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR', httpStatus: null, delayMs: grow(BASE_MS, MAX_MS, attempt) };
}

// ---------------------------------------------------------------------------------------------------------
// One delivery cycle.
// ---------------------------------------------------------------------------------------------------------
export interface BitrixTransport { installedCall(tenantId: string, method: string, params?: any): Promise<any>; }
export type CycleResult = { outcome: 'IDLE' } | { outcome: 'DELIVERED' | 'RETRY_WAIT' | 'PERMANENT_FAILURE'; id: string; errorCode?: string };
const BITRIX_USER_ID = /^[1-9][0-9]{0,9}$/;
let defaultTransport: BitrixTransport | undefined;
const transportOrDefault = () => defaultTransport ??= new RealBitrixAdapter();

/** The due-row claim. The "due" condition is a runtime predicate, deliberately not part of the partial index. */
export const DUE_ROW_SQL = `SELECT * FROM bitrix_notification_outbox
    WHERE status IN ('PENDING','RETRY_WAIT') AND next_attempt_at <= now()
    ORDER BY next_attempt_at, created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1`;

export async function deliverNextBitrixNotification(transport?: BitrixTransport): Promise<CycleResult> {
    return transaction(async (c) => {
        const row = await one(c, DUE_ROW_SQL);
        if (!row)
            return { outcome: 'IDLE' as const };
        const permanent = async (code: string, httpStatus: number | null = null, counted = false): Promise<CycleResult> => {
            await c.query(`UPDATE bitrix_notification_outbox SET status='PERMANENT_FAILURE',attempt_count=attempt_count+$3,last_attempt_at=now(),last_error_code=$4,last_http_status=$5,updated_at=now(),version=version+1 WHERE tenant_id=$1 AND id=$2`, [row.tenantId, row.id, counted ? 1 : 0, code, httpStatus]);
            return { outcome: 'PERMANENT_FAILURE', id: row.id, errorCode: code };
        };
        // Recipient is re-resolved at delivery time, tenant-scoped; never replaced by another user.
        const user = await one(c, 'SELECT id,is_active,bitrix_user_id FROM users WHERE tenant_id=$1 AND id=$2', [row.tenantId, row.recipientUserId]);
        if (!user || user.isActive !== true)
            return permanent('RECIPIENT_INACTIVE');
        if (typeof user.bitrixUserId !== 'string' || !BITRIX_USER_ID.test(user.bitrixUserId))
            return permanent('RECIPIENT_MAPPING_INVALID');
        const attempt = row.attemptCount + 1;
        try {
            const result = await (transport ?? transportOrDefault()).installedCall(row.tenantId, BITRIX_NOTIFY_METHOD, { USER_ID: Number(user.bitrixUserId), MESSAGE: row.message, TAG: row.bitrixTag });
            const id = typeof result === 'number' || (typeof result === 'string' && /^[0-9]+$/.test(result)) ? Number(result) : NaN;
            if (!Number.isSafeInteger(id) || id <= 0)
                return permanent('RESULT_NOT_CONFIRMED', 200, true);
            await c.query(`UPDATE bitrix_notification_outbox SET status='DELIVERED',attempt_count=$3,last_attempt_at=now(),delivered_at=now(),delivered_bitrix_user_id=$4,bitrix_notification_id=$5,last_error_code=NULL,last_http_status=NULL,updated_at=now(),version=version+1 WHERE tenant_id=$1 AND id=$2`, [row.tenantId, row.id, attempt, user.bitrixUserId, id]);
            return { outcome: 'DELIVERED', id: row.id };
        }
        catch (e: any) {
            const f = classifyFailure(e, attempt, Date.now());
            if (!f.retry)
                return permanent(f.code, f.httpStatus, true);
            await c.query(`UPDATE bitrix_notification_outbox SET status='RETRY_WAIT',attempt_count=$3,last_attempt_at=now(),next_attempt_at=now()+($4::int * interval '1 millisecond'),last_error_code=$5,last_http_status=$6,updated_at=now(),version=version+1 WHERE tenant_id=$1 AND id=$2`, [row.tenantId, row.id, attempt, Math.ceil(f.delayMs!), f.code, f.httpStatus]);
            return { outcome: 'RETRY_WAIT', id: row.id, errorCode: f.code };
        }
    });
}

// ---------------------------------------------------------------------------------------------------------
// Polling loop (sequential, low volume). Started only when explicitly enabled.
// ---------------------------------------------------------------------------------------------------------
export const IDLE_POLL_MS = 30_000, BUSY_POLL_MS = 1_500;
export const bitrixNotificationWorkerEnabled = (env: NodeJS.ProcessEnv = process.env) => env.AUTH_MODE === 'bitrix' && env.BITRIX_NOTIFICATION_DELIVERY_ENABLED === 'true';
export function startBitrixNotificationWorker(transport?: BitrixTransport) {
    let stopped = false, timer: NodeJS.Timeout | undefined;
    const tick = async () => {
        let next = IDLE_POLL_MS;
        try {
            const r = await deliverNextBitrixNotification(transport);
            if (r.outcome !== 'IDLE')
                next = BUSY_POLL_MS;
        }
        catch (e: any) {
            console.error(JSON.stringify({ level: 'error', component: 'bitrix-notification-worker', errorType: e?.constructor?.name, code: e?.code }));
        }
        if (!stopped) {
            timer = setTimeout(tick, next);
            timer.unref();
        }
    };
    timer = setTimeout(tick, 0);
    timer.unref();
    return { stop() { stopped = true; if (timer) clearTimeout(timer); } };
}
