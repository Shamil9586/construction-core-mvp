-- migration-class: additive
-- R06a: additive identity and initial quantity ledger only. No historical Work rows are populated or rewritten.
-- Current pointer has no R06a mutation route; future quantity changes require the R06b allocation model and R07 approval.

CREATE UNIQUE INDEX works_r06a_object_identity ON works(tenant_id, object_id, id);

CREATE TABLE work_quantity_origins (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    object_id uuid NOT NULL,
    work_id uuid NOT NULL,
    source_kind text NOT NULL CHECK (source_kind IN ('MANUAL_CREATE','FINISH_GENERATION','LEGACY_UNVERIFIED')),
    source_ref text,
    source_version text,
    provenance_status text NOT NULL CHECK (provenance_status IN ('PROVEN_CREATION','UNKNOWN_LEGACY')),
    original_quantity numeric(24,4),
    observed_current_quantity numeric(24,4),
    unit text NOT NULL CHECK (length(btrim(unit)) > 0),
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(tenant_id, object_id, id),
    UNIQUE(tenant_id, object_id, work_id),
    CHECK ((provenance_status='PROVEN_CREATION' AND source_kind<>'LEGACY_UNVERIFIED' AND original_quantity IS NOT NULL AND original_quantity>=0 AND observed_current_quantity IS NULL)
        OR (provenance_status='UNKNOWN_LEGACY' AND source_kind='LEGACY_UNVERIFIED' AND original_quantity IS NULL AND (observed_current_quantity IS NULL OR observed_current_quantity>=0))),
    FOREIGN KEY(tenant_id,object_id,work_id) REFERENCES works(tenant_id,object_id,id) ON DELETE RESTRICT,
    FOREIGN KEY(tenant_id,created_by) REFERENCES users(tenant_id,id)
);

CREATE TABLE work_quantity_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    object_id uuid NOT NULL,
    work_id uuid NOT NULL,
    sequence int NOT NULL CHECK (sequence>=1),
    quantity numeric(24,4) NOT NULL CHECK (quantity>=0),
    unit text NOT NULL CHECK (length(btrim(unit)) > 0),
    source_kind text NOT NULL CHECK (source_kind IN ('INITIAL_CREATION','OBSERVED_LEGACY','APPROVED_REQUEST')),
    approved_request_id uuid,
    previous_id uuid,
    created_by uuid NOT NULL,
    effective_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(tenant_id,object_id,id),
    UNIQUE(tenant_id,object_id,work_id,id),
    UNIQUE(tenant_id,object_id,work_id,sequence),
    CHECK ((sequence=1 AND previous_id IS NULL AND source_kind<>'APPROVED_REQUEST' AND approved_request_id IS NULL)
        OR (sequence>1 AND previous_id IS NOT NULL AND source_kind='APPROVED_REQUEST' AND approved_request_id IS NOT NULL)),
    FOREIGN KEY(tenant_id,object_id,work_id) REFERENCES work_quantity_origins(tenant_id,object_id,work_id) ON DELETE RESTRICT,
    FOREIGN KEY(tenant_id,object_id,work_id,previous_id) REFERENCES work_quantity_versions(tenant_id,object_id,work_id,id) ON DELETE RESTRICT,
    FOREIGN KEY(tenant_id,created_by) REFERENCES users(tenant_id,id)
);

CREATE TABLE work_current_quantity (
    tenant_id uuid NOT NULL,
    object_id uuid NOT NULL,
    work_id uuid NOT NULL,
    approved_version_id uuid NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(tenant_id,object_id,work_id),
    FOREIGN KEY(tenant_id,created_by) REFERENCES users(tenant_id,id),
    FOREIGN KEY(tenant_id,object_id,work_id,approved_version_id) REFERENCES work_quantity_versions(tenant_id,object_id,work_id,id) ON DELETE RESTRICT
);
CREATE INDEX work_quantity_versions_work_idx ON work_quantity_versions(tenant_id,object_id,work_id,sequence);

CREATE FUNCTION r06a_initial_quantity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_row record;
BEGIN
    IF TG_TABLE_NAME='work_quantity_origins' THEN
        IF NEW.provenance_status='PROVEN_CREATION' AND NOT EXISTS (
            SELECT 1 FROM works w WHERE w.tenant_id=NEW.tenant_id AND w.object_id=NEW.object_id AND w.id=NEW.work_id
              AND w.unit=NEW.unit AND w.planned_quantity=NEW.original_quantity) THEN
            RAISE EXCEPTION 'R06A: proven creation must match its Work quantity and unit' USING ERRCODE='23514';
        END IF;
    ELSE
        SELECT provenance_status,original_quantity,observed_current_quantity,unit INTO source_row FROM work_quantity_origins
          WHERE tenant_id=NEW.tenant_id AND object_id=NEW.object_id AND work_id=NEW.work_id;
        IF NEW.sequence=1 AND (source_row.unit IS DISTINCT FROM NEW.unit OR
            (NEW.source_kind='INITIAL_CREATION' AND (source_row.provenance_status IS DISTINCT FROM 'PROVEN_CREATION' OR source_row.original_quantity IS DISTINCT FROM NEW.quantity)) OR
            (NEW.source_kind='OBSERVED_LEGACY' AND (source_row.provenance_status IS DISTINCT FROM 'UNKNOWN_LEGACY' OR source_row.observed_current_quantity IS DISTINCT FROM NEW.quantity))) THEN
            RAISE EXCEPTION 'R06A: initial version must match its origin or observed current' USING ERRCODE='23514';
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER r06a_origin_initial_guard BEFORE INSERT ON work_quantity_origins FOR EACH ROW EXECUTE FUNCTION r06a_initial_quantity_guard();
CREATE TRIGGER r06a_version_initial_guard BEFORE INSERT ON work_quantity_versions FOR EACH ROW EXECUTE FUNCTION r06a_initial_quantity_guard();

CREATE FUNCTION r06a_immutable_quantity_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'R06A: immutable quantity history' USING ERRCODE='23514';
END $$;
CREATE TRIGGER r06a_origin_immutable BEFORE UPDATE OR DELETE ON work_quantity_origins FOR EACH ROW EXECUTE FUNCTION r06a_immutable_quantity_row();
CREATE TRIGGER r06a_version_immutable BEFORE UPDATE OR DELETE ON work_quantity_versions FOR EACH ROW EXECUTE FUNCTION r06a_immutable_quantity_row();
