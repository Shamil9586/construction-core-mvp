-- BITRIX-DISK-1 — file storage foundation (Bitrix24 Disk as a storage provider).
--
-- Production migration 024. Applied exactly once, in order, by scripts/migrate.ts through the normal numbered chain (it follows 023,
-- precedes 025 GPR production schedule). There is no pending-SQL mechanism any more. The statements are idempotent
-- (IF NOT EXISTS / guarded constraints), so a database that already applied this content from the former infra/pending location is unaffected.
--
-- Additive only. No existing row is rewritten, no document-version table is touched (documentation_document_versions keeps
-- storage_provider='CORE_FILE'; its CHECK and immutability trigger are unchanged), nothing is backfilled or migrated to Disk.
--
-- Model: `attachments` is the Core file record. It already carries `file_provider` (default 'LOCAL', every existing row) and
-- `external_file_id` (unused until now). This migration adds what a second provider needs to be a TRUSTED reference:
--   size_bytes, checksum_sha256  — Core's own claim about the bytes (verified on every read from Disk; makes "non-empty
--                                  file-backed" a pure-SQL fact for externally stored files)
--   external_folder_id           — where the provider put it (diagnostics / reconciliation)
-- and a CHECK that a non-LOCAL record cannot exist without an external id, a positive size and a checksum, and holds no inline bytes.
-- LOCAL rows (all legacy rows) satisfy the CHECK trivially, so it validates instantly and cannot reject history.

ALTER TABLE attachments ADD COLUMN IF NOT EXISTS size_bytes bigint;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS checksum_sha256 text;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS external_folder_id text;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='attachments'::regclass AND conname='attachments_size_nonnegative') THEN
        ALTER TABLE attachments ADD CONSTRAINT attachments_size_nonnegative CHECK(size_bytes IS NULL OR size_bytes>=0);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='attachments'::regclass AND conname='attachments_external_provider_complete') THEN
        ALTER TABLE attachments ADD CONSTRAINT attachments_external_provider_complete CHECK(
            file_provider='LOCAL'
            OR (external_file_id IS NOT NULL AND length(trim(external_file_id))>0
                AND content IS NULL
                AND size_bytes IS NOT NULL AND size_bytes>0
                AND checksum_sha256 IS NOT NULL AND length(checksum_sha256)=64));
    END IF;
END $$;

-- Provider-side folder mapping: a Core scope (tenant, provider, scope_key) -> the provider's folder id. The Disk folder NAME is
-- only a label; uploads address the folder by this id, so renaming an Object (or the folder) never orphans files, and a repeated
-- upload reuses the same folder instead of creating a second tree. scope_key examples: ROOT, OBJECT:<uuid>, OBJECT:<uuid>/PTO/ID/AOSR.
CREATE TABLE IF NOT EXISTS storage_folder_mappings(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    provider text NOT NULL,
    scope_key text NOT NULL CHECK(length(scope_key)>0),
    object_id uuid,
    external_folder_id text NOT NULL CHECK(length(trim(external_folder_id))>0),
    folder_name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version int NOT NULL DEFAULT 1,
    UNIQUE(tenant_id,id),
    UNIQUE(tenant_id,provider,scope_key),
    FOREIGN KEY(tenant_id,object_id) REFERENCES objects(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS storage_folder_mappings_object_idx ON storage_folder_mappings(tenant_id,object_id);
