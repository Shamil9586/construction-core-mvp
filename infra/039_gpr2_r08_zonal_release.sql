-- migration-class: additive
-- R08 additive offline candidate, conditionally numbered after R07/038.
-- Existing work_dependencies remain legacy context; no historical rows are inferred here.

CREATE TABLE gpr2_internal_sc_policy_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    object_id uuid NOT NULL,
    version integer NOT NULL CHECK (version > 0),
    policy text NOT NULL CHECK (policy IN ('REQUIRED','NOT_REQUIRED')),
    basis text NOT NULL CHECK (btrim(basis) <> ''),
    actor_id uuid NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, object_id, id),
    UNIQUE (tenant_id, object_id, version),
    FOREIGN KEY (tenant_id, object_id) REFERENCES objects(tenant_id, id),
    FOREIGN KEY (tenant_id, actor_id) REFERENCES users(tenant_id, id)
);

CREATE TABLE gpr2_current_internal_sc_policy (
    tenant_id uuid NOT NULL,
    object_id uuid NOT NULL,
    version_id uuid NOT NULL,
    PRIMARY KEY (tenant_id, object_id),
    FOREIGN KEY (tenant_id, object_id, version_id)
      REFERENCES gpr2_internal_sc_policy_versions(tenant_id, object_id, id)
);

-- Each requirement binds a specific target and prerequisite source. NULL scope is
-- prohibited: unknown legacy location is not a match for a chosen target zone.
CREATE TABLE gpr2_execution_unit_area_scopes (
    tenant_id uuid NOT NULL,
    object_id uuid NOT NULL,
    work_id uuid NOT NULL,
    execution_unit_id uuid NOT NULL,
    area_scope_id uuid NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, object_id, execution_unit_id, area_scope_id),
    UNIQUE (tenant_id, object_id, execution_unit_id),
    FOREIGN KEY (tenant_id, object_id, work_id) REFERENCES works(tenant_id, object_id, id),
    FOREIGN KEY (tenant_id, execution_unit_id) REFERENCES work_execution_units(tenant_id, id),
    FOREIGN KEY (tenant_id, object_id, area_scope_id) REFERENCES object_area_scopes(tenant_id, object_id, id),
    FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id)
);

CREATE TABLE technical_release_requirements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    object_id uuid NOT NULL,
    target_work_id uuid NOT NULL,
    target_execution_unit_id uuid NOT NULL,
    target_area_scope_id uuid NOT NULL,
    source_work_id uuid NOT NULL,
    source_execution_unit_id uuid NOT NULL,
    source_area_scope_id uuid NOT NULL,
    requires_internal_sc boolean NOT NULL,
    cure_days integer NOT NULL DEFAULT 0 CHECK (cure_days >= 0),
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, object_id, id),
    UNIQUE (tenant_id, object_id, target_execution_unit_id, target_area_scope_id,
            source_execution_unit_id, source_area_scope_id),
    FOREIGN KEY (tenant_id, object_id, target_work_id) REFERENCES works(tenant_id, object_id, id),
    FOREIGN KEY (tenant_id, object_id, source_work_id) REFERENCES works(tenant_id, object_id, id),
    FOREIGN KEY (tenant_id, object_id, target_area_scope_id) REFERENCES object_area_scopes(tenant_id, object_id, id),
    FOREIGN KEY (tenant_id, object_id, source_area_scope_id) REFERENCES object_area_scopes(tenant_id, object_id, id),
    FOREIGN KEY (tenant_id, object_id, target_execution_unit_id, target_area_scope_id)
      REFERENCES gpr2_execution_unit_area_scopes(tenant_id, object_id, execution_unit_id, area_scope_id),
    FOREIGN KEY (tenant_id, object_id, source_execution_unit_id, source_area_scope_id)
      REFERENCES gpr2_execution_unit_area_scopes(tenant_id, object_id, execution_unit_id, area_scope_id),
    FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
    CHECK (target_work_id <> source_work_id)
);

CREATE FUNCTION gpr2_r08_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'R08 evidence rows are immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER gpr2_r08_policy_immutable BEFORE UPDATE OR DELETE ON gpr2_internal_sc_policy_versions
  FOR EACH ROW EXECUTE FUNCTION gpr2_r08_immutable();
CREATE TRIGGER gpr2_r08_scope_immutable BEFORE UPDATE OR DELETE ON gpr2_execution_unit_area_scopes
  FOR EACH ROW EXECUTE FUNCTION gpr2_r08_immutable();
CREATE TRIGGER gpr2_r08_requirement_immutable BEFORE UPDATE OR DELETE ON technical_release_requirements
  FOR EACH ROW EXECUTE FUNCTION gpr2_r08_immutable();

CREATE FUNCTION gpr2_r08_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM works WHERE tenant_id=NEW.tenant_id AND object_id=NEW.object_id AND id=NEW.work_id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM work_execution_units u WHERE u.tenant_id=NEW.tenant_id
       AND u.id=NEW.execution_unit_id AND u.object_work_id=NEW.work_id) OR
     NOT EXISTS (SELECT 1 FROM object_area_scopes a WHERE a.tenant_id=NEW.tenant_id
       AND a.object_id=NEW.object_id AND a.id=NEW.area_scope_id AND a.lifecycle='ACTIVE') THEN
    RAISE EXCEPTION 'R08 execution unit / active AreaScope mismatch' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM works w WHERE w.tenant_id=NEW.tenant_id AND w.id=NEW.work_id AND w.actual_quantity>0)
    OR EXISTS(SELECT 1 FROM work_progress p WHERE p.tenant_id=NEW.tenant_id AND p.object_work_id=NEW.work_id)
    OR EXISTS(SELECT 1 FROM portion_quantity_confirmations f JOIN quantity_portions p ON p.tenant_id=f.tenant_id AND p.id=f.portion_id
      JOIN work_execution_units u ON u.tenant_id=p.tenant_id AND u.id=p.execution_unit_id
      WHERE f.tenant_id=NEW.tenant_id AND u.object_work_id=NEW.work_id)
    OR EXISTS(SELECT 1 FROM inspections i WHERE i.tenant_id=NEW.tenant_id AND i.object_work_id=NEW.work_id) THEN
    RAISE EXCEPTION 'R08 historical evidence needs I-LIVE mapping' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER gpr2_r08_scope_check BEFORE INSERT ON gpr2_execution_unit_area_scopes
  FOR EACH ROW EXECUTE FUNCTION gpr2_r08_scope_guard();

CREATE FUNCTION gpr2_r08_requirement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_work uuid; source_work uuid;
BEGIN
  SELECT work_id INTO target_work FROM gpr2_execution_unit_area_scopes WHERE tenant_id=NEW.tenant_id
    AND object_id=NEW.object_id AND execution_unit_id=NEW.target_execution_unit_id
    AND area_scope_id=NEW.target_area_scope_id;
  SELECT work_id INTO source_work FROM gpr2_execution_unit_area_scopes WHERE tenant_id=NEW.tenant_id
    AND object_id=NEW.object_id AND execution_unit_id=NEW.source_execution_unit_id
    AND area_scope_id=NEW.source_area_scope_id;
  IF target_work IS DISTINCT FROM NEW.target_work_id OR source_work IS DISTINCT FROM NEW.source_work_id THEN
    RAISE EXCEPTION 'R08 requirement Work / unit scope mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER gpr2_r08_requirement_check BEFORE INSERT ON technical_release_requirements
  FOR EACH ROW EXECUTE FUNCTION gpr2_r08_requirement_guard();

-- An explicit completeness declaration is required even when the target has
-- zero prerequisites. It cannot be inferred from an empty requirement query.
CREATE TABLE gpr2_release_scope_completeness (
    tenant_id uuid NOT NULL,
    object_id uuid NOT NULL,
    work_id uuid NOT NULL,
    execution_unit_id uuid NOT NULL,
    area_scope_id uuid NOT NULL,
    basis text NOT NULL CHECK (btrim(basis)<>''),
    declared_by uuid NOT NULL,
    declared_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, object_id, execution_unit_id, area_scope_id),
    FOREIGN KEY (tenant_id, object_id, execution_unit_id, area_scope_id)
      REFERENCES gpr2_execution_unit_area_scopes(tenant_id, object_id, execution_unit_id, area_scope_id),
    FOREIGN KEY (tenant_id, object_id, work_id) REFERENCES works(tenant_id, object_id, id),
    FOREIGN KEY (tenant_id, declared_by) REFERENCES users(tenant_id, id)
);
CREATE TRIGGER gpr2_r08_completeness_immutable BEFORE UPDATE OR DELETE ON gpr2_release_scope_completeness
  FOR EACH ROW EXECUTE FUNCTION gpr2_r08_immutable();

CREATE FUNCTION gpr2_r08_completeness_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual_work uuid;
BEGIN
  SELECT work_id INTO actual_work FROM gpr2_execution_unit_area_scopes WHERE tenant_id=NEW.tenant_id
    AND object_id=NEW.object_id AND execution_unit_id=NEW.execution_unit_id AND area_scope_id=NEW.area_scope_id;
  IF actual_work IS DISTINCT FROM NEW.work_id OR EXISTS (
    SELECT 1 FROM work_dependencies d WHERE d.tenant_id=NEW.tenant_id AND d.successor_work_id=NEW.work_id
      AND NOT EXISTS (SELECT 1 FROM technical_release_requirements r WHERE r.tenant_id=NEW.tenant_id
        AND r.object_id=NEW.object_id AND r.target_execution_unit_id=NEW.execution_unit_id
        AND r.target_area_scope_id=NEW.area_scope_id AND r.source_work_id=d.predecessor_work_id)) THEN
    RAISE EXCEPTION 'R08 scope incomplete or legacy dependency unmapped' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER gpr2_r08_completeness_check BEFORE INSERT ON gpr2_release_scope_completeness
  FOR EACH ROW EXECUTE FUNCTION gpr2_r08_completeness_guard();

-- A legacy issue without an exact mapping remains object-wide. New scoped
-- mappings require the issue's inspected Work to belong to the same object.
CREATE TABLE gpr2_critical_issue_scopes (
    tenant_id uuid NOT NULL,
    object_id uuid NOT NULL,
    issue_id uuid NOT NULL,
    area_scope_id uuid NOT NULL,
    execution_unit_id uuid NOT NULL,
    recorded_by uuid NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, issue_id),
    FOREIGN KEY (tenant_id, object_id, execution_unit_id, area_scope_id)
      REFERENCES gpr2_execution_unit_area_scopes(tenant_id, object_id, execution_unit_id, area_scope_id),
    FOREIGN KEY (tenant_id, issue_id) REFERENCES issues(tenant_id, id),
    FOREIGN KEY (tenant_id, recorded_by) REFERENCES users(tenant_id, id)
);
CREATE TRIGGER gpr2_r08_issue_scope_immutable BEFORE UPDATE OR DELETE ON gpr2_critical_issue_scopes
  FOR EACH ROW EXECUTE FUNCTION gpr2_r08_immutable();
CREATE FUNCTION gpr2_r08_issue_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM issues i JOIN inspections x ON x.tenant_id=i.tenant_id AND x.id=i.inspection_id
    JOIN works w ON w.tenant_id=x.tenant_id AND w.id=x.object_work_id
    WHERE i.tenant_id=NEW.tenant_id AND i.id=NEW.issue_id AND i.created_at=transaction_timestamp()
      AND i.severity='CRITICAL' AND x.object_id=NEW.object_id
      AND w.id=(SELECT m.work_id FROM gpr2_execution_unit_area_scopes m WHERE m.tenant_id=NEW.tenant_id
        AND m.object_id=NEW.object_id AND m.execution_unit_id=NEW.execution_unit_id AND m.area_scope_id=NEW.area_scope_id)) THEN
    RAISE EXCEPTION 'R08 issue scope mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER gpr2_r08_issue_scope_check BEFORE INSERT ON gpr2_critical_issue_scopes
  FOR EACH ROW EXECUTE FUNCTION gpr2_r08_issue_scope_guard();

CREATE FUNCTION gpr2_r08_policy_pointer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_seq int; new_seq int;
BEGIN
  SELECT version INTO new_seq FROM gpr2_internal_sc_policy_versions WHERE tenant_id=NEW.tenant_id
    AND object_id=NEW.object_id AND id=NEW.version_id;
  IF TG_OP='UPDATE' THEN
    SELECT version INTO old_seq FROM gpr2_internal_sc_policy_versions WHERE tenant_id=OLD.tenant_id
      AND object_id=OLD.object_id AND id=OLD.version_id;
    IF NEW.tenant_id<>OLD.tenant_id OR NEW.object_id<>OLD.object_id OR new_seq<>old_seq+1 THEN
      RAISE EXCEPTION 'R08 policy version must advance by one' USING ERRCODE='23514';
    END IF;
  ELSIF new_seq<>1 THEN
    RAISE EXCEPTION 'R08 initial policy version must be one' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER gpr2_r08_policy_pointer_check BEFORE INSERT OR UPDATE ON gpr2_current_internal_sc_policy
  FOR EACH ROW EXECUTE FUNCTION gpr2_r08_policy_pointer_guard();
CREATE TRIGGER gpr2_r08_policy_pointer_delete BEFORE DELETE ON gpr2_current_internal_sc_policy
  FOR EACH ROW EXECUTE FUNCTION gpr2_r08_immutable();

-- No historical backfill: absent scope/policy is UNKNOWN and must fail closed.
