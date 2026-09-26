-- F8.3-19: reversible Portion allocation. Additive only — no existing
-- column, table, row or constraint is altered destructively.
--
-- Portion allocation is OPTIONAL, so a mistaken allocation must be able to
-- return to "no active allocation for this Portion" while its own history
-- stays intact. A zero-valued amount does not work: the row would still be
-- a present allocation and could wrongly force SdoClosingAllocationService's
-- exact-sum rule (packages/domain) even when the actor's intent is "closing
-- should use the total amount alone again". cancelled_at/cancelled_by give
-- the row an explicit active/cancelled state instead: "active" is
-- cancelled_at IS NULL; a cancelled row is never deleted, and
-- sdo_closing_portion_allocations_unique (infra/008_sdo_closing.sql) still
-- guarantees at most one row per (tenant, Case, Portion) whether that row is
-- currently active or cancelled — cancelling and later reactivating
-- (setSdoClosingPortionAllocation's own RESTORE, service.ts) both operate on
-- this exact same row, never a second one.
ALTER TABLE sdo_closing_portion_allocations
    ADD COLUMN cancelled_at timestamptz,
    ADD COLUMN cancelled_by uuid;
ALTER TABLE sdo_closing_portion_allocations
    ADD CONSTRAINT sdo_closing_portion_allocations_cancelled_by_fkey FOREIGN KEY(tenant_id,cancelled_by) REFERENCES users(tenant_id,id);
-- Cancellation must have both fields or neither.
ALTER TABLE sdo_closing_portion_allocations
    ADD CONSTRAINT sdo_closing_portion_allocations_cancelled_pair CHECK((cancelled_at IS NULL) = (cancelled_by IS NULL));

-- The append-only correction/cancellation trail. `operation` distinguishes
-- CREATE (the Portion's first allocation) from CORRECT (an active row's
-- amount changes) from CANCEL (the row becomes inactive — new_amount is
-- NULL, there being no active amount left to record) from RESTORE (a
-- previously cancelled row becomes active again with a fresh amount).
-- new_amount is now nullable — a CHECK expression against NULL evaluates to
-- NULL, which PostgreSQL treats as satisfied, so this alone is enough to let
-- CANCEL rows through without weakening new_amount>0 for every other
-- operation. Existing rows (all either CREATE or CORRECT, from before this
-- migration) default to 'CREATE' — an additive backfill, never a rewrite of
-- their preserved amount/actor/timestamp columns.
ALTER TABLE sdo_closing_portion_allocation_history
    ALTER COLUMN new_amount DROP NOT NULL;
ALTER TABLE sdo_closing_portion_allocation_history
    ADD COLUMN operation text NOT NULL DEFAULT 'CREATE' CHECK(operation IN ('CREATE','CORRECT','CANCEL','RESTORE'));
ALTER TABLE sdo_closing_portion_allocation_history
    ALTER COLUMN operation DROP DEFAULT;
