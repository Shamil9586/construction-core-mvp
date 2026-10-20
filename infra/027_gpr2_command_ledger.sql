-- migration-class: additive
-- GPR-2 R03c — the command ledger (Technical Design §12.4).
--
-- One new table; nothing existing is altered. The older `idempotent_commands` ledger (014) keeps serving the five F12 commands exactly as it
-- does; the GPR-2 commands share this one. Scope of a key = tenant + actor + command kind + object/aggregate + Idempotency-Key, so knowing
-- a key opens nothing for anyone else.
--
-- Atomicity is part of the schema, not only of the application:
--   * a row is first INSERTed as a claim and later UPDATEd once with its result, inside the same transaction as the business mutation;
--   * a deferred constraint trigger refuses to COMMIT a row that has no result, so a ledger row can never outlive a command that did not finish;
--   * once completed a row is immutable, and it cannot be deleted.

CREATE TABLE gpr2_command_ledger(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    actor_id uuid NOT NULL,
    command_kind text NOT NULL CHECK(command_kind ~ '^[a-z][a-z0-9.-]{2,80}$'),
    scope_id uuid NOT NULL,
    idempotency_key uuid NOT NULL,
    fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
    result jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    UNIQUE(tenant_id,id),
    UNIQUE(tenant_id,actor_id,command_kind,scope_id,idempotency_key),
    FOREIGN KEY(tenant_id,actor_id) REFERENCES users(tenant_id,id),
    CHECK((result IS NULL) = (completed_at IS NULL))
);
CREATE INDEX gpr2_command_ledger_tenant_idx ON gpr2_command_ledger(tenant_id,created_at);

CREATE FUNCTION gpr2_command_ledger_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'gpr2_command_ledger is append-only' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.result IS NOT NULL THEN
        RAISE EXCEPTION 'gpr2_command_ledger: a completed command is immutable' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.actor_id <> OLD.actor_id OR NEW.command_kind <> OLD.command_kind
       OR NEW.scope_id <> OLD.scope_id OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.fingerprint <> OLD.fingerprint OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'gpr2_command_ledger: only the result may be written onto a claim' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER gpr2_command_ledger_guard BEFORE UPDATE OR DELETE ON gpr2_command_ledger FOR EACH ROW EXECUTE FUNCTION gpr2_command_ledger_guard();

CREATE FUNCTION gpr2_command_ledger_completed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE done boolean;
BEGIN
    SELECT (result IS NOT NULL) INTO done FROM gpr2_command_ledger WHERE id = NEW.id;
    IF done IS NOT TRUE THEN
        RAISE EXCEPTION 'gpr2_command_ledger: a command was committed without a result' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER gpr2_command_ledger_completed AFTER INSERT OR UPDATE ON gpr2_command_ledger DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION gpr2_command_ledger_completed();
