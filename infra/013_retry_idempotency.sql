-- F12.3 Final Internal Pilot Hardening — LOCKED DECISION 2 (safe retry).
--
-- F12-QTY-06 inspection: createExecutionUnit() and createQuantityPortion()
-- (apps/backend/src/service.ts) are plain INSERTs with no target row to
-- version-check against — unlike recordPortionFact()/requestPortionInspection(),
-- which lock and version-gate the very row they mutate (proven safe by
-- tests/f12-qty-06-retry-safety.test.ts, not touched here). A network retry,
-- a timeout after the first request already committed, or a double click
-- before the earlier request's response returns can resubmit the identical
-- logical command and create a second, duplicate row.
--
-- Same idempotency-key pattern financial_closings/close() already established
-- (infra/001_initial.sql, apps/backend/src/service.ts close()): a per-tenant
-- unique key, compared against the full payload on reuse. Unlike
-- financial_closings' idempotency_key (NOT NULL from that table's own
-- inception), this column is nullable and the unique index is partial
-- (WHERE idempotency_key IS NOT NULL) — additive against *existing* rows and
-- existing callers: every row already in these tables gets NULL, and
-- PostgreSQL never considers NULL a duplicate of another NULL in a unique
-- index, so no backfill value is needed and no existing caller that omits
-- the (optional) key changes behaviour at all. Only a caller that opts in by
-- sending idempotencyKey gets retry protection — ProductionService compares
-- the full payload on a repeat key and returns the original row unchanged
-- rather than inserting again.
ALTER TABLE work_execution_units ADD COLUMN idempotency_key uuid;
CREATE UNIQUE INDEX work_execution_units_idempotency_unique ON work_execution_units(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

ALTER TABLE quantity_portions ADD COLUMN idempotency_key uuid;
CREATE UNIQUE INDEX quantity_portions_idempotency_unique ON quantity_portions(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
