-- migration-class: additive
-- R04 expand: existing rows/IDs/evidence remain byte-for-byte unchanged.
-- Short ACCESS EXCLUSIVE catalogue locks; no data rewrite/backfill/default.
-- Old binaries may hide nullable rows: separate compatible-reader release required.
ALTER TABLE works ALTER COLUMN contractor_id DROP NOT NULL;
ALTER TABLE works ALTER COLUMN responsible_user_id DROP NOT NULL;
ALTER TABLE works ALTER COLUMN estimated_cost DROP NOT NULL;
ALTER TABLE works ALTER COLUMN planned_start_date DROP NOT NULL;
ALTER TABLE works ALTER COLUMN planned_finish_date DROP NOT NULL;
