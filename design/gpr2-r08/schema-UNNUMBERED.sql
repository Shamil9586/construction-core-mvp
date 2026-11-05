-- R08 offline design candidate only. Not loaded by scripts/migrate.ts.
-- A numbered additive migration requires coordinator allocation and independent review.
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
    FOREIGN KEY (tenant_id, target_execution_unit_id) REFERENCES work_execution_units(tenant_id, id),
    FOREIGN KEY (tenant_id, source_execution_unit_id) REFERENCES work_execution_units(tenant_id, id),
    FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
    CHECK (target_work_id <> source_work_id)
);

-- Before numbering: add immutable-row guards, same-Work/WEU ownership triggers,
-- active AreaScope checks, write authorization, and coordinated update protocol.
-- This draft creates no rows and does not backfill ambiguous legacy dependencies.
