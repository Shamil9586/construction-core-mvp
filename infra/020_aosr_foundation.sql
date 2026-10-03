-- ID-AUTO-1 — AOSR (акт освидетельствования скрытых работ) inside the existing
-- Documentation Package. Additive only: no F8.1/F8.2/F8.3 table keeps anything but
-- one nullable column (documentation_documents.title) and a wider storage-provider
-- CHECK on documentation_document_versions.
--
-- Locked model:
--   * an AOSR is a documented operation of a package's Work, NOT a production Work/WEU;
--     one Work/package holds any number of AOSRs (aosr_documents);
--   * an AOSR may cite Quantity Portions for provenance only (aosr_portion_links) — a
--     portion is never consumed, the same portion may back several AOSRs, and no
--     quantity is ever stored on or rendered from an AOSR;
--   * an AOSR's DOCX lives in the existing documentation_documents (type AOSR) ->
--     documentation_document_versions layer (storage_provider CORE_FILE -> attachments);
--   * the official number is assigned on the first successful generation only;
--     aosr_revisions is the append-only technical history behind "one AOSR, one current DOCX";
--   * one executive scheme (documentation_documents, type EXECUTIVE_SCHEME) may back many
--     AOSRs (aosr_scheme_links is many-to-many);
--   * customer-accepted quantity is an independent append-only history that also appends a
--     CUSTOMER_SC row to portion_quantity_confirmations, so SDO reads it like any other
--     customer confirmation while RP_FACT / INTERNAL_SC rows stay untouched.

ALTER TABLE documentation_documents ADD COLUMN title text;

DO $$
DECLARE r record;
BEGIN
    FOR r IN SELECT conname FROM pg_constraint WHERE conrelid='documentation_document_versions'::regclass AND contype='c' LOOP
        EXECUTE format('ALTER TABLE documentation_document_versions DROP CONSTRAINT %I', r.conname);
    END LOOP;
END $$;
ALTER TABLE documentation_document_versions ADD CHECK(version_number>0);
ALTER TABLE documentation_document_versions ADD CHECK(storage_provider IN ('NONE','EXTERNAL_REFERENCE','CORE_FILE'));
ALTER TABLE documentation_document_versions ADD CHECK(
    (storage_provider='NONE' AND storage_reference IS NULL)
    OR (storage_provider IN ('EXTERNAL_REFERENCE','CORE_FILE') AND storage_reference IS NOT NULL AND length(trim(storage_reference))>0));

-- Object-level master data: organizations and signatories required by the official form.
-- Current state is edited in place; every change appends an immutable snapshot.
CREATE TABLE aosr_party_records(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    object_id uuid NOT NULL,
    party_role text NOT NULL CHECK(party_role IN ('DEVELOPER','CONSTRUCTION_ENTITY','DESIGNER','WORK_EXECUTOR','DEVELOPER_SC_REP','CONSTRUCTION_REP','INTERNAL_SC','DESIGNER_REP','EXECUTOR_REP')),
    organization_name text,
    organization_details text,
    person_name text,
    position text,
    registry_number text,
    authority_document text,
    updated_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version int NOT NULL DEFAULT 1,
    UNIQUE(tenant_id,id),
    UNIQUE(tenant_id,object_id,party_role),
    FOREIGN KEY(tenant_id,object_id) REFERENCES objects(tenant_id,id),
    FOREIGN KEY(tenant_id,updated_by) REFERENCES users(tenant_id,id)
);
CREATE INDEX aosr_party_records_tenant_idx ON aosr_party_records(tenant_id,object_id);

CREATE TABLE aosr_party_record_history(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    object_id uuid NOT NULL,
    party_role text NOT NULL,
    snapshot jsonb NOT NULL,
    changed_by uuid NOT NULL,
    changed_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version int NOT NULL DEFAULT 1,
    UNIQUE(tenant_id,id),
    FOREIGN KEY(tenant_id,object_id) REFERENCES objects(tenant_id,id),
    FOREIGN KEY(tenant_id,changed_by) REFERENCES users(tenant_id,id)
);
CREATE INDEX aosr_party_record_history_idx ON aosr_party_record_history(tenant_id,object_id,party_role,changed_at);
CREATE TRIGGER aosr_party_record_history_immutable BEFORE UPDATE OR DELETE ON aosr_party_record_history FOR EACH ROW EXECUTE FUNCTION immutable_history();

-- The AOSR identity inside a Documentation Package.
CREATE TABLE aosr_documents(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    object_id uuid NOT NULL,
    object_work_id uuid NOT NULL,
    documentation_package_id uuid NOT NULL,
    documentation_document_id uuid,
    suggestion_code text,
    title text NOT NULL,
    work_description text,
    start_date date,
    end_date date,
    act_date date,
    project_documentation text,
    normative_references text,
    subsequent_work text,
    additional_info text,
    copies_count int CHECK(copies_count IS NULL OR copies_count>0),
    official_number int CHECK(official_number IS NULL OR official_number>0),
    revision_count int NOT NULL DEFAULT 0,
    generated_at_version int,
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version int NOT NULL DEFAULT 1,
    UNIQUE(tenant_id,id),
    FOREIGN KEY(tenant_id,object_id) REFERENCES objects(tenant_id,id),
    FOREIGN KEY(tenant_id,object_work_id) REFERENCES works(tenant_id,id),
    FOREIGN KEY(tenant_id,documentation_package_id) REFERENCES documentation_packages(tenant_id,id),
    FOREIGN KEY(tenant_id,documentation_document_id) REFERENCES documentation_documents(tenant_id,id),
    FOREIGN KEY(tenant_id,created_by) REFERENCES users(tenant_id,id)
);
CREATE INDEX aosr_documents_package_idx ON aosr_documents(tenant_id,documentation_package_id);
CREATE UNIQUE INDEX aosr_documents_number_unique ON aosr_documents(tenant_id,object_id,official_number) WHERE official_number IS NOT NULL;
CREATE UNIQUE INDEX aosr_documents_document_unique ON aosr_documents(tenant_id,documentation_document_id) WHERE documentation_document_id IS NOT NULL;

-- Automatic sequence per object scope (consumed only by first generation).
CREATE TABLE aosr_number_counters(
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    object_id uuid NOT NULL,
    last_number int NOT NULL DEFAULT 0,
    PRIMARY KEY(tenant_id,object_id),
    FOREIGN KEY(tenant_id,object_id) REFERENCES objects(tenant_id,id)
);

-- Technical revision/audit history: one row per successful generation.
CREATE TABLE aosr_revisions(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    aosr_id uuid NOT NULL,
    revision_number int NOT NULL CHECK(revision_number>0),
    official_number int NOT NULL,
    render_model jsonb NOT NULL,
    documentation_version_id uuid NOT NULL,
    generated_by uuid NOT NULL,
    generated_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version int NOT NULL DEFAULT 1,
    UNIQUE(tenant_id,id),
    UNIQUE(tenant_id,aosr_id,revision_number),
    FOREIGN KEY(tenant_id,aosr_id) REFERENCES aosr_documents(tenant_id,id),
    FOREIGN KEY(tenant_id,documentation_version_id) REFERENCES documentation_document_versions(tenant_id,id),
    FOREIGN KEY(tenant_id,generated_by) REFERENCES users(tenant_id,id)
);
CREATE TRIGGER aosr_revisions_immutable BEFORE UPDATE OR DELETE ON aosr_revisions FOR EACH ROW EXECUTE FUNCTION immutable_history();

-- Provenance only. Deliberately NO uniqueness across AOSRs: a portion is not consumed.
CREATE TABLE aosr_portion_links(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    aosr_id uuid NOT NULL,
    quantity_portion_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version int NOT NULL DEFAULT 1,
    UNIQUE(tenant_id,id),
    UNIQUE(tenant_id,aosr_id,quantity_portion_id),
    FOREIGN KEY(tenant_id,aosr_id) REFERENCES aosr_documents(tenant_id,id),
    FOREIGN KEY(tenant_id,quantity_portion_id) REFERENCES quantity_portions(tenant_id,id)
);

-- Materials -> quality documents. No delivery/batch/logistics.
CREATE TABLE aosr_material_records(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    object_id uuid NOT NULL,
    material_id uuid,
    name text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version int NOT NULL DEFAULT 1,
    UNIQUE(tenant_id,id),
    FOREIGN KEY(tenant_id,object_id) REFERENCES objects(tenant_id,id),
    FOREIGN KEY(tenant_id,material_id) REFERENCES materials(tenant_id,id),
    FOREIGN KEY(tenant_id,created_by) REFERENCES users(tenant_id,id)
);
CREATE INDEX aosr_material_records_object_idx ON aosr_material_records(tenant_id,object_id);
CREATE TABLE aosr_quality_documents(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    material_record_id uuid NOT NULL,
    doc_type text NOT NULL CHECK(doc_type IN ('PASSPORT','CERTIFICATE','DECLARATION','OTHER')),
    number text NOT NULL,
    doc_date date,
    issuer text,
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version int NOT NULL DEFAULT 1,
    UNIQUE(tenant_id,id),
    FOREIGN KEY(tenant_id,material_record_id) REFERENCES aosr_material_records(tenant_id,id),
    FOREIGN KEY(tenant_id,created_by) REFERENCES users(tenant_id,id)
);
CREATE INDEX aosr_quality_documents_material_idx ON aosr_quality_documents(tenant_id,material_record_id);
CREATE TABLE aosr_material_links(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    aosr_id uuid NOT NULL,
    material_record_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version int NOT NULL DEFAULT 1,
    UNIQUE(tenant_id,id),
    UNIQUE(tenant_id,aosr_id,material_record_id),
    FOREIGN KEY(tenant_id,aosr_id) REFERENCES aosr_documents(tenant_id,id),
    FOREIGN KEY(tenant_id,material_record_id) REFERENCES aosr_material_records(tenant_id,id)
);

-- AOSR <-> executive scheme: many-to-many.
CREATE TABLE aosr_scheme_links(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    aosr_id uuid NOT NULL,
    scheme_document_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version int NOT NULL DEFAULT 1,
    UNIQUE(tenant_id,id),
    UNIQUE(tenant_id,aosr_id,scheme_document_id),
    FOREIGN KEY(tenant_id,aosr_id) REFERENCES aosr_documents(tenant_id,id),
    FOREIGN KEY(tenant_id,scheme_document_id) REFERENCES documentation_documents(tenant_id,id)
);

-- Typical-suggestion items the engineer removed from a package's suggestion list.
CREATE TABLE aosr_suggestion_dismissals(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    documentation_package_id uuid NOT NULL,
    suggestion_code text NOT NULL,
    dismissed_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version int NOT NULL DEFAULT 1,
    UNIQUE(tenant_id,id),
    UNIQUE(tenant_id,documentation_package_id,suggestion_code),
    FOREIGN KEY(tenant_id,documentation_package_id) REFERENCES documentation_packages(tenant_id,id),
    FOREIGN KEY(tenant_id,dismissed_by) REFERENCES users(tenant_id,id)
);

-- "Принято заказчиком": independent append-only history, one row per portion per action.
-- confirmation_id is the CUSTOMER_SC row appended to portion_quantity_confirmations in the
-- same transaction (what SDO reads); RP_FACT / INTERNAL_SC rows are never touched.
CREATE TABLE documentation_customer_accepted_quantities(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    documentation_package_id uuid NOT NULL,
    quantity_portion_id uuid NOT NULL,
    quantity numeric(20,4) NOT NULL CHECK(quantity>=0),
    confirmation_id uuid NOT NULL,
    reference text,
    comment text,
    recorded_by uuid NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version int NOT NULL DEFAULT 1,
    UNIQUE(tenant_id,id),
    FOREIGN KEY(tenant_id,documentation_package_id) REFERENCES documentation_packages(tenant_id,id),
    FOREIGN KEY(tenant_id,quantity_portion_id) REFERENCES quantity_portions(tenant_id,id),
    FOREIGN KEY(tenant_id,confirmation_id) REFERENCES portion_quantity_confirmations(tenant_id,id),
    FOREIGN KEY(tenant_id,recorded_by) REFERENCES users(tenant_id,id)
);
CREATE INDEX documentation_customer_accepted_quantities_idx ON documentation_customer_accepted_quantities(tenant_id,documentation_package_id,recorded_at);
CREATE TRIGGER documentation_customer_accepted_quantities_immutable BEFORE UPDATE OR DELETE ON documentation_customer_accepted_quantities FOR EACH ROW EXECUTE FUNCTION immutable_history();
