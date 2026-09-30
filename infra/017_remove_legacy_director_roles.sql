-- ROLE-CLEANUP (ROLE-CLEANUP-D01 / DR-R06) — remove TECHNICAL_DIRECTOR and
-- DEPARTMENT_HEAD from the users.role storage model.
-- DEPUTY_DIRECTOR («Заместитель директора») is the single current managerial
-- role; current department heads are the explicit PTO_HEAD /
-- CONSTRUCTION_CONTROL_HEAD / SDO_HEAD roles. No CONSTRUCTION_DIRECTOR / DoC.
--
-- 1. Drop the existing role CHECK (looked up by definition, as in 012/015).
-- 2. Convert stored rows in place (id, tenant_id, bitrix_user_id, contractor_id,
--    is_active and every FK reference are preserved; sessions store user_id only).
-- 3. Add the narrowed CHECK.
-- audit_logs / domain_events / other immutable history payloads are NOT rewritten.
-- Safe for zero, one or many removed-role rows; re-running finds nothing to convert.
DO $$
DECLARE
    old_check text;
BEGIN
    FOR old_check IN
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'users'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%role%'
          AND pg_get_constraintdef(oid) LIKE '%GENERAL_DIRECTOR%'
    LOOP
        EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', old_check);
    END LOOP;
END $$;
UPDATE users
   SET role = 'DEPUTY_DIRECTOR', version = version + 1, updated_at = now()
 WHERE role IN ('TECHNICAL_DIRECTOR', 'DEPARTMENT_HEAD');
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK(role IN ('GENERAL_DIRECTOR','DEPUTY_DIRECTOR','PROJECT_MANAGER','CONSTRUCTION_CONTROL','CONSTRUCTION_CONTROL_HEAD','PTO','PTO_HEAD','SDO','SDO_HEAD','ADMIN','CONTRACTOR_VIEWER'));
