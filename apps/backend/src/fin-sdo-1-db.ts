/**
 * FIN-SDO-1 protected PostgreSQL connector (S-01 preparatory implementation).
 * Does NOT provision credentials, grant any SQL privileges, or enable product routes.
 * Backend FIN service still uses legacy pool until all writes have been replaced
 * by independently verified SECURITY DEFINER command functions; SEC-01 OPEN.
 *
 * Separate pool is selected BEFORE runCommandTx enters the guarded callback.
 */
import { Pool } from 'pg';
import { runCommandTx, runSnapshotRead, type TxContext, type CommandTxOptions } from './tx-context';

let restrictedFinPool: Pool | undefined;
export function restrictedFinConnectionPool(): Pool {
    const dsn = process.env.FIN_SDO_DATABASE_URL;
    if (!dsn) throw new Error('FIN_SDO_RESTRICTED_CONNECTION_NOT_CONFIGURED');
    if (process.env.DB_MODE === 'pglite') throw new Error('FIN_SDO_REQUIRES_NATIVE_POSTGRESQL');
    const parsed = new URL(dsn);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol))
        throw new Error('FIN_SDO_INVALID_CONNECTION_PROTOCOL');
    const mainDsn = process.env.DATABASE_URL;
    if (mainDsn) {
        const main = new URL(mainDsn);
        if (parsed.username && main.username && parsed.username === main.username)
            throw new Error('FIN_SDO_RUNTIME_ROLE_MUST_BE_SEPARATE');
    }
    if (!parsed.username) throw new Error('FIN_SDO_EXPLICIT_RESTRICTED_ROLE_REQUIRED');
    if (!restrictedFinPool) {
        restrictedFinPool = new Pool({ connectionString: dsn, max: 4, connectionTimeoutMillis: 5000, options: '-c timezone=UTC' });
    }
    return restrictedFinPool;
}

/** Same GPR-2 TxContext semantics, but selected FIN pool before BEGIN. */
export function runFinSdoCommandTx<T>(
    fn: (tx: TxContext) => Promise<T>,
    opts: Pick<CommandTxOptions, 'isolation' | 'maxAttempts'> = {}
): Promise<T> {
    return runCommandTx(fn, { ...opts, connect: () => restrictedFinConnectionPool().connect() });
}

export function runFinSdoSnapshotRead<T>(fn: (tx: TxContext) => Promise<T>): Promise<T> {
    return runSnapshotRead(fn, () => restrictedFinConnectionPool().connect());
}
