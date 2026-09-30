-- PBX-3A — Object Responsibility, Team Redistribution & Handover Foundation.
-- Additive migration: four NEW generic tables, no existing table is altered and
-- no existing row is rewritten. function_code is generic (PTO is the only value
-- PBX-3A writes; the rest are reserved for later verticals).
--
-- Three independent axes (PBX3-D02):
--   functional_team_memberships        organizational: member -> current manager
--   object_function_lead_assignments   object functional lead
--   object_function_member_assignments object functional membership
-- The member table deliberately has NO reference to a lead-assignment row
-- (PBX3-D01): replacing/ending a lead can never cascade into object members,
-- and the operational manager of a member is derived from the current lead.
--
-- started_at/ended_at use clock_timestamp() (taken after the command's advisory locks), not
-- the transaction-start now(): a serialised later command could otherwise stamp an earlier
-- ended_at than the started_at of the row it just ended.
--
-- Native PostgreSQL is the integrity backstop: partial unique indexes over
-- ended_at IS NULL, tenant-scoped composite FKs, CHECKs, and triggers that
-- forbid physical deletes and any rewrite of assignment history.

-- ---------------------------------------------------------------------------
-- Shared guard: assignment rows are append-only history. A row may only be
-- ENDED (ended_at/ended_by/end_reason set once, version bumped); every other
-- column is frozen and the row is never deleted.
CREATE OR REPLACE FUNCTION assignment_history_guard() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION '% is append-only: physical delete is not allowed', TG_TABLE_NAME USING ERRCODE = '23514';
    END IF;
    IF OLD.ended_at IS NOT NULL THEN
        RAISE EXCEPTION '% row is already ended: history is immutable', TG_TABLE_NAME USING ERRCODE = '23514';
    END IF;
    -- Everything except the ENDING columns (and the version bump) is frozen: object, function,
    -- manager/lead/member, assigned_by and started_at can never be rewritten on any row.
    IF (to_jsonb(NEW) - 'ended_at' - 'ended_by' - 'end_reason' - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'ended_at' - 'ended_by' - 'end_reason' - 'version') THEN
        RAISE EXCEPTION '% identity columns are immutable', TG_TABLE_NAME USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- 1) Organizational membership: one ACTIVE manager per member per function.
CREATE TABLE functional_team_memberships(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    function_code text NOT NULL CHECK(function_code IN ('PTO','CONSTRUCTION_CONTROL','SDO','PROJECT_MANAGEMENT')),
    manager_user_id uuid NOT NULL,
    member_user_id uuid NOT NULL,
    assigned_by uuid NOT NULL,
    started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    ended_at timestamptz,
    ended_by uuid,
    end_reason text,
    version int NOT NULL DEFAULT 1,
    CHECK(manager_user_id <> member_user_id),
    CHECK((ended_at IS NULL AND ended_by IS NULL AND end_reason IS NULL) OR (ended_at IS NOT NULL AND ended_by IS NOT NULL)),
    UNIQUE(tenant_id,id),
    FOREIGN KEY(tenant_id,manager_user_id) REFERENCES users(tenant_id,id),
    FOREIGN KEY(tenant_id,member_user_id) REFERENCES users(tenant_id,id),
    FOREIGN KEY(tenant_id,assigned_by) REFERENCES users(tenant_id,id),
    FOREIGN KEY(tenant_id,ended_by) REFERENCES users(tenant_id,id)
);
CREATE UNIQUE INDEX functional_team_memberships_one_active_manager ON functional_team_memberships(tenant_id,function_code,member_user_id) WHERE ended_at IS NULL;
CREATE INDEX functional_team_memberships_manager_idx ON functional_team_memberships(tenant_id,function_code,manager_user_id) WHERE ended_at IS NULL;
CREATE INDEX functional_team_memberships_tenant_idx ON functional_team_memberships(tenant_id);
CREATE TRIGGER functional_team_memberships_history BEFORE UPDATE OR DELETE ON functional_team_memberships FOR EACH ROW EXECUTE FUNCTION assignment_history_guard();

-- ---------------------------------------------------------------------------
-- 2) Object functional lead: one ACTIVE lead per object per function.
CREATE TABLE object_function_lead_assignments(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    object_id uuid NOT NULL,
    function_code text NOT NULL CHECK(function_code IN ('PTO','CONSTRUCTION_CONTROL','SDO','PROJECT_MANAGEMENT')),
    lead_user_id uuid NOT NULL,
    assigned_by uuid NOT NULL,
    started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    ended_at timestamptz,
    ended_by uuid,
    end_reason text,
    version int NOT NULL DEFAULT 1,
    CHECK((ended_at IS NULL AND ended_by IS NULL AND end_reason IS NULL) OR (ended_at IS NOT NULL AND ended_by IS NOT NULL)),
    UNIQUE(tenant_id,id),
    FOREIGN KEY(tenant_id,object_id) REFERENCES objects(tenant_id,id),
    FOREIGN KEY(tenant_id,lead_user_id) REFERENCES users(tenant_id,id),
    FOREIGN KEY(tenant_id,assigned_by) REFERENCES users(tenant_id,id),
    FOREIGN KEY(tenant_id,ended_by) REFERENCES users(tenant_id,id)
);
CREATE UNIQUE INDEX object_function_lead_one_active ON object_function_lead_assignments(tenant_id,object_id,function_code) WHERE ended_at IS NULL;
CREATE INDEX object_function_lead_user_idx ON object_function_lead_assignments(tenant_id,function_code,lead_user_id) WHERE ended_at IS NULL;
CREATE INDEX object_function_lead_tenant_idx ON object_function_lead_assignments(tenant_id);
CREATE TRIGGER object_function_lead_history BEFORE UPDATE OR DELETE ON object_function_lead_assignments FOR EACH ROW EXECUTE FUNCTION assignment_history_guard();

-- ---------------------------------------------------------------------------
-- 3) Object functional membership: one ACTIVE row per object/function/member.
-- No reference to a lead-assignment row (PBX3-D01/D02).
CREATE TABLE object_function_member_assignments(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    object_id uuid NOT NULL,
    function_code text NOT NULL CHECK(function_code IN ('PTO','CONSTRUCTION_CONTROL','SDO','PROJECT_MANAGEMENT')),
    member_user_id uuid NOT NULL,
    assigned_by uuid NOT NULL,
    started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    ended_at timestamptz,
    ended_by uuid,
    end_reason text,
    version int NOT NULL DEFAULT 1,
    CHECK((ended_at IS NULL AND ended_by IS NULL AND end_reason IS NULL) OR (ended_at IS NOT NULL AND ended_by IS NOT NULL)),
    UNIQUE(tenant_id,id),
    FOREIGN KEY(tenant_id,object_id) REFERENCES objects(tenant_id,id),
    FOREIGN KEY(tenant_id,member_user_id) REFERENCES users(tenant_id,id),
    FOREIGN KEY(tenant_id,assigned_by) REFERENCES users(tenant_id,id),
    FOREIGN KEY(tenant_id,ended_by) REFERENCES users(tenant_id,id)
);
CREATE UNIQUE INDEX object_function_member_one_active ON object_function_member_assignments(tenant_id,object_id,function_code,member_user_id) WHERE ended_at IS NULL;
CREATE INDEX object_function_member_user_idx ON object_function_member_assignments(tenant_id,function_code,member_user_id) WHERE ended_at IS NULL;
CREATE INDEX object_function_member_tenant_idx ON object_function_member_assignments(tenant_id);
CREATE TRIGGER object_function_member_history BEFORE UPDATE OR DELETE ON object_function_member_assignments FOR EACH ROW EXECUTE FUNCTION assignment_history_guard();

-- ---------------------------------------------------------------------------
-- 4) Formal handover record (PBX3-D10). Data is never copied between users;
-- a handover documents the change and its acknowledgement state. It never
-- blocks the new assignment from taking effect.
CREATE TABLE object_function_handovers(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    object_id uuid NOT NULL,
    function_code text NOT NULL CHECK(function_code IN ('PTO','CONSTRUCTION_CONTROL','SDO','PROJECT_MANAGEMENT')),
    outgoing_user_id uuid NOT NULL,
    incoming_user_id uuid NOT NULL,
    initiated_by uuid NOT NULL,
    reason text NOT NULL CHECK(length(trim(reason)) > 0),
    note text,
    status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','ACKNOWLEDGED','ADMIN_COMPLETED')),
    acknowledged_by uuid,
    acknowledged_at timestamptz,
    administrative_completed_by uuid,
    administrative_completed_at timestamptz,
    administrative_completion_reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version int NOT NULL DEFAULT 1,
    CHECK(outgoing_user_id <> incoming_user_id),
    CHECK((status='OPEN' AND acknowledged_by IS NULL AND acknowledged_at IS NULL AND administrative_completed_by IS NULL AND administrative_completed_at IS NULL AND administrative_completion_reason IS NULL)
       OR (status='ACKNOWLEDGED' AND acknowledged_by IS NOT NULL AND acknowledged_at IS NOT NULL AND administrative_completed_by IS NULL AND administrative_completed_at IS NULL AND administrative_completion_reason IS NULL)
       OR (status='ADMIN_COMPLETED' AND administrative_completed_by IS NOT NULL AND administrative_completed_at IS NOT NULL AND length(trim(coalesce(administrative_completion_reason,''))) > 0 AND acknowledged_by IS NULL AND acknowledged_at IS NULL)),
    UNIQUE(tenant_id,id),
    FOREIGN KEY(tenant_id,object_id) REFERENCES objects(tenant_id,id),
    FOREIGN KEY(tenant_id,outgoing_user_id) REFERENCES users(tenant_id,id),
    FOREIGN KEY(tenant_id,incoming_user_id) REFERENCES users(tenant_id,id),
    FOREIGN KEY(tenant_id,initiated_by) REFERENCES users(tenant_id,id),
    FOREIGN KEY(tenant_id,acknowledged_by) REFERENCES users(tenant_id,id),
    FOREIGN KEY(tenant_id,administrative_completed_by) REFERENCES users(tenant_id,id)
);
CREATE INDEX object_function_handovers_tenant_idx ON object_function_handovers(tenant_id);
CREATE INDEX object_function_handovers_object_idx ON object_function_handovers(tenant_id,object_id,function_code,created_at);
CREATE INDEX object_function_handovers_open_idx ON object_function_handovers(tenant_id,incoming_user_id) WHERE status='OPEN';

-- A handover is never deleted and its identity/reason never rewritten; only its
-- acknowledgement state advances (OPEN -> ACKNOWLEDGED | ADMIN_COMPLETED, once).
CREATE OR REPLACE FUNCTION handover_guard() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'object_function_handovers is append-only: physical delete is not allowed' USING ERRCODE = '23514';
    END IF;
    IF OLD.status <> 'OPEN' THEN
        RAISE EXCEPTION 'completed handover is immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.object_id IS DISTINCT FROM OLD.object_id OR NEW.function_code IS DISTINCT FROM OLD.function_code
       OR NEW.outgoing_user_id IS DISTINCT FROM OLD.outgoing_user_id OR NEW.incoming_user_id IS DISTINCT FROM OLD.incoming_user_id
       OR NEW.initiated_by IS DISTINCT FROM OLD.initiated_by OR NEW.reason IS DISTINCT FROM OLD.reason
       OR NEW.note IS DISTINCT FROM OLD.note OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'handover identity columns are immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER object_function_handovers_guard BEFORE UPDATE OR DELETE ON object_function_handovers FOR EACH ROW EXECUTE FUNCTION handover_guard();
