import { randomUUID } from 'node:crypto';
import { connectUnguarded, markTransactionClient, poolGuard, unmarkTransactionClient } from './db';

/**
 * GPR-2 R03a — one transaction context for a business operation (Technical Design §12.2; decision C16; scenario A30).
 *
 * Two entry points, one connection each:
 *   runCommandTx()    a command: BEGIN, the work, COMMIT; ROLLBACK on any error. The mutation, its ledger row and its events share this one
 *                     transaction (TD §12.4), so an aborted command leaves nothing. Optional bounded retry of PostgreSQL's own
 *                     "try again" failures (40001 serialization_failure, 40P01 deadlock_detected) — never of a business error.
 *   runSnapshotRead() a composite read: BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY. Every statement sees the same snapshot, so a
 *                     response assembled from quantity, baseline, facts and SC cannot mix two moments (TD §12.2: "Несколько независимых
 *                     pool queries не составляют один согласованный срез").
 *
 * While the callback runs, the shared pool is OFF LIMITS (db.ts poolGuard): a `pool.query()` / `pool.connect()` / `transaction()` made from
 * inside — directly or from any helper the callback awaits — throws NestedPoolAccessError. That is the "prohibit nested independent pool
 * reads in one business operation" rule made mechanical: a second connection inside a command can neither see the command's uncommitted
 * writes nor belong to its snapshot, and it can deadlock against the command's own locks. Code that needs the database inside the callback
 * uses `tx.c`.
 *
 * This module is for NEW commands and projections (R02 readers, R03c ledger, R04+). Existing services keep calling transaction() from db.ts
 * exactly as before; they are brought under the lock protocol by coordinate() (coordination-lock.ts), not rewritten onto this context.
 */
export type Isolation = 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';

export interface TxContext {
    /** The one connection of this operation. */
    readonly c: any;
    readonly kind: 'COMMAND' | 'SNAPSHOT_READ';
    readonly isolation: Isolation;
    /** 1 for the first run; greater only when a retryable failure re-ran the callback. */
    readonly attempt: number;
    readonly id: string;
}

export const RETRYABLE_SQLSTATES: readonly string[] = ['40001', '40P01'];
export const MAX_ATTEMPTS_CEILING = 5;

export interface CommandTxOptions {
    isolation?: Isolation;
    /** Total attempts (1 = no retry). Bounded: at most MAX_ATTEMPTS_CEILING, whatever is asked. */
    maxAttempts?: number;
}

async function runOnce<T>(kind: TxContext['kind'], isolation: Isolation, attempt: number, begin: string, fn: (tx: TxContext) => Promise<T>): Promise<T> {
    const c = await connectUnguarded();
    try {
        await c.query(begin);
        markTransactionClient(c);
        const tx: TxContext = Object.freeze({ c, kind, isolation, attempt, id: randomUUID() });
        let result: T;
        try {
            result = await poolGuard.run({ label: kind + ':' + tx.id }, () => fn(tx));
        }
        catch (e) {
            await c.query('ROLLBACK').catch(() => undefined);
            throw e;
        }
        await c.query('COMMIT');
        return result;
    }
    finally {
        unmarkTransactionClient(c);
        c.release();
    }
}

export async function runCommandTx<T>(fn: (tx: TxContext) => Promise<T>, opts: CommandTxOptions = {}): Promise<T> {
    const isolation = opts.isolation ?? 'READ COMMITTED';
    const maxAttempts = Math.min(Math.max(1, Math.trunc(opts.maxAttempts ?? 1)), MAX_ATTEMPTS_CEILING);
    for (let attempt = 1; ; attempt++) {
        try {
            return await runOnce('COMMAND', isolation, attempt, 'BEGIN ISOLATION LEVEL ' + isolation, fn);
        }
        catch (e: any) {
            if (attempt >= maxAttempts || !RETRYABLE_SQLSTATES.includes(e?.code))
                throw e;
        }
    }
}

export function runSnapshotRead<T>(fn: (tx: TxContext) => Promise<T>): Promise<T> {
    return runOnce('SNAPSHOT_READ', 'REPEATABLE READ', 1, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', fn);
}
