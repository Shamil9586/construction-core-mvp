-- migration-class: additive
-- GPR-2 R05 third corrective — closes R05-GPT-R3-B01 (GPT_REVIEW_20261025_R05_INDEPENDENT_CORRECTIVE) in PostgreSQL without editing 029–034.
--
-- ADDITIVE ONLY: one function, one trigger and a precondition check that refuses to apply over data already breaking the rule (nothing is repaired,
-- moved or invented — the run fails and rolls back). No table, column, index, existing function or row is changed.
--
-- The finding: 034's operation claim identifies a Work's one operation by (finish type, occurrence key). Across published versions the same key can
-- carry another measure scope (MAIN vs LOCAL) with the same WorkType and unit; the claim, 032's per-binding check and 033's Work lock all pass, so one
-- Work could produce two semantically different operations over disjoint AreaScopes — exactly what the generation preview refuses as incompatible
-- (producerCompatible, NEW-05).
--
-- The rule, in the same terms as producerCompatible: every ACTIVE producer binding of one Work names an occurrence with the SAME WorkType, the SAME
-- measure unit and the SAME measure scope (and, by 034, the same finish type and occurrence key). Bindings of one compatible operation over several
-- disjoint AreaScopes, under one version or several, stay allowed. WorkType and unit are already pinned by 032 (each binding agrees with its Work) and
-- 033 (a bound Work keeps them); they are compared here again so the rule stands on its own.
--
-- Concurrency: the comparison reads committed bindings. It needs no new shared row: a Work's FIRST binding inserts 034's work_scope_operations claim,
-- so two concurrent first bindings conflict there (READ COMMITTED: the second waits and this trigger, a new statement, sees the first; REPEATABLE
-- READ: 40001); once a binding is committed every later binding sees it. The trigger runs after gpr2_binding_operation_claim (name order).

-- Precondition: no Work already produces occurrences of different WorkType / unit / measure scope.
DO $$
DECLARE n bigint;
BEGIN
    SELECT count(*) INTO n FROM (
        SELECT b.tenant_id, b.work_id FROM work_scope_bindings b JOIN finish_stage_occurrences o ON o.tenant_id = b.tenant_id AND o.id = b.occurrence_id
         WHERE b.binding_state = 'ACTIVE'
         GROUP BY b.tenant_id, b.work_id HAVING count(DISTINCT (b.measure_scope, o.work_type_id, o.measure_unit)) > 1) x;
    IF n > 0 THEN
        RAISE EXCEPTION 'GPR2_R05:PRECONDITION % Work(s) producing occurrences of different measure scope / WorkType / unit (R3-B01); resolve them before 035', n USING ERRCODE = 'check_violation';
    END IF;
END $$;

CREATE FUNCTION gpr2_binding_operation_semantics() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE occ record;
BEGIN
    SELECT work_type_id, measure_unit, measure_scope INTO occ FROM finish_stage_occurrences WHERE tenant_id = NEW.tenant_id AND id = NEW.occurrence_id;
    IF EXISTS (SELECT 1 FROM work_scope_bindings b JOIN finish_stage_occurrences o ON o.tenant_id = b.tenant_id AND o.id = b.occurrence_id
                WHERE b.tenant_id = NEW.tenant_id AND b.work_id = NEW.work_id AND b.binding_state = 'ACTIVE'
                  AND (b.measure_scope IS DISTINCT FROM NEW.measure_scope OR o.measure_scope IS DISTINCT FROM occ.measure_scope
                       OR o.work_type_id IS DISTINCT FROM occ.work_type_id OR o.measure_unit IS DISTINCT FROM occ.measure_unit)) THEN
        RAISE EXCEPTION 'GPR2_R05:ONE_PRODUCER_CONFLICT a Work produces one operation: the same WorkType, unit and measure scope in every binding' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
-- name order on work_scope_bindings: gpr2_binding_area_lock, gpr2_binding_guard, gpr2_binding_operation_claim, gpr2_binding_operation_semantics, gpr2_binding_work_lock
CREATE TRIGGER gpr2_binding_operation_semantics BEFORE INSERT ON work_scope_bindings FOR EACH ROW EXECUTE FUNCTION gpr2_binding_operation_semantics();
