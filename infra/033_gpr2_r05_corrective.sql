-- migration-class: additive
-- GPR-2 R05 corrective — closes the first independent review (GPT_REVIEW_20261024: R05-GPT-B01, B02, B03) without editing 029–032.
--
-- ADDITIVE ONLY: one CHECK constraint (added NOT VALID, then validated) and new triggers. No table, column or index is added; no row is written by
-- this file; no existing function is replaced. Works / WEU / QuantityPortion / confirmations / progress / history are not touched.
--
-- B01  A Work that produces an obligation keeps its identity. Once a Work carries a producer binding (work_scope_bindings) its tenant, object,
--      WorkType and unit are frozen; once it carries a legacy classification its tenant and object are frozen (the classification names the object).
--      The race between "bind / classify" and "change the Work" is closed from both sides, at every isolation level:
--        * the binding / classification insert locks the Work row FOR SHARE and re-checks object, WorkType and unit against the LOCKED row (a change
--          that committed while it waited is seen; under REPEATABLE READ the lock itself fails with a serialization error);
--        * a change of a Work's identity moves the object scope version (work_scope_state) of the old and the new object FIRST — a binding and a
--          classification move the same row — so a REPEATABLE READ change that cannot see a just-committed binding conflicts on that row
--          (serialization error) instead of slipping past it; under READ COMMITTED it waits and then sees the binding.
--      Moving the scope version is also what the preview fence needs: a Work that changes object / WorkType / unit changes what generation reads.
--      R04 planning completion, start, progress, inspection and the portion fact mode write none of these columns: the triggers do not fire for them.
-- B02  A template / finish-system version keeps the identity and source lineage its stages / occurrences were drafted and checked against:
--        * finish_template_versions: created as DRAFT only (a direct INSERT in PUBLISHED is refused); template_id never changes;
--        * object_finish_system_versions: object_id, finish_type_id and source_template_version_id never change (DRAFT included — the coverage check
--          at publication can no longer be bypassed by nulling or swapping the source in the same statement);
--        * at DRAFT -> PUBLISHED the object version's provenance is re-checked against its ORIGINAL source: every occurrence / exclusion with a source
--          names exactly that template version, an INHERITED occurrence is still an exact copy, and the source is a published template version.
-- B03  An OBJECT WorkType has a non-NULL origin equal to its object. 029's CHECK `origin_object_id = object_id` is UNKNOWN (so accepted) for a NULL
--      origin; the new CHECK states the non-NULL requirement explicitly. It is validated against existing rows: every row the API ever wrote satisfies
--      it; a row that does not makes this migration fail and roll back (no value is invented for it).
-- B05  029's header says no index is added to work_types; 029 does add the partial index work_types_object_idx (tenant_id, object_id) WHERE
--      object_id IS NOT NULL. It is kept: it is not a unique key and object_id is a column 029 itself adds — no pre-R05 query references it, so no
--      existing plan can choose it. The statement in 029 is wrong, the index is not; 029 is not edited (its checksum is recorded).

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- B03
ALTER TABLE work_types ADD CONSTRAINT work_types_object_origin_required CHECK (scope <> 'OBJECT' OR (origin_object_id IS NOT NULL AND origin_object_id = object_id)) NOT VALID;
ALTER TABLE work_types VALIDATE CONSTRAINT work_types_object_origin_required;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- B01 — the Work side
CREATE FUNCTION gpr2_bound_work_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    -- First: take the object scope row(s) a binding / classification also writes (see the header). Old object before new object, by id, so two
    -- concurrent moves between the same two objects lock in one order.
    INSERT INTO work_scope_state AS s (tenant_id, object_id, scope_version)
    SELECT OLD.tenant_id, o, 1 FROM (SELECT DISTINCT unnest(ARRAY[OLD.object_id, NEW.object_id]) AS o) x WHERE o IS NOT NULL ORDER BY o
    ON CONFLICT (tenant_id, object_id) DO UPDATE SET scope_version = s.scope_version + 1, updated_at = now();
    IF EXISTS (SELECT 1 FROM work_scope_bindings b WHERE b.tenant_id = OLD.tenant_id AND b.work_id = OLD.id AND b.binding_state = 'ACTIVE') THEN
        RAISE EXCEPTION 'GPR2_R05:IDENTITY_IMMUTABLE a Work that produces an obligation keeps its tenant, object, WorkType and unit' USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW.object_id IS DISTINCT FROM OLD.object_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id)
       AND EXISTS (SELECT 1 FROM legacy_work_classifications c WHERE c.tenant_id = OLD.tenant_id AND c.work_id = OLD.id) THEN
        RAISE EXCEPTION 'GPR2_R05:IDENTITY_IMMUTABLE a classified Work stays in the object its classification names' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER gpr2_bound_work_identity_guard BEFORE UPDATE OF tenant_id, object_id, work_type_id, unit ON works FOR EACH ROW
    WHEN (OLD.tenant_id IS DISTINCT FROM NEW.tenant_id OR OLD.object_id IS DISTINCT FROM NEW.object_id
          OR OLD.work_type_id IS DISTINCT FROM NEW.work_type_id OR OLD.unit IS DISTINCT FROM NEW.unit)
    EXECUTE FUNCTION gpr2_bound_work_identity_guard();

-- B01 — the binding side: runs after gpr2_binding_guard (trigger order is by name), on the LOCKED Work row.
CREATE FUNCTION gpr2_binding_work_lock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w record; occ record;
BEGIN
    SELECT object_id, work_type_id, unit INTO w FROM works WHERE tenant_id = NEW.tenant_id AND id = NEW.work_id FOR SHARE;
    IF NOT FOUND OR w.object_id IS DISTINCT FROM NEW.object_id THEN
        RAISE EXCEPTION 'GPR2_R05:CROSS_SCOPE_REFERENCE the producing Work belongs to the same object' USING ERRCODE = 'check_violation';
    END IF;
    SELECT work_type_id, measure_unit INTO occ FROM finish_stage_occurrences WHERE tenant_id = NEW.tenant_id AND id = NEW.occurrence_id;
    IF w.work_type_id IS DISTINCT FROM occ.work_type_id OR w.unit IS DISTINCT FROM occ.measure_unit THEN
        RAISE EXCEPTION 'GPR2_R05:INVALID_MEASUREMENT the producing Work has the occurrence''s WorkType and unit' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER gpr2_binding_work_lock BEFORE INSERT ON work_scope_bindings FOR EACH ROW EXECUTE FUNCTION gpr2_binding_work_lock();

-- B01 — the classification side: the same lock and object re-check, and the classification moves the object scope version (a classified Work is
-- never bound by generation, so the generation scope did change) — the row a concurrent Work move also writes.
CREATE FUNCTION gpr2_classification_work_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM 1 FROM works WHERE tenant_id = NEW.tenant_id AND id = NEW.work_id AND object_id = NEW.object_id FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'GPR2_R05:CROSS_SCOPE_REFERENCE a classification is about a Work of its own object' USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO work_scope_state AS s (tenant_id, object_id, scope_version) VALUES (NEW.tenant_id, NEW.object_id, 1)
    ON CONFLICT (tenant_id, object_id) DO UPDATE SET scope_version = s.scope_version + 1, updated_at = now();
    RETURN NEW;
END $$;
CREATE TRIGGER gpr2_classification_work_lock BEFORE INSERT ON legacy_work_classifications FOR EACH ROW EXECUTE FUNCTION gpr2_classification_work_lock();

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- B02 — template versions
CREATE FUNCTION gpr2_template_version_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.state IS DISTINCT FROM 'DRAFT' THEN
            RAISE EXCEPTION 'GPR2_R05:VERSION_IMMUTABLE a version is created as a draft' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.template_id IS DISTINCT FROM OLD.template_id THEN
        RAISE EXCEPTION 'GPR2_R05:VERSION_IMMUTABLE a template version stays a version of its template' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER gpr2_template_version_identity_guard BEFORE INSERT OR UPDATE ON finish_template_versions FOR EACH ROW EXECUTE FUNCTION gpr2_template_version_identity_guard();

-- B02 — object finish-system versions: identity and source frozen on every update
CREATE FUNCTION gpr2_system_version_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.object_id IS DISTINCT FROM OLD.object_id OR NEW.finish_type_id IS DISTINCT FROM OLD.finish_type_id
       OR NEW.source_template_version_id IS DISTINCT FROM OLD.source_template_version_id THEN
        RAISE EXCEPTION 'GPR2_R05:VERSION_IMMUTABLE a finish-system version keeps its object, finish type and source template version' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER gpr2_system_version_identity_guard BEFORE UPDATE ON object_finish_system_versions FOR EACH ROW EXECUTE FUNCTION gpr2_system_version_identity_guard();

-- B02 — at publication, the provenance of every occurrence / exclusion is re-checked against the version's ORIGINAL source (OLD row).
CREATE FUNCTION gpr2_system_version_publish_provenance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.source_template_version_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM finish_template_versions v WHERE v.tenant_id = OLD.tenant_id AND v.id = OLD.source_template_version_id AND v.state = 'PUBLISHED') THEN
        RAISE EXCEPTION 'GPR2_R05:PROVENANCE_MISMATCH the source of a finish-system version is a published template version' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM finish_stage_occurrences o WHERE o.tenant_id = OLD.tenant_id AND o.system_version_id = OLD.id
                  AND o.source_template_version_id IS NOT NULL AND o.source_template_version_id IS DISTINCT FROM OLD.source_template_version_id)
       OR EXISTS (SELECT 1 FROM finish_stage_exclusions x WHERE x.tenant_id = OLD.tenant_id AND x.system_version_id = OLD.id
                  AND x.source_template_version_id IS DISTINCT FROM OLD.source_template_version_id) THEN
        RAISE EXCEPTION 'GPR2_R05:PROVENANCE_MISMATCH every occurrence and exclusion names the version''s own source template version' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM finish_stage_occurrences o JOIN finish_template_stages s ON s.tenant_id = o.tenant_id AND s.id = o.source_template_stage_id
                WHERE o.tenant_id = OLD.tenant_id AND o.system_version_id = OLD.id AND o.override_kind = 'INHERITED'
                  AND (s.occurrence_key IS DISTINCT FROM o.occurrence_key OR s.position IS DISTINCT FROM o.position OR s.work_type_id IS DISTINCT FROM o.work_type_id
                       OR s.required IS DISTINCT FROM o.required OR s.measure_scope IS DISTINCT FROM o.measure_scope OR s.measure_unit IS DISTINCT FROM o.measure_unit
                       OR s.proposed_hold_hours IS DISTINCT FROM o.proposed_hold_hours)) THEN
        RAISE EXCEPTION 'GPR2_R05:PROVENANCE_MISMATCH an INHERITED occurrence is an exact copy of its template stage' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER gpr2_system_version_publish_provenance BEFORE UPDATE OF state ON object_finish_system_versions FOR EACH ROW
    WHEN (OLD.state = 'DRAFT' AND NEW.state = 'PUBLISHED') EXECUTE FUNCTION gpr2_system_version_publish_provenance();
