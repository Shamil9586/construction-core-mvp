-- migration-class: additive
-- GPR-2 R05a — one WorkType model with two scopes, CORPORATE and OBJECT, and the explicit publication request (Technical Design §5.2
-- `work_types` / `work_type_publication_requests`, §11.2–11.3; decisions D03, D05; scenarios A03, A19).
--
-- ADDITIVE ONLY. Every existing work_types row keeps its id, name, unit and category; nothing is merged, re-pointed or re-classified by hand:
--   * scope is added NOT NULL with the constant default 'CORPORATE' (catalogue-only since PostgreSQL 11, no table rewrite). Every row that exists
--     today was created through the tenant-wide dictionary (POST dictionaries/work-types, ADMIN_DICTIONARIES) and carries no object, so CORPORATE is
--     what it already is — this states the existing fact, it does not decide a new one;
--   * object_id / origin_object_id / alias_of_work_type_id / created_by are added NULL; no existing row receives a value;
--   * a new UNIQUE index (tenant_id, object_id, id) on works lets the R05 tables point at a Work of the SAME object by foreign key. It is an index,
--     not a change of any row; it takes a SHARE lock on works for one scan (release plan, R22).
-- Works / WEU / QuantityPortion / confirmations / history are not touched: no column of theirs changes, no row is written.
--
-- What PostgreSQL itself now guarantees (not only the API):
--   * a WorkType is CORPORATE (no object) or OBJECT (exactly one object of the same tenant) — CHECK + composite FK;
--   * an OBJECT WorkType never becomes CORPORATE by itself: the only permitted scope change is OBJECT -> CORPORATE, and only while an APPROVED
--     publication request with outcome PROMOTED exists for it (the Admin's explicit act). CORPORATE -> OBJECT and any other move are refused;
--   * an alias to a reviewed corporate WorkType is set only by an APPROVED request with outcome ALIASED, only once, only to a CORPORATE type of the
--     same tenant and the same unit — and an alias rewrites nothing: historical Work references keep the id they have;
--   * the unit of a WorkType that any Work or execution unit references cannot change;
--   * a Work or an execution unit may use an OBJECT WorkType only inside that object (cross-object reference refused, same tenant or not);
--   * a publication request is append-only in its decided state, never deleted; one PENDING and at most one APPROVED request per WorkType.
-- Rejection writes nothing to the WorkType row: the object type stays exactly as it was (D05).

ALTER TABLE work_types ADD COLUMN scope text NOT NULL DEFAULT 'CORPORATE';
ALTER TABLE work_types ADD COLUMN object_id uuid;
ALTER TABLE work_types ADD COLUMN origin_object_id uuid;
ALTER TABLE work_types ADD COLUMN alias_of_work_type_id uuid;
ALTER TABLE work_types ADD COLUMN created_by uuid;

ALTER TABLE work_types ADD CONSTRAINT work_types_scope_check CHECK (scope IN ('CORPORATE','OBJECT')) NOT VALID;
ALTER TABLE work_types VALIDATE CONSTRAINT work_types_scope_check;
ALTER TABLE work_types ADD CONSTRAINT work_types_scope_object_check CHECK ((scope = 'CORPORATE' AND object_id IS NULL) OR (scope = 'OBJECT' AND object_id IS NOT NULL)) NOT VALID;
ALTER TABLE work_types VALIDATE CONSTRAINT work_types_scope_object_check;
-- An object type is born in its object and remembers it; a corporate type has an origin only if it was promoted from an object.
ALTER TABLE work_types ADD CONSTRAINT work_types_origin_check CHECK (scope <> 'OBJECT' OR origin_object_id = object_id) NOT VALID;
ALTER TABLE work_types VALIDATE CONSTRAINT work_types_origin_check;
ALTER TABLE work_types ADD CONSTRAINT work_types_alias_check CHECK (alias_of_work_type_id IS NULL OR (scope = 'OBJECT' AND alias_of_work_type_id <> id)) NOT VALID;
ALTER TABLE work_types VALIDATE CONSTRAINT work_types_alias_check;

ALTER TABLE work_types ADD CONSTRAINT work_types_object_fk FOREIGN KEY (tenant_id, object_id) REFERENCES objects(tenant_id, id);
ALTER TABLE work_types ADD CONSTRAINT work_types_origin_object_fk FOREIGN KEY (tenant_id, origin_object_id) REFERENCES objects(tenant_id, id);
ALTER TABLE work_types ADD CONSTRAINT work_types_alias_fk FOREIGN KEY (tenant_id, alias_of_work_type_id) REFERENCES work_types(tenant_id, id);
ALTER TABLE work_types ADD CONSTRAINT work_types_created_by_fk FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id);
CREATE UNIQUE INDEX work_types_tenant_origin_id_uq ON work_types(tenant_id, origin_object_id, id);
CREATE INDEX work_types_object_idx ON work_types(tenant_id, object_id) WHERE object_id IS NOT NULL;

-- The R05 tables refer to "a Work of THIS object" by composite FK.
CREATE UNIQUE INDEX works_tenant_object_id_uq ON works(tenant_id, object_id, id);

CREATE TABLE work_type_publication_requests(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    object_id uuid NOT NULL,
    work_type_id uuid NOT NULL,
    work_type_version int NOT NULL CHECK (work_type_version > 0),
    -- the corporate metadata proposed, as the WorkType stood when the request was made (a snapshot, never re-read)
    proposed_name text NOT NULL CHECK (btrim(proposed_name) <> ''),
    proposed_category_id uuid NOT NULL,
    proposed_unit text NOT NULL CHECK (btrim(proposed_unit) <> ''),
    justification text,
    requested_by uuid NOT NULL,
    status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
    outcome text CHECK (outcome IS NULL OR outcome IN ('PROMOTED','ALIASED')),
    alias_of_work_type_id uuid,
    decided_by uuid,
    decided_at timestamptz,
    decision_reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version int NOT NULL DEFAULT 1 CHECK (version > 0),
    UNIQUE(tenant_id, id),
    FOREIGN KEY (tenant_id, object_id) REFERENCES objects(tenant_id, id),
    -- the requested type must be a type born in THIS object (origin_object_id is immutable, so the link survives a promotion)
    FOREIGN KEY (tenant_id, object_id, work_type_id) REFERENCES work_types(tenant_id, origin_object_id, id),
    FOREIGN KEY (tenant_id, proposed_category_id) REFERENCES work_categories(tenant_id, id),
    FOREIGN KEY (tenant_id, requested_by) REFERENCES users(tenant_id, id),
    FOREIGN KEY (tenant_id, decided_by) REFERENCES users(tenant_id, id),
    FOREIGN KEY (tenant_id, alias_of_work_type_id) REFERENCES work_types(tenant_id, id),
    CHECK (status <> 'PENDING' OR (outcome IS NULL AND alias_of_work_type_id IS NULL AND decided_by IS NULL AND decided_at IS NULL AND decision_reason IS NULL)),
    CHECK (status <> 'APPROVED' OR (outcome IS NOT NULL AND decided_by IS NOT NULL AND decided_at IS NOT NULL)),
    CHECK (status <> 'REJECTED' OR (outcome IS NULL AND alias_of_work_type_id IS NULL AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND btrim(coalesce(decision_reason, '')) <> '')),
    CHECK ((outcome = 'ALIASED') = (alias_of_work_type_id IS NOT NULL) OR outcome IS NULL)
);
CREATE INDEX work_type_publication_requests_object_idx ON work_type_publication_requests(tenant_id, object_id, created_at);
CREATE UNIQUE INDEX work_type_publication_requests_one_pending ON work_type_publication_requests(tenant_id, work_type_id) WHERE status = 'PENDING';
CREATE UNIQUE INDEX work_type_publication_requests_one_approved ON work_type_publication_requests(tenant_id, work_type_id) WHERE status = 'APPROVED';

-- A request is decided once. PENDING -> APPROVED | REJECTED with version + 1; nothing else of the row changes; a decided row is frozen; no row is ever removed.
CREATE FUNCTION gpr2_publication_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'GPR2_R05:APPEND_ONLY work_type_publication_requests rows are never removed' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status <> 'PENDING' THEN
        RAISE EXCEPTION 'GPR2_R05:DECIDED_IMMUTABLE a decided publication request is immutable' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status NOT IN ('APPROVED','REJECTED') OR NEW.version <> OLD.version + 1 OR NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id
       OR NEW.object_id <> OLD.object_id OR NEW.work_type_id <> OLD.work_type_id OR NEW.work_type_version <> OLD.work_type_version
       OR NEW.proposed_name <> OLD.proposed_name OR NEW.proposed_category_id <> OLD.proposed_category_id OR NEW.proposed_unit <> OLD.proposed_unit
       OR NEW.justification IS DISTINCT FROM OLD.justification OR NEW.requested_by <> OLD.requested_by OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'GPR2_R05:INVALID_DECISION only the decision may be written onto a pending request' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER gpr2_publication_request_guard BEFORE UPDATE OR DELETE ON work_type_publication_requests FOR EACH ROW EXECUTE FUNCTION gpr2_publication_request_guard();

-- The WorkType side of the same rule.
CREATE FUNCTION gpr2_work_type_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target record;
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- A corporate type with an origin or an alias exists only as the result of an approved request, never as an INSERT.
        IF NEW.scope = 'CORPORATE' AND NEW.origin_object_id IS NOT NULL THEN
            RAISE EXCEPTION 'GPR2_R05:SCOPE_CHANGE_FORBIDDEN a corporate WorkType cannot be inserted with an object origin' USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.alias_of_work_type_id IS NOT NULL THEN
            RAISE EXCEPTION 'GPR2_R05:ALIAS_FORBIDDEN an alias is set only by an approved publication request' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.origin_object_id IS DISTINCT FROM OLD.origin_object_id OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
        RAISE EXCEPTION 'GPR2_R05:IDENTITY_IMMUTABLE the identity of a WorkType is immutable' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.scope IS DISTINCT FROM OLD.scope OR NEW.object_id IS DISTINCT FROM OLD.object_id THEN
        IF NOT (OLD.scope = 'OBJECT' AND NEW.scope = 'CORPORATE' AND NEW.object_id IS NULL AND EXISTS (
                SELECT 1 FROM work_type_publication_requests r
                WHERE r.tenant_id = OLD.tenant_id AND r.work_type_id = OLD.id AND r.status = 'APPROVED' AND r.outcome = 'PROMOTED')) THEN
            RAISE EXCEPTION 'GPR2_R05:SCOPE_CHANGE_FORBIDDEN a WorkType changes scope only OBJECT -> CORPORATE through an approved publication' USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    IF NEW.alias_of_work_type_id IS DISTINCT FROM OLD.alias_of_work_type_id THEN
        IF OLD.alias_of_work_type_id IS NOT NULL OR NOT EXISTS (
                SELECT 1 FROM work_type_publication_requests r
                WHERE r.tenant_id = OLD.tenant_id AND r.work_type_id = OLD.id AND r.status = 'APPROVED' AND r.outcome = 'ALIASED'
                  AND r.alias_of_work_type_id = NEW.alias_of_work_type_id) THEN
            RAISE EXCEPTION 'GPR2_R05:ALIAS_FORBIDDEN an alias is set once, only by an approved publication request' USING ERRCODE = 'check_violation';
        END IF;
        SELECT scope, unit INTO target FROM work_types WHERE tenant_id = NEW.tenant_id AND id = NEW.alias_of_work_type_id;
        IF target.scope IS DISTINCT FROM 'CORPORATE' OR target.unit IS DISTINCT FROM NEW.unit THEN
            RAISE EXCEPTION 'GPR2_R05:ALIAS_FORBIDDEN an alias names a corporate WorkType of the same unit' USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    IF NEW.unit IS DISTINCT FROM OLD.unit AND (
            EXISTS (SELECT 1 FROM works w WHERE w.tenant_id = OLD.tenant_id AND w.work_type_id = OLD.id)
         OR EXISTS (SELECT 1 FROM work_execution_units u WHERE u.tenant_id = OLD.tenant_id AND u.work_type_id = OLD.id)) THEN
        RAISE EXCEPTION 'GPR2_R05:UNIT_IMMUTABLE the unit of a referenced WorkType cannot change' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER gpr2_work_type_scope_guard BEFORE INSERT OR UPDATE ON work_types FOR EACH ROW EXECUTE FUNCTION gpr2_work_type_scope_guard();

-- An OBJECT WorkType is usable only inside its object: by a Work of that object, and by an execution unit of a Work of that object.
CREATE FUNCTION gpr2_work_type_use_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE wt record; owner_object uuid;
BEGIN
    SELECT scope, object_id INTO wt FROM work_types WHERE tenant_id = NEW.tenant_id AND id = NEW.work_type_id;
    IF wt.scope = 'OBJECT' THEN
        IF TG_TABLE_NAME = 'works' THEN
            owner_object := NEW.object_id;
        ELSE
            SELECT object_id INTO owner_object FROM works WHERE tenant_id = NEW.tenant_id AND id = NEW.object_work_id;
        END IF;
        IF owner_object IS DISTINCT FROM wt.object_id THEN
            RAISE EXCEPTION 'GPR2_R05:CROSS_SCOPE_REFERENCE an object WorkType is used outside its object' USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER gpr2_work_type_use_guard BEFORE INSERT OR UPDATE OF work_type_id, object_id ON works FOR EACH ROW EXECUTE FUNCTION gpr2_work_type_use_guard();
CREATE TRIGGER gpr2_work_type_use_guard BEFORE INSERT OR UPDATE OF work_type_id, object_work_id ON work_execution_units FOR EACH ROW EXECUTE FUNCTION gpr2_work_type_use_guard();
