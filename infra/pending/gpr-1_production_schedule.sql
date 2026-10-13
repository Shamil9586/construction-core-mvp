-- GPR-1 Production Schedule («График производства работ») — PENDING MIGRATION.
--
-- NOT NUMBERED, ON PURPOSE. Other slices are being built in parallel and several of them may need a migration; the production migration
-- number is the coordinator's to assign at integration. This file therefore lives in infra/pending/, which scripts/migrate.ts does not read
-- (it applies only infra/<digits>_*.sql), so NOTHING here reaches any database through the repository runner until it is promoted.
--
-- PROMOTION (coordinator, at integration): rename the file to the next free production number and commit — no change to its content.
--     git mv infra/pending/gpr-1_production_schedule.sql infra/0NN_production_schedule.sql
-- The GPR tests apply this file from infra/pending/ while it is still there and rely on the ordinary runner once it has been promoted,
-- so they pass unchanged on either side of the rename (tests/helpers/gpr-fixtures.ts).
--
-- Additive only: five new tables, their indexes and guard triggers. No existing table or column is altered; a database without this file
-- behaves exactly as before (the schedule endpoints answer with an error, nothing else is affected).
--
-- Model (see packages/domain/schedule.ts and docs/gpr-1-production-schedule.md):
--   schedule_items            WHAT is planned: one identity row per production scope — an execution unit, or a work with no units.
--   schedule_revisions        a VERSION of an object's schedule: DRAFT -> APPROVED (the current baseline) -> SUPERSEDED; or DRAFT -> DISCARDED.
--   schedule_revision_entries the dates / order of an item inside one revision. Frozen the moment the revision stops being a draft.
--   schedule_delay_categories a tenant's additions / renames / switch-offs on top of the built-in delay-reason categories.
--   schedule_delay_reasons    WHY a scope is late: category, comment, responsible party, who recorded it and when, open / resolved.
-- Planned quantity, unit, zone and contractor are NOT stored here: they are read from work_execution_units / works. Physical progress is
-- never stored either: it is derived from portion_quantity_confirmations (RP_FACT) at read time.

-- ---------------------------------------------------------------------------------------------------------------------------------
-- schedule_items — the stable identity of a planned scope
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE schedule_items(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    object_id uuid NOT NULL,
    object_work_id uuid NOT NULL,
    -- NULL = the whole Work (allowed only for a Work with no execution units — enforced by the service, restated at approval).
    execution_unit_id uuid,
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(tenant_id,id),
    FOREIGN KEY(tenant_id,object_id) REFERENCES objects(tenant_id,id),
    FOREIGN KEY(tenant_id,object_work_id) REFERENCES works(tenant_id,id),
    FOREIGN KEY(tenant_id,execution_unit_id) REFERENCES work_execution_units(tenant_id,id),
    FOREIGN KEY(tenant_id,created_by) REFERENCES users(tenant_id,id)
);
-- One item per scope, ever: a unit once, a whole work once. Re-planning a scope re-uses its item, which is what keeps delay reasons and the
-- history of its dates attached to the same thing across revisions.
CREATE UNIQUE INDEX schedule_items_unit_unique ON schedule_items(tenant_id,execution_unit_id) WHERE execution_unit_id IS NOT NULL;
CREATE UNIQUE INDEX schedule_items_work_unique ON schedule_items(tenant_id,object_work_id) WHERE execution_unit_id IS NULL;
CREATE INDEX schedule_items_object_idx ON schedule_items(tenant_id,object_id);

-- Database backstop for what a composite FK cannot say: the item's Work belongs to the item's Object, and its unit belongs to its Work (so an
-- item can never smuggle another object's scope into this object's schedule). Identity rows never change and are never deleted.
CREATE FUNCTION schedule_items_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    work_object uuid;
    unit_work uuid;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'Участок графика неизменяем и не удаляется: он остаётся в системе для аудита.' USING ERRCODE = '23514';
    END IF;
    SELECT object_id INTO work_object FROM works WHERE tenant_id = NEW.tenant_id AND id = NEW.object_work_id;
    IF work_object IS DISTINCT FROM NEW.object_id THEN
        RAISE EXCEPTION 'Работа участка графика должна относиться к тому же объекту.' USING ERRCODE = '23514';
    END IF;
    IF NEW.execution_unit_id IS NOT NULL THEN
        SELECT object_work_id INTO unit_work FROM work_execution_units WHERE tenant_id = NEW.tenant_id AND id = NEW.execution_unit_id;
        IF unit_work IS DISTINCT FROM NEW.object_work_id THEN
            RAISE EXCEPTION 'Единица исполнения должна относиться к работе участка графика.' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER schedule_items_guard BEFORE INSERT OR UPDATE OR DELETE ON schedule_items FOR EACH ROW EXECUTE FUNCTION schedule_items_guard();

-- ---------------------------------------------------------------------------------------------------------------------------------
-- schedule_revisions — a version of one object's schedule
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE schedule_revisions(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    object_id uuid NOT NULL,
    revision_no int NOT NULL CHECK(revision_no >= 1),
    status text NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','APPROVED','SUPERSEDED','DISCARDED')),
    -- The approved revision this draft was cloned from; NULL for the first schedule of an object. A revision with a base is a CORRECTION.
    based_on_revision_id uuid,
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    -- Approval provenance.
    approved_by uuid,
    approved_at timestamptz,
    approval_comment text,
    -- Why an already-approved schedule was changed. Mandatory for every correction (CHECK below), never for the first approval.
    correction_reason text,
    superseded_at timestamptz,
    superseded_by_revision_id uuid,
    discarded_by uuid,
    discarded_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    version int NOT NULL DEFAULT 1,
    UNIQUE(tenant_id,id),
    UNIQUE(tenant_id,object_id,revision_no),
    FOREIGN KEY(tenant_id,object_id) REFERENCES objects(tenant_id,id),
    FOREIGN KEY(tenant_id,based_on_revision_id) REFERENCES schedule_revisions(tenant_id,id),
    FOREIGN KEY(tenant_id,superseded_by_revision_id) REFERENCES schedule_revisions(tenant_id,id),
    FOREIGN KEY(tenant_id,created_by) REFERENCES users(tenant_id,id),
    FOREIGN KEY(tenant_id,approved_by) REFERENCES users(tenant_id,id),
    FOREIGN KEY(tenant_id,discarded_by) REFERENCES users(tenant_id,id),
    CONSTRAINT schedule_revisions_state_consistent CHECK(
        (status = 'DRAFT'      AND approved_at IS NULL AND approved_by IS NULL AND superseded_at IS NULL AND discarded_at IS NULL)
     OR (status = 'APPROVED'   AND approved_at IS NOT NULL AND approved_by IS NOT NULL AND superseded_at IS NULL AND discarded_at IS NULL)
     OR (status = 'SUPERSEDED' AND approved_at IS NOT NULL AND approved_by IS NOT NULL AND superseded_at IS NOT NULL AND superseded_by_revision_id IS NOT NULL AND discarded_at IS NULL)
     OR (status = 'DISCARDED'  AND approved_at IS NULL AND approved_by IS NULL AND discarded_at IS NOT NULL AND discarded_by IS NOT NULL AND superseded_at IS NULL)
    ),
    CONSTRAINT schedule_revisions_correction_needs_reason CHECK(
        status NOT IN ('APPROVED','SUPERSEDED') OR based_on_revision_id IS NULL OR (correction_reason IS NOT NULL AND length(trim(correction_reason)) > 0)
    )
);
-- At most one draft being prepared and at most one current baseline per object.
CREATE UNIQUE INDEX schedule_revisions_one_draft ON schedule_revisions(tenant_id,object_id) WHERE status = 'DRAFT';
CREATE UNIQUE INDEX schedule_revisions_one_current ON schedule_revisions(tenant_id,object_id) WHERE status = 'APPROVED';
CREATE INDEX schedule_revisions_object_idx ON schedule_revisions(tenant_id,object_id,revision_no);

-- The audit backstop: an approved plan can never be rewritten, whatever writes to the table. Allowed: a draft is edited / approved /
-- discarded; the current baseline is superseded (touching only the supersession columns). Superseded and discarded revisions are frozen.
CREATE FUNCTION schedule_revisions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Версия графика не удаляется: она остаётся в системе для аудита.' USING ERRCODE = '23514';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.object_id IS DISTINCT FROM OLD.object_id
       OR NEW.revision_no IS DISTINCT FROM OLD.revision_no OR NEW.based_on_revision_id IS DISTINCT FROM OLD.based_on_revision_id
       OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Реквизиты версии графика не изменяются.' USING ERRCODE = '23514';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
           (OLD.status = 'DRAFT' AND NEW.status IN ('APPROVED','DISCARDED'))
        OR (OLD.status = 'APPROVED' AND NEW.status = 'SUPERSEDED')) THEN
        RAISE EXCEPTION 'Недопустимый переход статуса версии графика: % -> %.', OLD.status, NEW.status USING ERRCODE = '23514';
    END IF;
    IF OLD.status <> 'DRAFT' THEN
        IF NOT (OLD.status = 'APPROVED' AND NEW.status = 'SUPERSEDED') THEN
            RAISE EXCEPTION 'Утверждённая, замещённая или отклонённая версия графика не изменяется.' USING ERRCODE = '23514';
        END IF;
        IF NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
           OR NEW.approval_comment IS DISTINCT FROM OLD.approval_comment OR NEW.correction_reason IS DISTINCT FROM OLD.correction_reason
           OR NEW.discarded_by IS DISTINCT FROM OLD.discarded_by OR NEW.discarded_at IS DISTINCT FROM OLD.discarded_at THEN
            RAISE EXCEPTION 'Утверждённые даты и подтверждение версии графика не переписываются.' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER schedule_revisions_guard BEFORE UPDATE OR DELETE ON schedule_revisions FOR EACH ROW EXECUTE FUNCTION schedule_revisions_guard();

-- ---------------------------------------------------------------------------------------------------------------------------------
-- schedule_revision_entries — dates and order of an item inside one revision
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE schedule_revision_entries(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    revision_id uuid NOT NULL,
    item_id uuid NOT NULL,
    planned_start date NOT NULL,
    planned_finish date NOT NULL,
    -- The planned order within the object's schedule (a sort key, not unique: parallel stages may share a number).
    sequence int NOT NULL CHECK(sequence >= 1),
    -- Planning reference "this follows that" (finish-to-start, ADVISORY: it orders and annotates, it never blocks production — the
    -- technological gate stays work_dependencies). Must be another item of the SAME revision (composite FK below).
    predecessor_item_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version int NOT NULL DEFAULT 1,
    UNIQUE(tenant_id,id),
    UNIQUE(tenant_id,revision_id,item_id),
    CHECK(planned_finish >= planned_start),
    CHECK(predecessor_item_id IS NULL OR predecessor_item_id <> item_id),
    FOREIGN KEY(tenant_id,revision_id) REFERENCES schedule_revisions(tenant_id,id),
    FOREIGN KEY(tenant_id,item_id) REFERENCES schedule_items(tenant_id,id),
    FOREIGN KEY(tenant_id,revision_id,predecessor_item_id) REFERENCES schedule_revision_entries(tenant_id,revision_id,item_id)
);
CREATE INDEX schedule_revision_entries_revision_idx ON schedule_revision_entries(tenant_id,revision_id);
CREATE INDEX schedule_revision_entries_item_idx ON schedule_revision_entries(tenant_id,item_id);

-- Entries are editable only while their revision is a draft; the moment it is approved, superseded or discarded they are frozen for good.
-- The item must belong to the revision's own object (cross-object isolation holds even for a writer that bypasses the service).
CREATE FUNCTION schedule_revision_entries_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    revision_status text;
    revision_object uuid;
    item_object uuid;
BEGIN
    SELECT status, object_id INTO revision_status, revision_object FROM schedule_revisions
     WHERE tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id) AND id = COALESCE(NEW.revision_id, OLD.revision_id);
    IF revision_status IS DISTINCT FROM 'DRAFT' THEN
        RAISE EXCEPTION 'Состав и даты версии графика можно менять только в черновике: утверждённые даты не переписываются.' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    IF TG_OP = 'UPDATE' AND (NEW.revision_id IS DISTINCT FROM OLD.revision_id OR NEW.item_id IS DISTINCT FROM OLD.item_id) THEN
        RAISE EXCEPTION 'Версия и участок записи графика не изменяются.' USING ERRCODE = '23514';
    END IF;
    SELECT object_id INTO item_object FROM schedule_items WHERE tenant_id = NEW.tenant_id AND id = NEW.item_id;
    IF item_object IS DISTINCT FROM revision_object THEN
        RAISE EXCEPTION 'Участок относится к другому объекту.' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER schedule_revision_entries_guard BEFORE INSERT OR UPDATE OR DELETE ON schedule_revision_entries FOR EACH ROW EXECUTE FUNCTION schedule_revision_entries_guard();

-- ---------------------------------------------------------------------------------------------------------------------------------
-- schedule_delay_categories — the open part of the delay-reason model
-- ---------------------------------------------------------------------------------------------------------------------------------
-- The built-in categories (materials, mobilisation, decisions, ...) are code defaults; a row here with the same code renames / reorders /
-- switches one off, a new code adds a category. Nothing is seeded, so a new tenant needs no setup.
CREATE TABLE schedule_delay_categories(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    code text NOT NULL CHECK(code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
    name text NOT NULL CHECK(length(trim(name)) > 0),
    is_active boolean NOT NULL DEFAULT true,
    sort_order int NOT NULL DEFAULT 100,
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version int NOT NULL DEFAULT 1,
    UNIQUE(tenant_id,id),
    UNIQUE(tenant_id,code),
    FOREIGN KEY(tenant_id,created_by) REFERENCES users(tenant_id,id)
);

-- ---------------------------------------------------------------------------------------------------------------------------------
-- schedule_delay_reasons — why a scope is late
-- ---------------------------------------------------------------------------------------------------------------------------------
-- Planning delay reasons only. Construction defects / СК remarks are issues (issues table) and are deliberately a different thing.
CREATE TABLE schedule_delay_reasons(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    object_id uuid NOT NULL,
    -- The affected schedule scope, and the approved baseline the delay was measured against.
    item_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    category_code text NOT NULL CHECK(category_code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
    comment text NOT NULL CHECK(length(trim(comment)) > 0),
    -- Who the reason is about, where that is meaningful: a person OR a contractor, not both.
    responsible_user_id uuid,
    responsible_contractor_id uuid,
    -- Evidence: how many calendar days late the scope was when the reason was recorded.
    delay_days_at_record int NOT NULL CHECK(delay_days_at_record >= 1),
    recorded_by uuid NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT now(),
    status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','RESOLVED')),
    resolved_by uuid,
    resolved_at timestamptz,
    resolution_comment text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    version int NOT NULL DEFAULT 1,
    UNIQUE(tenant_id,id),
    CHECK(responsible_user_id IS NULL OR responsible_contractor_id IS NULL),
    CONSTRAINT schedule_delay_reasons_state_consistent CHECK(
        (status = 'OPEN' AND resolved_at IS NULL AND resolved_by IS NULL)
     OR (status = 'RESOLVED' AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL)
    ),
    FOREIGN KEY(tenant_id,object_id) REFERENCES objects(tenant_id,id),
    FOREIGN KEY(tenant_id,item_id) REFERENCES schedule_items(tenant_id,id),
    FOREIGN KEY(tenant_id,revision_id) REFERENCES schedule_revisions(tenant_id,id),
    FOREIGN KEY(tenant_id,responsible_user_id) REFERENCES users(tenant_id,id),
    FOREIGN KEY(tenant_id,responsible_contractor_id) REFERENCES contractors(tenant_id,id),
    FOREIGN KEY(tenant_id,recorded_by) REFERENCES users(tenant_id,id),
    FOREIGN KEY(tenant_id,resolved_by) REFERENCES users(tenant_id,id)
);
CREATE INDEX schedule_delay_reasons_item_idx ON schedule_delay_reasons(tenant_id,item_id,recorded_at);
CREATE INDEX schedule_delay_reasons_object_idx ON schedule_delay_reasons(tenant_id,object_id,status);

-- A recorded reason is evidence: it is never deleted and nothing about it is rewritten. The only change allowed is the one-way
-- OPEN -> RESOLVED, which writes the resolution columns and nothing else.
CREATE FUNCTION schedule_delay_reasons_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    item_object uuid;
    revision_object uuid;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Причина отставания не удаляется: она остаётся в системе для аудита.' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'INSERT' THEN
        SELECT object_id INTO item_object FROM schedule_items WHERE tenant_id = NEW.tenant_id AND id = NEW.item_id;
        SELECT object_id INTO revision_object FROM schedule_revisions WHERE tenant_id = NEW.tenant_id AND id = NEW.revision_id;
        IF item_object IS DISTINCT FROM NEW.object_id OR revision_object IS DISTINCT FROM NEW.object_id THEN
            RAISE EXCEPTION 'Участок и версия графика должны относиться к объекту причины отставания.' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    IF OLD.status <> 'OPEN' OR NEW.status <> 'RESOLVED'
       OR NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.object_id IS DISTINCT FROM OLD.object_id
       OR NEW.item_id IS DISTINCT FROM OLD.item_id OR NEW.revision_id IS DISTINCT FROM OLD.revision_id
       OR NEW.category_code IS DISTINCT FROM OLD.category_code OR NEW.comment IS DISTINCT FROM OLD.comment
       OR NEW.responsible_user_id IS DISTINCT FROM OLD.responsible_user_id OR NEW.responsible_contractor_id IS DISTINCT FROM OLD.responsible_contractor_id
       OR NEW.delay_days_at_record IS DISTINCT FROM OLD.delay_days_at_record
       OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at THEN
        RAISE EXCEPTION 'Записанная причина отставания не переписывается: допустимо только закрыть её (OPEN -> RESOLVED).' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER schedule_delay_reasons_guard BEFORE INSERT OR UPDATE OR DELETE ON schedule_delay_reasons FOR EACH ROW EXECUTE FUNCTION schedule_delay_reasons_guard();
