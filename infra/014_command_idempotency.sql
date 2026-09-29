-- F12.3 FINAL-R01/FINAL-R02 corrective pass — true concurrent command
-- idempotency (LOCKED DECISION 2, Option A).
--
-- FINAL-R01: createExecutionUnit()/createQuantityPortion() already have an
-- idempotency_key column + partial unique index (infra/013) but the service
-- used a plain SELECT-then-INSERT, which two genuinely concurrent
-- same-key transactions can both pass before either commits. That is fixed
-- in application code alone (service.ts now uses INSERT ... ON CONFLICT
-- (tenant_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
-- RETURNING *, targeting the exact same 013 index) — no schema change is
-- needed or made here for that half of this migration's purpose.
--
-- FINAL-R02: recordPortionFact()/requestPortionInspection()/
-- handoffDocumentationPackageToSdo()/returnSdoCaseToPto()/
-- changeSdoClosingStatus() each mutate an *existing* versioned row rather
-- than creating an independent new one, so there is no single row to key
-- idempotency off directly the way 013 does for creates. This table is a
-- small, shared, opt-in ledger used only by those five confirmed paths:
-- one row per (tenant, operation, idempotency_key), recording the payload
-- first seen and — once the operation completes — the exact response to
-- replay. A retry with the same key is served the stored response instead
-- of re-running the mutation or hitting the version guard a second time;
-- reusing the same key with a different payload is rejected (checked in
-- application code against the stored payload). The claim insert and the
-- operation's own mutation share one PostgreSQL transaction (see
-- claimIdempotentCommand()/completeIdempotentCommand(), security.ts), so a
-- business-rule failure rolls back the claim together with everything else
-- — a genuinely failed attempt leaves nothing behind for a later, real
-- retry to trip over, and a stale command without a matching prior success
-- keeps failing normally.
CREATE TABLE idempotent_commands(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    operation text NOT NULL,
    idempotency_key uuid NOT NULL,
    scope_id uuid NOT NULL,
    payload jsonb NOT NULL,
    response jsonb,
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(tenant_id,id),
    UNIQUE(tenant_id,operation,idempotency_key),
    FOREIGN KEY(tenant_id,created_by) REFERENCES users(tenant_id,id)
);
CREATE INDEX idempotent_commands_tenant_idx ON idempotent_commands(tenant_id);
