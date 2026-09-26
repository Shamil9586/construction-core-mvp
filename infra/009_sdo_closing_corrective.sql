-- F8.3 Corrective Patch (R02, R05). Additive only — 008_sdo_closing.sql's own
-- tables are unchanged; this migration only adds two new tables.

-- R02: documentation_customer_acceptances.documentation_package_version is the
-- Documentation Package's own optimistic-lock row version — never a
-- Documentation Document Version, and a Package can hold several documents
-- (documentation_documents), each independently versioned
-- (documentation_document_versions, 007_documentation_foundation.sql). That
-- column alone cannot prove which actual document content the customer
-- accepted, and createDocumentationVersion() never bumps the package's own
-- version, so a new document version after acceptance would leave the old
-- acceptance record looking unchanged.
--
-- This table is the immutable snapshot fixing that: one row per Documentation
-- Document Version that was current/presented at the moment
-- registerDocumentationCustomerAcceptance() ran, linked to that acceptance.
-- Append-only, the same treatment every other F8.2/F8.3 history table already
-- gets — a new presentation/acceptance cycle inserts a whole new acceptance
-- row and a whole new set of version links here, never edits the old ones.
-- Readiness (resolvePackageSdoReadiness's caller, packages/domain) requires
-- the *latest* acceptance's snapshot to still match every covered document's
-- *current* latest version — see isCustomerAcceptanceSnapshotCurrent(),
-- packages/domain — so adding or changing a document version after the
-- accepted presentation can no longer silently remain "covered" by the old
-- acceptance.
CREATE TABLE documentation_customer_acceptance_versions(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    customer_acceptance_id uuid NOT NULL,
    documentation_document_version_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version int NOT NULL DEFAULT 1,
    UNIQUE(tenant_id,id),
    FOREIGN KEY(tenant_id,customer_acceptance_id) REFERENCES documentation_customer_acceptances(tenant_id,id),
    FOREIGN KEY(tenant_id,documentation_document_version_id) REFERENCES documentation_document_versions(tenant_id,id)
);
CREATE INDEX documentation_customer_acceptance_versions_tenant_idx ON documentation_customer_acceptance_versions(tenant_id);
CREATE INDEX documentation_customer_acceptance_versions_acceptance_idx ON documentation_customer_acceptance_versions(tenant_id,customer_acceptance_id);
CREATE UNIQUE INDEX documentation_customer_acceptance_versions_unique ON documentation_customer_acceptance_versions(tenant_id,customer_acceptance_id,documentation_document_version_id);
CREATE TRIGGER documentation_customer_acceptance_versions_immutable BEFORE UPDATE OR DELETE ON documentation_customer_acceptance_versions FOR EACH ROW EXECUTE FUNCTION immutable_history();

-- R05: sdo_closing_portion_allocations was create-only (no update/delete
-- route) — a mistaken allocation could never be corrected, since a duplicate
-- allocation for the same Quantity Portion was rejected outright and the
-- exact-sum-for-CLOSED rule could then permanently block closing. This table
-- is the append-only correction trail: setSdoClosingPortionAllocation()
-- (service.ts) now updates the existing Portion allocation row in place
-- (sdo_closing_portion_allocations_unique still guarantees at most one
-- *current* row per Portion) and records the prior and new value here on
-- every write — previous_amount is NULL exactly the first time, the same
-- convention sdo_closing_amount_history already uses for the case's own
-- total amount.
CREATE TABLE sdo_closing_portion_allocation_history(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    sdo_closing_case_id uuid NOT NULL,
    quantity_portion_id uuid NOT NULL,
    previous_amount numeric(20,2),
    new_amount numeric(20,2) NOT NULL CHECK(new_amount>0),
    changed_by uuid NOT NULL,
    changed_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version int NOT NULL DEFAULT 1,
    UNIQUE(tenant_id,id),
    FOREIGN KEY(tenant_id,sdo_closing_case_id) REFERENCES sdo_closing_cases(tenant_id,id),
    FOREIGN KEY(tenant_id,quantity_portion_id) REFERENCES quantity_portions(tenant_id,id),
    FOREIGN KEY(tenant_id,changed_by) REFERENCES users(tenant_id,id)
);
CREATE INDEX sdo_closing_portion_allocation_history_tenant_idx ON sdo_closing_portion_allocation_history(tenant_id);
CREATE INDEX sdo_closing_portion_allocation_history_case_idx ON sdo_closing_portion_allocation_history(tenant_id,sdo_closing_case_id,changed_at);
CREATE TRIGGER sdo_closing_portion_allocation_history_immutable BEFORE UPDATE OR DELETE ON sdo_closing_portion_allocation_history FOR EACH ROW EXECUTE FUNCTION immutable_history();
