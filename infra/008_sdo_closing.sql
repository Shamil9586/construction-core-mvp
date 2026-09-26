-- F8.3 SDO / Closing.
--
-- Construction Core F8.3 accepted contract — SDO Case, status workflow
-- (ON_RECONCILIATION/VERIFICATION_PASSED/ON_CORRECTION/CLOSED), closing
-- amount + history, optional per-Quantity-Portion allocations, and the
-- dedicated PTO<->SDO handoff/return lifecycle. Additive only.
--
-- Deliberately separate from the pre-existing executive_packages/
-- executive_documents/pto_transfers/sdo_cases/financial_closings
-- (001_initial.sql): those are a different, still-active "SDO-closing"
-- pipeline (work-scoped, FINANCE_EDIT-gated, feeds O01's PotentialClosingService
-- dashboard figures) that F8.2 already declined to build on
-- (007_documentation_foundation.sql's own comment) and that has no presence
-- in the modern frontend at all. Reusing its `sdo_cases` name/keying would
-- collide with a one-work-many-packages world (F8.2.1) and would pull in
-- payment/accounting machinery the F8.3 contract explicitly excludes
-- ("Closing is NOT payment and NOT accounting"). This migration never
-- writes to or reads from that legacy pipeline's tables, and O01's existing
-- dashboard/potentialClosing computation is left untouched.
--
-- One Documentation Package maps to at most one SDO Case
-- (sdo_closing_cases_unique below) — enforced at the database level, not
-- only in application code, exactly the discipline pto_transfers_unique/
-- sdo_cases_unique already apply to the legacy pipeline.

-- Customer documentation acceptance (F8.3 decisions 8-10): a fact PTO
-- registers, distinct from Customer SC quantity confirmation
-- (portion_quantity_confirmations, source='CUSTOMER_SC', F8.1) and never an
-- ordinary free status transition — this table is the dedicated, audited
-- record a package's ACCEPTED_BY_CUSTOMER transition is always tied to.
-- documentation_package_version is the package's own `version` at the
-- moment of registration (the "relevant presented documentation version"),
-- so which exact package state was accepted is always reconstructable.
-- accepted_date is the external fact (when the customer actually signed);
-- created_at is when PTO entered it into Core — the same distinction
-- executive_documents.document_date/created_at and
-- inspections.inspection_date/created_at already draw.
CREATE TABLE documentation_customer_acceptances(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    documentation_package_id uuid NOT NULL,
    documentation_package_version int NOT NULL CHECK(documentation_package_version>0),
    accepted_date date NOT NULL,
    reference text,
    comment text,
    registered_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version int NOT NULL DEFAULT 1,
    UNIQUE(tenant_id,id),
    FOREIGN KEY(tenant_id,documentation_package_id) REFERENCES documentation_packages(tenant_id,id),
    FOREIGN KEY(tenant_id,registered_by) REFERENCES users(tenant_id,id)
);
CREATE INDEX documentation_customer_acceptances_tenant_idx ON documentation_customer_acceptances(tenant_id);
CREATE INDEX documentation_customer_acceptances_package_idx ON documentation_customer_acceptances(tenant_id,documentation_package_id);
CREATE TRIGGER documentation_customer_acceptances_immutable BEFORE UPDATE OR DELETE ON documentation_customer_acceptances FOR EACH ROW EXECUTE FUNCTION immutable_history();

-- The SDO Case itself. object_id/object_work_id are denormalized from the
-- package, the same convenience documentation_packages itself already takes
-- from works. `status` is the user-facing SDO workflow (F8.3 decision:
-- ON_RECONCILIATION "На выверке" / VERIFICATION_PASSED "Выверка пройдена" /
-- ON_CORRECTION "На корректировке" / CLOSED "Закрытие"), a completely
-- separate vocabulary from documentation_packages.status and from the
-- legacy sdo_cases.status — no shared meaning, no shared column.
-- `package_locked` is the Package Portion composition lock (F8.3 decisions
-- 11-13): true from the moment of handoff, false only while SDO has
-- returned the package to PTO for correction, true again on re-handoff —
-- denormalized current state, the same treatment documentation_packages.status
-- itself gets, backed by the append-only sdo_closing_handoff_history below
-- for the full timeline. `total_amount` is nullable (a case may sit in
-- ON_RECONCILIATION before SDO has entered a figure) but must be set before
-- CLOSED (service-layer rule; see SdoClosingAllocationService,
-- packages/domain) — it is never payment, invoice or accounting (F8.3: not
-- KS-2/KS-3, no financial_closings row is ever produced from this table).
CREATE TABLE sdo_closing_cases(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    object_id uuid NOT NULL,
    object_work_id uuid NOT NULL,
    documentation_package_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'ON_RECONCILIATION' CHECK(status IN ('ON_RECONCILIATION','VERIFICATION_PASSED','ON_CORRECTION','CLOSED')),
    package_locked boolean NOT NULL DEFAULT true,
    responsible_user_id uuid,
    total_amount numeric(20,2) CHECK(total_amount IS NULL OR total_amount>=0),
    created_by uuid NOT NULL,
    closed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version int NOT NULL DEFAULT 1,
    UNIQUE(tenant_id,id),
    FOREIGN KEY(tenant_id,object_id) REFERENCES objects(tenant_id,id),
    FOREIGN KEY(tenant_id,object_work_id) REFERENCES works(tenant_id,id),
    FOREIGN KEY(tenant_id,documentation_package_id) REFERENCES documentation_packages(tenant_id,id),
    FOREIGN KEY(tenant_id,responsible_user_id) REFERENCES users(tenant_id,id),
    FOREIGN KEY(tenant_id,created_by) REFERENCES users(tenant_id,id)
);
CREATE INDEX sdo_closing_cases_tenant_idx ON sdo_closing_cases(tenant_id);
CREATE INDEX sdo_closing_cases_object_idx ON sdo_closing_cases(tenant_id,object_id);
CREATE INDEX sdo_closing_cases_work_idx ON sdo_closing_cases(tenant_id,object_work_id);
CREATE INDEX sdo_closing_cases_status_idx ON sdo_closing_cases(tenant_id,status);
CREATE INDEX sdo_closing_cases_responsible_idx ON sdo_closing_cases(tenant_id,responsible_user_id);
-- "No second independent SDO Case may be created for the same Package" —
-- enforced here, not only in application code (handoffDocumentationPackageToSdo,
-- service.ts, re-locks this same row on re-handoff rather than inserting a
-- second one).
CREATE UNIQUE INDEX sdo_closing_cases_unique ON sdo_closing_cases(tenant_id,documentation_package_id);

-- Status history — append-only, same treatment as
-- documentation_package_status_history. `reason` carries the mandatory
-- CLOSED -> ON_CORRECTION justification (service-layer requirement; the
-- column itself stays nullable because every other transition's reason is
-- optional) alongside the same free-text `comment` every other history
-- table in this schema already offers.
CREATE TABLE sdo_closing_status_history(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    sdo_closing_case_id uuid NOT NULL,
    from_status text NOT NULL CHECK(from_status IN ('ON_RECONCILIATION','VERIFICATION_PASSED','ON_CORRECTION','CLOSED')),
    to_status text NOT NULL CHECK(to_status IN ('ON_RECONCILIATION','VERIFICATION_PASSED','ON_CORRECTION','CLOSED')),
    reason text,
    comment text,
    changed_by uuid NOT NULL,
    changed_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version int NOT NULL DEFAULT 1,
    UNIQUE(tenant_id,id),
    FOREIGN KEY(tenant_id,sdo_closing_case_id) REFERENCES sdo_closing_cases(tenant_id,id),
    FOREIGN KEY(tenant_id,changed_by) REFERENCES users(tenant_id,id)
);
CREATE INDEX sdo_closing_status_history_tenant_idx ON sdo_closing_status_history(tenant_id);
CREATE INDEX sdo_closing_status_history_case_idx ON sdo_closing_status_history(tenant_id,sdo_closing_case_id,changed_at);
CREATE TRIGGER sdo_closing_status_history_immutable BEFORE UPDATE OR DELETE ON sdo_closing_status_history FOR EACH ROW EXECUTE FUNCTION immutable_history();

-- Handoff/return history — append-only. A separate axis from case status
-- (F8.3 decision 13: "Вернуть в ПТО" retains the same case and does not by
-- itself change its reconciliation status) and from package status: it is
-- the record of custody between PTO and SDO over the package's composition
-- lock, independent of both.
CREATE TABLE sdo_closing_handoff_history(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    sdo_closing_case_id uuid NOT NULL,
    event text NOT NULL CHECK(event IN ('HANDED_OFF','RETURNED_TO_PTO')),
    actor_id uuid NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    comment text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version int NOT NULL DEFAULT 1,
    UNIQUE(tenant_id,id),
    FOREIGN KEY(tenant_id,sdo_closing_case_id) REFERENCES sdo_closing_cases(tenant_id,id),
    FOREIGN KEY(tenant_id,actor_id) REFERENCES users(tenant_id,id)
);
CREATE INDEX sdo_closing_handoff_history_tenant_idx ON sdo_closing_handoff_history(tenant_id);
CREATE INDEX sdo_closing_handoff_history_case_idx ON sdo_closing_handoff_history(tenant_id,sdo_closing_case_id,occurred_at);
CREATE TRIGGER sdo_closing_handoff_history_immutable BEFORE UPDATE OR DELETE ON sdo_closing_handoff_history FOR EACH ROW EXECUTE FUNCTION immutable_history();

-- Total closing amount history — append-only (F8.3: "Keep amount change
-- history... Record the prior and new value with actor and timestamp").
-- previous_amount is NULL exactly the first time an amount is ever set.
CREATE TABLE sdo_closing_amount_history(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    sdo_closing_case_id uuid NOT NULL,
    previous_amount numeric(20,2),
    new_amount numeric(20,2) NOT NULL CHECK(new_amount>=0),
    changed_by uuid NOT NULL,
    changed_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version int NOT NULL DEFAULT 1,
    UNIQUE(tenant_id,id),
    FOREIGN KEY(tenant_id,sdo_closing_case_id) REFERENCES sdo_closing_cases(tenant_id,id),
    FOREIGN KEY(tenant_id,changed_by) REFERENCES users(tenant_id,id)
);
CREATE INDEX sdo_closing_amount_history_tenant_idx ON sdo_closing_amount_history(tenant_id);
CREATE INDEX sdo_closing_amount_history_case_idx ON sdo_closing_amount_history(tenant_id,sdo_closing_case_id,changed_at);
CREATE TRIGGER sdo_closing_amount_history_immutable BEFORE UPDATE OR DELETE ON sdo_closing_amount_history FOR EACH ROW EXECUTE FUNCTION immutable_history();

-- Optional per-Quantity-Portion allocation of the total closing amount
-- (F8.3: "Detailed amount allocation across covered Quantity Portions is
-- optional... Do not allow duplicate allocations for the same Quantity
-- Portion... Allocated Portions must belong to the Documentation Package
-- coverage"). Create-only (no update/delete route), the same lifecycle
-- documentation_package_portions linking already has — correcting a mistake
-- means the case is still in ON_RECONCILIATION/VERIFICATION_PASSED/
-- ON_CORRECTION (never CLOSED, service-layer rule) where nothing yet
-- depends on the wrong figure. Cross-entity "this portion is actually
-- covered by this case's package" is checked in application code
-- (setSdoClosingPortionAllocation, service.ts), the same discipline
-- linkDocumentationPackagePortion() already applies to its own cross-table rule.
CREATE TABLE sdo_closing_portion_allocations(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    sdo_closing_case_id uuid NOT NULL,
    quantity_portion_id uuid NOT NULL,
    amount numeric(20,2) NOT NULL CHECK(amount>0),
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version int NOT NULL DEFAULT 1,
    UNIQUE(tenant_id,id),
    FOREIGN KEY(tenant_id,sdo_closing_case_id) REFERENCES sdo_closing_cases(tenant_id,id),
    FOREIGN KEY(tenant_id,quantity_portion_id) REFERENCES quantity_portions(tenant_id,id),
    FOREIGN KEY(tenant_id,created_by) REFERENCES users(tenant_id,id)
);
CREATE INDEX sdo_closing_portion_allocations_tenant_idx ON sdo_closing_portion_allocations(tenant_id);
CREATE INDEX sdo_closing_portion_allocations_case_idx ON sdo_closing_portion_allocations(tenant_id,sdo_closing_case_id);
CREATE UNIQUE INDEX sdo_closing_portion_allocations_unique ON sdo_closing_portion_allocations(tenant_id,sdo_closing_case_id,quantity_portion_id);
