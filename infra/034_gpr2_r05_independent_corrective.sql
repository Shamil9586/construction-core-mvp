-- migration-class: additive
-- GPR-2 R05 independent-acceptance corrective — closes R05-IND-NEW-01 … NEW-04 (INDEPENDENT_ACCEPTANCE_REPORT, FINDINGS_REGISTER of 24.10.2026) in
-- PostgreSQL without editing 029–033. (NEW-05 is a generation-preview rule in packages/domain/gpr2/r05.ts; it needs no schema.)
--
-- ADDITIVE ONLY: three new tables (empty when created), new functions and triggers, and a precondition check that refuses to apply over data that
-- already breaks one of the four invariants (no row is repaired, moved or invented — the run fails and rolls back). No existing table, column, index,
-- function or row is changed. Works / WEU / QuantityPortion / confirmations / progress / history are not written.
--
-- The common cause of all four findings: a guard read committed rows and relied on a LOCK of a row nobody modifies. Under REPEATABLE READ a lock on an
-- unmodified row does not refresh the snapshot, so the waiting transaction re-checks against the old state and passes. Every protocol below therefore
-- makes the two competing operations WRITE the same row:
--   READ COMMITTED     the second operation waits for the first, then its guard (a new statement, a new snapshot) sees the committed row and decides;
--   REPEATABLE READ    the second operation's write meets a row version committed after its snapshot: 40001 serialization_failure, never a silent pass.
--                      A retry runs in a new snapshot and gets the business answer.
--
-- NEW-01  sibling AreaScope measures.     object_area_scope_child_revisions: one row per parent; every child INSERT writes it FIRST (before 030's sum).
--                                         Children are only ever added with a quantity (a measure is immutable; ACTIVE -> RETIRED only lowers the sum),
--                                         so serialising child inserts per parent is the complete protocol.
-- NEW-02  one Work = one operation.       work_scope_operations: one row per producing Work, PRIMARY KEY (tenant, work): its (finish type, occurrence key).
--                                         Every producer binding claims it (INSERT … ON CONFLICT DO NOTHING) and compares; the same operation over several
--                                         disjoint AreaScopes passes, a second operation is refused. Bindings older than 034 have no claim row: they are
--                                         compared directly (they are committed, hence visible).
-- NEW-03  retirement vs producer.         The binding locks its AreaScope FOR SHARE and re-checks lifecycle on the locked row; ACTIVE -> RETIRED writes the
--                                         object's work_scope_state row, which every binding also writes (032), and then 032's producer guard decides.
-- NEW-04  WorkType unit vs references.    work_type_reference_state: one row per WorkType, `referenced` set by the FIRST Work / WEU / template stage /
--                                         stage occurrence that names the type (later references find it set and write nothing — no contention). Every
--                                         reference locks the WorkType row FOR SHARE; stages / occurrences re-check their measure unit on the locked row. A
--                                         unit change writes the same row and is refused when the type is referenced (029 / 031 refuse it on existing
--                                         rows as before). No unit is ever rewritten and nothing is converted.
-- Lock order (no inversion): AreaScope -> finish type -> operation claim -> Work -> WorkType -> work_scope_state for a binding; child revision ->
-- parent AreaScope for a child; AreaScope -> work_scope_state for a retirement; WorkType -> reference state for a unit change.

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Precondition: the data this migration starts from satisfies the four invariants (a database written by an earlier candidate under the race may not).
DO $$
DECLARE n bigint;
BEGIN
    SELECT count(*) INTO n FROM object_area_scopes p
     WHERE p.measure_quantity IS NOT NULL
       AND (SELECT coalesce(sum(c.measure_quantity), 0) FROM object_area_scopes c
             WHERE c.tenant_id = p.tenant_id AND c.object_id = p.object_id AND c.parent_id = p.id AND c.lifecycle = 'ACTIVE' AND c.measure_unit = p.measure_unit) > p.measure_quantity;
    IF n > 0 THEN
        RAISE EXCEPTION 'GPR2_R05:PRECONDITION % AreaScope(s) whose active children measure more than the AreaScope (NEW-01); resolve them before 034', n USING ERRCODE = 'check_violation';
    END IF;
    SELECT count(*) INTO n FROM (SELECT b.tenant_id, b.work_id FROM work_scope_bindings b WHERE b.binding_state = 'ACTIVE'
                                  GROUP BY b.tenant_id, b.work_id HAVING count(DISTINCT (b.finish_type_id, b.occurrence_key)) > 1) x;
    IF n > 0 THEN
        RAISE EXCEPTION 'GPR2_R05:PRECONDITION % Work(s) producing more than one operation (NEW-02); resolve them before 034', n USING ERRCODE = 'check_violation';
    END IF;
    SELECT count(*) INTO n FROM work_scope_bindings b JOIN object_area_scopes a ON a.tenant_id = b.tenant_id AND a.id = b.area_scope_id
     WHERE b.binding_state = 'ACTIVE' AND a.lifecycle <> 'ACTIVE';
    IF n > 0 THEN
        RAISE EXCEPTION 'GPR2_R05:PRECONDITION % active producer binding(s) on a retired AreaScope (NEW-03); resolve them before 034', n USING ERRCODE = 'check_violation';
    END IF;
    SELECT count(*) INTO n FROM (
        SELECT s.tenant_id FROM finish_template_stages s JOIN work_types t ON t.tenant_id = s.tenant_id AND t.id = s.work_type_id WHERE s.measure_unit IS DISTINCT FROM t.unit
        UNION ALL
        SELECT o.tenant_id FROM finish_stage_occurrences o JOIN work_types t ON t.tenant_id = o.tenant_id AND t.id = o.work_type_id WHERE o.measure_unit IS DISTINCT FROM t.unit) x;
    IF n > 0 THEN
        RAISE EXCEPTION 'GPR2_R05:PRECONDITION % template stage(s) / occurrence(s) measuring in another unit than their WorkType (NEW-04); resolve them before 034', n USING ERRCODE = 'check_violation';
    END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- NEW-01
CREATE TABLE object_area_scope_child_revisions(
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    object_id uuid NOT NULL,
    parent_id uuid NOT NULL,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, parent_id),
    FOREIGN KEY (tenant_id, object_id, parent_id) REFERENCES object_area_scopes(tenant_id, object_id, id)
);

CREATE FUNCTION gpr2_area_scope_child_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    -- runs before 030's gpr2_area_scope_guard (name order): the sum it computes is then never older than the last committed sibling
    INSERT INTO object_area_scope_child_revisions AS r (tenant_id, object_id, parent_id) VALUES (NEW.tenant_id, NEW.object_id, NEW.parent_id)
    ON CONFLICT (tenant_id, parent_id) DO UPDATE SET revision = r.revision + 1, updated_at = now();
    RETURN NEW;
END $$;
CREATE TRIGGER gpr2_area_scope_child_fence BEFORE INSERT ON object_area_scopes FOR EACH ROW WHEN (NEW.parent_id IS NOT NULL)
    EXECUTE FUNCTION gpr2_area_scope_child_fence();

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- NEW-02
CREATE TABLE work_scope_operations(
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    object_id uuid NOT NULL,
    work_id uuid NOT NULL,
    finish_type_id uuid NOT NULL,
    occurrence_key text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, work_id),
    FOREIGN KEY (tenant_id, work_id) REFERENCES works(tenant_id, id),
    FOREIGN KEY (tenant_id, object_id, finish_type_id) REFERENCES object_finish_types(tenant_id, object_id, id)
);
CREATE TRIGGER work_scope_operations_immutable BEFORE UPDATE OR DELETE ON work_scope_operations FOR EACH ROW EXECUTE FUNCTION immutable_history();

CREATE FUNCTION gpr2_binding_operation_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE op record;
BEGIN
    INSERT INTO work_scope_operations(tenant_id, object_id, work_id, finish_type_id, occurrence_key)
    VALUES (NEW.tenant_id, NEW.object_id, NEW.work_id, NEW.finish_type_id, NEW.occurrence_key)
    ON CONFLICT (tenant_id, work_id) DO NOTHING;
    SELECT object_id, finish_type_id, occurrence_key INTO op FROM work_scope_operations WHERE tenant_id = NEW.tenant_id AND work_id = NEW.work_id;
    IF op.object_id IS DISTINCT FROM NEW.object_id OR op.finish_type_id IS DISTINCT FROM NEW.finish_type_id OR op.occurrence_key IS DISTINCT FROM NEW.occurrence_key THEN
        RAISE EXCEPTION 'GPR2_R05:ONE_PRODUCER_CONFLICT a Work produces one operation (one finish type and occurrence key)' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM work_scope_bindings b WHERE b.tenant_id = NEW.tenant_id AND b.work_id = NEW.work_id AND b.binding_state = 'ACTIVE'
                  AND (b.finish_type_id <> NEW.finish_type_id OR b.occurrence_key <> NEW.occurrence_key)) THEN
        RAISE EXCEPTION 'GPR2_R05:ONE_PRODUCER_CONFLICT a Work produces one operation (one finish type and occurrence key)' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
-- name order on work_scope_bindings: gpr2_binding_area_lock, gpr2_binding_guard (032), gpr2_binding_operation_claim, gpr2_binding_work_lock (033)
CREATE TRIGGER gpr2_binding_operation_claim BEFORE INSERT ON work_scope_bindings FOR EACH ROW EXECUTE FUNCTION gpr2_binding_operation_claim();

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- NEW-03
CREATE FUNCTION gpr2_binding_area_lock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a record;
BEGIN
    SELECT lifecycle INTO a FROM object_area_scopes WHERE tenant_id = NEW.tenant_id AND object_id = NEW.object_id AND id = NEW.area_scope_id FOR SHARE;
    IF NOT FOUND OR a.lifecycle IS DISTINCT FROM 'ACTIVE' THEN
        RAISE EXCEPTION 'GPR2_R05:AREA_SCOPE_CONFLICT a retired AreaScope takes no producer' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER gpr2_binding_area_lock BEFORE INSERT ON work_scope_bindings FOR EACH ROW EXECUTE FUNCTION gpr2_binding_area_lock();

CREATE FUNCTION gpr2_area_scope_lifecycle_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    -- the row every producer binding of this object writes (032 gpr2_bump_scope_version); 032's gpr2_area_scope_producer_guard decides after it
    INSERT INTO work_scope_state AS s (tenant_id, object_id, scope_version) VALUES (OLD.tenant_id, OLD.object_id, 1)
    ON CONFLICT (tenant_id, object_id) DO UPDATE SET scope_version = s.scope_version + 1, updated_at = now();
    RETURN NEW;
END $$;
CREATE TRIGGER gpr2_area_scope_lifecycle_fence BEFORE UPDATE OF lifecycle ON object_area_scopes FOR EACH ROW
    WHEN (OLD.lifecycle = 'ACTIVE' AND NEW.lifecycle = 'RETIRED') EXECUTE FUNCTION gpr2_area_scope_lifecycle_fence();

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- NEW-04
CREATE TABLE work_type_reference_state(
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    work_type_id uuid NOT NULL,
    referenced boolean NOT NULL DEFAULT false,
    unit_revision bigint NOT NULL DEFAULT 0 CHECK (unit_revision >= 0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, work_type_id),
    FOREIGN KEY (tenant_id, work_type_id) REFERENCES work_types(tenant_id, id)
);

-- Works and execution units: the reference itself (their own unit is not compared — legacy Works keep the unit they were created with).
CREATE FUNCTION gpr2_work_type_reference_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s record;
BEGIN
    PERFORM 1 FROM work_types WHERE tenant_id = NEW.tenant_id AND id = NEW.work_type_id FOR SHARE;
    IF NOT FOUND THEN
        RETURN NEW; -- the foreign key refuses it
    END IF;
    SELECT referenced INTO s FROM work_type_reference_state WHERE tenant_id = NEW.tenant_id AND work_type_id = NEW.work_type_id;
    IF s.referenced IS DISTINCT FROM true THEN
        INSERT INTO work_type_reference_state AS r (tenant_id, work_type_id, referenced) VALUES (NEW.tenant_id, NEW.work_type_id, true)
        ON CONFLICT (tenant_id, work_type_id) DO UPDATE SET referenced = true, updated_at = now();
    END IF;
    RETURN NEW;
END $$;
-- Template stages and stage occurrences: the same, plus their measure unit against the LOCKED WorkType row.
CREATE FUNCTION gpr2_measured_reference_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t record; s record;
BEGIN
    SELECT unit INTO t FROM work_types WHERE tenant_id = NEW.tenant_id AND id = NEW.work_type_id FOR SHARE;
    IF NOT FOUND THEN
        RETURN NEW;
    END IF;
    IF NEW.measure_unit IS DISTINCT FROM t.unit THEN
        RAISE EXCEPTION 'GPR2_R05:INVALID_MEASUREMENT a stage measures in its WorkType''s unit' USING ERRCODE = 'check_violation';
    END IF;
    SELECT referenced INTO s FROM work_type_reference_state WHERE tenant_id = NEW.tenant_id AND work_type_id = NEW.work_type_id;
    IF s.referenced IS DISTINCT FROM true THEN
        INSERT INTO work_type_reference_state AS r (tenant_id, work_type_id, referenced) VALUES (NEW.tenant_id, NEW.work_type_id, true)
        ON CONFLICT (tenant_id, work_type_id) DO UPDATE SET referenced = true, updated_at = now();
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER gpr2_work_type_reference_fence BEFORE INSERT ON works FOR EACH ROW EXECUTE FUNCTION gpr2_work_type_reference_fence();
CREATE TRIGGER gpr2_work_type_reference_fence_change BEFORE UPDATE OF work_type_id ON works FOR EACH ROW
    WHEN (OLD.work_type_id IS DISTINCT FROM NEW.work_type_id) EXECUTE FUNCTION gpr2_work_type_reference_fence();
CREATE TRIGGER gpr2_work_type_reference_fence BEFORE INSERT ON work_execution_units FOR EACH ROW EXECUTE FUNCTION gpr2_work_type_reference_fence();
CREATE TRIGGER gpr2_work_type_reference_fence_change BEFORE UPDATE OF work_type_id ON work_execution_units FOR EACH ROW
    WHEN (OLD.work_type_id IS DISTINCT FROM NEW.work_type_id) EXECUTE FUNCTION gpr2_work_type_reference_fence();
CREATE TRIGGER gpr2_measured_reference_fence BEFORE INSERT OR UPDATE OF work_type_id, measure_unit ON finish_template_stages FOR EACH ROW EXECUTE FUNCTION gpr2_measured_reference_fence();
CREATE TRIGGER gpr2_measured_reference_fence BEFORE INSERT OR UPDATE OF work_type_id, measure_unit ON finish_stage_occurrences FOR EACH ROW EXECUTE FUNCTION gpr2_measured_reference_fence();

CREATE FUNCTION gpr2_work_type_unit_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE was_referenced boolean;
BEGIN
    INSERT INTO work_type_reference_state AS r (tenant_id, work_type_id, unit_revision) VALUES (OLD.tenant_id, OLD.id, 1)
    ON CONFLICT (tenant_id, work_type_id) DO UPDATE SET unit_revision = r.unit_revision + 1, updated_at = now()
    RETURNING referenced INTO was_referenced;
    IF was_referenced THEN
        RAISE EXCEPTION 'GPR2_R05:UNIT_IMMUTABLE the unit of a referenced WorkType cannot change' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER gpr2_work_type_unit_fence BEFORE UPDATE OF unit ON work_types FOR EACH ROW WHEN (OLD.unit IS DISTINCT FROM NEW.unit)
    EXECUTE FUNCTION gpr2_work_type_unit_fence();
