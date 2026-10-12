-- PTO package scope / duplicate prevention.
--
-- A Quantity Portion may be claimed by at most ONE Documentation Package (several packages per Work are fine as long as their portions
-- differ; several AOSRs inside one package may reuse a portion — that is aosr_portion_links, a different relation).
--
-- The service already refuses an overlapping package (and serialises creation/linking on the works row). This trigger is the database
-- backstop for a writer that bypasses the service and for a race the row lock could not see: it takes a per-portion advisory lock
-- (so two concurrent inserts of the same portion are serialised) and then rejects the insert when ANOTHER package already holds it.
--
-- It fires on INSERT only. Rows that already overlap (historical data, e.g. verification packages) are neither rewritten nor invalidated.
-- The lifecycle has no archived/cancelled state, so every package is active; an archive state would be excluded in the EXISTS below.

CREATE FUNCTION documentation_package_portions_no_overlap() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('doc-package-portion:' || NEW.quantity_portion_id::text, 0));
    IF EXISTS (
        SELECT 1 FROM documentation_package_portions p
        WHERE p.tenant_id = NEW.tenant_id AND p.quantity_portion_id = NEW.quantity_portion_id AND p.documentation_package_id <> NEW.documentation_package_id
    ) THEN
        RAISE EXCEPTION 'Этот участок уже включён в активный пакет исполнительной документации.' USING ERRCODE = '23505';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER documentation_package_portions_no_overlap BEFORE INSERT ON documentation_package_portions FOR EACH ROW EXECUTE FUNCTION documentation_package_portions_no_overlap();
CREATE INDEX IF NOT EXISTS documentation_package_portions_portion_idx ON documentation_package_portions(tenant_id,quantity_portion_id);
