import { randomUUID } from 'node:crypto';
import { rows } from './db';
import type { Gpr2CommandContext, Gpr2Hooks } from './gpr2-command-guard';
import { CommandResult, Gpr2Error, commandResultSchema, pathParamsOf } from '../../../packages/domain/gpr2';

/**
 * GPR-2 R03c — the command ledger: authorization before replay, payload mismatch, lost-response retry (Technical Design §12.4; scenarios A19, A30).
 *
 * One mechanism for every new command, over one table (gpr2_command_ledger, migration 027) — not a cache per command. A row says:
 * "this actor, in this tenant, issued this command kind against this object or aggregate under this Idempotency-Key, with this input
 * fingerprint, and this is the result". The key is scoped by all of those, so knowing a key opens nothing: another actor's identical key is a
 * different row, and the same actor's key reused on another command or aggregate is a different row too.
 *
 * The order inside runLedgered() is fixed, and a test proves it from a trace:
 *   1. authorize()   — always, with the caller's rights as they are NOW; a replay is never served to a caller who could not issue the command today
 *   2. claim         — INSERT … ON CONFLICT DO NOTHING on the unique scope. A concurrent twin blocks here on the first transaction's uncommitted row
 *                      and, once that commits, sees the conflict; if that one rolls back, this one proceeds. PostgreSQL's own conflict check — not
 *                      an application SELECT — is what makes "one effect" true.
 *   3. compare       — the stored fingerprint against this call's: different → 409 IDEMPOTENCY_PAYLOAD_MISMATCH, nothing executed
 *   4. replay | run  — same fingerprint on a completed row → the stored result, no second effect; otherwise execute()
 *   5. complete      — the result is written onto the claimed row in the SAME transaction as the business mutation
 * A mutation that aborts rolls the claim back with it, so a ledger row can never record a success that did not happen, and a retry after a
 * genuine failure starts clean. A deferred constraint trigger refuses to commit a claimed row that never received its result.
 */
export interface LedgerCommand {
    tenantId: string;
    actorId: string;
    /** The endpoint register id, e.g. "quantity.request.approve". */
    commandKind: string;
    /** The object, or the aggregate the key is scoped to. */
    scopeId: string;
    idempotencyKey: string | null;
    /** commandFingerprint() of the semantic input. */
    fingerprint: string;
}

export type Executed = Omit<CommandResult, 'commandId'>;
export interface LedgerSteps {
    /** Re-checks the caller's rights now. Runs first, on every call including a replay; throws to refuse. */
    authorize: () => Promise<void>;
    /** The business mutation, on the caller's transaction. `commandId` is the id the result will carry. */
    execute: (commandId: string) => Promise<Executed>;
    /** Test seam: called with each phase name as it happens. */
    trace?: (phase: 'authorize' | 'claim' | 'compare' | 'replay' | 'execute' | 'complete') => void;
}
export interface LedgerOutcome { replayed: boolean; result: CommandResult }

interface Row { id: string; fingerprint: string; result: CommandResult | null }

const fromRow = (r: any): Row => ({ id: r.id, fingerprint: r.fingerprint, result: r.result ?? null });
const scopeParams = (cmd: LedgerCommand) => [cmd.tenantId, cmd.actorId, cmd.commandKind, cmd.scopeId, cmd.idempotencyKey];
const SELECT_ROW = 'SELECT id, fingerprint, result FROM gpr2_command_ledger WHERE tenant_id=$1 AND actor_id=$2 AND command_kind=$3 AND scope_id=$4 AND idempotency_key=$5';

function replayOrMismatch(cmd: LedgerCommand, row: Row, trace?: LedgerSteps['trace']): CommandResult {
    trace?.('compare');
    if (row.fingerprint !== cmd.fingerprint)
        throw new Gpr2Error('IDEMPOTENCY_PAYLOAD_MISMATCH');
    if (!row.result)
        throw new Error('command ledger: a committed row has no result (integrity violation)'); // the deferred trigger makes this unreachable
    trace?.('replay');
    return commandResultSchema.parse(row.result);
}

/** Run one command inside the caller's open transaction `c`. */
export async function runLedgered(c: any, cmd: LedgerCommand, steps: LedgerSteps): Promise<LedgerOutcome> {
    steps.trace?.('authorize');
    await steps.authorize();
    // A command without a key is not retry-safe by contract (the envelope requires a key wherever that matters); it is simply executed.
    if (!cmd.idempotencyKey) {
        const commandId = randomUUID();
        steps.trace?.('execute');
        return { replayed: false, result: commandResultSchema.parse({ commandId, ...(await steps.execute(commandId)) }) };
    }
    steps.trace?.('claim');
    const claimedId = randomUUID();
    const claimed = (await rows(c, 'INSERT INTO gpr2_command_ledger(id,tenant_id,actor_id,command_kind,scope_id,idempotency_key,fingerprint) VALUES($6,$1,$2,$3,$4,$5,$7) ON CONFLICT (tenant_id,actor_id,command_kind,scope_id,idempotency_key) DO NOTHING RETURNING id', [...scopeParams(cmd), claimedId, cmd.fingerprint]))[0];
    if (!claimed) {
        const existing = (await rows(c, SELECT_ROW, scopeParams(cmd)))[0];
        if (!existing)
            throw new Error('command ledger: conflicting row vanished'); // cannot happen under READ COMMITTED; under a snapshot isolation level the caller retries (40001)
        return { replayed: true, result: replayOrMismatch(cmd, fromRow(existing), steps.trace) };
    }
    steps.trace?.('execute');
    const result = commandResultSchema.parse({ commandId: claimedId, ...(await steps.execute(claimedId)) });
    steps.trace?.('complete');
    await c.query('UPDATE gpr2_command_ledger SET result=$2::jsonb, completed_at=now() WHERE id=$1', [claimedId, JSON.stringify(result)]);
    return { replayed: false, result };
}

/**
 * The read-only look-up behind the pipeline's `replay` hook (gpr2-command-guard.ts step 6). By the time it runs the pipeline has already
 * authenticated, checked the grant, the object scope and the aggregate's ownership — so it is only ever reached by a caller who may issue
 * the command today. It answers null when there is nothing to replay (the command then runs and claims the key); the claim in runLedgered()
 * stays the authority for a race this look-up cannot see.
 */
export async function lookupReplay(db: any, cmd: LedgerCommand): Promise<CommandResult | null> {
    if (!cmd.idempotencyKey)
        return null;
    const row = (await rows(db, SELECT_ROW, scopeParams(cmd)))[0];
    return row ? replayOrMismatch(cmd, fromRow(row)) : null;
}

/** The id a command's key is scoped to: the aggregate named by the path (`{id}` …) when there is one, else the object, else the tenant. */
export function ledgerScopeId(ctx: Gpr2CommandContext): string {
    const names = pathParamsOf(ctx.endpoint).filter(n => n !== 'objectId');
    const aggregate = names.length ? ctx.params[names[names.length - 1]] : null;
    return (aggregate ?? ctx.objectId ?? ctx.actor.tenantId).toLowerCase();
}

export const ledgerCommandOf = (ctx: Gpr2CommandContext): LedgerCommand => ({
    tenantId: ctx.actor.tenantId, actorId: ctx.actor.id, commandKind: ctx.endpoint.id, scopeId: ledgerScopeId(ctx), idempotencyKey: ctx.command.idempotencyKey, fingerprint: ctx.fingerprint
});

/** The `replay` hook for runGpr2Command: stored results come from the one ledger. */
export const ledgerReplayHook = (db: any): Gpr2Hooks['replay'] => ctx => lookupReplay(db, ledgerCommandOf(ctx));
