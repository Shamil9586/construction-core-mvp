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

-- R07-REV-03a. The request lifecycle is structural, not only a service convention (DRAFT -> SUBMITTED -> APPROVED | RETURNED -> DRAFT; APPROVED is final).
-- A request is born as an undecided DRAFT; a submission snapshot is taken only from the author's DRAFT, in sequence; SUBMITTED needs that snapshot;
-- APPROVED needs a decision by somebody other than the author / submitter; nothing changes once submitted. TRUST BOUNDARY (not removed by this file):
-- the application uses ONE database role, so these checks make a forgery by a single INSERT / UPDATE impossible, but a writer with the same role can still
-- fabricate a complete and consistent history (it is permanent and immutable, hence detectable). Making the database authoritative about WHO decided needs
-- separate roles / privileges / SECURITY DEFINER, an architecture change that this migration does not make.
CREATE FUNCTION gpr2_r07_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='INSERT' THEN
        IF NEW.state<>'DRAFT' OR NEW.submission_number<>0 OR NEW.submitter_id IS NOT NULL OR NEW.decided_by IS NOT NULL THEN
            RAISE EXCEPTION 'R07: a quantity request starts as an undecided DRAFT' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
    END IF;
    IF (NEW.tenant_id,NEW.object_id,NEW.work_id,NEW.quantity_version_id,NEW.author_id,NEW.created_at)
       IS DISTINCT FROM (OLD.tenant_id,OLD.object_id,OLD.work_id,OLD.quantity_version_id,OLD.author_id,OLD.created_at) THEN
        RAISE EXCEPTION 'R07: request identity and source version are immutable' USING ERRCODE='23514';
    END IF;
    IF (OLD.state='DRAFT' AND NEW.state='DRAFT') OR (OLD.state='RETURNED' AND NEW.state='DRAFT') THEN
        IF NEW.submission_number<>OLD.submission_number OR NEW.submitter_id IS DISTINCT FROM OLD.submitter_id OR NEW.decided_by IS DISTINCT FROM OLD.decided_by THEN
            RAISE EXCEPTION 'R07: editing a request cannot touch its submission or decision' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
    END IF;
    -- from here on the content is frozen: what was submitted is what is decided
    IF (NEW.proposed_quantity,NEW.reason,NEW.allocation,NEW.surface) IS DISTINCT FROM (OLD.proposed_quantity,OLD.reason,OLD.allocation,OLD.surface) THEN
        RAISE EXCEPTION 'R07: a submitted request is not edited' USING ERRCODE='23514';
    END IF;
    IF OLD.state='DRAFT' AND NEW.state='SUBMITTED' THEN
        IF NEW.submission_number<>OLD.submission_number+1 OR NEW.submitter_id IS DISTINCT FROM OLD.author_id OR NEW.decided_by IS DISTINCT FROM OLD.decided_by
           OR NOT EXISTS(SELECT 1 FROM gpr2_quantity_submissions s WHERE s.tenant_id=NEW.tenant_id AND s.object_id=NEW.object_id AND s.request_id=NEW.id
                         AND s.number=NEW.submission_number AND s.submitted_by=NEW.submitter_id) THEN
            RAISE EXCEPTION 'R07: SUBMITTED needs the author''s submission snapshot of the next number' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
    END IF;
    IF OLD.state='SUBMITTED' AND NEW.state IN ('APPROVED','RETURNED') THEN
        IF NEW.submission_number<>OLD.submission_number OR NEW.submitter_id IS DISTINCT FROM OLD.submitter_id OR NEW.decided_by IS NULL THEN
            RAISE EXCEPTION 'R07: a decision needs the submitted snapshot and a decider' USING ERRCODE='23514';
        END IF;
        IF NEW.state='APPROVED' AND NEW.decided_by IN (NEW.author_id,NEW.submitter_id) THEN
            RAISE EXCEPTION 'R07: the author or submitter cannot approve the request' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'R07: invalid quantity request transition % -> %',OLD.state,NEW.state USING ERRCODE='23514';
END $$;
CREATE TRIGGER gpr2_quantity_requests_guard BEFORE INSERT OR UPDATE ON gpr2_quantity_requests
    FOR EACH ROW EXECUTE FUNCTION gpr2_r07_request_guard();

CREATE FUNCTION gpr2_r07_submission_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
    SELECT state,submission_number,author_id INTO r FROM gpr2_quantity_requests WHERE tenant_id=NEW.tenant_id AND object_id=NEW.object_id AND id=NEW.request_id;
    IF r.state IS DISTINCT FROM 'DRAFT' OR NEW.number<>r.submission_number+1 OR NEW.submitted_by IS DISTINCT FROM r.author_id THEN
        RAISE EXCEPTION 'R07: a submission snapshot is taken only from the author''s DRAFT, in sequence' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER gpr2_quantity_submissions_guard BEFORE INSERT ON gpr2_quantity_submissions
    FOR EACH ROW EXECUTE FUNCTION gpr2_r07_submission_guard();

-- Used at COMMIT by every pointer guard: the request that carries a pointer must be a complete, consistent, decided request.
CREATE FUNCTION gpr2_r07_assert_request_provenance(p_tenant uuid,p_object uuid,p_request uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r record; s record;
BEGIN
    SELECT * INTO r FROM gpr2_quantity_requests WHERE tenant_id=p_tenant AND object_id=p_object AND id=p_request;
    IF NOT FOUND OR r.state<>'APPROVED' OR r.submission_number<1 OR r.submitter_id IS NULL OR r.decided_by IS NULL
       OR r.decided_by IN (r.author_id,r.submitter_id) THEN
        RAISE EXCEPTION 'R07: request provenance incomplete (state, submission or decision)' USING ERRCODE='23514';
    END IF;
    SELECT payload,submitted_by INTO s FROM gpr2_quantity_submissions
      WHERE tenant_id=p_tenant AND object_id=p_object AND request_id=p_request AND number=r.submission_number;
    IF NOT FOUND OR s.submitted_by IS DISTINCT FROM r.submitter_id
       OR s.payload->>'workId' IS DISTINCT FROM r.work_id::text
       OR s.payload->>'quantityVersionId' IS DISTINCT FROM r.quantity_version_id::text
       OR (s.payload->>'newQuantity')::numeric IS DISTINCT FROM r.proposed_quantity
       OR s.payload->'allocation' IS DISTINCT FROM r.allocation OR s.payload->'surface' IS DISTINCT FROM r.surface THEN
        RAISE EXCEPTION 'R07: request provenance incomplete (submitted snapshot does not match the request)' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM gpr2_quantity_events e WHERE e.tenant_id=p_tenant AND e.object_id=p_object AND e.request_id=p_request
                  AND e.submission_number=r.submission_number AND e.action='SUBMIT' AND e.actor_id=r.submitter_id)
       OR NOT EXISTS(SELECT 1 FROM gpr2_quantity_events e WHERE e.tenant_id=p_tenant AND e.object_id=p_object AND e.request_id=p_request
                  AND e.submission_number=r.submission_number AND e.action='APPROVE' AND e.actor_id=r.decided_by) THEN
        RAISE EXCEPTION 'R07: request provenance incomplete (no SUBMIT / APPROVE event of this submission)' USING ERRCODE='23514';
    END IF;
END $$;

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

-- R07-REV-03c. The same protected evidence, per PORTION: an allocation snapshot must keep every portion at or above its own RP fact, INTERNAL_SC or
-- customer-accepted quantity (a missing line counts as zero), even when the Work total is above the Work floor. Facts on disjoint portions add; kinds overlap by max.
CREATE FUNCTION gpr2_r07_assert_portion_floor(p_tenant uuid,p_object uuid,p_work uuid,p_version uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS(
        SELECT 1 FROM (
            SELECT p.id, greatest(
                coalesce((SELECT max(f.quantity) FROM portion_quantity_confirmations f WHERE f.tenant_id=p.tenant_id AND f.portion_id=p.id AND f.source='RP_FACT'),0),
                coalesce((SELECT max(f.quantity) FROM portion_quantity_confirmations f WHERE f.tenant_id=p.tenant_id AND f.portion_id=p.id AND f.source='INTERNAL_SC'),0),
                coalesce((SELECT max(f.quantity) FROM documentation_customer_accepted_quantities f WHERE f.tenant_id=p.tenant_id AND f.quantity_portion_id=p.id),0)) AS floor,
                p.tenant_id
            FROM quantity_portions p JOIN work_execution_units u ON u.tenant_id=p.tenant_id AND u.id=p.execution_unit_id
            WHERE p.tenant_id=p_tenant AND u.object_work_id=p_work) f
        WHERE f.floor>0 AND coalesce((SELECT sum(l.quantity) FROM work_allocation_lines l WHERE l.tenant_id=f.tenant_id AND l.object_id=p_object
              AND l.work_id=p_work AND l.version_id=p_version AND l.portion_id=f.id),0) < f.floor) THEN
        RAISE EXCEPTION 'R07: BELOW_PROTECTED_QUANTITY (a portion is allocated below its own protected evidence)' USING ERRCODE='23514';
    END IF;
END $$;

CREATE FUNCTION gpr2_r07_quantity_pointer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v record; r record; planned numeric; old_v record;
BEGIN
    SELECT quantity,source_kind,approved_request_id,previous_id,sequence INTO v FROM work_quantity_versions WHERE tenant_id=NEW.tenant_id
      AND object_id=NEW.object_id AND work_id=NEW.work_id AND id=NEW.approved_version_id;
    SELECT state,work_id,quantity_version_id,proposed_quantity INTO r FROM gpr2_quantity_requests WHERE tenant_id=NEW.tenant_id AND object_id=NEW.object_id AND id=v.approved_request_id;
    IF v.source_kind IS DISTINCT FROM 'APPROVED_REQUEST' OR r.state IS DISTINCT FROM 'APPROVED' OR
      (r.work_id IS DISTINCT FROM NEW.work_id AND NOT EXISTS(SELECT 1 FROM gpr2_surface_effects e JOIN gpr2_surface_changes s ON s.id=e.surface_change_id
        WHERE s.tenant_id=NEW.tenant_id AND s.object_id=NEW.object_id AND s.request_id=v.approved_request_id AND e.work_id=NEW.work_id)) THEN
        RAISE EXCEPTION 'R07: quantity pointer requires approved request' USING ERRCODE='23514';
    END IF;
    -- R07-REV-03a: the request must be complete, consistent and decided by somebody else, not merely marked APPROVED
    PERFORM gpr2_r07_assert_request_provenance(NEW.tenant_id,NEW.object_id,v.approved_request_id);
    -- R07-REV-03b: the new version must be built on exactly the version being replaced, and (for the request's own Work) on the version the request was
    -- written against; a request already consumed, or written against an older version, cannot be applied to a newer pointer. A surface sibling is bound
    -- through its recorded effect: old quantity = the version replaced, new quantity = the new version.
    SELECT quantity,sequence INTO old_v FROM work_quantity_versions WHERE tenant_id=NEW.tenant_id AND object_id=NEW.object_id AND work_id=NEW.work_id AND id=OLD.approved_version_id;
    IF v.previous_id IS DISTINCT FROM OLD.approved_version_id OR v.sequence IS DISTINCT FROM old_v.sequence+1 THEN
        RAISE EXCEPTION 'R07: quantity version must advance the pointer being replaced by one' USING ERRCODE='23514';
    END IF;
    IF r.work_id=NEW.work_id THEN
        IF r.quantity_version_id IS DISTINCT FROM OLD.approved_version_id OR v.quantity IS DISTINCT FROM r.proposed_quantity THEN
            RAISE EXCEPTION 'R07: request is stale for this Work (source version or approved quantity differs)' USING ERRCODE='23514';
        END IF;
    ELSIF NOT EXISTS(SELECT 1 FROM gpr2_surface_effects e JOIN gpr2_surface_changes s ON s.id=e.surface_change_id
        WHERE s.tenant_id=NEW.tenant_id AND s.object_id=NEW.object_id AND s.request_id=v.approved_request_id AND e.work_id=NEW.work_id
          AND e.old_quantity=old_v.quantity AND e.new_quantity=v.quantity) THEN
        RAISE EXCEPTION 'R07: surface effect is stale for this Work (old or new quantity differs)' USING ERRCODE='23514';
    END IF;
    PERFORM gpr2_r07_assert_floor(NEW.tenant_id,NEW.object_id,NEW.work_id,v.quantity);
    SELECT coalesce(sum(planned_quantity),0) INTO planned FROM work_execution_units
      WHERE tenant_id=NEW.tenant_id AND object_work_id=NEW.work_id;
    IF planned>v.quantity AND NOT EXISTS(SELECT 1 FROM work_current_allocation a JOIN work_allocation_versions av
       ON av.tenant_id=a.tenant_id AND av.object_id=a.object_id AND av.work_id=a.work_id AND av.id=a.version_id
       WHERE a.tenant_id=NEW.tenant_id AND a.object_id=NEW.object_id AND a.work_id=NEW.work_id
         AND av.quantity_version_id=NEW.approved_version_id AND av.approved_request_id=v.approved_request_id
         AND EXISTS(SELECT 1 FROM work_allocation_lines l WHERE l.tenant_id=a.tenant_id AND l.object_id=a.object_id
           AND l.version_id=a.version_id AND l.portion_id IS NULL AND l.quantity>0)) THEN
        RAISE EXCEPTION 'R07: reduced Work requires coherent allocation snapshot' USING ERRCODE='23514';
    END IF;
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
        IF approved IS DISTINCT FROM 'APPROVED' OR v.quantity_version_id IS DISTINCT FROM current_q.approved_version_id
           OR (SELECT approved_request_id FROM work_quantity_versions WHERE id=current_q.approved_version_id) IS DISTINCT FROM v.approved_request_id THEN
            RAISE EXCEPTION 'R07: allocation pointer requires approved quantity request' USING ERRCODE='23514';
        END IF;
        PERFORM gpr2_r07_assert_request_provenance(NEW.tenant_id,NEW.object_id,v.approved_request_id);
        PERFORM gpr2_r07_assert_floor(NEW.tenant_id,NEW.object_id,NEW.work_id,current_q.quantity);
        PERFORM gpr2_r07_assert_portion_floor(NEW.tenant_id,NEW.object_id,NEW.work_id,NEW.version_id);
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
