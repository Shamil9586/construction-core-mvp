import { createHash } from 'node:crypto';
import { transactionToken } from './db';
import { WriterId, writerEntry } from './writer-registry';

/**
 * GPR-2 R03b — the object coordination lock (Technical Design §12.3).
 *
 * One transaction-scoped PostgreSQL advisory lock per (tenant, object), in two modes:
 *   SHARED     the ordinary fact / SC / PTO / SDO writers of an object. They do not exclude one another; their own row locks, in the order
 *              package / case / portion that F12.1 proved, keep serialising what they always serialised.
 *   EXCLUSIVE  the scope-changing writers: quantity approval, Work generation and topology changes, GPR approval. They wait for every shared
 *              writer in flight, and no shared writer starts while one is waiting or running.
 *
 * Why this protocol is safe to add to code that already works:
 *   1. It is taken FIRST in the transaction, before any row lock. acquireCoordination() proves it: `pg_current_xact_id_if_assigned()` is
 *      NULL until the transaction writes or row-locks something, so a writer that already holds a row lock cannot acquire (it throws
 *      COORDINATION_AFTER_ROW_LOCK) — a new lock can never be queued behind a package lock that was taken first (§12.3 item 2).
 *   2. A transaction coordinates ONE object, and only upgrades never: a second object, or SHARED -> EXCLUSIVE inside one transaction, is
 *      refused. Those are the two ways an advisory protocol deadlocks with itself.
 *   3. The key is sha256-derived under a namespaced prefix. A hash collision between two objects can only SERIALISE them needlessly; it can
 *      never admit anything it should have blocked. It cannot equal the migration lock (830017) — that value is re-derived away from.
 *   4. The lock is held by the transaction and released by COMMIT/ROLLBACK/disconnect; there is nothing to forget to release.
 *
 * Every writer reaches this module through coordinate(), naming itself by its registry id (writer-registry.ts). The registry decides the
 * mode, not the call site, so the mode of a writer is written down once and a static test proves each registered writer really calls it.
 */
export type CoordinationMode = 'SHARED' | 'EXCLUSIVE';

export class CoordinationError extends Error {
    constructor(readonly code: 'COORDINATION_AFTER_ROW_LOCK' | 'COORDINATION_OBJECT_MISMATCH' | 'COORDINATION_UPGRADE_FORBIDDEN' | 'COORDINATION_NOT_IN_TRANSACTION' | 'COORDINATION_BAD_ID' | 'COORDINATION_TIMEOUT') {
        super(code);
        this.name = 'CoordinationError';
    }
}

const NAMESPACE = 'construction-core:gpr2:object-coordination:v1';
const MIGRATION_LOCK = 830017n; // scripts/migrate.ts
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The signed 64-bit advisory-lock key of an object. Deterministic; same inputs, same key, in every process. */
export function coordinationKey(tenantId: string, objectId: string): bigint {
    const t = String(tenantId).toLowerCase(), o = String(objectId).toLowerCase();
    if (!UUID.test(t) || !UUID.test(o))
        throw new CoordinationError('COORDINATION_BAD_ID');
    const digest = createHash('sha256').update(NAMESPACE + '\0' + t + '\0' + o, 'utf8').digest();
    let key = digest.readBigInt64BE(0);
    if (key === MIGRATION_LOCK)
        key = digest.readBigInt64BE(8);
    return key;
}

// A pooled client object outlives its transactions, so what a transaction holds is remembered WITH that transaction's token (db.ts): an entry
// left by an earlier transaction on the same connection is stale and is ignored. (Keying by the client alone made a later transaction believe it
// already held the lock and skip it — the defect tests/gpr2-r03b-coordination-pg.test.ts found.)
interface Held { token: symbol; key: bigint; tenantId: string; objectId: string; mode: CoordinationMode }
const HELD = new WeakMap<object, Held>();

/** What this transaction holds, if anything — for tests and for the transaction context. */
export const heldCoordination = (c: object): Readonly<Held> | undefined => { const h = HELD.get(c); return h && h.token === transactionToken(c) ? h : undefined; };

/**
 * A wait for the lock is BOUNDED (lock_timeout, transaction-local): a scope-changing section is short, so a wait that is not is a fault to report, not a
 * queue to join forever. The default can be set with GPR2_COORDINATION_WAIT_MS; an explicit `waitMs` wins. On expiry the statement fails with 55P03,
 * which becomes COORDINATION_TIMEOUT — the caller's transaction is aborted and rolled back as for any other error.
 */
export const DEFAULT_COORDINATION_WAIT_MS = 15000;
const waitMsFromEnvironment = (): number => { const n = Number(process.env.GPR2_COORDINATION_WAIT_MS); return Number.isInteger(n) && n > 0 && n <= 600000 ? n : DEFAULT_COORDINATION_WAIT_MS; };

/**
 * Take the coordination lock of one object for the rest of the transaction.
 * Re-acquiring what is already held (same object; EXCLUSIVE held, or SHARED wanted) is a no-op and returns 'ALREADY_HELD'.
 */
export async function acquireCoordination(c: any, tenantId: string, objectId: string, mode: CoordinationMode, opts: { waitMs?: number } = {}): Promise<'ACQUIRED' | 'ALREADY_HELD'> {
    const token = transactionToken(c);
    if (!token)
        throw new CoordinationError('COORDINATION_NOT_IN_TRANSACTION'); // an xact lock taken outside a transaction block is released at once
    const key = coordinationKey(tenantId, objectId);
    const held = heldCoordination(c);
    if (held) {
        if (held.key !== key)
            throw new CoordinationError('COORDINATION_OBJECT_MISMATCH');
        if (held.mode === 'EXCLUSIVE' || mode === 'SHARED')
            return 'ALREADY_HELD';
        throw new CoordinationError('COORDINATION_UPGRADE_FORBIDDEN');
    }
    const assigned = (await c.query('SELECT pg_current_xact_id_if_assigned() IS NOT NULL AS assigned')).rows[0].assigned;
    if (assigned)
        throw new CoordinationError('COORDINATION_AFTER_ROW_LOCK');
    const waitMs = opts.waitMs ?? waitMsFromEnvironment();
    const previous = (await c.query("SELECT current_setting('lock_timeout') AS v")).rows[0].v;
    await c.query("SELECT set_config('lock_timeout', $1, true)", [waitMs + 'ms']);
    try {
        await c.query(mode === 'SHARED' ? 'SELECT pg_advisory_xact_lock_shared($1::bigint)' : 'SELECT pg_advisory_xact_lock($1::bigint)', [key.toString()]);
    }
    catch (e: any) {
        if (e?.code === '55P03')
            throw new CoordinationError('COORDINATION_TIMEOUT');
        throw e;
    }
    await c.query("SELECT set_config('lock_timeout', $1, true)", [previous]); // the rest of the transaction waits as it always did
    HELD.set(c, { token, key, tenantId: String(tenantId).toLowerCase(), objectId: String(objectId).toLowerCase(), mode });
    return 'ACQUIRED';
}

/**
 * How a writer names the object it works on. Each kind is resolved with ONE plain SELECT (no row lock, no transaction id), so resolving the
 * object cannot itself put a row lock ahead of the coordination lock. An id that resolves to nothing takes no lock: the writer's own
 * scoped() read answers 404 a moment later, exactly as before.
 */
export type ObjectRef =
    | { object: string }
    | { work: string }
    | { unit: string }
    | { portion: string }
    | { inspection: string }
    | { issue: string }
    | { executivePackage: string }
    | { executiveDocument: string }
    | { sdoCase: string }
    | { financialClosing: string }
    | { documentationPackage: string }
    | { documentationDocument: string }
    | { sdoClosingCase: string }
    | { aosrDocument: string }
    | { scheduleRevision: string }
    | { delayReason: string }
    | { ptoAssignmentWork: string };

const RESOLVERS: Record<string, string> = {
    work: 'SELECT object_id FROM works WHERE tenant_id=$1 AND id=$2',
    unit: 'SELECT w.object_id FROM work_execution_units u JOIN works w ON w.tenant_id=u.tenant_id AND w.id=u.object_work_id WHERE u.tenant_id=$1 AND u.id=$2',
    portion: 'SELECT w.object_id FROM quantity_portions p JOIN work_execution_units u ON u.tenant_id=p.tenant_id AND u.id=p.execution_unit_id JOIN works w ON w.tenant_id=u.tenant_id AND w.id=u.object_work_id WHERE p.tenant_id=$1 AND p.id=$2',
    inspection: 'SELECT object_id FROM inspections WHERE tenant_id=$1 AND id=$2',
    issue: 'SELECT i.object_id FROM issues x JOIN inspections i ON i.tenant_id=x.tenant_id AND i.id=x.inspection_id WHERE x.tenant_id=$1 AND x.id=$2',
    executivePackage: 'SELECT object_id FROM executive_packages WHERE tenant_id=$1 AND id=$2',
    executiveDocument: 'SELECT object_id FROM executive_documents WHERE tenant_id=$1 AND id=$2',
    sdoCase: 'SELECT object_id FROM sdo_cases WHERE tenant_id=$1 AND id=$2',
    financialClosing: 'SELECT object_id FROM financial_closings WHERE tenant_id=$1 AND id=$2',
    documentationPackage: 'SELECT w.object_id FROM documentation_packages p JOIN works w ON w.tenant_id=p.tenant_id AND w.id=p.object_work_id WHERE p.tenant_id=$1 AND p.id=$2',
    documentationDocument: 'SELECT w.object_id FROM documentation_documents d JOIN documentation_packages p ON p.tenant_id=d.tenant_id AND p.id=d.documentation_package_id JOIN works w ON w.tenant_id=p.tenant_id AND w.id=p.object_work_id WHERE d.tenant_id=$1 AND d.id=$2',
    sdoClosingCase: 'SELECT w.object_id FROM sdo_closing_cases s JOIN documentation_packages p ON p.tenant_id=s.tenant_id AND p.id=s.documentation_package_id JOIN works w ON w.tenant_id=p.tenant_id AND w.id=p.object_work_id WHERE s.tenant_id=$1 AND s.id=$2',
    aosrDocument: 'SELECT object_id FROM aosr_documents WHERE tenant_id=$1 AND id=$2',
    scheduleRevision: 'SELECT object_id FROM schedule_revisions WHERE tenant_id=$1 AND id=$2',
    delayReason: 'SELECT object_id FROM schedule_delay_reasons WHERE tenant_id=$1 AND id=$2',
    ptoAssignmentWork: 'SELECT object_id FROM works WHERE tenant_id=$1 AND id=$2'
};

export async function resolveObjectId(c: any, tenantId: string, ref: ObjectRef): Promise<string | null> {
    const [[kind, id]] = Object.entries(ref) as [string, string][];
    if (!UUID.test(String(id).toLowerCase()))
        return null; // not an id: the writer's own validation answers it
    if (kind === 'object')
        return String(id).toLowerCase();
    const sql = RESOLVERS[kind];
    if (!sql)
        throw new Error('coordination: unknown object reference kind ' + kind);
    const r = await c.query(sql, [tenantId, id]);
    return r.rows[0]?.object_id ?? null;
}

/**
 * The call every relevant writer makes as the FIRST statement of its transaction. `writer` is its registry id; the registry — not the call
 * site — decides SHARED or EXCLUSIVE. Returns what was done, so a test can see an unresolved reference took no lock.
 */
export async function coordinate(c: any, writer: WriterId, tenantId: string, ref: ObjectRef): Promise<'ACQUIRED' | 'ALREADY_HELD' | 'UNRESOLVED'> {
    const entry = writerEntry(writer);
    if (entry.mode === 'NONE')
        throw new Error('coordinate(): ' + writer + ' is registered as NONE and must not coordinate');
    const objectId = await resolveObjectId(c, tenantId, ref);
    if (!objectId)
        return 'UNRESOLVED';
    return acquireCoordination(c, tenantId, objectId, entry.mode);
}
