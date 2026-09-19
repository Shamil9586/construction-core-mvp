-- Core 2.1 corrective: единый active-contractor read source (docs/core-2.1-architecture-plan.md).
-- Six call sites independently repeated "object_contractors WHERE removed_at IS NULL"
-- (security.ts objectAccess, read-service.ts x3, objects.controller.ts, service.ts
-- x3) — the same drift risk already fixed once for ContractorPanel in b1a3764. A
-- simple, non-aggregating single-table view is updatable and supports FOR UPDATE,
-- which locks the underlying object_contractors row exactly as querying the base
-- table directly would.
CREATE VIEW object_contractors_active AS
    SELECT * FROM object_contractors WHERE removed_at IS NULL;
