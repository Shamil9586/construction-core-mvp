# GPR-2 R04 contract checkpoint

Owner authorised offline R04 on 21.10.2026, base 92fcf6d047fd22453349260432dbc65590386a17. D01/D09, C04/C13, A12/A05. No R05 or LIVE activation.

- Work keeps its existing ID, unit and positive known quantity; status remains PLANNED until production starts. `productionEligibility` is a derived state (MISSING_ASSIGNMENTS / BLOCKED / READY), never a second Work or fact source.
- POST /works accepts absent/null contractorId, responsibleUserId, estimatedCost and provisional dates. Missing values persist as NULL. An early create requires an idempotencyKey; fully specified legacy calls remain compatible.
- POST /works/:id/complete-planning fills only previously unknown planning fields. It requires version and idempotencyKey, uses existing WORK_CREATE authority and current object access (no new grant), and cannot overwrite a known field or change identity/unit/quantity. Assignment/cost/date change workflows are outside R04.
- Create/completion use the R03c ledger in the caller's READ COMMITTED transaction, after current permission/object authorization. Replay preserves command result IDs; the legacy-shaped HTTP response is the current representation of that same Work.
- Assignment writes coordinate EXCLUSIVE before row locks, like createWork. Production stays blocked without contractor/responsible; missing cost/dates does not block production. Existing dependency/SC/freeze guards still apply.
- Missing cost makes money-dependent work projections and object weighted percentages NULL. Known monetary totals remain separately known; an unknown contribution is never silently zero. No claim of K01 labor aggregation.
- Missing provisional dates give no legacy schedule verdict. Approved GPR-1 dates still come from its revision entries; an Early Work is offered to a draft with nullable suggested dates and requires explicit valid entry dates.
- Migration 028 relaxes five NOT NULL constraints without rewriting rows. The runner's conservative DROP detector needs a narrow syntactic exemption for a complete standalone ALTER TABLE … ALTER COLUMN … DROP NOT NULL statement; destructive DROP/type/SET NOT NULL/data rewrites and contract gating remain prohibited/controlled. This is an expand operation, not an implicit contract migration.
- Old readers with INNER JOINs cannot safely consume new nullable rows. Apply schema and deploy compatible readers together under a separate release plan; no old-binary rollback is claimed after creating Early Work. API startup remains migration/seed-free.
- Full definition/finish/areas, quantity versions, CUSTOMER_SC display, team expansion and history timeline remain outside scope.
