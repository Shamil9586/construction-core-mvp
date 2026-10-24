-- migration-class: additive
-- GPR-2 R05b — the object finish registry, AreaScopes, legacy finish compatibility mapping and historical Work classification
-- (Technical Design §4.1, §5.2 `object_finish_types` / `legacy_finish_mappings` / `object_area_scopes` / `legacy_work_classifications`, §13.2 I05;
-- decisions D01, D03, D20, C02; scenarios A01, A03, A25).
--
-- ADDITIVE ONLY: four new tables, their guards and indexes. No existing row is read-and-rewritten, classified, mapped or split:
--   * the legacy tenant `finish_types` and every WEU's finish_type_id stay exactly as they are; they are reachable from an object ONLY through an explicit
--     legacy_finish_mappings row. No mapping is created by this migration and none is ever inferred from a name: an object without a mapping row reads
--     UNRESOLVED, an AMBIGUOUS mapping carries no target. Converting real legacy finish IDs is R19 after the LIVE inventory (Roadmap R05 LIVE gate);
--   * a historical (possibly mixed) Work keeps its id, WEUs, portions and facts. A legacy classification is a separate append-only record ABOUT the Work;
--     nothing here writes to works, work_execution_units, quantity_portions or confirmations, and nothing splits a Work.
--
-- What PostgreSQL guarantees:
--   * object_finish_types — the ONE active registry of finish types of an object: stable code unique per object (never reused, retired included),
--     identity immutable, lifecycle ACTIVE -> RETIRED only, never deleted;
--   * object_area_scopes — a flexible tree (any kind under any kind; no fixed building/section/floor hierarchy is imposed): parent in the SAME object by
--     composite FK, parent immutable (so the tree cannot become cyclic), code unique per object, measure immutable, and the children of a parent that
--     carries a measure can never add up to more of the SAME unit than the parent holds (no double counting of space; checked under a lock on the
--     parent row, so two concurrent children cannot both slip through). Never deleted; a parent with active children cannot be retired;
--   * legacy_finish_mappings / legacy_work_classifications — append-only; a correction is a new row that supersedes exactly one earlier row of the same
--     chain, so every (object, legacy finish) and every Work has at most one current record.

CREATE TABLE object_finish_types(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    object_id uuid NOT NULL,
    code text NOT NULL CHECK (code ~ '^[A-Za-z0-9А-Яа-яЁё][A-Za-z0-9А-Яа-яЁё_.-]{0,63}$'),
    name text NOT NULL CHECK (btrim(name) <> ''),
    lifecycle text NOT NULL DEFAULT 'ACTIVE' CHECK (lifecycle IN ('ACTIVE','RETIRED')),
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version int NOT NULL DEFAULT 1 CHECK (version > 0),
    UNIQUE(tenant_id, id),
    UNIQUE(tenant_id, object_id, id),
    FOREIGN KEY (tenant_id, object_id) REFERENCES objects(tenant_id, id),
    FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id)
);
CREATE UNIQUE INDEX object_finish_types_code_uq ON object_finish_types(tenant_id, object_id, code);

CREATE FUNCTION gpr2_object_finish_type_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'GPR2_R05:VERSION_IMMUTABLE an object finish type is never removed' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.object_id <> OLD.object_id OR NEW.code <> OLD.code OR NEW.created_by <> OLD.created_by
       OR NEW.created_at <> OLD.created_at OR (OLD.lifecycle = 'RETIRED' AND NEW.lifecycle <> 'RETIRED') THEN
        RAISE EXCEPTION 'GPR2_R05:VERSION_IMMUTABLE the identity of an object finish type is immutable' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER gpr2_object_finish_type_guard BEFORE UPDATE OR DELETE ON object_finish_types FOR EACH ROW EXECUTE FUNCTION gpr2_object_finish_type_guard();

CREATE TABLE object_area_scopes(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    object_id uuid NOT NULL,
    parent_id uuid,
    kind text NOT NULL CHECK (kind IN ('BUILDING','SECTION','FLOOR','ZONE','ROOM','SURFACE','OTHER')),
    code text NOT NULL CHECK (code ~ '^[A-Za-z0-9А-Яа-яЁё][A-Za-z0-9А-Яа-яЁё_.-]{0,63}$'),
    name text NOT NULL CHECK (btrim(name) <> ''),
    measure_quantity numeric(24,4) CHECK (measure_quantity > 0),
    measure_unit text,
    lifecycle text NOT NULL DEFAULT 'ACTIVE' CHECK (lifecycle IN ('ACTIVE','RETIRED')),
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version int NOT NULL DEFAULT 1 CHECK (version > 0),
    UNIQUE(tenant_id, id),
    UNIQUE(tenant_id, object_id, id),
    FOREIGN KEY (tenant_id, object_id) REFERENCES objects(tenant_id, id),
    -- the parent is an AreaScope of the SAME object: a cross-object (or cross-tenant) parent is impossible by key, not by convention
    FOREIGN KEY (tenant_id, object_id, parent_id) REFERENCES object_area_scopes(tenant_id, object_id, id),
    FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
    CHECK (parent_id IS NULL OR parent_id <> id),
    CHECK ((measure_quantity IS NULL) = (measure_unit IS NULL))
);
CREATE UNIQUE INDEX object_area_scopes_code_uq ON object_area_scopes(tenant_id, object_id, code);
CREATE INDEX object_area_scopes_parent_idx ON object_area_scopes(tenant_id, object_id, parent_id);

CREATE FUNCTION gpr2_area_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p record; used numeric;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'GPR2_R05:AREA_SCOPE_CONFLICT an AreaScope is never removed (it is a stable spatial identity)' USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW.lifecycle <> 'ACTIVE' THEN
            RAISE EXCEPTION 'GPR2_R05:AREA_SCOPE_CONFLICT an AreaScope is created active' USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.parent_id IS NOT NULL THEN
            -- the lock serialises siblings: two children inserted at once are checked one after the other
            SELECT * INTO p FROM object_area_scopes WHERE tenant_id = NEW.tenant_id AND object_id = NEW.object_id AND id = NEW.parent_id FOR NO KEY UPDATE;
            IF p.lifecycle <> 'ACTIVE' THEN
                RAISE EXCEPTION 'GPR2_R05:AREA_SCOPE_CONFLICT a retired AreaScope takes no children' USING ERRCODE = 'check_violation';
            END IF;
            IF p.measure_unit IS NOT NULL AND NEW.measure_unit = p.measure_unit THEN
                SELECT coalesce(sum(measure_quantity), 0) INTO used FROM object_area_scopes
                 WHERE tenant_id = NEW.tenant_id AND object_id = NEW.object_id AND parent_id = NEW.parent_id AND lifecycle = 'ACTIVE' AND measure_unit = p.measure_unit;
                IF used + NEW.measure_quantity > p.measure_quantity THEN
                    RAISE EXCEPTION 'GPR2_R05:AREA_SCOPE_CONFLICT the children of an AreaScope would measure more than the AreaScope itself' USING ERRCODE = 'check_violation';
                END IF;
            END IF;
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.object_id <> OLD.object_id OR NEW.parent_id IS DISTINCT FROM OLD.parent_id OR NEW.kind <> OLD.kind
       OR NEW.code <> OLD.code OR NEW.measure_quantity IS DISTINCT FROM OLD.measure_quantity OR NEW.measure_unit IS DISTINCT FROM OLD.measure_unit
       OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at OR (OLD.lifecycle = 'RETIRED' AND NEW.lifecycle <> 'RETIRED') THEN
        RAISE EXCEPTION 'GPR2_R05:AREA_SCOPE_CONFLICT the identity, place and measure of an AreaScope are immutable' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.lifecycle = 'ACTIVE' AND NEW.lifecycle = 'RETIRED' AND EXISTS (
            SELECT 1 FROM object_area_scopes c WHERE c.tenant_id = OLD.tenant_id AND c.object_id = OLD.object_id AND c.parent_id = OLD.id AND c.lifecycle = 'ACTIVE') THEN
        RAISE EXCEPTION 'GPR2_R05:AREA_SCOPE_CONFLICT an AreaScope with active children cannot be retired' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER gpr2_area_scope_guard BEFORE INSERT OR UPDATE OR DELETE ON object_area_scopes FOR EACH ROW EXECUTE FUNCTION gpr2_area_scope_guard();

CREATE TABLE legacy_finish_mappings(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    object_id uuid NOT NULL,
    legacy_finish_type_id uuid NOT NULL,
    resolution_state text NOT NULL CHECK (resolution_state IN ('UNRESOLVED','RESOLVED','AMBIGUOUS')),
    target_finish_type_id uuid,
    basis text NOT NULL CHECK (btrim(basis) <> ''),
    supersedes_mapping_id uuid,
    recorded_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(tenant_id, id),
    UNIQUE(tenant_id, object_id, id),
    FOREIGN KEY (tenant_id, object_id) REFERENCES objects(tenant_id, id),
    -- many objects may map the SAME legacy tenant finish id: the key is per object
    FOREIGN KEY (tenant_id, legacy_finish_type_id) REFERENCES finish_types(tenant_id, id),
    FOREIGN KEY (tenant_id, object_id, target_finish_type_id) REFERENCES object_finish_types(tenant_id, object_id, id),
    FOREIGN KEY (tenant_id, object_id, supersedes_mapping_id) REFERENCES legacy_finish_mappings(tenant_id, object_id, id),
    FOREIGN KEY (tenant_id, recorded_by) REFERENCES users(tenant_id, id),
    -- only a RESOLVED mapping names a target; UNRESOLVED and AMBIGUOUS never substitute one
    CHECK ((resolution_state = 'RESOLVED') = (target_finish_type_id IS NOT NULL))
);
CREATE UNIQUE INDEX legacy_finish_mappings_root_uq ON legacy_finish_mappings(tenant_id, object_id, legacy_finish_type_id) WHERE supersedes_mapping_id IS NULL;
CREATE UNIQUE INDEX legacy_finish_mappings_superseded_once ON legacy_finish_mappings(tenant_id, supersedes_mapping_id) WHERE supersedes_mapping_id IS NOT NULL;
CREATE TRIGGER legacy_finish_mappings_immutable BEFORE UPDATE OR DELETE ON legacy_finish_mappings FOR EACH ROW EXECUTE FUNCTION immutable_history();

CREATE TABLE legacy_work_classifications(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    object_id uuid NOT NULL,
    work_id uuid NOT NULL,
    classification text NOT NULL CHECK (classification IN ('SINGLE_FINISH','MIXED_FINISH','NON_FINISH','UNKNOWN')),
    -- what was observed when the record was made (legacy finish ids of the Work's units, counts) — evidence, never a value written back anywhere
    evidence jsonb NOT NULL,
    basis text NOT NULL CHECK (btrim(basis) <> ''),
    supersedes_classification_id uuid,
    recorded_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(tenant_id, id),
    UNIQUE(tenant_id, object_id, id),
    FOREIGN KEY (tenant_id, object_id, work_id) REFERENCES works(tenant_id, object_id, id),
    FOREIGN KEY (tenant_id, object_id, supersedes_classification_id) REFERENCES legacy_work_classifications(tenant_id, object_id, id),
    FOREIGN KEY (tenant_id, recorded_by) REFERENCES users(tenant_id, id)
);
CREATE UNIQUE INDEX legacy_work_classifications_root_uq ON legacy_work_classifications(tenant_id, work_id) WHERE supersedes_classification_id IS NULL;
CREATE UNIQUE INDEX legacy_work_classifications_superseded_once ON legacy_work_classifications(tenant_id, supersedes_classification_id) WHERE supersedes_classification_id IS NOT NULL;
CREATE TRIGGER legacy_work_classifications_immutable BEFORE UPDATE OR DELETE ON legacy_work_classifications FOR EACH ROW EXECUTE FUNCTION immutable_history();

-- A correction supersedes an earlier record of the SAME chain: the same (object, legacy finish) or the same Work.
CREATE FUNCTION gpr2_legacy_mapping_chain_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.supersedes_mapping_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM legacy_finish_mappings m WHERE m.tenant_id = NEW.tenant_id AND m.id = NEW.supersedes_mapping_id
               AND m.object_id = NEW.object_id AND m.legacy_finish_type_id = NEW.legacy_finish_type_id) THEN
        RAISE EXCEPTION 'GPR2_R05:CROSS_SCOPE_REFERENCE a mapping supersedes only a mapping of the same object and legacy finish' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER gpr2_legacy_mapping_chain_guard BEFORE INSERT ON legacy_finish_mappings FOR EACH ROW EXECUTE FUNCTION gpr2_legacy_mapping_chain_guard();
CREATE FUNCTION gpr2_legacy_classification_chain_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.supersedes_classification_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM legacy_work_classifications w WHERE w.tenant_id = NEW.tenant_id AND w.id = NEW.supersedes_classification_id AND w.work_id = NEW.work_id) THEN
        RAISE EXCEPTION 'GPR2_R05:CROSS_SCOPE_REFERENCE a classification supersedes only a classification of the same Work' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER gpr2_legacy_classification_chain_guard BEFORE INSERT ON legacy_work_classifications FOR EACH ROW EXECUTE FUNCTION gpr2_legacy_classification_chain_guard();
