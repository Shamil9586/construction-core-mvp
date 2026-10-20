import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

/**
 * GPR-2 P1 — the harness for NATIVE PostgreSQL tests (R02 SQL, R03 locks / snapshots / ledger / migrations).
 *
 * PGlite is single-connection: it cannot give two transactions a real lock wait, so it is no evidence for a concurrency claim (TD §15). These
 * tests need a real server, and a real server is a place a careless harness can do damage. Hence the isolation proof BEFORE anything is created:
 *
 *   * the URL comes ONLY from GPR2_ISOLATED_PG_URL — never from DATABASE_URL / E2E_* / PG*, which may name anything;
 *   * the host is loopback or a unix-socket directory;
 *   * the server reports `cluster_name = 'gpr2-p1-isolated'` — a marker set in that cluster's own configuration, which no application server
 *     has — and a non-routable `inet_server_addr()`;
 *   * every database the tests create is named `gpr2_p1_<random>` and is the only thing they ever DROP.
 *
 * If any check fails the suite does not skip quietly: it throws, so a missing or wrong server is a visible failure, not a green run.
 */
export const ISOLATED_CLUSTER_NAME = 'gpr2-p1-isolated';
export const ISOLATED_DB_PREFIX = 'gpr2_p1_';

export interface IsolationEvidence {
    serverVersion: string;
    serverVersionNum: number;
    clusterName: string;
    port: number | null;
    host: string;
    serverAddr: string | null;
    dataDirectory: string | null;
    database: string;
    productionCredentialsUsed: false;
    checkedAt: string;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '[::1]']);

export function isolatedAdminUrl(): string {
    const url = process.env.GPR2_ISOLATED_PG_URL;
    if (!url)
        throw new Error('GPR2_ISOLATED_PG_URL is not set: native PostgreSQL tests need the isolated cluster (see docs/gpr-2-p1-evidence.md); refusing to guess a server');
    const u = new URL(url);
    const host = u.hostname || u.searchParams.get('host') || '';
    if (!(LOOPBACK.has(host) || host.startsWith('/')))
        throw new Error('GPR2_ISOLATED_PG_URL must name a loopback host or a unix socket directory, got ' + JSON.stringify(host));
    return url;
}

/** Throws unless the server behind `url` is the isolated cluster. Returns what it saw, for the evidence file. */
export async function assertIsolatedPostgres(url = isolatedAdminUrl()): Promise<IsolationEvidence> {
    const c = new Client({ connectionString: url });
    await c.connect();
    try {
        const r = (await c.query(`SELECT version() AS v, current_setting('server_version_num')::int AS num, current_setting('cluster_name') AS cluster,
            current_setting('port')::int AS port, inet_server_addr()::text AS addr, current_database() AS db,
            (SELECT setting FROM pg_settings WHERE name='data_directory') AS dd`)).rows[0];
        if (r.cluster !== ISOLATED_CLUSTER_NAME)
            throw new Error('not the isolated cluster: cluster_name=' + JSON.stringify(r.cluster));
        if (r.addr !== null && !/^(127\.0\.0\.1|::1)(\/\d+)?$/.test(r.addr))
            throw new Error('server address is not loopback: ' + r.addr);
        return { serverVersion: r.v, serverVersionNum: r.num, clusterName: r.cluster, port: r.port, host: new URL(url).hostname, serverAddr: r.addr, dataDirectory: r.dd, database: r.db, productionCredentialsUsed: false, checkedAt: new Date().toISOString() };
    }
    finally {
        await c.end();
    }
}

/** Remove everything that could point a test at another database. Call first thing in a native test file. */
export function scrubConnectionEnvironment(): void {
    for (const k of Object.keys(process.env))
        if (/^(DATABASE_URL|E2E_.*|PG.*|POSTGRES_.*)$/.test(k) && k !== 'GPR2_ISOLATED_PG_URL')
            delete process.env[k];
}

export interface IsolatedDatabase { name: string; url: string; evidence: IsolationEvidence; drop: () => Promise<void> }

export async function createIsolatedDatabase(label = 'test'): Promise<IsolatedDatabase> {
    const adminUrl = isolatedAdminUrl();
    await assertIsolatedPostgres(adminUrl);
    const name = ISOLATED_DB_PREFIX + label.replace(/[^a-z0-9_]/gi, '_').toLowerCase().slice(0, 20) + '_' + randomBytes(4).toString('hex');
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    try {
        await admin.query(`CREATE DATABASE ${name} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`);
    }
    finally {
        await admin.end();
    }
    const u = new URL(adminUrl);
    u.pathname = '/' + name;
    const url = u.toString();
    const evidence = await assertIsolatedPostgres(url);
    return {
        name, url, evidence,
        drop: async () => {
            if (!name.startsWith(ISOLATED_DB_PREFIX))
                throw new Error('refusing to drop a database that is not a P1 test database: ' + name);
            const a = new Client({ connectionString: adminUrl });
            await a.connect();
            try {
                await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
            }
            finally {
                await a.end();
            }
        }
    };
}

/** Write a piece of evidence next to the others when GPR2_EVIDENCE_DIR is set (a no-op otherwise). */
export function recordEvidence(name: string, value: unknown): void {
    const dir = process.env.GPR2_EVIDENCE_DIR;
    if (!dir)
        return;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name + '.json'), JSON.stringify(value, null, 2) + '\n');
}

// ----------------------------------------------------------------------------------------------------------------------------------
// Barriers. A bare Promise.all of two racers proves nothing about interleaving (the lesson of the F8.3 / F12 harnesses): a barrier is a
// condition PostgreSQL itself reports, polled until it holds, never a sleep that hopes.
// ----------------------------------------------------------------------------------------------------------------------------------

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export async function until(predicate: () => Promise<boolean>, what: string, timeoutMs = 10000): Promise<void> {
    const t0 = Date.now();
    for (;;) {
        if (await predicate())
            return;
        if (Date.now() - t0 > timeoutMs)
            throw new Error('timed out waiting for: ' + what);
        await sleep(25);
    }
}

/** A connection with an open transaction whose backend pid is known, so another session can see whether it is blocked. */
export class Session {
    pid = 0;
    private constructor(readonly client: Client, readonly label: string) { }
    static async open(url: string, label: string): Promise<Session> {
        const c = new Client({ connectionString: url, application_name: 'gpr2-p1:' + label });
        await c.connect();
        const s = new Session(c, label);
        s.pid = (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        return s;
    }
    async begin(isolation = 'READ COMMITTED') { await this.client.query('BEGIN ISOLATION LEVEL ' + isolation); }
    query(sql: string, args: any[] = []) { return this.client.query(sql, args); }
    async commit() { await this.client.query('COMMIT'); }
    async rollback() { await this.client.query('ROLLBACK'); }
    async close() { await this.client.end().catch(() => undefined); }
}

/** True while the backend `pid` is waiting for a heavyweight lock (advisory locks included). */
export async function isBlockedOnLock(observer: Client, pid: number): Promise<boolean> {
    const r = await observer.query(`SELECT wait_event_type, wait_event, cardinality(pg_blocking_pids($1)) AS blockers FROM pg_stat_activity WHERE pid=$1`, [pid]);
    return r.rows[0]?.wait_event_type === 'Lock' && r.rows[0].blockers > 0;
}
export const waitUntilBlocked = (observer: Client, pid: number, what: string) => until(() => isBlockedOnLock(observer, pid), what + ' to be blocked on a lock');
export const waitUntilNotBlocked = (observer: Client, pid: number, what: string) => until(async () => !(await isBlockedOnLock(observer, pid)), what + ' to stop being blocked');

/** The backend pids that currently hold an advisory lock with the given key, and in which mode. */
export async function advisoryHolders(observer: Client, key: bigint): Promise<{ pid: number; mode: string; granted: boolean }[]> {
    const hi = Number(BigInt.asIntN(64, key) >> 32n), lo = Number(BigInt.asIntN(32, key));
    const r = await observer.query(`SELECT pid, mode, granted FROM pg_locks WHERE locktype='advisory' AND classid=$1::oid AND objid=$2::oid AND objsubid=1 ORDER BY pid`, [(hi >>> 0).toString(), (lo >>> 0).toString()]);
    return r.rows;
}

/** Settle a promise to a tagged result without throwing, so an expected failure can be asserted. */
export async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: any }> {
    try {
        return { ok: true, value: await p };
    }
    catch (error) {
        return { ok: false, error };
    }
}
