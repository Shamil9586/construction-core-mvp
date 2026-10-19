import { HttpException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { pool } from './db';
import { Actor, objectAccess } from './security';
import {
    Gpr2Endpoint, Gpr2Error, CapabilityAssignment, NO_CAPABILITY_ASSIGNMENTS, CommandResult, ParsedCommand, InputFingerprint,
    commandFingerprint, isAuthorized, parseCommand, pathParamsOf, permissionDenied, scopeSafeNotFound
} from '../../../packages/domain/gpr2';

/**
 * GPR-2 R01 — the one door every new /v2 command passes through (Technical Design §11.1, §12.4; acceptance A19).
 *
 * The ORDER is the contract, and it is the same for every command:
 *   1. authenticate            401, before anything else is looked at
 *   2. permission              403 — decided from the caller's CURRENT role (authenticate() reads it from the database on every request, so a
 *                              role changed since a session or an idempotency key was issued takes effect immediately) and before any
 *                              scope lookup, so a caller without the grant learns nothing about any object
 *   3. path ids + scope        404 — a malformed id, a missing object, another tenant's object and another project manager's object are
 *                              one and the same answer (scopeSafeNotFound)
 *   4. envelope                422 — Idempotency-Key, the version tokens the register says this command carries, the payload
 *   5. replay                  ONLY now may a stored result be returned: authorization comes before replay, so neither ADMIN nor knowledge of
 *                              an idempotency key can fetch someone else's result (§12.4, A19 "no cached-response privilege leak")
 *   6. execute                 the behaviour of the stage that owns the command
 *
 * R01 ships no behaviour. DISABLED_HOOKS answers an authorised, in-scope, well-formed call with 501 COMMAND_NOT_ENABLED, writes nothing and
 * stores no ledger row. The stages that implement a command replace the hooks; they cannot reorder the steps above.
 */
export interface Gpr2CommandContext {
    endpoint: Gpr2Endpoint;
    actor: Actor;
    objectId: string | null;
    params: Record<string, string>;
    command: ParsedCommand;
    fingerprint: InputFingerprint;
}
export interface Gpr2Hooks {
    /** R03c: a stored result for a repeat of this exact command by this actor, or null. Called only after steps 1–4 passed. */
    replay: (ctx: Gpr2CommandContext) => Promise<CommandResult | null>;
    execute: (ctx: Gpr2CommandContext) => Promise<CommandResult>;
}
export const DISABLED_HOOKS: Gpr2Hooks = {
    replay: async () => null,
    execute: async () => { throw new Gpr2Error('COMMAND_NOT_ENABLED'); }
};

/** An HttpException that carries the contract error, so the application filter can put `code` and `details` on the wire. */
export class Gpr2HttpException extends HttpException {
    constructor(readonly gpr2: Gpr2Error) { super(gpr2.toBody(), gpr2.status); }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function runGpr2Command(endpoint: Gpr2Endpoint, input: { actor: Actor; params: Record<string, string>; headers: Record<string, unknown>; body: unknown },
                                     hooks: Gpr2Hooks = DISABLED_HOOKS, assignments: readonly CapabilityAssignment[] = NO_CAPABILITY_ASSIGNMENTS): Promise<CommandResult> {
    const { actor, params } = input;
    if (endpoint.kind !== 'COMMAND' || endpoint.authorization.type === 'EXISTING_RULES')
        throw new Error('runGpr2Command: ' + endpoint.id + ' is not a command with a GPR-2 authorization');
    // 2. permission — from the role as it is NOW.
    if (!isAuthorized({ tenantId: actor.tenantId, userId: actor.id, role: actor.role }, endpoint.authorization, params.objectId?.toLowerCase() ?? null, assignments))
        throw permissionDenied();
    // 3. path ids and scope.
    for (const name of pathParamsOf(endpoint))
        if (!UUID.test(params[name] ?? ''))
            throw scopeSafeNotFound();
    const objectId = endpoint.scope === 'OBJECT' ? params.objectId.toLowerCase() : null;
    if (objectId)
        try {
            await objectAccess(pool, actor, objectId, true);
        }
        catch (e) {
            if (e instanceof NotFoundException || e instanceof ForbiddenException)
                throw scopeSafeNotFound();
            throw e;
        }
    // 4. envelope.
    const command = parseCommand(endpoint, input.headers, input.body);
    const fingerprint = commandFingerprint({
        commandKind: endpoint.id, payload: command.payload, expectedVersion: command.expectedVersion as any, expectedScopeVersion: command.expectedScopeVersion as any, sourceVersions: {}
    });
    const ctx: Gpr2CommandContext = { endpoint, actor, objectId, params, command, fingerprint };
    // 5. replay, 6. execute.
    return (await hooks.replay(ctx)) ?? hooks.execute(ctx);
}
