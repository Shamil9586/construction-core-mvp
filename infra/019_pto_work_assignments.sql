-- PILOT-W01 UI03 — PTO work handoff («Передать в работу»).
-- Additive: ONE new table, no existing table is altered and no row is written.
--
-- A PTO work assignment records which PTO engineer the object's PTO_HEAD has made
-- responsible for preparing executive documentation for ONE work. It exists BEFORE any
-- documentation package and creating it never creates a package (documentation_packages is
-- untouched). It deliberately is NOT works.responsible_user_id (production responsibility) and
-- NOT documentation_packages.responsible_user_id (set only when the assigned engineer creates
-- the package).
--
-- Same append-only history discipline as 016: one ACTIVE row per work (partial unique index),
-- a row may only be ENDED (assignment_history_guard, 016), reassignment = end + insert, and
-- rows are never physically deleted. Tenant-scoped composite FKs as everywhere else.
CREATE TABLE pto_work_assignments(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    object_id uuid NOT NULL,
    object_work_id uuid NOT NULL,
    assignee_user_id uuid NOT NULL,
    assigned_by uuid NOT NULL,
    started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    ended_at timestamptz,
    ended_by uuid,
    end_reason text,
    version int NOT NULL DEFAULT 1,
    CHECK((ended_at IS NULL AND ended_by IS NULL AND end_reason IS NULL) OR (ended_at IS NOT NULL AND ended_by IS NOT NULL)),
    UNIQUE(tenant_id,id),
    FOREIGN KEY(tenant_id,object_id) REFERENCES objects(tenant_id,id),
    FOREIGN KEY(tenant_id,object_work_id) REFERENCES works(tenant_id,id),
    FOREIGN KEY(tenant_id,assignee_user_id) REFERENCES users(tenant_id,id),
    FOREIGN KEY(tenant_id,assigned_by) REFERENCES users(tenant_id,id),
    FOREIGN KEY(tenant_id,ended_by) REFERENCES users(tenant_id,id)
);
CREATE UNIQUE INDEX pto_work_assignments_one_active ON pto_work_assignments(tenant_id,object_work_id) WHERE ended_at IS NULL;
CREATE INDEX pto_work_assignments_assignee_idx ON pto_work_assignments(tenant_id,assignee_user_id) WHERE ended_at IS NULL;
CREATE INDEX pto_work_assignments_tenant_idx ON pto_work_assignments(tenant_id);
CREATE TRIGGER pto_work_assignments_history BEFORE UPDATE OR DELETE ON pto_work_assignments FOR EACH ROW EXECUTE FUNCTION assignment_history_guard();
