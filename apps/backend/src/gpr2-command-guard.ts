import { HttpException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { pool } from './db';
import { Actor, objectAccess } from './security';
import {
    Gpr2Endpoint, Gpr2Error, CapabilityAssignment, NO_CAPABILITY_ASSIGNMENTS, CommandResult, ParsedCommand, InputFingerprint, Gpr2ResourceResolver, DENY_ALL_RESOURCES,
    commandFingerprint, isAuthorized, ownershipPermits, parseCommand, pathParamsOf, permissionDenied, resourceRefsOf, scopeSafeNotFound, validationFailed
} from '../../../packages/domain/gpr2';

/**
 * GPR-2 R01 — the one door every new /v2 command passes through (Technical Design §11.1, §12.4; acceptance A19).
 *
 * The ORDER is the contract, and it is the same for every command:
 *   1. authenticate            401, before anything else is looked at
 *   2. permission              403 — decided from the caller's CURRENT role (authenticate() reads it from the database on every request, so a
 *                              role changed since a session or an idempotency key was issued takes effect immediately) and before any
 *                              scope lookup, so a caller without the grant learns nothing about any object
 *   3. path ids + object scope 404 — a malformed id, a missing object, another tenant's object and another project manager's object are
 *                              one and the same answer (scopeSafeNotFound)
 *   4. nested resource         404 — the aggregate named by `{id}` must exist AND belong to this tenant and this object (a tenant-level request:
 *      preflight               to this tenant and to no object). A UUID that is merely well formed proves nothing. Same single 404, so
 *                              "missing", "another object's" and "another tenant's" cannot be told apart (R01-B04; resources.ts)
 *   5. envelope                422 — Idempotency-Key, the version tokens the register says this command carries, the payload
 *   6. replay                  ONLY now may a stored result be returned: authorization comes before replay, so neither ADMIN nor knowledge of
 *                              an idempotency key can fetch someone else's result (§12.4, A19 "no cached-response privilege leak")
 *   7. execute                 the behaviour of the stage that owns the command
 *
 * R01 ships no behaviour. DISABLED_HOOKS answers an authorised, in-scope, well-formed call with 501 COMMAND_NOT_ENABLED, writes nothing and
 * stores no ledger row — and, because its resolver knows no aggregate, a command addressed to one never gets that far. The stages that implement
 * a command replace the hooks; they cannot reorder the steps above.
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
    /** MANDATORY owner lookup for the aggregate a path names. There is no optional form: a command cannot be wired without answering "who owns this?". */
    resources: Gpr2ResourceResolver;
    /** R03c: a stored result for a repeat of this exact command by this actor, or null. Called only after steps 1–5 passed. */
    replay: (ctx: Gpr2CommandContext) => Promise<CommandResult | null>;
    execute: (ctx: Gpr2CommandContext) => Promise<CommandResult>;
}
export const DISABLED_HOOKS: Gpr2Hooks = {
    resources: DENY_ALL_RESOURCES,
    replay: async () => null,
    execute: async () => { throw new Gpr2Error('COMMAND_NOT_ENABLED'); }
};

/** An HttpException that carries the contract error, so the application filter can put `code` and `details` on the wire. */
export class Gpr2HttpException extends HttpException {
    constructor(readonly gpr2: Gpr2Error) { super(gpr2.toBody(), gpr2.status); }
}

/**
 * The fingerprint of a parsed command. The envelope has already limited the payload to canonicalisable JSON (open-value.ts), so this cannot throw
 * for a payload that passed; if it ever does, that is a refusal of the input (422), never a 500 (R01-B03).
 */
function fingerprintOf(endpoint: Gpr2Endpoint, command: ParsedCommand): InputFingerprint {
    try {
        return commandFingerprint({
            commandKind: endpoint.id, payload: command.payload, expectedVersion: command.expectedVersion as any, expectedScopeVersion: command.expectedScopeVersion as any,
            sourceVersions: command.payload?.expectedSourceVersions ?? {}
        });
    }
    catch (e) {
        if (e instanceof TypeError)
            throw validationFailed([{ path: 'payload', rule: 'FIELD_TYPE' }]);
        throw e;
    }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function runGpr2Command(endpoint: Gpr2Endpoint, input: { actor: Actor; params: Record<string, string>; headers: Record<string, unknown>; body: unknown },
                                     hooks: Gpr2Hooks = DISABLED_HOOKS, assignments: readonly CapabilityAssignment[] = NO_CAPABILITY_ASSIGNMENTS): Promise<CommandResult> {
    const { actor, params } = input;
    // A hook set without a resolver is a wiring mistake (a JS caller, a half-built test double): it must fail BEFORE anything can reach replay.
    if (typeof hooks?.resources?.resolve !== 'function' || typeof hooks.replay !== 'function' || typeof hooks.execute !== 'function')
        throw new Error('runGpr2Command: hooks must provide resources.resolve, replay and execute');
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
    // 4. nested resource preflight. Every refusal is the same 404; only a resolver that VERIFIED the owner lets the call through. An exception from the
    //    resolver is not an answer, so it propagates (a 500 with no body detail) and nothing reaches replay or execute.
    for (const ref of resourceRefsOf(endpoint, params))
        if (!ownershipPermits(await hooks.resources.resolve(ref), { tenantId: actor.tenantId }, { scope: endpoint.scope, objectId }))
            throw scopeSafeNotFound();
    // 5. envelope.
    const command = parseCommand(endpoint, input.headers, input.body);
    const ctx: Gpr2CommandContext = { endpoint, actor, objectId, params, command, fingerprint: fingerprintOf(endpoint, command) };
    // 6. replay, 7. execute.
    return (await hooks.replay(ctx)) ?? hooks.execute(ctx);
}
