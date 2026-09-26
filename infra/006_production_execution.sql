-- F8.1 Production Execution + Construction Control Foundation.
-- Construction Core F8.1 Domain Contract v1.0 (approved) — Work Execution
-- Unit, Quantity Portion, separated quantity confirmation history, and the
-- Internal SC / Customer SC inspection split. Additive only: no existing
-- column is removed or narrowed, and every column added to an existing
-- table (`inspections`) is nullable or DEFAULTed, so every row and every
-- consumer that predates this migration is unaffected. A work with no
-- execution unit behaves exactly as it did before this migration.
--
-- Composite foreign keys follow the precedent 004_object_contractor_history.sql
-- set (`FOREIGN KEY(tenant_id,col) REFERENCES table(tenant_id,id)`), rather
-- than 001's original bare-uuid convention: these are new tables with no
-- existing rows to validate, so the stronger guarantee costs nothing. See
-- the F8.1 Domain Impact Analysis for the full design.

CREATE TABLE finish_types(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    name text NOT NULL,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version int NOT NULL DEFAULT 1,
    UNIQUE(tenant_id,id)
);
CREATE INDEX finish_types_tenant_idx ON finish_types(tenant_id);

CREATE TABLE work_execution_units(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    object_work_id uuid NOT NULL,
    work_type_id uuid NOT NULL,
    finish_type_id uuid,
    execution_conditions text,
    location text,
    contractor_id uuid NOT NULL,
    unit text NOT NULL,
    -- No actual_quantity column: derived at read time as the sum of this
    -- unit's portions' latest RP_FACT confirmation (F8.1 decision 2 — a
    -- stored total here would be a second, potentially-conflicting source
    -- of truth).
    planned_quantity numeric(20,4) NOT NULL CHECK(planned_quantity>0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version int NOT NULL DEFAULT 1,
    UNIQUE(tenant_id,id),
    FOREIGN KEY(tenant_id,object_work_id) REFERENCES works(tenant_id,id),
    FOREIGN KEY(tenant_id,work_type_id) REFERENCES work_types(tenant_id,id),
    FOREIGN KEY(tenant_id,finish_type_id) REFERENCES finish_types(tenant_id,id),
    FOREIGN KEY(tenant_id,contractor_id) REFERENCES contractors(tenant_id,id)
);
CREATE INDEX work_execution_units_tenant_idx ON work_execution_units(tenant_id);
CREATE INDEX work_execution_units_work_idx ON work_execution_units(tenant_id,object_work_id);

CREATE TABLE execution_unit_layers(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    execution_unit_id uuid NOT NULL,
    sort_order int NOT NULL DEFAULT 0,
    name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version int NOT NULL DEFAULT 1,
    UNIQUE(tenant_id,id),
    FOREIGN KEY(tenant_id,execution_unit_id) REFERENCES work_execution_units(tenant_id,id)
);
CREATE INDEX execution_unit_layers_tenant_idx ON execution_unit_layers(tenant_id);
CREATE INDEX execution_unit_layers_unit_idx ON execution_unit_layers(tenant_id,execution_unit_id);

CREATE TABLE quantity_portions(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    execution_unit_id uuid NOT NULL,
    label text NOT NULL,
    -- May cover only part of the parent unit's planned_quantity (F8.1
    -- decision 4). The sum of a unit's portions cannot exceed the unit's
    -- planned_quantity — a cross-row invariant, checked in the creating
    -- service method (ProductionService), the same way createWork() already
    -- checks its own cross-row business rules rather than relying on SQL
    -- alone for anything wider than one row.
    planned_quantity numeric(20,4) NOT NULL CHECK(planned_quantity>0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version int NOT NULL DEFAULT 1,
    UNIQUE(tenant_id,id),
    FOREIGN KEY(tenant_id,execution_unit_id) REFERENCES work_execution_units(tenant_id,id)
);
CREATE INDEX quantity_portions_tenant_idx ON quantity_portions(tenant_id);
CREATE INDEX quantity_portions_unit_idx ON quantity_portions(tenant_id,execution_unit_id);

-- Internal SC and Customer SC (F8.1 Domain Contract decisions 5-6): one
-- table, distinguished by inspection_type — never a separate table for
-- Customer SC, and Customer SC has no user/account/login of its own.
-- inspector_id (existing column, unchanged) is always a users.id: for
-- INTERNAL_SC, the person who inspected; for CUSTOMER_SC, the authorized
-- internal employee who registered the customer's decision on their behalf.
-- Both new columns are added with a DEFAULT, so every existing row (all of
-- them today's whole-work Internal SC inspections) is valid the instant the
-- column exists — no backfill statement, no window where a row could fail
-- the CHECK added below. object_work_id stays required and unchanged, so
-- work-level logic (dependency blockers) keeps seeing every inspection
-- regardless of whether it is also portion-scoped.
ALTER TABLE inspections ADD COLUMN portion_id uuid;
ALTER TABLE inspections ADD COLUMN inspection_type text NOT NULL DEFAULT 'INTERNAL_SC';
ALTER TABLE inspections ADD FOREIGN KEY(tenant_id,portion_id) REFERENCES quantity_portions(tenant_id,id);
CREATE INDEX inspections_portion_idx ON inspections(tenant_id,portion_id) WHERE portion_id IS NOT NULL;

-- Quantity confirmation history (F8.1 Domain Contract): RP fact, Internal SC
-- and Customer SC recorded for the same portion are three independent,
-- never-overwriting figures ("all values remain separately. No overwrite.").
-- Append-only, immutable via the same trigger function 001_initial.sql
-- already defines for work_progress/audit_logs/financial_closings — no new
-- PL/pgSQL. inspection_id is set for INTERNAL_SC and CUSTOMER_SC rows
-- (which inspection cycle produced this figure) and NULL for RP_FACT rows
-- (site-reported fact is not an inspection).
CREATE TABLE portion_quantity_confirmations(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    portion_id uuid NOT NULL,
    source text NOT NULL,
    quantity numeric(20,4) NOT NULL CHECK(quantity>=0),
    inspection_id uuid,
    recorded_by uuid NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT now(),
    comment text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version int NOT NULL DEFAULT 1,
    UNIQUE(tenant_id,id),
    FOREIGN KEY(tenant_id,portion_id) REFERENCES quantity_portions(tenant_id,id),
    FOREIGN KEY(tenant_id,inspection_id) REFERENCES inspections(tenant_id,id),
    FOREIGN KEY(tenant_id,recorded_by) REFERENCES users(tenant_id,id)
);
CREATE INDEX portion_quantity_confirmations_tenant_idx ON portion_quantity_confirmations(tenant_id);
CREATE INDEX portion_quantity_confirmations_portion_idx ON portion_quantity_confirmations(tenant_id,portion_id,source,recorded_at);
CREATE TRIGGER portion_confirmations_immutable BEFORE UPDATE OR DELETE ON portion_quantity_confirmations FOR EACH ROW EXECUTE FUNCTION immutable_history();

-- Invariants (002_invariants.sql's own style: bare ADD CHECK, appended after
-- the columns/rows they constrain exist). Both are safe against every
-- existing row: inspection_type's DEFAULT above backfilled it before this
-- runs, and source only ever applies to newly-inserted confirmation rows.
ALTER TABLE portion_quantity_confirmations ADD CHECK(source IN ('RP_FACT','INTERNAL_SC','CUSTOMER_SC'));
ALTER TABLE inspections ADD CHECK(inspection_type IN ('INTERNAL_SC','CUSTOMER_SC'));
-- Customer SC only ever exists at portion granularity (F8.1 decision 6 —
-- there is no whole-work "customer accepted the entire work" shortcut);
-- Internal SC may still be either whole-work (portion_id NULL, the
-- pre-F8.1 shape, unchanged) or portion-scoped.
ALTER TABLE inspections ADD CHECK(inspection_type<>'CUSTOMER_SC' OR portion_id IS NOT NULL);

-- 001_initial.sql's inspection_active partial unique index — "at most one
-- active (non-terminal) inspection per work" — is keyed on (tenant_id,
-- object_work_id) alone, with no notion of a portion. Left as-is it would
-- serialise every portion of a work against every other portion (and
-- against the work's own whole-work inspections): presenting portion B
-- would fail while portion A's inspection is still WAITING, directly
-- contradicting "a portion can be presented, inspected and tracked
-- independently." Following the exact precedent
-- 004_object_contractor_history.sql set — drop and recreate a constraint
-- from a *new* migration, never edit an old one — it is replaced by two
-- narrower indexes: the original constraint, now scoped to portion_id IS
-- NULL so every pre-F8.1, non-portioned work keeps exactly its current
-- "at most one active inspection" behaviour; and a new, separate
-- constraint scoped to portion_id IS NOT NULL, keyed additionally by
-- inspection_type so Internal SC and Customer SC on the *same* portion
-- never collide with each other, only a duplicate active request of the
-- *same* type on the *same* portion does — a DB-level backstop for the
-- check requestPortionInspection() already makes in application code,
-- the same defence-in-depth object_contractors_active_unique already
-- gives assignContractor()'s own check.
DROP INDEX inspection_active;
CREATE UNIQUE INDEX inspection_active ON inspections(tenant_id,object_work_id) WHERE status IN ('WAITING','IN_REVIEW','ISSUES_FOUND','REINSPECTION') AND portion_id IS NULL;
CREATE UNIQUE INDEX portion_inspection_active ON inspections(tenant_id,portion_id,inspection_type) WHERE status IN ('WAITING','IN_REVIEW','ISSUES_FOUND','REINSPECTION') AND portion_id IS NOT NULL;
