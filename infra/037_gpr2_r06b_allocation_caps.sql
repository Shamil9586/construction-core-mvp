-- migration-class: additive
-- R06b: explicit allocation snapshots. Existing WEU/portion plans are not silently converted.
CREATE UNIQUE INDEX work_execution_units_r06b_identity ON work_execution_units(tenant_id,object_work_id,id);
CREATE UNIQUE INDEX quantity_portions_r06b_identity ON quantity_portions(tenant_id,execution_unit_id,id);

CREATE TABLE work_allocation_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    object_id uuid NOT NULL,
    work_id uuid NOT NULL,
    sequence int NOT NULL CHECK(sequence>0),
    previous_id uuid,
    quantity_version_id uuid NOT NULL,
    unit text NOT NULL CHECK(length(btrim(unit))>0),
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(tenant_id,object_id,id),
    UNIQUE(tenant_id,object_id,work_id,id),
    UNIQUE(tenant_id,object_id,work_id,sequence),
    CHECK ((sequence=1 AND previous_id IS NULL) OR (sequence>1 AND previous_id IS NOT NULL)),
    FOREIGN KEY(tenant_id,object_id,work_id,quantity_version_id) REFERENCES work_quantity_versions(tenant_id,object_id,work_id,id),
    FOREIGN KEY(tenant_id,object_id,work_id,previous_id) REFERENCES work_allocation_versions(tenant_id,object_id,work_id,id),
    FOREIGN KEY(tenant_id,created_by) REFERENCES users(tenant_id,id)
);
CREATE TABLE work_allocation_lines (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    object_id uuid NOT NULL,
    work_id uuid NOT NULL,
    version_id uuid NOT NULL,
    execution_unit_id uuid NOT NULL,
    portion_id uuid,
    quantity numeric(24,4) NOT NULL CHECK(quantity>=0),
    unit text NOT NULL CHECK(length(btrim(unit))>0),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(tenant_id,object_id,version_id,execution_unit_id,portion_id),
    FOREIGN KEY(tenant_id,object_id,work_id,version_id) REFERENCES work_allocation_versions(tenant_id,object_id,work_id,id),
    FOREIGN KEY(tenant_id,work_id,execution_unit_id) REFERENCES work_execution_units(tenant_id,object_work_id,id),
    FOREIGN KEY(tenant_id,execution_unit_id,portion_id) REFERENCES quantity_portions(tenant_id,execution_unit_id,id)
);
CREATE UNIQUE INDEX work_allocation_unit_line ON work_allocation_lines(tenant_id,object_id,version_id,execution_unit_id) WHERE portion_id IS NULL;
CREATE UNIQUE INDEX work_allocation_portion_line ON work_allocation_lines(tenant_id,object_id,version_id,portion_id) WHERE portion_id IS NOT NULL;
CREATE TABLE work_current_allocation (
    tenant_id uuid NOT NULL,
    object_id uuid NOT NULL,
    work_id uuid NOT NULL,
    version_id uuid NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(tenant_id,object_id,work_id),
    FOREIGN KEY(tenant_id,object_id,work_id,version_id) REFERENCES work_allocation_versions(tenant_id,object_id,work_id,id)
);

CREATE FUNCTION r06b_allocation_validate(p_tenant uuid,p_object uuid,p_work uuid,p_version uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v record; current_q numeric(24,4); current_unit text; bad boolean;
BEGIN
    -- One shared row lock serializes direct SQL and service writers against the approved Work quantity.
    SELECT q.quantity,q.unit INTO current_q,current_unit FROM work_current_quantity p
      JOIN work_quantity_versions q ON (q.tenant_id=p.tenant_id AND q.object_id=p.object_id AND q.work_id=p.work_id AND q.id=p.approved_version_id)
      WHERE p.tenant_id=p_tenant AND p.object_id=p_object AND p.work_id=p_work FOR UPDATE OF p;
    IF NOT FOUND THEN RAISE EXCEPTION 'R06B: allocation requires a proven current quantity' USING ERRCODE='23514'; END IF;
    SELECT * INTO v FROM work_allocation_versions WHERE tenant_id=p_tenant AND object_id=p_object AND work_id=p_work AND id=p_version;
    IF v.unit<>current_unit OR v.quantity_version_id<>(SELECT approved_version_id FROM work_current_quantity WHERE tenant_id=p_tenant AND object_id=p_object AND work_id=p_work)
       THEN RAISE EXCEPTION 'R06B: allocation unit/current version mismatch' USING ERRCODE='23514'; END IF;
    SELECT coalesce(sum(l.quantity),0)>current_q OR bool_or(l.unit<>current_unit OR l.quantity>u.planned_quantity)
      INTO bad FROM work_allocation_lines l JOIN work_execution_units u ON u.tenant_id=l.tenant_id AND u.id=l.execution_unit_id
      WHERE l.tenant_id=p_tenant AND l.object_id=p_object AND l.version_id=p_version AND l.portion_id IS NULL;
    IF bad THEN RAISE EXCEPTION 'R06B: Work allocation cap or unit mismatch' USING ERRCODE='23514'; END IF;
    SELECT bool_or(l.unit<>current_unit OR l.quantity>p.planned_quantity OR
      l.quantity>coalesce((SELECT uline.quantity FROM work_allocation_lines uline WHERE uline.tenant_id=l.tenant_id
        AND uline.object_id=l.object_id AND uline.version_id=l.version_id AND uline.execution_unit_id=l.execution_unit_id AND uline.portion_id IS NULL),-1))
      INTO bad FROM work_allocation_lines l JOIN quantity_portions p ON p.tenant_id=l.tenant_id AND p.id=l.portion_id
      WHERE l.tenant_id=p_tenant AND l.object_id=p_object AND l.version_id=p_version AND l.portion_id IS NOT NULL;
    IF bad THEN RAISE EXCEPTION 'R06B: portion allocation cap or unit mismatch' USING ERRCODE='23514'; END IF;
    SELECT EXISTS (SELECT 1 FROM work_allocation_lines l WHERE l.tenant_id=p_tenant AND l.object_id=p_object AND l.version_id=p_version
      AND l.portion_id IS NOT NULL GROUP BY l.execution_unit_id HAVING sum(l.quantity)>
       (SELECT uline.quantity FROM work_allocation_lines uline WHERE uline.tenant_id=p_tenant AND uline.object_id=p_object
         AND uline.version_id=p_version AND uline.execution_unit_id=l.execution_unit_id AND uline.portion_id IS NULL)) INTO bad;
    IF bad THEN RAISE EXCEPTION 'R06B: sum of portions exceeds unit allocation' USING ERRCODE='23514'; END IF;
END $$;

CREATE FUNCTION r06b_allocation_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pointer_xid text; line_xid text; pointer_version uuid;
BEGIN
    SELECT version_id,xmin::text INTO pointer_version,pointer_xid FROM work_current_allocation
       WHERE tenant_id=NEW.tenant_id AND object_id=NEW.object_id AND work_id=NEW.work_id;
    SELECT xmin::text INTO line_xid FROM work_allocation_lines WHERE id=NEW.id;
    IF pointer_version IS NOT NULL AND (pointer_version<>NEW.version_id OR pointer_xid<>line_xid) THEN
        RAISE EXCEPTION 'R06B: historical allocation is immutable' USING ERRCODE='23514';
    END IF;
    PERFORM r06b_allocation_validate(NEW.tenant_id,NEW.object_id,NEW.work_id,NEW.version_id);
    RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER r06b_line_validate AFTER INSERT ON work_allocation_lines DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION r06b_allocation_line_guard();
CREATE FUNCTION r06b_pointer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v record;
BEGIN
    IF TG_OP='UPDATE' AND (OLD.tenant_id,OLD.object_id,OLD.work_id) IS DISTINCT FROM (NEW.tenant_id,NEW.object_id,NEW.work_id) THEN
        RAISE EXCEPTION 'R06B: pointer identity immutable' USING ERRCODE='23514';
    END IF;
    SELECT sequence,previous_id INTO v FROM work_allocation_versions WHERE tenant_id=NEW.tenant_id AND object_id=NEW.object_id AND work_id=NEW.work_id AND id=NEW.version_id;
    IF (TG_OP='INSERT' AND v.sequence<>1) OR (TG_OP='UPDATE' AND (v.previous_id<>OLD.version_id OR
       v.sequence<>(SELECT sequence+1 FROM work_allocation_versions WHERE id=OLD.version_id))) THEN
       RAISE EXCEPTION 'R06B: pointer must advance by one version' USING ERRCODE='23514';
    END IF;
    -- Conservative R06b floor: after any fact/SC/customer evidence, freeze the
    -- snapshot. R07 will coordinate scoped adjustments with fact writers; a
    -- partial R02 interpretation inside a SQL trigger would invent provenance.
    IF EXISTS (SELECT 1 FROM works w WHERE w.tenant_id=NEW.tenant_id AND w.object_id=NEW.object_id AND w.id=NEW.work_id AND
       (w.actual_quantity>0 OR EXISTS(SELECT 1 FROM work_progress p WHERE p.tenant_id=w.tenant_id AND p.object_work_id=w.id)
        OR EXISTS(SELECT 1 FROM work_execution_units u JOIN quantity_portions p ON p.tenant_id=u.tenant_id AND p.execution_unit_id=u.id
          JOIN portion_quantity_confirmations f ON f.tenant_id=p.tenant_id AND f.portion_id=p.id
          WHERE u.tenant_id=w.tenant_id AND u.object_work_id=w.id)
        OR EXISTS(SELECT 1 FROM work_execution_units u JOIN quantity_portions p ON p.tenant_id=u.tenant_id AND p.execution_unit_id=u.id
          JOIN documentation_customer_accepted_quantities f ON f.tenant_id=p.tenant_id AND f.quantity_portion_id=p.id
          WHERE u.tenant_id=w.tenant_id AND u.object_work_id=w.id))) THEN
       RAISE EXCEPTION 'R06B: allocation is frozen after confirmed evidence' USING ERRCODE='23514';
    END IF;
    PERFORM r06b_allocation_validate(NEW.tenant_id,NEW.object_id,NEW.work_id,NEW.version_id);
    RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER r06b_pointer_validate AFTER INSERT OR UPDATE ON work_current_allocation DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION r06b_pointer_guard();
CREATE FUNCTION r06b_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    RAISE EXCEPTION 'R06B: immutable allocation history' USING ERRCODE='23514';
END $$;
CREATE TRIGGER r06b_version_immutable BEFORE UPDATE OR DELETE ON work_allocation_versions FOR EACH ROW EXECUTE FUNCTION r06b_immutable();
CREATE TRIGGER r06b_line_immutable BEFORE UPDATE OR DELETE ON work_allocation_lines FOR EACH ROW EXECUTE FUNCTION r06b_immutable();
CREATE TRIGGER r06b_pointer_no_delete BEFORE DELETE ON work_current_allocation FOR EACH ROW EXECUTE FUNCTION r06b_immutable();

-- Newly written planned rows cannot overrun a known approved current cap. Historical rows remain unchanged.
CREATE FUNCTION r06b_planned_cap_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE oid uuid; limit_q numeric; total numeric;
BEGIN
    IF TG_TABLE_NAME='work_execution_units' THEN
        SELECT object_id INTO oid FROM works WHERE tenant_id=NEW.tenant_id AND id=NEW.object_work_id;
        SELECT v.quantity INTO limit_q FROM work_current_quantity p JOIN work_quantity_versions v ON v.id=p.approved_version_id
          WHERE p.tenant_id=NEW.tenant_id AND p.object_id=oid AND p.work_id=NEW.object_work_id FOR UPDATE OF p;
        IF limit_q IS NOT NULL THEN
            SELECT coalesce(sum(planned_quantity),0) INTO total FROM work_execution_units WHERE tenant_id=NEW.tenant_id AND object_work_id=NEW.object_work_id;
            IF total>limit_q THEN RAISE EXCEPTION 'R06B: Work planned WEU cap exceeded' USING ERRCODE='23514'; END IF;
        END IF;
        SELECT coalesce(sum(planned_quantity),0) INTO total FROM quantity_portions
          WHERE tenant_id=NEW.tenant_id AND execution_unit_id=NEW.id;
        IF total>NEW.planned_quantity THEN RAISE EXCEPTION 'R06B: WEU plan below planned portion sum' USING ERRCODE='23514'; END IF;
        IF EXISTS (SELECT 1 FROM work_current_allocation a JOIN work_allocation_lines l
          ON l.tenant_id=a.tenant_id AND l.object_id=a.object_id AND l.version_id=a.version_id
          WHERE a.tenant_id=NEW.tenant_id AND a.work_id=NEW.object_work_id AND l.execution_unit_id=NEW.id
            AND l.portion_id IS NULL AND l.quantity>NEW.planned_quantity) THEN
          RAISE EXCEPTION 'R06B: WEU plan below current allocation' USING ERRCODE='23514';
        END IF;
    ELSE
        PERFORM 1 FROM work_execution_units WHERE tenant_id=NEW.tenant_id AND id=NEW.execution_unit_id FOR UPDATE;
        SELECT planned_quantity INTO limit_q FROM work_execution_units WHERE tenant_id=NEW.tenant_id AND id=NEW.execution_unit_id;
        SELECT coalesce(sum(planned_quantity),0) INTO total FROM quantity_portions WHERE tenant_id=NEW.tenant_id AND execution_unit_id=NEW.execution_unit_id;
        IF total>limit_q THEN RAISE EXCEPTION 'R06B: WEU planned portion cap exceeded' USING ERRCODE='23514'; END IF;
        IF EXISTS (SELECT 1 FROM work_current_allocation a JOIN work_allocation_lines l
          ON l.tenant_id=a.tenant_id AND l.object_id=a.object_id AND l.version_id=a.version_id
          WHERE a.tenant_id=NEW.tenant_id AND l.portion_id=NEW.id AND l.quantity>NEW.planned_quantity) THEN
          RAISE EXCEPTION 'R06B: portion plan below current allocation' USING ERRCODE='23514';
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER r06b_weu_cap AFTER INSERT OR UPDATE OF planned_quantity,object_work_id ON work_execution_units FOR EACH ROW EXECUTE FUNCTION r06b_planned_cap_guard();
CREATE TRIGGER r06b_portion_cap AFTER INSERT OR UPDATE OF planned_quantity,execution_unit_id ON quantity_portions FOR EACH ROW EXECUTE FUNCTION r06b_planned_cap_guard();
CREATE FUNCTION r06b_current_quantity_allocation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE aid uuid;
BEGIN
    SELECT version_id INTO aid FROM work_current_allocation WHERE tenant_id=NEW.tenant_id AND object_id=NEW.object_id AND work_id=NEW.work_id;
    IF aid IS NOT NULL THEN PERFORM r06b_allocation_validate(NEW.tenant_id,NEW.object_id,NEW.work_id,aid); END IF;
    RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER r06b_current_quantity_cap AFTER UPDATE OF approved_version_id ON work_current_quantity
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION r06b_current_quantity_allocation_guard();
