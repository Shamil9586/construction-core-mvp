import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * GPR-2 R03d — controlled migration execution (Technical Design §13.1, §13.4; Roadmap R03d; decision C17; scenario A29).
 *
 * What the original runner did: apply every `infra/NNN_*.sql` whose version is not in `schema_migrations`, all in one transaction, remembering
 * only the version number. Nothing recorded WHAT was applied, so a file edited after it ran was never noticed; nothing distinguished a harmless
 * addition from a destructive contract step, so "the file is in the repository" was the only thing standing between a restart and a DROP.
 *
 * What this adds, without touching any applied file:
 *   1. CLASS. Every migration after the legacy range declares `-- migration-class: additive | contract` in its header. A missing or unknown
 *      class is an error (fail closed). Files 001–025 are the grandfathered `legacy` range, pinned by the checked-in manifest.
 *   2. ADDITIVE means additive, and it is checked, not trusted: an additive file may not contain DROP, TRUNCATE, DELETE FROM, a data-rewriting
 *      UPDATE … SET, ALTER COLUMN … TYPE / SET NOT NULL / DROP …, or RENAME. A destructive statement in an additive file is a plan error.
 *   3. CONTRACT migrations never run implicitly. They run only when the operator names the version (`--allow-contract=NNN`), and never in `boot`
 *      mode. The planning step refuses BEFORE anything is applied, so a refused plan leaves the database untouched.
 *   4. CHECKSUMS. The ledger records the sha256 of each migration this runner applies (line endings normalised). A recorded checksum that no longer
 *      matches the file is refused (MIGRATION_CHANGED_AFTER_APPLY). A row WITHOUT a checksum — the 25 legacy rows, and any row written by the previous
 *      runner or by a tool that records only the version — is NOT presented as verified and is NOT refused either (refusing would strand a database
 *      migrated before this runner existed): it is reported as `unverifiedInLedger`. The legacy FILES are checked against the pinned manifest.
 *   5. PLAN FIRST. `plan()` reports what would run (version, class, checksum) and applies nothing; `--through=N` stops at N.
 *
 * The apply step keeps the original's guarantees: one transaction, one advisory lock (830017), so a crash leaves either all or none of this
 * run's migrations, and re-running is idempotent.
 */
export type MigrationClass = 'legacy' | 'additive' | 'contract';
export const LEGACY_LAST_VERSION = 25;
export const RUNNER_VERSION = 'gpr2-r03d.1';
export const MIGRATION_LOCK_KEY = 830017;

export interface MigrationFile { version: number; file: string; sql: string; checksum: string; class: MigrationClass }

export class MigrationError extends Error {
    constructor(readonly code: 'MIGRATION_CLASS_MISSING' | 'MIGRATION_CLASS_UNKNOWN' | 'MIGRATION_NOT_ADDITIVE' | 'MIGRATION_CONTRACT_NOT_ALLOWED' | 'MIGRATION_CONTRACT_IN_BOOT'
        | 'MIGRATION_CHANGED_AFTER_APPLY' | 'MIGRATION_LEGACY_MANIFEST_MISMATCH' | 'MIGRATION_VERSION_DUPLICATE' | 'MIGRATION_GAP', detail: string) {
        super(code + ': ' + detail);
        this.name = 'MigrationError';
    }
}

export const checksumOf = (sql: string): string => createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');

const CLASS_HEADER = /^\s*--\s*migration-class\s*:\s*([A-Za-z]+)\s*$/;
export function declaredClass(sql: string): string | null {
    for (const line of sql.split('\n').slice(0, 8)) {
        const m = CLASS_HEADER.exec(line);
        if (m)
            return m[1].toLowerCase();
    }
    return null;
}

/**
 * R03d/B1 — the additive scan reads what the migration EXECUTES when it is applied. Exactly two things are removed from that text, both only after a
 * real lexical pass (never by a regular expression over raw SQL):
 *   1. comments (a double-hyphen line comment ends at CR or LF; a slash-star block comment nests, as in PostgreSQL); and
 *   2. the dollar-quoted BODY of a top-level `CREATE [OR REPLACE] FUNCTION … AS $tag$ body $tag$` statement. CREATE FUNCTION stores the body; its DML runs
 *      later, under the function's own guards, and is not an effect of applying the migration.
 * Everything else stays visible, in particular string literals and every dollar-quoted string that is not such a body — so a DO block (which DOES run
 * at migration time), a dollar string after a function, the function's signature and its trailing clauses are all still scanned.
 * Fail closed: SQL the lexer cannot delimit with certainty (an unterminated comment / quote / dollar quote, a `$tag$` glued to an identifier, a
 * standard_conforming_strings setting that would change how quotes are read) is reported as a finding, so an additive file containing it is refused
 * instead of being partially hidden.
 */
type SqlSegment = { kind: 'code' | 'string' | 'ident' | 'dollar'; text: string; open?: string; close?: string; closed: boolean };
const IDENT_CHAR = /[A-Za-z0-9_$\u0080-￿]/;
const DOLLAR_OPEN = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;

function lexSql(sql: string): { segments: SqlSegment[]; problems: string[] } {
    const segments: SqlSegment[] = [];
    const problems = new Set<string>();
    let code = '';
    const flush = () => { if (code) { segments.push({ kind: 'code', text: code, closed: true }); code = ''; } };
    let i = 0;
    while (i < sql.length) {
        const ch = sql[i];
        const next = sql[i + 1];
        if (ch === '-' && next === '-') {
            // PostgreSQL ends a line comment at LF or CR.
            let j = i + 2;
            while (j < sql.length && sql[j] !== '\n' && sql[j] !== '\r')
                j++;
            code += ' ';
            i = j;
        }
        else if (ch === '/' && next === '*') {
            let depth = 1;
            let j = i + 2;
            while (j < sql.length && depth > 0) {
                if (sql[j] === '/' && sql[j + 1] === '*') { depth++; j += 2; }
                else if (sql[j] === '*' && sql[j + 1] === '/') { depth--; j += 2; }
                else
                    j++;
            }
            if (depth > 0) {
                // Unterminated: PostgreSQL would reject the file. The remainder is NOT treated as a comment, so it stays scanned.
                problems.add('UNTERMINATED COMMENT');
                code += ' ' + sql.slice(i + 2);
                i = sql.length;
            }
            else {
                code += ' ';
                i = j;
            }
        }
        else if (ch === "'" || ch === '"') {
            // E'…' honours backslash escapes; every other string and every identifier doubles its quote.
            const escaped = ch === "'" && /^[eE]$/.test(sql[i - 1] ?? '') && !IDENT_CHAR.test(sql[i - 2] ?? ' ');
            let j = i + 1;
            let closed = false;
            while (j < sql.length) {
                if (escaped && sql[j] === '\\') { j += 2; continue; }
                if (sql[j] === ch) {
                    if (sql[j + 1] === ch) { j += 2; continue; }
                    closed = true;
                    j++;
                    break;
                }
                j++;
            }
            if (!closed) {
                problems.add('UNTERMINATED QUOTE');
                j = sql.length;
            }
            // keep an E/U& prefix already in `code` with the code segment; the literal itself is its own segment
            flush();
            segments.push({ kind: ch === "'" ? 'string' : 'ident', text: sql.slice(i, j), closed });
            i = j;
        }
        else if (ch === '$' && DOLLAR_OPEN.test(sql.slice(i, i + 130))) {
            const open = DOLLAR_OPEN.exec(sql.slice(i, i + 130))![0];
            if (IDENT_CHAR.test(sql[i - 1] ?? ' '))
                problems.add('AMBIGUOUS DOLLAR QUOTE');
            const endAt = sql.indexOf(open, i + open.length);
            flush();
            if (endAt < 0) {
                problems.add('UNTERMINATED DOLLAR QUOTE');
                segments.push({ kind: 'dollar', text: sql.slice(i), open, close: open, closed: false });
                i = sql.length;
            }
            else {
                segments.push({ kind: 'dollar', text: sql.slice(i, endAt + open.length), open, close: open, closed: true });
                i = endAt + open.length;
            }
        }
        else {
            code += ch;
            i++;
        }
    }
    flush();
    return { segments, problems: [...problems] };
}

const FUNCTION_HEAD = /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/i;
const AS_BEFORE_BODY = /(?<![A-Za-z0-9_$\u0080-￿])AS\s*$/i;

/** The text the destructive scan reads, plus anything the lexer could not delimit safely. */
function scanSql(sql: string): { text: string; problems: string[] } {
    const { segments, problems } = lexSql(sql);
    // statements = runs of segments separated by a top-level ';' (a ';' inside a string / quoted identifier / dollar quote never separates)
    const statements: SqlSegment[][] = [[]];
    for (const seg of segments) {
        if (seg.kind !== 'code') { statements[statements.length - 1].push(seg); continue; }
        const parts = seg.text.split(';');
        parts.forEach((part, n) => {
            if (n > 0)
                statements.push([]);
            if (part)
                statements[statements.length - 1].push({ kind: 'code', text: part, closed: true });
        });
    }
    const flat = (t: string) => t.replace(/;/g, ' ');
    const out = statements.map(stmt => {
        const isFunction = stmt.length > 0 && stmt[0].kind === 'code' && FUNCTION_HEAD.test(stmt[0].text);
        let bodyHidden = false;
        const text = stmt.map((seg, idx) => {
            if (seg.kind === 'code')
                return seg.text;
            if (isFunction && !bodyHidden && seg.kind === 'dollar' && seg.closed && idx > 0 && stmt[idx - 1].kind === 'code' && AS_BEFORE_BODY.test(stmt[idx - 1].text)) {
                bodyHidden = true;
                return ' ';
            }
            return flat(seg.text);
        }).join('');
        // R04: only a COMPLETE standalone nullability expansion is exempt. A trailing DROP COLUMN/SET NOT NULL/UPDATE in the same statement remains visible.
        return /^\s*ALTER\s+TABLE\s+[a-z_][a-z0-9_]*\s+ALTER\s+COLUMN\s+[a-z_][a-z0-9_]*\s+DROP\s+NOT\s+NULL\s*$/i.test(text) ? '' : text;
    });
    const text = out.join(';');
    // A setting that changes how backslashes / quotes are read makes this lexer unreliable: refuse rather than guess.
    if (/\bstandard_conforming_strings\b/i.test(text))
        problems.push('STRING-SYNTAX SETTING (standard_conforming_strings)');
    return { text, problems };
}

/** The statements of a migration with comments and CREATE FUNCTION bodies removed — what the destructive scan reads. */
export function executableText(sql: string): string {
    return scanSql(sql).text;
}
const DESTRUCTIVE: [RegExp, string][] = [
    [/\bDROP\s+(TABLE|COLUMN|SCHEMA|DATABASE|TYPE|VIEW|INDEX|CONSTRAINT|TRIGGER|FUNCTION|SEQUENCE|POLICY|EXTENSION)\b/i, 'DROP'],
    [/\bALTER\s+TABLE\b[^;]*\bDROP\b/i, 'ALTER TABLE … DROP'],
    [/\bTRUNCATE\b/i, 'TRUNCATE'],
    [/\bDELETE\s+FROM\b/i, 'DELETE FROM'],
    [/\bUPDATE\s+(ONLY\s+)?[A-Za-z_."]+\s+(AS\s+\w+\s+)?SET\b/i, 'UPDATE … SET (data rewrite)'],
    [/\bALTER\s+COLUMN\s+\S+\s+(SET\s+DATA\s+)?TYPE\b/i, 'ALTER COLUMN … TYPE'],
    [/\bALTER\s+COLUMN\s+\S+\s+SET\s+NOT\s+NULL\b/i, 'ALTER COLUMN … SET NOT NULL'],
    [/\bRENAME\b/i, 'RENAME']
];
export function destructiveStatements(sql: string): string[] {
    const { text, problems } = scanSql(sql);
    return [...DESTRUCTIVE.filter(([re]) => re.test(text)).map(([, name]) => name), ...problems];
}

export function readMigrationFiles(dir = 'infra', legacyManifest = readLegacyManifest(dir)): MigrationFile[] {
    const out: MigrationFile[] = [];
    for (const file of fs.readdirSync(dir).filter(f => /^\d+_.*\.sql$/.test(f)).sort()) {
        const version = Number(file.split('_')[0]);
        if (out.some(m => m.version === version))
            throw new MigrationError('MIGRATION_VERSION_DUPLICATE', 'version ' + version + ' appears in two files');
        const sql = fs.readFileSync(path.join(dir, file), 'utf8');
        const checksum = checksumOf(sql);
        let cls: MigrationClass;
        if (version <= LEGACY_LAST_VERSION) {
            if (legacyManifest[file] !== checksum)
                throw new MigrationError('MIGRATION_LEGACY_MANIFEST_MISMATCH', file + ' differs from the pinned baseline manifest (an applied migration must never be edited)');
            cls = 'legacy';
        }
        else {
            const declared = declaredClass(sql);
            if (!declared)
                throw new MigrationError('MIGRATION_CLASS_MISSING', file + ' has no "-- migration-class: additive|contract" header');
            if (declared !== 'additive' && declared !== 'contract')
                throw new MigrationError('MIGRATION_CLASS_UNKNOWN', file + ' declares class "' + declared + '"');
            cls = declared;
            if (cls === 'additive') {
                const bad = destructiveStatements(sql);
                if (bad.length)
                    throw new MigrationError('MIGRATION_NOT_ADDITIVE', file + ' is declared additive but contains: ' + bad.join(', '));
            }
        }
        out.push({ version, file, sql, checksum, class: cls });
    }
    return out;
}

export function readLegacyManifest(dir = 'infra'): Record<string, string> {
    const p = path.join(dir, 'migrations.legacy.sha256.json');
    return JSON.parse(fs.readFileSync(p, 'utf8')).files;
}

export interface AppliedRow { version: number; checksum: string | null }
export interface PlanOptions {
    /** 'explicit' = an operator ran the command; 'boot' = the application is starting. */
    mode?: 'explicit' | 'boot';
    allowContract?: number[];
    through?: number;
}
export interface PlannedMigration { version: number; file: string; class: MigrationClass; checksum: string }
export interface MigrationPlan {
    pending: PlannedMigration[];
    /** Applied rows whose ledger holds no checksum — the 25 legacy ones and any written by the previous runner: reported honestly, never refused, never promoted to "verified". */
    unverifiedInLedger: number[];
}

/** Decide what would run. Pure: no database access, no side effect. Throws before anything could be applied. */
export function planMigrations(files: MigrationFile[], applied: AppliedRow[], opts: PlanOptions = {}): MigrationPlan {
    const mode = opts.mode ?? 'explicit';
    const allow = new Set(opts.allowContract ?? []);
    const byVersion = new Map(applied.map(a => [a.version, a]));
    const unverifiedInLedger: number[] = [];
    for (const f of files) {
        const row = byVersion.get(f.version);
        if (!row)
            continue;
        if (f.class === 'legacy') {
            if (row.checksum === null)
                unverifiedInLedger.push(f.version);
            else if (row.checksum !== f.checksum)
                throw new MigrationError('MIGRATION_CHANGED_AFTER_APPLY', f.file);
            continue;
        }
        // A row written by the PREVIOUS runner (or any tool that records only the version) has no checksum. It is the same case as a legacy row: reported as
        // unverified, never refused (refusing would strand a database that was migrated before this runner existed) and never promoted to "verified".
        if (row.checksum === null)
            unverifiedInLedger.push(f.version);
        else if (row.checksum !== f.checksum)
            throw new MigrationError('MIGRATION_CHANGED_AFTER_APPLY', f.file);
    }
    const pending = files.filter(f => !byVersion.has(f.version) && (opts.through === undefined || f.version <= opts.through));
    // An applied migration newer than a pending one means a file appeared out of order: apply nothing rather than guess.
    const maxApplied = Math.max(0, ...applied.map(a => a.version));
    for (const f of pending)
        if (f.version < maxApplied)
            throw new MigrationError('MIGRATION_GAP', f.file + ' is pending but a later version (' + maxApplied + ') is already applied');
    for (const f of pending) {
        if (f.class !== 'contract')
            continue;
        if (mode === 'boot')
            throw new MigrationError('MIGRATION_CONTRACT_IN_BOOT', f.file + ' is a contract migration and can never run at application start');
        if (!allow.has(f.version))
            throw new MigrationError('MIGRATION_CONTRACT_NOT_ALLOWED', f.file + ' is a contract migration; run it with --allow-contract=' + f.version + ' after the release decision');
    }
    return { pending: pending.map(f => ({ version: f.version, file: f.file, class: f.class, checksum: f.checksum })), unverifiedInLedger };
}

/** The ledger columns this runner owns. Added in the same transaction as the run; the original `version`/`applied_at` columns are untouched. */
const LEDGER_DDL = [
    'CREATE TABLE IF NOT EXISTS schema_migrations(version int PRIMARY KEY, applied_at timestamptz DEFAULT now())',
    'ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text',
    'ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS file_name text',
    'ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS migration_class text',
    'ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS runner_version text'
];

export interface ApplyResult { applied: PlannedMigration[]; unverifiedInLedger: number[] }

/** Apply the plan on `c` (a client already inside the caller's transaction). */
export async function applyMigrations(c: { query: (sql: string, args?: any[]) => Promise<any> }, files: MigrationFile[], opts: PlanOptions = {}): Promise<ApplyResult> {
    await c.query('SELECT pg_advisory_xact_lock(' + MIGRATION_LOCK_KEY + ')');
    for (const ddl of LEDGER_DDL)
        await c.query(ddl);
    const applied: AppliedRow[] = (await c.query('SELECT version, checksum FROM schema_migrations')).rows.map((r: any) => ({ version: Number(r.version), checksum: r.checksum ?? null }));
    const plan = planMigrations(files, applied, opts);
    for (const p of plan.pending) {
        const f = files.find(x => x.version === p.version)!;
        await c.query(f.sql);
        await c.query('INSERT INTO schema_migrations(version, checksum, file_name, migration_class, runner_version) VALUES($1,$2,$3,$4,$5)', [f.version, f.checksum, f.file, f.class, RUNNER_VERSION]);
    }
    return { applied: plan.pending, unverifiedInLedger: plan.unverifiedInLedger };
}

/** The same decision as applyMigrations, with nothing applied. Opens no transaction and takes no lock. */
export async function planAgainstLedger(c: { query: (sql: string, args?: any[]) => Promise<any> }, files: MigrationFile[], opts: PlanOptions = {}): Promise<MigrationPlan> {
    const exists = (await c.query("SELECT to_regclass('schema_migrations') IS NOT NULL AS ok")).rows[0].ok;
    if (!exists)
        return planMigrations(files, [], opts);
    const hasChecksum = (await c.query("SELECT 1 FROM information_schema.columns WHERE table_name='schema_migrations' AND column_name='checksum'")).rows.length > 0;
    const rows = (await c.query(hasChecksum ? 'SELECT version, checksum FROM schema_migrations' : 'SELECT version, NULL AS checksum FROM schema_migrations')).rows;
    return planMigrations(files, rows.map((r: any) => ({ version: Number(r.version), checksum: r.checksum ?? null })), opts);
}

export function parseCliArgs(argv: string[]): PlanOptions & { plan: boolean } {
    const opts: PlanOptions & { plan: boolean } = { plan: false, mode: 'explicit', allowContract: [] };
    for (const a of argv) {
        if (a === '--plan')
            opts.plan = true;
        else if (a.startsWith('--through='))
            opts.through = Number(a.slice('--through='.length));
        else if (a.startsWith('--allow-contract='))
            opts.allowContract!.push(...a.slice('--allow-contract='.length).split(',').map(Number));
        else
            throw new Error('migrate: unknown argument ' + a);
    }
    if (opts.through !== undefined && !Number.isInteger(opts.through))
        throw new Error('migrate: --through needs an integer');
    if (opts.allowContract!.some(n => !Number.isInteger(n)))
        throw new Error('migrate: --allow-contract needs integer versions');
    return opts;
}
