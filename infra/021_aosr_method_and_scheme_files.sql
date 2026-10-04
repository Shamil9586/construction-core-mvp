-- ID-AUTO-1 final corrective — the Core AOSR generator is an OPTIONAL PTO tool, not a workflow gate.
--
-- documentation_package_aosr_methods records, append-only, HOW a package's AOSRs are prepared:
--   CORE     — «АОСР формируются в Core» (the ID-AUTO-1 generator is used);
--   EXTERNAL — «АОСР формируются вне Core» (prepared on the engineer's own computer; Core keeps no AOSR
--              records, no placeholder document and consumes no AOSR number — only this fact).
-- The current method is the latest row; a package with no row has not declared one (never inferred).
-- Both methods converge into the same package -> customer acceptance -> SDO process.
--
-- Executive-scheme FILES need no schema change: a scheme stays a documentation_documents row
-- (type EXECUTIVE_SCHEME) and its real file is a CORE_FILE documentation_document_versions row pointing at an
-- attachments row with content (added by 020). A scheme without such a version is metadata only.

CREATE TABLE documentation_package_aosr_methods(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    documentation_package_id uuid NOT NULL,
    method text NOT NULL CHECK(method IN ('CORE','EXTERNAL')),
    chosen_by uuid NOT NULL,
    chosen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    comment text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version int NOT NULL DEFAULT 1,
    UNIQUE(tenant_id,id),
    FOREIGN KEY(tenant_id,documentation_package_id) REFERENCES documentation_packages(tenant_id,id),
    FOREIGN KEY(tenant_id,chosen_by) REFERENCES users(tenant_id,id)
);
CREATE INDEX documentation_package_aosr_methods_idx ON documentation_package_aosr_methods(tenant_id,documentation_package_id,chosen_at);
CREATE TRIGGER documentation_package_aosr_methods_immutable BEFORE UPDATE OR DELETE ON documentation_package_aosr_methods FOR EACH ROW EXECUTE FUNCTION immutable_history();

-- Packages that already hold Core AOSR records were prepared with the Core generator: record that fact once,
-- attributed to whoever created their first AOSR, so the method is explicit rather than silently inferred later.
INSERT INTO documentation_package_aosr_methods(tenant_id,documentation_package_id,method,chosen_by,comment)
SELECT DISTINCT ON (tenant_id,documentation_package_id) tenant_id,documentation_package_id,'CORE',created_by,'Зафиксировано миграцией 021 по уже созданным АОСР'
FROM aosr_documents ORDER BY tenant_id,documentation_package_id,created_at;
