-- migration-class: additive
-- GPR-2 R05d — Work generation from an object finish system: the object scope version and the one-producer binding
-- (Technical Design §4.1, §5.2 `work_scope_state` / `work_scope_bindings`, §11.1, §12.2–12.4; decisions D01, D06, D09; scenarios A01, A07, A12, A30).
--
-- ADDITIVE ONLY: two new tables, triggers and indexes. No existing Work, WEU, portion, fact or confirmation is written. Generation creates NEW real Works
-- (the same `works` table, no second planning entity) and binds each to the atomic production obligation it produces.
--
--   work_scope_state      one row per object, created on first use: scope_version, the token `expectedScopeVersion` is checked against (TD §12.2).
--                         It is moved by PostgreSQL, not by the application: every Work inserted into an object and every producer binding bumps it,
--                         whatever path the insert comes from (legacy POST /works, R05 confirm, seed). An object without a row has scope version 0.
--   work_scope_bindings   Work + stage occurrence + AreaScope (+ finish type, occurrence key, source version, basis quantity, command). One row = one
--                         atomic production obligation (finish type, occurrence key, leaf AreaScope) and the Work that produces it.
--
-- ONE ACTIVE PRODUCER PER ATOMIC OBLIGATION is a PostgreSQL guarantee, not an API pre-check:
--   * a UNIQUE index on (tenant, object, finish type, occurrence key, AreaScope): a second producer of the same obligation cannot be inserted;
--   * a trigger refuses a producer whose AreaScope is an ancestor or a descendant of an AreaScope already produced for the same (finish type, occurrence
--     key) — the parent and its child would count the same space twice. It runs under a row lock on the finish type, so two concurrent inserts are checked
--     one after the other;
--   * the Work must be a Work of the same object whose WorkType and unit are the occurrence's, a new Work (no execution unit, no legacy fact, no
--     legacy classification: a historical Work is never re-bound or split by generation), and a Work produces ONE operation (one finish type and
--     occurrence key); the occurrence's version must be PUBLISHED and belong to the same finish type;
--   * bindings are append-only. Replacing a producer (reuse, finish change) is R09 and needs its own migration; an AreaScope with a producer is not retired.
-- Different finish types are different obligations even for the same WorkType (Тип №1 «Штукатурка» and Тип №2 «Штукатурка» are never merged).

CREATE TABLE work_scope_state(
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    object_id uuid NOT NULL,
    scope_version bigint NOT NULL DEFAULT 0 CHECK (scope_version >= 0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, object_id),
    FOREIGN KEY (tenant_id, object_id) REFERENCES objects(tenant_id, id)
);

CREATE FUNCTION gpr2_bump_scope_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO work_scope_state AS s (tenant_id, object_id, scope_version) VALUES (NEW.tenant_id, NEW.object_id, 1)
    ON CONFLICT (tenant_id, object_id) DO UPDATE SET scope_version = s.scope_version + 1, updated_at = now();
    RETURN NULL;
END $$;
CREATE TRIGGER gpr2_bump_scope_version AFTER INSERT ON works FOR EACH ROW EXECUTE FUNCTION gpr2_bump_scope_version();

CREATE TABLE work_scope_bindings(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    object_id uuid NOT NULL,
    work_id uuid NOT NULL,
    finish_type_id uuid NOT NULL,
    system_version_id uuid NOT NULL,
    occurrence_id uuid NOT NULL,
    occurrence_key text NOT NULL,
    area_scope_id uuid NOT NULL,
    measure_scope text NOT NULL CHECK (measure_scope IN ('MAIN','LOCAL')),
    -- the measure this obligation was generated from (the leaf's main measure, or the stated local quantity) — provenance, not an allocation (R06)
    basis_quantity numeric(24,4) NOT NULL CHECK (basis_quantity > 0),
    binding_role text NOT NULL DEFAULT 'PRODUCER' CHECK (binding_role = 'PRODUCER'),
    binding_state text NOT NULL DEFAULT 'ACTIVE' CHECK (binding_state = 'ACTIVE'),
    command_id uuid NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(tenant_id, id),
    UNIQUE(tenant_id, object_id, id),
    FOREIGN KEY (tenant_id, object_id, work_id) REFERENCES works(tenant_id, object_id, id),
    FOREIGN KEY (tenant_id, object_id, finish_type_id, system_version_id) REFERENCES object_finish_system_versions(tenant_id, object_id, finish_type_id, id),
    FOREIGN KEY (tenant_id, object_id, system_version_id, occurrence_id) REFERENCES finish_stage_occurrences(tenant_id, object_id, system_version_id, id),
    FOREIGN KEY (tenant_id, object_id, area_scope_id) REFERENCES object_area_scopes(tenant_id, object_id, id),
    FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id)
);
CREATE UNIQUE INDEX work_scope_bindings_one_producer ON work_scope_bindings(tenant_id, object_id, finish_type_id, occurrence_key, area_scope_id) WHERE binding_role = 'PRODUCER' AND binding_state = 'ACTIVE';
CREATE INDEX work_scope_bindings_work_idx ON work_scope_bindings(tenant_id, work_id);
CREATE INDEX work_scope_bindings_area_idx ON work_scope_bindings(tenant_id, object_id, area_scope_id);
CREATE TRIGGER work_scope_bindings_immutable BEFORE UPDATE OR DELETE ON work_scope_bindings FOR EACH ROW EXECUTE FUNCTION immutable_history();
CREATE TRIGGER gpr2_bump_scope_version AFTER INSERT ON work_scope_bindings FOR EACH ROW EXECUTE FUNCTION gpr2_bump_scope_version();

CREATE FUNCTION gpr2_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE occ record; v record; w record; a record;
BEGIN
    -- serialise every producer insert of one finish type (the overlap check below reads other rows)
    PERFORM 1 FROM object_finish_types WHERE tenant_id = NEW.tenant_id AND object_id = NEW.object_id AND id = NEW.finish_type_id FOR NO KEY UPDATE;
    SELECT state INTO v FROM object_finish_system_versions WHERE tenant_id = NEW.tenant_id AND id = NEW.system_version_id;
    IF v.state IS DISTINCT FROM 'PUBLISHED' THEN
        RAISE EXCEPTION 'GPR2_R05:STALE_SOURCE_VERSION a producer is generated only from a published finish-system version' USING ERRCODE = 'check_violation';
    END IF;
    SELECT occurrence_key, work_type_id, measure_unit, measure_scope INTO occ FROM finish_stage_occurrences WHERE tenant_id = NEW.tenant_id AND id = NEW.occurrence_id;
    IF occ.occurrence_key IS DISTINCT FROM NEW.occurrence_key OR occ.measure_scope IS DISTINCT FROM NEW.measure_scope THEN
        RAISE EXCEPTION 'GPR2_R05:CROSS_SCOPE_REFERENCE the binding names its occurrence''s own key and measure scope' USING ERRCODE = 'check_violation';
    END IF;
    SELECT lifecycle INTO a FROM object_area_scopes WHERE tenant_id = NEW.tenant_id AND id = NEW.area_scope_id;
    IF a.lifecycle IS DISTINCT FROM 'ACTIVE' THEN
        RAISE EXCEPTION 'GPR2_R05:AREA_SCOPE_CONFLICT a retired AreaScope takes no producer' USING ERRCODE = 'check_violation';
    END IF;
    SELECT work_type_id, unit, actual_quantity INTO w FROM works WHERE tenant_id = NEW.tenant_id AND object_id = NEW.object_id AND id = NEW.work_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'GPR2_R05:CROSS_SCOPE_REFERENCE the producing Work belongs to the same object' USING ERRCODE = 'check_violation';
    END IF;
    IF w.work_type_id IS DISTINCT FROM occ.work_type_id OR w.unit IS DISTINCT FROM occ.measure_unit THEN
        RAISE EXCEPTION 'GPR2_R05:INVALID_MEASUREMENT the producing Work has the occurrence''s WorkType and unit' USING ERRCODE = 'check_violation';
    END IF;
    IF w.actual_quantity <> 0
       OR EXISTS (SELECT 1 FROM work_execution_units u WHERE u.tenant_id = NEW.tenant_id AND u.object_work_id = NEW.work_id)
       OR EXISTS (SELECT 1 FROM work_progress p WHERE p.tenant_id = NEW.tenant_id AND p.object_work_id = NEW.work_id)
       OR EXISTS (SELECT 1 FROM legacy_work_classifications c WHERE c.tenant_id = NEW.tenant_id AND c.work_id = NEW.work_id) THEN
        RAISE EXCEPTION 'GPR2_R05:HISTORICAL_WORK a Work with execution units, facts or a legacy classification is never bound by generation' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM work_scope_bindings b WHERE b.tenant_id = NEW.tenant_id AND b.work_id = NEW.work_id
               AND (b.finish_type_id <> NEW.finish_type_id OR b.occurrence_key <> NEW.occurrence_key)) THEN
        RAISE EXCEPTION 'GPR2_R05:ONE_PRODUCER_CONFLICT a Work produces one operation (one finish type and occurrence)' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (
        WITH RECURSIVE up AS (
            SELECT parent_id AS id FROM object_area_scopes WHERE tenant_id = NEW.tenant_id AND id = NEW.area_scope_id
            UNION ALL SELECT s.parent_id FROM object_area_scopes s JOIN up ON s.id = up.id WHERE s.tenant_id = NEW.tenant_id AND s.parent_id IS NOT NULL
        ), down AS (
            SELECT id FROM object_area_scopes WHERE tenant_id = NEW.tenant_id AND parent_id = NEW.area_scope_id
            UNION ALL SELECT s.id FROM object_area_scopes s JOIN down ON s.parent_id = down.id WHERE s.tenant_id = NEW.tenant_id
        )
        SELECT 1 FROM work_scope_bindings b
         WHERE b.tenant_id = NEW.tenant_id AND b.object_id = NEW.object_id AND b.finish_type_id = NEW.finish_type_id AND b.occurrence_key = NEW.occurrence_key
           AND b.binding_state = 'ACTIVE' AND (b.area_scope_id IN (SELECT id FROM up WHERE id IS NOT NULL) OR b.area_scope_id IN (SELECT id FROM down))) THEN
        RAISE EXCEPTION 'GPR2_R05:ONE_PRODUCER_CONFLICT the AreaScope overlaps one already produced for this obligation (ancestor or descendant)' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER gpr2_binding_guard BEFORE INSERT ON work_scope_bindings FOR EACH ROW EXECUTE FUNCTION gpr2_binding_guard();

-- An AreaScope that carries a producer is not retired (its obligation would lose its place).
CREATE FUNCTION gpr2_area_scope_producer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.lifecycle = 'ACTIVE' AND NEW.lifecycle = 'RETIRED' AND EXISTS (
            SELECT 1 FROM work_scope_bindings b WHERE b.tenant_id = OLD.tenant_id AND b.area_scope_id = OLD.id AND b.binding_state = 'ACTIVE') THEN
        RAISE EXCEPTION 'GPR2_R05:AREA_SCOPE_CONFLICT an AreaScope with an active producer cannot be retired' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER gpr2_area_scope_producer_guard BEFORE UPDATE OF lifecycle ON object_area_scopes FOR EACH ROW EXECUTE FUNCTION gpr2_area_scope_producer_guard();
