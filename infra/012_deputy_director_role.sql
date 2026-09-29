-- F12.3 Final Internal Pilot Hardening — LOCKED DECISION 1: DEPUTY_DIRECTOR
-- ("Заместитель директора") is the canonical current managerial role. The
-- application-level Role union (packages/domain) already accepts it; this
-- migration only widens the one DB-level CHECK constraint on users.role
-- (infra/002_invariants.sql) that would otherwise reject it. TECHNICAL_DIRECTOR
-- stays in the allowed set unchanged — existing/legacy rows and any future
-- read of historical data remain valid, exactly as the locked decision
-- requires ("preserve backward compatibility safely during migration").
--
-- The original constraint was added unnamed (`ADD CHECK(...)`), so Postgres
-- picked its own name (conventionally users_role_check, but never rewritten
-- previously and never relied upon here) — this looks it up by definition
-- rather than assuming a name, so the migration is correct regardless of
-- exactly what it was auto-named. Additive/backward-compatible: no row is
-- rewritten, no existing value stops being valid, and a users row inserted
-- or updated with any of the original nine role values is unaffected.
DO $$
DECLARE
    old_check text;
BEGIN
    SELECT conname INTO old_check
    FROM pg_constraint
    WHERE conrelid = 'users'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%role%TECHNICAL_DIRECTOR%';
    IF old_check IS NOT NULL THEN
        EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', old_check);
    END IF;
END $$;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK(role IN ('GENERAL_DIRECTOR','TECHNICAL_DIRECTOR','PROJECT_MANAGER','CONSTRUCTION_CONTROL','PTO','SDO','DEPARTMENT_HEAD','ADMIN','CONTRACTOR_VIEWER','DEPUTY_DIRECTOR'));
