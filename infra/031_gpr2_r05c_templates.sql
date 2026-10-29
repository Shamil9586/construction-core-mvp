-- migration-class: additive
-- GPR-2 R05c — versioned technological templates, object finish-system versions, stage occurrences and object-local overrides
-- (Technical Design §4.1, §5.2 `finish_template_versions` / `finish_template_stages` / `object_finish_system_versions` / `finish_stage_occurrences`;
-- decisions D06, D20; scenarios A07, A01).
--
-- ADDITIVE ONLY: new tables and guards. Nothing existing is written.
--
-- WorkType ≠ StageOccurrence. A version is an ordered list of OCCURRENCES; each has its own stable id and occurrence key, so the same WorkType may appear
-- twice («Грунтование» before plaster and «Грунтование» before putty are two occurrences, never one).
--
-- What PostgreSQL guarantees:
--   * a corporate template version and an object finish-system version are DRAFT until published, then IMMUTABLE: the version row, its stages /
--     occurrences / exclusions can be neither changed, added to nor removed (VERSION_IMMUTABLE). A change is a NEW version; one draft at a time;
--   * a corporate template uses CORPORATE WorkTypes only; an object version uses corporate WorkTypes or OBJECT WorkTypes of the SAME object;
--   * a stage measures in exactly its WorkType's unit (INVALID_MEASUREMENT otherwise; no conversion) and the unit of a WorkType used by any stage or
--     occurrence cannot change afterwards;
--   * provenance is explicit and checked: INHERITED is an exact copy of a stage of the published source template version; OVERRIDDEN keeps the source
--     stage and states a reason; ADDED_LOCAL has no source. Every stage of the source version is, at publication, inherited / overridden or explicitly
--     excluded (with a reason) — exactly once;
--   * a proposed technological hold is a PROPOSAL (hold status fixed to 'PROPOSAL'): it is never stored as a normative obligation.

CREATE TABLE finish_templates(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    code text NOT NULL CHECK (code ~ '^[A-Za-z0-9А-Яа-яЁё][A-Za-z0-9А-Яа-яЁё_.-]{0,63}$'),
    name text NOT NULL CHECK (btrim(name) <> ''),
    lifecycle text NOT NULL DEFAULT 'ACTIVE' CHECK (lifecycle IN ('ACTIVE','RETIRED')),
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version int NOT NULL DEFAULT 1 CHECK (version > 0),
    UNIQUE(tenant_id, id),
    FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id)
);
CREATE UNIQUE INDEX finish_templates_code_uq ON finish_templates(tenant_id, code);

CREATE TABLE finish_template_versions(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    template_id uuid NOT NULL,
    version_number int NOT NULL CHECK (version_number > 0),
    state text NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT','PUBLISHED')),
    content_hash text CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    published_by uuid,
    published_at timestamptz,
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(tenant_id, id),
    UNIQUE(tenant_id, template_id, version_number),
    FOREIGN KEY (tenant_id, template_id) REFERENCES finish_templates(tenant_id, id),
    FOREIGN KEY (tenant_id, published_by) REFERENCES users(tenant_id, id),
    FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
    CHECK ((state = 'DRAFT' AND content_hash IS NULL AND published_by IS NULL AND published_at IS NULL)
        OR (state = 'PUBLISHED' AND content_hash IS NOT NULL AND published_by IS NOT NULL AND published_at IS NOT NULL))
);
CREATE UNIQUE INDEX finish_template_versions_one_draft ON finish_template_versions(tenant_id, template_id) WHERE state = 'DRAFT';

CREATE TABLE finish_template_stages(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    template_version_id uuid NOT NULL,
    occurrence_key text NOT NULL CHECK (occurrence_key ~ '^[A-Za-z0-9А-Яа-яЁё][A-Za-z0-9А-Яа-яЁё_.-]{0,63}$'),
    position int NOT NULL CHECK (position > 0),
    work_type_id uuid NOT NULL,
    required boolean NOT NULL,
    measure_scope text NOT NULL CHECK (measure_scope IN ('MAIN','LOCAL')),
    measure_unit text NOT NULL,
    proposed_hold_hours numeric(30,12) CHECK (proposed_hold_hours >= 0),
    proposed_hold_status text NOT NULL DEFAULT 'PROPOSAL' CHECK (proposed_hold_status = 'PROPOSAL'),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(tenant_id, id),
    UNIQUE(tenant_id, template_version_id, id),
    UNIQUE(tenant_id, template_version_id, occurrence_key),
    UNIQUE(tenant_id, template_version_id, position),
    FOREIGN KEY (tenant_id, template_version_id) REFERENCES finish_template_versions(tenant_id, id),
    FOREIGN KEY (tenant_id, work_type_id) REFERENCES work_types(tenant_id, id)
);

CREATE TABLE object_finish_system_versions(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    object_id uuid NOT NULL,
    finish_type_id uuid NOT NULL,
    version_number int NOT NULL CHECK (version_number > 0),
    source_template_version_id uuid,
    state text NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT','PUBLISHED')),
    content_hash text CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    published_by uuid,
    published_at timestamptz,
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(tenant_id, id),
    UNIQUE(tenant_id, object_id, id),
    UNIQUE(tenant_id, object_id, finish_type_id, id),
    UNIQUE(tenant_id, finish_type_id, version_number),
    FOREIGN KEY (tenant_id, object_id, finish_type_id) REFERENCES object_finish_types(tenant_id, object_id, id),
    FOREIGN KEY (tenant_id, source_template_version_id) REFERENCES finish_template_versions(tenant_id, id),
    FOREIGN KEY (tenant_id, published_by) REFERENCES users(tenant_id, id),
    FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
    CHECK ((state = 'DRAFT' AND content_hash IS NULL AND published_by IS NULL AND published_at IS NULL)
        OR (state = 'PUBLISHED' AND content_hash IS NOT NULL AND published_by IS NOT NULL AND published_at IS NOT NULL))
);
CREATE UNIQUE INDEX object_finish_system_versions_one_draft ON object_finish_system_versions(tenant_id, finish_type_id) WHERE state = 'DRAFT';

CREATE TABLE finish_stage_occurrences(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    object_id uuid NOT NULL,
    system_version_id uuid NOT NULL,
    occurrence_key text NOT NULL CHECK (occurrence_key ~ '^[A-Za-z0-9А-Яа-яЁё][A-Za-z0-9А-Яа-яЁё_.-]{0,63}$'),
    position int NOT NULL CHECK (position > 0),
    work_type_id uuid NOT NULL,
    required boolean NOT NULL,
    measure_scope text NOT NULL CHECK (measure_scope IN ('MAIN','LOCAL')),
    measure_unit text NOT NULL,
    proposed_hold_hours numeric(30,12) CHECK (proposed_hold_hours >= 0),
    proposed_hold_status text NOT NULL DEFAULT 'PROPOSAL' CHECK (proposed_hold_status = 'PROPOSAL'),
    source_template_version_id uuid,
    source_template_stage_id uuid,
    override_kind text NOT NULL CHECK (override_kind IN ('INHERITED','OVERRIDDEN','ADDED_LOCAL')),
    override_reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(tenant_id, id),
    UNIQUE(tenant_id, object_id, id),
    UNIQUE(tenant_id, object_id, system_version_id, id),
    UNIQUE(tenant_id, system_version_id, occurrence_key),
    UNIQUE(tenant_id, system_version_id, position),
    FOREIGN KEY (tenant_id, object_id, system_version_id) REFERENCES object_finish_system_versions(tenant_id, object_id, id),
    -- the source stage belongs to the source template version, by key
    FOREIGN KEY (tenant_id, source_template_version_id, source_template_stage_id) REFERENCES finish_template_stages(tenant_id, template_version_id, id),
    FOREIGN KEY (tenant_id, work_type_id) REFERENCES work_types(tenant_id, id),
    CHECK ((override_kind = 'ADDED_LOCAL') = (source_template_stage_id IS NULL)),
    CHECK ((source_template_stage_id IS NULL) = (source_template_version_id IS NULL)),
    CHECK (override_kind <> 'OVERRIDDEN' OR btrim(coalesce(override_reason, '')) <> '')
);
CREATE UNIQUE INDEX finish_stage_occurrences_source_once ON finish_stage_occurrences(tenant_id, system_version_id, source_template_stage_id) WHERE source_template_stage_id IS NOT NULL;

CREATE TABLE finish_stage_exclusions(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    object_id uuid NOT NULL,
    system_version_id uuid NOT NULL,
    source_template_version_id uuid NOT NULL,
    template_stage_id uuid NOT NULL,
    reason text NOT NULL CHECK (btrim(reason) <> ''),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(tenant_id, id),
    UNIQUE(tenant_id, system_version_id, template_stage_id),
    FOREIGN KEY (tenant_id, object_id, system_version_id) REFERENCES object_finish_system_versions(tenant_id, object_id, id),
    FOREIGN KEY (tenant_id, source_template_version_id, template_stage_id) REFERENCES finish_template_stages(tenant_id, template_version_id, id)
);

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Published = immutable. A version row: DRAFT -> PUBLISHED once, nothing else; never removed.
CREATE FUNCTION gpr2_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'GPR2_R05:VERSION_IMMUTABLE a template / finish-system version is never removed' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.state = 'PUBLISHED' THEN
        RAISE EXCEPTION 'GPR2_R05:VERSION_IMMUTABLE a published version is immutable' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.state <> 'PUBLISHED' OR NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.version_number <> OLD.version_number
       OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'GPR2_R05:VERSION_IMMUTABLE a draft version only becomes published' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER gpr2_version_guard BEFORE UPDATE OR DELETE ON finish_template_versions FOR EACH ROW EXECUTE FUNCTION gpr2_version_guard();
CREATE TRIGGER gpr2_version_guard BEFORE UPDATE OR DELETE ON object_finish_system_versions FOR EACH ROW EXECUTE FUNCTION gpr2_version_guard();

-- Publication of a template version: it has stages. Of an object version: its finish type is active, it has occurrences, and every stage of its source
-- template version is covered exactly once (an occurrence that inherits / overrides it, or an exclusion with a reason).
CREATE FUNCTION gpr2_template_version_publish_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM finish_template_stages s WHERE s.tenant_id = NEW.tenant_id AND s.template_version_id = NEW.id) THEN
        RAISE EXCEPTION 'GPR2_R05:MISSING_REQUIRED_DATA a template version without stages cannot be published' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER gpr2_template_version_publish_check BEFORE UPDATE OF state ON finish_template_versions FOR EACH ROW WHEN (OLD.state = 'DRAFT' AND NEW.state = 'PUBLISHED') EXECUTE FUNCTION gpr2_template_version_publish_check();

CREATE FUNCTION gpr2_system_version_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.state <> 'DRAFT' THEN
            RAISE EXCEPTION 'GPR2_R05:VERSION_IMMUTABLE a version is created as a draft' USING ERRCODE = 'check_violation';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM object_finish_types f WHERE f.tenant_id = NEW.tenant_id AND f.id = NEW.finish_type_id AND f.lifecycle = 'ACTIVE') THEN
            RAISE EXCEPTION 'GPR2_R05:CROSS_SCOPE_REFERENCE a retired finish type takes no new version' USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.source_template_version_id IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM finish_template_versions v WHERE v.tenant_id = NEW.tenant_id AND v.id = NEW.source_template_version_id AND v.state = 'PUBLISHED') THEN
            RAISE EXCEPTION 'GPR2_R05:CROSS_SCOPE_REFERENCE only a published template version is a source' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF OLD.state = 'DRAFT' AND NEW.state = 'PUBLISHED' THEN
        IF NOT EXISTS (SELECT 1 FROM finish_stage_occurrences o WHERE o.tenant_id = NEW.tenant_id AND o.system_version_id = NEW.id) THEN
            RAISE EXCEPTION 'GPR2_R05:MISSING_REQUIRED_DATA a finish-system version without occurrences cannot be published' USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.source_template_version_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM finish_template_stages s WHERE s.tenant_id = NEW.tenant_id AND s.template_version_id = NEW.source_template_version_id
                   AND (SELECT count(*) FROM finish_stage_occurrences o WHERE o.tenant_id = NEW.tenant_id AND o.system_version_id = NEW.id AND o.source_template_stage_id = s.id)
                     + (SELECT count(*) FROM finish_stage_exclusions x WHERE x.tenant_id = NEW.tenant_id AND x.system_version_id = NEW.id AND x.template_stage_id = s.id) <> 1) THEN
            RAISE EXCEPTION 'GPR2_R05:MISSING_REQUIRED_DATA every stage of the source template is inherited, overridden or excluded exactly once' USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER gpr2_system_version_check BEFORE INSERT OR UPDATE OF state ON object_finish_system_versions FOR EACH ROW EXECUTE FUNCTION gpr2_system_version_check();

-- Children of a version: written only while the version is a DRAFT (the FOR SHARE read serialises with the publication's row lock).
CREATE FUNCTION gpr2_template_stage_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; wt record;
BEGIN
    r := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    IF (SELECT state FROM finish_template_versions WHERE tenant_id = r.tenant_id AND id = r.template_version_id FOR SHARE) IS DISTINCT FROM 'DRAFT'
       OR (TG_OP = 'UPDATE' AND OLD.template_version_id <> NEW.template_version_id) THEN
        RAISE EXCEPTION 'GPR2_R05:VERSION_IMMUTABLE the stages of a published template version are immutable' USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    SELECT scope, unit INTO wt FROM work_types WHERE tenant_id = NEW.tenant_id AND id = NEW.work_type_id;
    IF wt.scope IS DISTINCT FROM 'CORPORATE' THEN
        RAISE EXCEPTION 'GPR2_R05:CROSS_SCOPE_REFERENCE a corporate template uses corporate WorkTypes only' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.measure_unit IS DISTINCT FROM wt.unit THEN
        RAISE EXCEPTION 'GPR2_R05:INVALID_MEASUREMENT a stage measures in its WorkType''s unit' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER gpr2_template_stage_guard BEFORE INSERT OR UPDATE OR DELETE ON finish_template_stages FOR EACH ROW EXECUTE FUNCTION gpr2_template_stage_guard();

CREATE FUNCTION gpr2_occurrence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; v record; wt record; src record;
BEGIN
    r := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    SELECT state, source_template_version_id INTO v FROM object_finish_system_versions WHERE tenant_id = r.tenant_id AND id = r.system_version_id FOR SHARE;
    IF v.state IS DISTINCT FROM 'DRAFT' OR (TG_OP = 'UPDATE' AND (OLD.system_version_id <> NEW.system_version_id OR OLD.object_id <> NEW.object_id)) THEN
        RAISE EXCEPTION 'GPR2_R05:VERSION_IMMUTABLE the occurrences of a published finish-system version are immutable' USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    IF NEW.source_template_version_id IS DISTINCT FROM v.source_template_version_id AND NEW.source_template_version_id IS NOT NULL THEN
        RAISE EXCEPTION 'GPR2_R05:CROSS_SCOPE_REFERENCE an occurrence inherits only from its version''s source template' USING ERRCODE = 'check_violation';
    END IF;
    SELECT scope, object_id, unit INTO wt FROM work_types WHERE tenant_id = NEW.tenant_id AND id = NEW.work_type_id;
    IF NOT (wt.scope = 'CORPORATE' OR (wt.scope = 'OBJECT' AND wt.object_id = NEW.object_id)) THEN
        RAISE EXCEPTION 'GPR2_R05:CROSS_SCOPE_REFERENCE an occurrence uses a corporate WorkType or an object WorkType of the same object' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.measure_unit IS DISTINCT FROM wt.unit THEN
        RAISE EXCEPTION 'GPR2_R05:INVALID_MEASUREMENT an occurrence measures in its WorkType''s unit' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.override_kind = 'INHERITED' THEN
        SELECT * INTO src FROM finish_template_stages WHERE tenant_id = NEW.tenant_id AND id = NEW.source_template_stage_id;
        IF src.occurrence_key IS DISTINCT FROM NEW.occurrence_key OR src.position IS DISTINCT FROM NEW.position OR src.work_type_id IS DISTINCT FROM NEW.work_type_id
           OR src.required IS DISTINCT FROM NEW.required OR src.measure_scope IS DISTINCT FROM NEW.measure_scope OR src.measure_unit IS DISTINCT FROM NEW.measure_unit
           OR src.proposed_hold_hours IS DISTINCT FROM NEW.proposed_hold_hours THEN
            RAISE EXCEPTION 'GPR2_R05:PROVENANCE_MISMATCH an INHERITED occurrence is an exact copy of its template stage (anything else is OVERRIDDEN with a reason)' USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    IF NEW.source_template_stage_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM finish_stage_exclusions x WHERE x.tenant_id = NEW.tenant_id AND x.system_version_id = NEW.system_version_id AND x.template_stage_id = NEW.source_template_stage_id) THEN
        RAISE EXCEPTION 'GPR2_R05:CROSS_SCOPE_REFERENCE a template stage is either used or excluded, not both' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER gpr2_occurrence_guard BEFORE INSERT OR UPDATE OR DELETE ON finish_stage_occurrences FOR EACH ROW EXECUTE FUNCTION gpr2_occurrence_guard();

CREATE FUNCTION gpr2_exclusion_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; v record;
BEGIN
    r := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    SELECT state, source_template_version_id INTO v FROM object_finish_system_versions WHERE tenant_id = r.tenant_id AND id = r.system_version_id FOR SHARE;
    IF v.state IS DISTINCT FROM 'DRAFT' OR TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'GPR2_R05:VERSION_IMMUTABLE the exclusions of a finish-system version are fixed with it' USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    IF NEW.source_template_version_id IS DISTINCT FROM v.source_template_version_id THEN
        RAISE EXCEPTION 'GPR2_R05:CROSS_SCOPE_REFERENCE an exclusion names a stage of the version''s source template' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM finish_stage_occurrences o WHERE o.tenant_id = NEW.tenant_id AND o.system_version_id = NEW.system_version_id AND o.source_template_stage_id = NEW.template_stage_id) THEN
        RAISE EXCEPTION 'GPR2_R05:CROSS_SCOPE_REFERENCE a template stage is either used or excluded, not both' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER gpr2_exclusion_guard BEFORE INSERT OR UPDATE OR DELETE ON finish_stage_exclusions FOR EACH ROW EXECUTE FUNCTION gpr2_exclusion_guard();

-- The unit of a WorkType a stage or an occurrence measures in cannot change afterwards (029 already covers Works and execution units).
CREATE FUNCTION gpr2_work_type_unit_stage_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.unit IS DISTINCT FROM OLD.unit AND (
            EXISTS (SELECT 1 FROM finish_template_stages s WHERE s.tenant_id = OLD.tenant_id AND s.work_type_id = OLD.id)
         OR EXISTS (SELECT 1 FROM finish_stage_occurrences o WHERE o.tenant_id = OLD.tenant_id AND o.work_type_id = OLD.id)) THEN
        RAISE EXCEPTION 'GPR2_R05:UNIT_IMMUTABLE the unit of a WorkType used by a template stage or an occurrence cannot change' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER gpr2_work_type_unit_stage_guard BEFORE UPDATE OF unit ON work_types FOR EACH ROW EXECUTE FUNCTION gpr2_work_type_unit_stage_guard();
