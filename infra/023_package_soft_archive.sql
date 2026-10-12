-- Documentation Package soft archive.
--
-- Archive is NOT a lifecycle status (documentation_packages.status keeps the PTO workflow unchanged): it is orthogonal metadata that
-- says "this package is no longer part of the working set". The row, its documents, versions, method, scope and history all stay.
--
--   archived_at / archived_by / archive_reason are written together, once, by the audited service operation. An archived package:
--     * does not appear in the normal package lists;
--     * does NOT reserve its Quantity Portions (the overlap rule below only looks at packages with archived_at IS NULL);
--     * can never change again (no forward mutation, no un-archive) and can never be hard-deleted.
--
-- The service decides WHEN a package may be archived (only unused DRAFT/PREPARING packages — see packages/domain/package-archive.ts);
-- the constraints and triggers here are the database backstop for the invariants that must never depend on the application.

ALTER TABLE documentation_packages ADD COLUMN archived_at timestamptz;
ALTER TABLE documentation_packages ADD COLUMN archived_by uuid;
ALTER TABLE documentation_packages ADD COLUMN archive_reason text;
ALTER TABLE documentation_packages ADD CONSTRAINT documentation_packages_archive_consistent CHECK (
    (archived_at IS NULL AND archived_by IS NULL AND archive_reason IS NULL)
    OR (archived_at IS NOT NULL AND archived_by IS NOT NULL AND archive_reason IS NOT NULL AND length(trim(archive_reason)) > 0)
);
ALTER TABLE documentation_packages ADD CONSTRAINT documentation_packages_archived_by_fk FOREIGN KEY(tenant_id,archived_by) REFERENCES users(tenant_id,id);
-- The working set: "active" packages of a Work.
CREATE INDEX documentation_packages_active_idx ON documentation_packages(tenant_id,object_work_id) WHERE archived_at IS NULL;

-- An archived package is a retained historical record: it never changes again and is never deleted.
CREATE FUNCTION documentation_packages_archived_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.archived_at IS NOT NULL THEN
            RAISE EXCEPTION 'Архивный пакет исполнительной документации не удаляется: он остаётся в системе для аудита.' USING ERRCODE = '23000';
        END IF;
        RETURN OLD;
    END IF;
    IF OLD.archived_at IS NOT NULL THEN
        RAISE EXCEPTION 'Архивный пакет исполнительной документации не изменяется.' USING ERRCODE = '23000';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER documentation_packages_archived_immutable BEFORE UPDATE OR DELETE ON documentation_packages FOR EACH ROW EXECUTE FUNCTION documentation_packages_archived_immutable();

-- Overlap rule (022) restated for the archive: a portion is reserved only by ACTIVE packages. An archived package neither blocks a new
-- claim nor may receive one. Same per-portion advisory lock as before, so concurrent claims of one portion stay serialised.
CREATE OR REPLACE FUNCTION documentation_package_portions_no_overlap() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('doc-package-portion:' || NEW.quantity_portion_id::text, 0));
    IF EXISTS (SELECT 1 FROM documentation_packages p WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.documentation_package_id AND p.archived_at IS NOT NULL) THEN
        RAISE EXCEPTION 'Пакет архивирован: в него нельзя добавить участок.' USING ERRCODE = '23000';
    END IF;
    IF EXISTS (
        SELECT 1 FROM documentation_package_portions l
        JOIN documentation_packages p ON p.tenant_id = l.tenant_id AND p.id = l.documentation_package_id
        WHERE l.tenant_id = NEW.tenant_id AND l.quantity_portion_id = NEW.quantity_portion_id
          AND l.documentation_package_id <> NEW.documentation_package_id AND p.archived_at IS NULL
    ) THEN
        RAISE EXCEPTION 'Этот участок уже включён в активный пакет исполнительной документации.' USING ERRCODE = '23505';
    END IF;
    RETURN NEW;
END $$;
