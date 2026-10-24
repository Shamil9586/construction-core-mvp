import { pool } from './db';
import { Gpr2Hooks, Gpr2CommandContext } from './gpr2-command-guard';
import { ledgerCommandOf, lookupReplay } from './command-ledger';
import { resolveR05Owner } from './gpr2-r05-support';
import { approveWorkTypePublication, createObjectWorkType, rejectWorkTypePublication, requestWorkTypePublication } from './gpr2-r05-catalog';
import { CommandResult, Gpr2Error } from '../../../packages/domain/gpr2';

/**
 * GPR-2 R05 — the behaviour behind the R05 rows of the endpoint register. Every OTHER command keeps exactly the R01 behaviour: its aggregates are
 * unknown to the resolver (scope-safe 404) and an authorised call answers 501 COMMAND_NOT_ENABLED without a ledger lookup or a write. The guard order
 * (permission → scope → nested resource → envelope → replay → execute) is the guard's, not this module's.
 */
export const R05_HANDLERS: Readonly<Record<string, (ctx: Gpr2CommandContext) => Promise<CommandResult>>> = Object.freeze({
    'work-type.create': createObjectWorkType,
    'work-type.publication.request': requestWorkTypePublication,
    'work-type.publication.approve': approveWorkTypePublication,
    'work-type.publication.reject': rejectWorkTypePublication
});

export const R05_HOOKS: Gpr2Hooks = Object.freeze({
    resources: Object.freeze({ resolve: (ref: any) => resolveR05Owner(pool, ref) }),
    // A pure preview has no stored result; a command of another stage never reaches the ledger.
    replay: async (ctx: Gpr2CommandContext) => (R05_HANDLERS[ctx.endpoint.id] && !ctx.endpoint.pure ? lookupReplay(pool, ledgerCommandOf(ctx)) : null),
    execute: async (ctx: Gpr2CommandContext) => {
        const handler = R05_HANDLERS[ctx.endpoint.id];
        if (!handler)
            throw new Gpr2Error('COMMAND_NOT_ENABLED');
        return handler(ctx);
    }
});
