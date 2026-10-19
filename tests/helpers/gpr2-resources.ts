import { randomUUID as uuid } from 'node:crypto';
import type { Gpr2Endpoint, Gpr2ResourceOwnership, Gpr2ResourceRef, Gpr2ResourceResolver, CommandResult } from '../../packages/domain/gpr2';
import type { Gpr2CommandContext, Gpr2Hooks } from '../../apps/backend/src/gpr2-command-guard';

/**
 * GPR-2 R01 test doubles for the nested-resource preflight (finding R01-B04). TEST-ONLY: nothing in the application imports this file.
 *
 * R01 has no aggregate tables, so there is no real owner lookup to call. `TrustedResources` is an explicit, isolated stand-in: it knows exactly the
 * (kind, id) pairs a test registered with the owner the test chose, and answers `{ found: false }` for everything else — the same deny-by-default
 * behaviour the production DENY_ALL_RESOURCES has, plus the positives a test needs. It records every question it was asked, so a test can prove the
 * preflight ran (or did NOT run) for a given request.
 */
export class TrustedResources implements Gpr2ResourceResolver {
  readonly asked: Gpr2ResourceRef[] = [];
  private owners = new Map<string, Gpr2ResourceOwnership>();
  private key = (kind: string, id: string) => `${kind}:${id.toLowerCase()}`;
  own(kind: Gpr2ResourceRef['kind'], id: string, owner: { tenantId: string; objectId: string | null }) { this.owners.set(this.key(kind, id), { found: true, tenantId: owner.tenantId, objectId: owner.objectId }); return id; }
  forget(kind: Gpr2ResourceRef['kind'], id: string) { this.owners.delete(this.key(kind, id)); }
  async resolve(ref: Gpr2ResourceRef): Promise<Gpr2ResourceOwnership> { this.asked.push({ ...ref }); return this.owners.get(this.key(ref.kind, ref.id)) ?? { found: false }; }
  reset() { this.asked.length = 0; }
}

export interface Owner { tenantId: string; objectId: string }
/** Path params for an endpoint whose `{id}` is a resource owned by `owner` (a tenant-level route: owned by the tenant, no object). */
export function ownedParams(resources: TrustedResources, e: Gpr2Endpoint, owner: Owner, objectId: string = owner.objectId): Record<string, string> {
  const params: Record<string, string> = e.scope === 'OBJECT' ? { objectId } : {};
  if (e.resource) params.id = resources.own(e.resource.kind, uuid(), { tenantId: owner.tenantId, objectId: e.scope === 'OBJECT' ? owner.objectId : null });
  return params;
}

export const RESULT: CommandResult = { commandId: '00000000-0000-4000-8000-0000000000aa', resultIds: [], appliedVersions: { aggregate: '2', scope: null }, warnings: [] };

/** Hooks that record the order in which they are reached. `replayResult` makes the stored-result path observable. */
export function recordingHooks(resources: Gpr2ResourceResolver, replayResult: CommandResult | null = null, run?: { execute?: (ctx: Gpr2CommandContext) => Promise<CommandResult> }) {
  const calls: string[] = [], seen: Gpr2CommandContext[] = [];
  const hooks: Gpr2Hooks = {
    resources,
    replay: async ctx => { calls.push('replay'); seen.push(ctx); return replayResult; },
    execute: async ctx => { calls.push('execute'); seen.push(ctx); return run?.execute ? run.execute(ctx) : RESULT; }
  };
  return { hooks, calls, seen };
}

/** Swap the hooks of the LIVE controller of a running application (the seam the stages will use too: the module provides them). Returns the undo. */
export async function installHooks(app: { get: (token: any, options?: any) => any }, hooks: Gpr2Hooks): Promise<() => void> {
  const { Gpr2ContractController } = await import('../../apps/backend/src/modules/gpr2/gpr2.controller');
  const controller = app.get(Gpr2ContractController, { strict: false });
  const previous = controller.hooks;
  controller.hooks = hooks;
  return () => { controller.hooks = previous; };
}
