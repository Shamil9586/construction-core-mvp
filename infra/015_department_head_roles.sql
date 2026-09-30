-- PBX-2 corrective patch — department-head roles.
-- Adds three CURRENT internal roles to the users.role CHECK constraint:
--   PTO_HEAD                  («Начальник ПТО»)
--   CONSTRUCTION_CONTROL_HEAD («Начальник СК»)
--   SDO_HEAD                  («Начальник СДО»)
-- DEPARTMENT_HEAD and TECHNICAL_DIRECTOR stay valid (legacy-compatible): no row
-- is rewritten or converted and every previously valid value remains accepted.
-- The constraint is looked up by definition (as in 012) rather than by name.
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
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK(role IN ('GENERAL_DIRECTOR','TECHNICAL_DIRECTOR','PROJECT_MANAGER','CONSTRUCTION_CONTROL','PTO','SDO','DEPARTMENT_HEAD','ADMIN','CONTRACTOR_VIEWER','DEPUTY_DIRECTOR','PTO_HEAD','CONSTRUCTION_CONTROL_HEAD','SDO_HEAD'));
