-- migration-class: additive
-- GPR-2 R02 — persisted fact source mode and monotonic confirmation sequence (Technical Design §5.2, §12.1; decisions C13, C15).
--
-- ADDITIVE ONLY. No existing row is rewritten, classified or reordered:
--   * works.fact_source_mode is added NULL, with NO default. NULL = "never classified": the Work is read from its evidence by the one resolver
--     (packages/domain/gpr2/fact-resolver.ts) and flagged DERIVED_UNCLASSIFIED. Classifying real Works, and enabling the persisted mode for them,
--     is R19 after the live inventory (Roadmap R02 "LIVE gate"); this migration classifies nothing and no code path in R02 writes the column except
--     the guarded LEGACY_WORK -> PORTION edge below, which only an explicitly classified Work can reach. A default here would classify every future
--     Work implicitly — the kind of silent decision this stage exists to remove.
--   * portion_quantity_confirmations.confirmation_seq is added NULL and is NOT back-filled: numbering the legacy rows would invent an order
--     between rows whose order cannot be proven (§12.1: "Legacy точные ties, которые нельзя доказательно упорядочить, помечаются ambiguity").
--     Only confirmations written after this migration take a number from the sequence.
--   * work_fact_source_mode_history is new and empty.
-- The existing immutability trigger on portion_quantity_confirmations fires on UPDATE/DELETE only, so adding a column does not touch it.
--
-- Lock budget (for the release plan, R22): ADD COLUMN and SET DEFAULT without a volatile default are catalogue-only. The CHECK is added
-- NOT VALID and validated separately (SHARE UPDATE EXCLUSIVE, writes continue). The partial unique index is built over a column that is
-- NULL in every existing row; it takes a SHARE lock for the duration of one scan of portion_quantity_confirmations.

ALTER TABLE works ADD COLUMN fact_source_mode text;
ALTER TABLE works ADD CONSTRAINT works_fact_source_mode_check CHECK (fact_source_mode IS NULL OR fact_source_mode IN ('LEGACY_WORK','PORTION')) NOT VALID;
ALTER TABLE works VALIDATE CONSTRAINT works_fact_source_mode_check;

CREATE SEQUENCE portion_confirmation_seq AS bigint;
ALTER TABLE portion_quantity_confirmations ADD COLUMN confirmation_seq bigint;
ALTER TABLE portion_quantity_confirmations ALTER COLUMN confirmation_seq SET DEFAULT nextval('portion_confirmation_seq');
CREATE UNIQUE INDEX portion_confirmations_seq_uq ON portion_quantity_confirmations(confirmation_seq) WHERE confirmation_seq IS NOT NULL;

-- The append-only record of every change of a Work's fact source mode. It is written by the trigger below, not by the application, so no code
-- path can change a mode without leaving the row (and the row is what the known-at resolver reads to learn when a Work became PORTION).
CREATE TABLE work_fact_source_mode_history(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    work_id uuid NOT NULL,
    from_mode text CHECK(from_mode IS NULL OR from_mode IN ('LEGACY_WORK','PORTION')),  -- NULL: the Work was classified (R19), not switched
    to_mode text NOT NULL CHECK(to_mode IN ('LEGACY_WORK','PORTION')),
    basis text NOT NULL,
    changed_by uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version int NOT NULL DEFAULT 1,
    UNIQUE(tenant_id,id),
    FOREIGN KEY(tenant_id,work_id) REFERENCES works(tenant_id,id),
    FOREIGN KEY(tenant_id,changed_by) REFERENCES users(tenant_id,id)
);
CREATE INDEX work_fact_source_mode_history_work_idx ON work_fact_source_mode_history(tenant_id,work_id,created_at);
CREATE TRIGGER work_fact_source_mode_history_immutable BEFORE UPDATE OR DELETE ON work_fact_source_mode_history FOR EACH ROW EXECUTE FUNCTION immutable_history();

-- The one edge: LEGACY_WORK -> PORTION, and only for a Work that provably carries no legacy fact. Every other change of the column is refused:
-- an unclassified Work (NULL) is classified only by the R19 reconciliation, PORTION never goes back, and nothing is ever set to NULL.
CREATE FUNCTION works_fact_source_mode_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.fact_source_mode IS NOT DISTINCT FROM OLD.fact_source_mode THEN
        RETURN NEW;
    END IF;
    IF OLD.fact_source_mode = 'LEGACY_WORK' AND NEW.fact_source_mode = 'PORTION' THEN
        IF NEW.actual_quantity <> 0 OR EXISTS (SELECT 1 FROM work_progress p WHERE p.tenant_id = NEW.tenant_id AND p.object_work_id = NEW.id) THEN
            RAISE EXCEPTION 'fact_source_mode: a Work with a legacy fact cannot take the portion source (LEGACY_FACT_PRESENT)' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'fact_source_mode: % -> % is not a permitted change', COALESCE(OLD.fact_source_mode, 'NULL'), COALESCE(NEW.fact_source_mode, 'NULL') USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER works_fact_source_mode_guard BEFORE UPDATE OF fact_source_mode ON works FOR EACH ROW EXECUTE FUNCTION works_fact_source_mode_guard();

CREATE FUNCTION works_fact_source_mode_record() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor uuid := NULLIF(current_setting('gpr2.actor', true), '')::uuid;
BEGIN
    INSERT INTO work_fact_source_mode_history(tenant_id, work_id, from_mode, to_mode, basis, changed_by)
    VALUES (NEW.tenant_id, NEW.id, OLD.fact_source_mode, NEW.fact_source_mode, COALESCE(NULLIF(current_setting('gpr2.basis', true), ''), 'UNSPECIFIED'), actor);
    RETURN NEW;
END $$;
CREATE TRIGGER works_fact_source_mode_record AFTER UPDATE OF fact_source_mode ON works FOR EACH ROW WHEN (NEW.fact_source_mode IS DISTINCT FROM OLD.fact_source_mode) EXECUTE FUNCTION works_fact_source_mode_record();
