-- Core 2.1: history-aware contractor management (docs/core-2.1-architecture-plan.md).
-- Soft-remove of a contractor's assignment to an object must not delete the
-- relationship row or affect historical works/inspections/documents/sdo/financial
-- data — only the active-assignment status changes.
ALTER TABLE object_contractors ADD COLUMN removed_at timestamptz;
ALTER TABLE object_contractors ADD COLUMN removed_by uuid;
ALTER TABLE object_contractors ADD FOREIGN KEY(tenant_id,removed_by) REFERENCES users(tenant_id,id);
-- Replaces the original UNIQUE(tenant_id,object_id,contractor_id): that constraint
-- would reject re-assigning the same contractor after a soft-remove. A partial
-- index enforces uniqueness only among active (not yet removed) relations, so a
-- removed row remains as permanent history and a later re-assign creates a new row.
DROP INDEX object_contractors_unique;
CREATE UNIQUE INDEX object_contractors_active_unique
    ON object_contractors(tenant_id,object_id,contractor_id)
    WHERE removed_at IS NULL;
