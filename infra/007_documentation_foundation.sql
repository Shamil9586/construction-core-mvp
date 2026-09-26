-- F8.2 PTO / Executive Documentation Foundation.
-- Construction Core F8.2 Architecture Contract v1.0 / Decision Lock v1.1 —
-- Documentation Package, Package <-> Quantity Portion relation, Documentation
-- Document, Documentation Version (carrying its own storage reference),
-- status history. Additive only: no F8.1 or earlier table is altered.
--
-- Deliberately separate from the pre-existing executive_packages /
-- executive_documents / package_documents / pto_transfers (001_initial.sql):
-- those are the SDO-closing pipeline (pto_transfers -> sdo_cases,
-- packageAction() 'transfer-sdo' in service.ts) — F8.2's own Definition of
-- Done explicitly excludes SDO closing, so reusing that model would pull
-- F8.2 into a workflow it is not allowed to touch. A Documentation Package
-- here never produces an sdo_cases row and has no column that could.
--
-- Composite foreign keys follow 004_object_contractor_history.sql's and
-- 006_production_execution.sql's precedent
-- (FOREIGN KEY(tenant_id,col) REFERENCES table(tenant_id,id)) — new tables,
-- no existing rows to validate against.

CREATE TABLE documentation_packages(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    object_id uuid NOT NULL,
    object_work_id uuid NOT NULL,
    -- BR-01: a package may exist before the work it covers is complete — no
    -- column here reads or constrains works.actual_quantity/planned_quantity
    -- at all. BR-02: this status never feeds ProgressCalculationService,
    -- ScheduleStatusService or ObjectHealthService. BR-03: it never feeds
    -- portion_quantity_confirmations or quantity_portions either — quantity
    -- confirmation stays exactly F8.1's own model.
    status text NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','PREPARING','READY_FOR_PRESENTATION','PRESENTED','RETURNED','CORRECTING','ACCEPTED_BY_CUSTOMER')),
    responsible_user_id uuid NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version int NOT NULL DEFAULT 1,
    UNIQUE(tenant_id,id),
    FOREIGN KEY(tenant_id,object_id) REFERENCES objects(tenant_id,id),
    FOREIGN KEY(tenant_id,object_work_id) REFERENCES works(tenant_id,id),
    FOREIGN KEY(tenant_id,responsible_user_id) REFERENCES users(tenant_id,id),
    FOREIGN KEY(tenant_id,created_by) REFERENCES users(tenant_id,id)
);
CREATE INDEX documentation_packages_tenant_idx ON documentation_packages(tenant_id);
CREATE INDEX documentation_packages_object_idx ON documentation_packages(tenant_id,object_id);
CREATE INDEX documentation_packages_work_idx ON documentation_packages(tenant_id,object_work_id);
CREATE INDEX documentation_packages_status_idx ON documentation_packages(tenant_id,status);

-- Package <-> Quantity Portion relation. Many-to-many by construction (a
-- package can cover several portions of its own work; nothing here prevents
-- the same portion being referenced by more than one package either — nothing
-- in the Foundation contract asks for that restriction). Cross-work linking
-- (a portion whose execution unit belongs to a *different* work than the
-- package's own object_work_id) is rejected in ProductionService, the same
-- place createExecutionUnit() already checks its own cross-entity rules —
-- not a cross-row invariant a CHECK constraint alone could express.
CREATE TABLE documentation_package_portions(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    documentation_package_id uuid NOT NULL,
    quantity_portion_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version int NOT NULL DEFAULT 1,
    UNIQUE(tenant_id,id),
    FOREIGN KEY(tenant_id,documentation_package_id) REFERENCES documentation_packages(tenant_id,id),
    FOREIGN KEY(tenant_id,quantity_portion_id) REFERENCES quantity_portions(tenant_id,id)
);
CREATE INDEX documentation_package_portions_tenant_idx ON documentation_package_portions(tenant_id);
CREATE INDEX documentation_package_portions_package_idx ON documentation_package_portions(tenant_id,documentation_package_id);
CREATE UNIQUE INDEX documentation_package_portions_unique ON documentation_package_portions(tenant_id,documentation_package_id,quantity_portion_id);

-- Documentation Document — one row per document *slot* in a package (e.g.
-- "the AOSR for this package"); its actual content lives in its versions
-- below, never here. Document Types MVP dictionary (F8.2 Decision Lock):
-- AOSR / ACT_CERTIFICATE / EXECUTIVE_SCHEME only. GENERAL_WORK_LOG is
-- explicitly out of scope and is not a legal value.
CREATE TABLE documentation_documents(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    documentation_package_id uuid NOT NULL,
    type text NOT NULL CHECK(type IN ('AOSR','ACT_CERTIFICATE','EXECUTIVE_SCHEME')),
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version int NOT NULL DEFAULT 1,
    UNIQUE(tenant_id,id),
    FOREIGN KEY(tenant_id,documentation_package_id) REFERENCES documentation_packages(tenant_id,id),
    FOREIGN KEY(tenant_id,created_by) REFERENCES users(tenant_id,id)
);
CREATE INDEX documentation_documents_tenant_idx ON documentation_documents(tenant_id);
CREATE INDEX documentation_documents_package_idx ON documentation_documents(tenant_id,documentation_package_id);

-- Documentation Version — the Storage Reference layer (F8.2 Decision Lock):
-- NONE (no file reference of any kind yet) or EXTERNAL_REFERENCE (a plain
-- URL/reference string PTO enters by hand). BITRIX_DISK is future
-- compatibility only and is deliberately absent from the CHECK below — this
-- migration does not implement Bitrix Disk, file upload, an archive or a PDF
-- viewer; adding BITRIX_DISK is a later migration's job, once that provider
-- is real. Append-only (immutable_history(), 001_initial.sql's own trigger
-- function) — a new version is how a document changes, never an edit to an
-- existing one, so "version 1, version 2, history preserved" holds by
-- construction, not by application discipline alone.
CREATE TABLE documentation_document_versions(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    documentation_document_id uuid NOT NULL,
    version_number int NOT NULL CHECK(version_number>0),
    storage_provider text NOT NULL CHECK(storage_provider IN ('NONE','EXTERNAL_REFERENCE')),
    storage_reference text,
    CHECK((storage_provider='NONE' AND storage_reference IS NULL) OR (storage_provider='EXTERNAL_REFERENCE' AND storage_reference IS NOT NULL AND length(trim(storage_reference))>0)),
    comment text,
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version int NOT NULL DEFAULT 1,
    UNIQUE(tenant_id,id),
    FOREIGN KEY(tenant_id,documentation_document_id) REFERENCES documentation_documents(tenant_id,id),
    FOREIGN KEY(tenant_id,created_by) REFERENCES users(tenant_id,id)
);
CREATE INDEX documentation_document_versions_tenant_idx ON documentation_document_versions(tenant_id);
CREATE INDEX documentation_document_versions_document_idx ON documentation_document_versions(tenant_id,documentation_document_id,version_number);
CREATE UNIQUE INDEX documentation_document_versions_unique ON documentation_document_versions(tenant_id,documentation_document_id,version_number);
CREATE TRIGGER documentation_document_versions_immutable BEFORE UPDATE OR DELETE ON documentation_document_versions FOR EACH ROW EXECUTE FUNCTION immutable_history();

-- Status history — append-only, same treatment as portion_quantity_confirmations
-- (006_production_execution.sql). Recorded on every changeDocumentationPackageStatus()
-- call, never on package creation itself (the package row's own created_at
-- and its DRAFT default already say "DRAFT since creation" without a row).
CREATE TABLE documentation_package_status_history(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    documentation_package_id uuid NOT NULL,
    from_status text NOT NULL CHECK(from_status IN ('DRAFT','PREPARING','READY_FOR_PRESENTATION','PRESENTED','RETURNED','CORRECTING','ACCEPTED_BY_CUSTOMER')),
    to_status text NOT NULL CHECK(to_status IN ('DRAFT','PREPARING','READY_FOR_PRESENTATION','PRESENTED','RETURNED','CORRECTING','ACCEPTED_BY_CUSTOMER')),
    changed_by uuid NOT NULL,
    changed_at timestamptz NOT NULL DEFAULT now(),
    comment text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version int NOT NULL DEFAULT 1,
    UNIQUE(tenant_id,id),
    FOREIGN KEY(tenant_id,documentation_package_id) REFERENCES documentation_packages(tenant_id,id),
    FOREIGN KEY(tenant_id,changed_by) REFERENCES users(tenant_id,id)
);
CREATE INDEX documentation_package_status_history_tenant_idx ON documentation_package_status_history(tenant_id);
CREATE INDEX documentation_package_status_history_package_idx ON documentation_package_status_history(tenant_id,documentation_package_id,changed_at);
CREATE TRIGGER documentation_status_history_immutable BEFORE UPDATE OR DELETE ON documentation_package_status_history FOR EACH ROW EXECUTE FUNCTION immutable_history();
