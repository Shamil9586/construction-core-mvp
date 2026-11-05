-- migration-class: additive
-- R07 offline quantity request ledger. Existing rows and production data are never backfilled.
CREATE TABLE gpr2_quantity_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    object_id uuid NOT NULL,
    work_id uuid NOT NULL,
    state text NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT','SUBMITTED','RETURNED','APPROVED')),
    version int NOT NULL DEFAULT 1 CHECK (version > 0),
    proposed_quantity numeric(24,4) NOT NULL CHECK (proposed_quantity >= 0),
    quantity_version_id uuid NOT NULL,
    reason text NOT NULL CHECK (length(btrim(reason)) > 0),
    allocation jsonb,
    surface jsonb,
    author_id uuid NOT NULL,
    submitter_id uuid,
    submission_number int NOT NULL DEFAULT 0 CHECK (submission_number >= 0),
    decided_by uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(tenant_id,object_id,id),
    UNIQUE(tenant_id,object_id,work_id,id),
    FOREIGN KEY(tenant_id,object_id,work_id) REFERENCES works(tenant_id,object_id,id),
    FOREIGN KEY(tenant_id,object_id,work_id,quantity_version_id) REFERENCES work_quantity_versions(tenant_id,object_id,work_id,id),
    FOREIGN KEY(tenant_id,author_id) REFERENCES users(tenant_id,id),
    FOREIGN KEY(tenant_id,submitter_id) REFERENCES users(tenant_id,id),
    FOREIGN KEY(tenant_id,decided_by) REFERENCES users(tenant_id,id)
);
CREATE INDEX gpr2_quantity_requests_scope ON gpr2_quantity_requests(tenant_id,object_id,state,created_at);
CREATE TABLE gpr2_quantity_submissions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    object_id uuid NOT NULL,
    request_id uuid NOT NULL,
    number int NOT NULL CHECK(number > 0),
    payload jsonb NOT NULL,
    submitted_by uuid NOT NULL,
    submitted_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(tenant_id,object_id,request_id,number),
    FOREIGN KEY(tenant_id,object_id,request_id) REFERENCES gpr2_quantity_requests(tenant_id,object_id,id),
    FOREIGN KEY(tenant_id,submitted_by) REFERENCES users(tenant_id,id)
);
CREATE TABLE gpr2_quantity_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    object_id uuid NOT NULL,
    request_id uuid NOT NULL,
    submission_number int NOT NULL,
    action text NOT NULL CHECK(action IN ('CREATE','EDIT','SUBMIT','REVISE','REVIEW_NOTE','RETURN','APPROVE')),
    actor_id uuid NOT NULL,
    reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY(tenant_id,object_id,request_id) REFERENCES gpr2_quantity_requests(tenant_id,object_id,id),
    FOREIGN KEY(tenant_id,actor_id) REFERENCES users(tenant_id,id)
);
CREATE INDEX gpr2_quantity_events_history ON gpr2_quantity_events(tenant_id,object_id,request_id,created_at,id);
CREATE FUNCTION gpr2_r07_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    RAISE EXCEPTION 'R07: quantity request history immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER gpr2_quantity_submissions_immutable BEFORE UPDATE OR DELETE ON gpr2_quantity_submissions
    FOR EACH ROW EXECUTE FUNCTION gpr2_r07_history_immutable();
CREATE TRIGGER gpr2_quantity_events_immutable BEFORE UPDATE OR DELETE ON gpr2_quantity_events
    FOR EACH ROW EXECUTE FUNCTION gpr2_r07_history_immutable();

-- The approved request identifies the only permitted post-initial quantity version.
ALTER TABLE work_quantity_versions ADD CONSTRAINT gpr2_r07_approved_request_fk
    FOREIGN KEY(tenant_id,object_id,approved_request_id)
    REFERENCES gpr2_quantity_requests(tenant_id,object_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE UNIQUE INDEX gpr2_r07_one_version_per_work_request ON work_quantity_versions(tenant_id,object_id,work_id,approved_request_id)
    WHERE approved_request_id IS NOT NULL;
ALTER TABLE work_allocation_versions ADD COLUMN approved_request_id uuid;
ALTER TABLE work_allocation_versions ADD CONSTRAINT gpr2_r07_allocation_approval_fk
    FOREIGN KEY(tenant_id,object_id,work_id,approved_request_id)
    REFERENCES gpr2_quantity_requests(tenant_id,object_id,work_id,id) DEFERRABLE INITIALLY DEFERRED;

-- At commit, a new current pointer is legal only for an approved request and only above the protected evidence floor.
-- The checks are also invoked for direct SQL. Facts on disjoint portions add; different evidence kinds on one portion overlap by max.
CREATE FUNCTION gpr2_r07_assert_floor(p_tenant uuid,p_object uuid,p_work uuid,p_quantity numeric) RETURNS void LANGUAGE plpgsql AS $$
DECLARE work_floor numeric; portion_floor numeric; has_closing boolean;
BEGIN
    SELECT greatest(coalesce(w.actual_quantity,0),coalesce((SELECT max(x.total_quantity) FROM work_progress x
        WHERE x.tenant_id=w.tenant_id AND x.object_work_id=w.id),0)) INTO work_floor
        FROM works w WHERE w.tenant_id=p_tenant AND w.object_id=p_object AND w.id=p_work;
    SELECT coalesce(sum(greatest(
        coalesce((SELECT max(f.quantity) FROM portion_quantity_confirmations f
          WHERE f.tenant_id=p.tenant_id AND f.portion_id=p.id AND f.source='RP_FACT'),0),
        coalesce((SELECT max(f.quantity) FROM portion_quantity_confirmations f
          WHERE f.tenant_id=p.tenant_id AND f.portion_id=p.id AND f.source='INTERNAL_SC'),0),
        coalesce((SELECT max(f.quantity) FROM documentation_customer_accepted_quantities f
          WHERE f.tenant_id=p.tenant_id AND f.quantity_portion_id=p.id),0))),0) INTO portion_floor
        FROM quantity_portions p JOIN work_execution_units u ON u.tenant_id=p.tenant_id AND u.id=p.execution_unit_id
        WHERE p.tenant_id=p_tenant AND u.object_work_id=p_work;
    SELECT EXISTS(SELECT 1 FROM sdo_closing_portion_allocations x JOIN quantity_portions p ON p.tenant_id=x.tenant_id AND p.id=x.quantity_portion_id
        JOIN work_execution_units u ON u.tenant_id=p.tenant_id AND u.id=p.execution_unit_id
        WHERE x.tenant_id=p_tenant AND u.object_work_id=p_work AND x.cancelled_at IS NULL) INTO has_closing;
    IF has_closing OR p_quantity < greatest(coalesce(work_floor,0),coalesce(portion_floor,0)) THEN
        RAISE EXCEPTION 'R07: BELOW_PROTECTED_QUANTITY' USING ERRCODE='23514';
    END IF;
END $$;

CREATE FUNCTION gpr2_r07_quantity_pointer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v record; r record;
BEGIN
    SELECT quantity,source_kind,approved_request_id INTO v FROM work_quantity_versions WHERE tenant_id=NEW.tenant_id
      AND object_id=NEW.object_id AND work_id=NEW.work_id AND id=NEW.approved_version_id;
    SELECT state,work_id INTO r FROM gpr2_quantity_requests WHERE tenant_id=NEW.tenant_id AND object_id=NEW.object_id AND id=v.approved_request_id;
    IF v.source_kind IS DISTINCT FROM 'APPROVED_REQUEST' OR r.state IS DISTINCT FROM 'APPROVED' OR
      (r.work_id IS DISTINCT FROM NEW.work_id AND NOT EXISTS(SELECT 1 FROM gpr2_surface_effects e JOIN gpr2_surface_changes s ON s.id=e.surface_change_id
        WHERE s.tenant_id=NEW.tenant_id AND s.object_id=NEW.object_id AND s.request_id=v.approved_request_id AND e.work_id=NEW.work_id)) THEN
        RAISE EXCEPTION 'R07: quantity pointer requires approved request' USING ERRCODE='23514';
    END IF;
    PERFORM gpr2_r07_assert_floor(NEW.tenant_id,NEW.object_id,NEW.work_id,v.quantity);
    RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER gpr2_r07_quantity_pointer AFTER UPDATE OF approved_version_id ON work_current_quantity
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION gpr2_r07_quantity_pointer_guard();

-- Replace R06b's conservative post-fact freeze with a request-bound R07 path. No request: old freeze stays effective.
CREATE OR REPLACE FUNCTION r06b_pointer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v record; current_q record; approved text;
BEGIN
    IF TG_OP='UPDATE' AND (OLD.tenant_id,OLD.object_id,OLD.work_id) IS DISTINCT FROM (NEW.tenant_id,NEW.object_id,NEW.work_id) THEN
        RAISE EXCEPTION 'R06B: pointer identity immutable' USING ERRCODE='23514';
    END IF;
    SELECT sequence,previous_id,quantity_version_id,approved_request_id INTO v FROM work_allocation_versions
      WHERE tenant_id=NEW.tenant_id AND object_id=NEW.object_id AND work_id=NEW.work_id AND id=NEW.version_id;
    IF (TG_OP='INSERT' AND v.sequence<>1) OR (TG_OP='UPDATE' AND (v.previous_id<>OLD.version_id OR
       v.sequence<>(SELECT sequence+1 FROM work_allocation_versions WHERE id=OLD.version_id))) THEN
       RAISE EXCEPTION 'R06B: pointer must advance by one version' USING ERRCODE='23514';
    END IF;
    SELECT p.approved_version_id,q.quantity INTO current_q FROM work_current_quantity p JOIN work_quantity_versions q ON q.id=p.approved_version_id
      WHERE p.tenant_id=NEW.tenant_id AND p.object_id=NEW.object_id AND p.work_id=NEW.work_id;
    IF v.approved_request_id IS NOT NULL THEN
        SELECT state INTO approved FROM gpr2_quantity_requests WHERE tenant_id=NEW.tenant_id AND object_id=NEW.object_id
          AND work_id=NEW.work_id AND id=v.approved_request_id;
        IF approved IS DISTINCT FROM 'APPROVED' OR v.quantity_version_id IS DISTINCT FROM current_q.approved_version_id THEN
            RAISE EXCEPTION 'R07: allocation pointer requires approved quantity request' USING ERRCODE='23514';
        END IF;
        PERFORM gpr2_r07_assert_floor(NEW.tenant_id,NEW.object_id,NEW.work_id,current_q.quantity);
    ELSIF EXISTS(SELECT 1 FROM works w WHERE w.tenant_id=NEW.tenant_id AND w.object_id=NEW.object_id AND w.id=NEW.work_id AND
        (w.actual_quantity>0 OR EXISTS(SELECT 1 FROM work_progress p WHERE p.tenant_id=w.tenant_id AND p.object_work_id=w.id)
         OR EXISTS(SELECT 1 FROM work_execution_units u JOIN quantity_portions p ON p.tenant_id=u.tenant_id AND p.execution_unit_id=u.id
           JOIN portion_quantity_confirmations f ON f.tenant_id=p.tenant_id AND f.portion_id=p.id WHERE u.tenant_id=w.tenant_id AND u.object_work_id=w.id)
         OR EXISTS(SELECT 1 FROM work_execution_units u JOIN quantity_portions p ON p.tenant_id=u.tenant_id AND p.execution_unit_id=u.id
           JOIN documentation_customer_accepted_quantities f ON f.tenant_id=p.tenant_id AND f.quantity_portion_id=p.id WHERE u.tenant_id=w.tenant_id AND u.object_work_id=w.id))) THEN
        RAISE EXCEPTION 'R06B: allocation is frozen after confirmed evidence' USING ERRCODE='23514';
    END IF;
    PERFORM r06b_allocation_validate(NEW.tenant_id,NEW.object_id,NEW.work_id,NEW.version_id);
    RETURN NEW;
END $$;

CREATE TABLE gpr2_surface_changes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, object_id uuid NOT NULL,
    request_id uuid NOT NULL, area_scope_id uuid NOT NULL, previous_quantity numeric(24,4) NOT NULL,
    new_quantity numeric(24,4) NOT NULL, delta numeric(24,4) NOT NULL,
    unit text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(tenant_id,object_id,request_id,area_scope_id),
    FOREIGN KEY(tenant_id,object_id,request_id) REFERENCES gpr2_quantity_requests(tenant_id,object_id,id),
    FOREIGN KEY(tenant_id,object_id,area_scope_id) REFERENCES object_area_scopes(tenant_id,object_id,id)
);
CREATE TABLE gpr2_surface_effects (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, object_id uuid NOT NULL,
    surface_change_id uuid NOT NULL REFERENCES gpr2_surface_changes(id),
    stage_occurrence_id uuid NOT NULL, work_id uuid NOT NULL, old_quantity numeric(24,4) NOT NULL,
    new_quantity numeric(24,4) NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(tenant_id,object_id,surface_change_id,stage_occurrence_id,work_id)
);
ALTER TABLE gpr2_surface_effects ADD CONSTRAINT gpr2_r07_effect_work_fk
    FOREIGN KEY(tenant_id,object_id,work_id) REFERENCES works(tenant_id,object_id,id);
CREATE TRIGGER gpr2_surface_changes_immutable BEFORE UPDATE OR DELETE ON gpr2_surface_changes
    FOR EACH ROW EXECUTE FUNCTION gpr2_r07_history_immutable();
CREATE TRIGGER gpr2_surface_effects_immutable BEFORE UPDATE OR DELETE ON gpr2_surface_effects
    FOR EACH ROW EXECUTE FUNCTION gpr2_r07_history_immutable();
CREATE TABLE gpr2_schedule_basis_invalidations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, object_id uuid NOT NULL,
    work_id uuid NOT NULL, quantity_version_id uuid NOT NULL, request_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY(tenant_id,object_id,work_id,quantity_version_id) REFERENCES work_quantity_versions(tenant_id,object_id,work_id,id),
    FOREIGN KEY(tenant_id,object_id,request_id) REFERENCES gpr2_quantity_requests(tenant_id,object_id,id)
);
CREATE TABLE gpr2_labor_coverage_recalculations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, object_id uuid NOT NULL,
    work_id uuid NOT NULL, quantity_version_id uuid NOT NULL, request_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY(tenant_id,object_id,work_id,quantity_version_id) REFERENCES work_quantity_versions(tenant_id,object_id,work_id,id),
    FOREIGN KEY(tenant_id,object_id,request_id) REFERENCES gpr2_quantity_requests(tenant_id,object_id,id)
);
CREATE TRIGGER gpr2_schedule_basis_invalidations_immutable BEFORE UPDATE OR DELETE ON gpr2_schedule_basis_invalidations
    FOR EACH ROW EXECUTE FUNCTION gpr2_r07_history_immutable();
CREATE TRIGGER gpr2_labor_coverage_recalculations_immutable BEFORE UPDATE OR DELETE ON gpr2_labor_coverage_recalculations
    FOR EACH ROW EXECUTE FUNCTION gpr2_r07_history_immutable();
