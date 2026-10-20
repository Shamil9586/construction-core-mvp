---
name: postgres-engineering
description: Construction Core PostgreSQL rules — raw SQL through pg, the db.ts transaction helper, numbered migrations in infra/, transaction boundaries, row locks versus advisory locks, tenant/object composite constraints, exact-decimal quantities and the F12.1 quantity invariants, migration ordering and checksum gaps, and native-PostgreSQL concurrency evidence. Use when writing or reviewing a migration or schema change, a transaction, a lock, a concurrent or idempotent write, a quantity or cap check, or a cross-row constraint. Not for UI work or for authorization decisions alone.
---

# PostgreSQL engineering — Construction Core

Applies to schema, migration, transaction, locking and quantity-integrity work. For who may
call a command use `rbac-authorization`; for how to prove behaviour use `backend-testing`.
For GPR-2 the approved Technical Design (§5, §12, §13) is the contract; this skill only
describes how the current code works and how to change it safely.

## 1. Current architecture

- No ORM. SQL is written by hand and run through `pg` (`apps/backend/src/db.ts`).
- `pool` is a node-postgres `Pool` (`max: 12`, session `timezone=UTC`), unless
  `DB_MODE=pglite` and no `DATABASE_URL` is set — then it is a local PGlite adapter that
  serialises every call through one queue.
- Helpers: `rows`/`one` (snake_case → camelCase), `insert` and `insertIdempotent`
  (allow-listed tables only; `insertIdempotent` uses
  `ON CONFLICT (tenant_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`).
- `DATE` (OID 1082) is parsed as a string: a civil date, not a host-timezone midnight.
- Do not add a query builder, repository framework or ORM convention.

## 2. Transactions

- `transaction(fn)` takes one client, runs `BEGIN`, `fn(client)`, `COMMIT`, and `ROLLBACK`
  on any throw. Every statement of one business operation goes through that client `c`.
- Never mix `pool.query` and `c.query` inside one operation: a pool query runs on another
  connection, outside the transaction and its snapshot.
- Business mutation, audit/history, domain event and idempotency-ledger record commit in the
  same transaction (`docs/architecture.md`; Technical Design §12.4).
- A composite read (quantities + baseline + facts + SC) uses one connection and one snapshot
  (`REPEATABLE READ READ ONLY`) or one statement (Technical Design §12.2).
- No remote calls (Bitrix24, file storage, HTTP) while holding DB locks.

## 3. Locks

- Row locks: `SELECT … FOR UPDATE` on the aggregate rows, as used in `service.ts`,
  `schedule-service.ts` and `security.ts` (`scoped(..., lock = true)`). Keep the existing
  order; F12 package-first ordering is protected by tests.
- Advisory locks: transaction-scoped only (`pg_advisory_xact_lock`) with a namespaced key, as
  in `team-service.ts` (`hashtextextended('pbx3:<tenant>:…', 0)`) and `scripts/migrate.ts`
  (`830017`). Use them to serialise something that has no row yet; never session-level locks.
- A hash collision may only over-serialise; it must never grant access.
- The GPR-2 coordination lock protocol (Technical Design §12.3: shared/exclusive per
  `(tenant, object)`, taken before any row lock) is **designed, not implemented**. It belongs
  to Roadmap R03b and is introduced for all relevant writers at once — never one endpoint at a
  time, and never acquired after a package lock is already held.

## 4. Tenant and object constraints

- Existing tables use composite keys `(tenant_id, id)`; references between portals are
  impossible by FK. New object-scoped GPR-2 tables use `(tenant_id, object_id, id)` composite
  FKs (Technical Design §5.1). An optional relation is checked whole, never half-filled.
- Tenant comes from the server session, never from a DTO or path id.
- Immutable history is protected by triggers as well as by the API; referenced history uses
  `RESTRICT`, never `CASCADE`. There is no RLS today — do not claim it.

## 5. Quantities and precision

- Use `decimal.js` and `numeric` — never JS floating point for commands, sums or equality.
- Existing production quantities are `numeric(20,4)` (e.g. `infra/006_production_execution.sql`),
  HALF_UP to 4 places. New GPR-2 quantity columns: `numeric(24,4)`; rates/hours
  `numeric(30,12)`. Do not widen existing columns without the LIVE inventory (I-LIVE).
- Decimals cross the API as strings. No global epsilon that lets a cap be exceeded.
- A cross-row sum is not a `CHECK`: lock first, then validate (or a deferred constraint
  trigger). A sum read without a lock before an insert proves nothing.
- `NULL` (unknown) is not `0`. A fact above the current quantity is an integrity conflict, not
  a clamped 100%.

## 6. F12.1 invariants (protected)

Technical Design §12.5, pinned by `tests/f12.1-customer-sc-zero-accept.test.ts`,
`tests/f12.1-fact-freeze-customer-sc.test.ts` and the suites in Roadmap §5.1:

- zero customer acceptance is refused; quantities are normalised before the check;
- CUSTOMER_SC is bounded by the valid RP quantity; direct path and fact freeze stay;
- confirmations, accepted versions and history stay append-only;
- new Work/WEU/portion caps are added on top of existing guards, never replace them;
- package scope/no-overlap, soft archive and SDO `CLOSED` revalidation stay.

## 7. Migrations — what exists and what does not

`scripts/migrate.ts` today:

- runs **all pending files in one transaction** under `pg_advisory_xact_lock(830017)`;
- picks `infra/` files matching `^\d+_.*\.sql$`, sorted, version = numeric prefix;
- records `schema_migrations(version int PRIMARY KEY, applied_at)` — **version only, no
  content checksum**. An edited, already-applied file is neither re-run nor detected.
- API startup does not migrate (CR01: `infra/Dockerfile`, `tests/startup-contract.test.ts`).
  The Technical Design (E09) recorded migrations-on-boot at its source commit; re-check the
  current startup path before relying on either statement.

Rules for future migration work:

- Never edit an applied migration (in particular `025_production_schedule.sql`). Add the next
  number determined from the real branch and ledger; do not pre-assign one.
- Additive and backward compatible first (expand → reconcile → cutover → contract).
- Because the runner wraps everything in a transaction, statements that cannot run in one
  (e.g. `CREATE INDEX CONCURRENTLY`) do not work through it.
- Record the SHA-256 of each new migration file in the evidence package. Persistent checksum
  verification is **missing** from the runner; designing it is Roadmap R03d. Do not claim it
  exists, and never fabricate checksums for historical rows.

## 8. Failure and rollback safety

- A failed command leaves no partial rows and no ledger success (acceptance A30).
- Transient serialization/deadlock retries are bounded and reuse the same command identity.
- After GPR-2 quantity versions exist, reverting to an old binary is not a rollback; prefer
  compatible read-only fallback and forward repair (Technical Design §13.5).

## 9. Native PostgreSQL evidence

PGlite (one serialized connection) cannot show competing transactions, lock waits, deadlocks,
isolation anomalies or concurrent idempotent inserts. Those claims need native PostgreSQL with
two real connections and an explicit barrier — see `withRowLockBarrier()` in
`tests/f12-final-corrective-postgres-concurrency.test.ts` and `withPackageLockBarrier()` in
`tests/f8.3-postgres-concurrency.test.ts`. `Promise.all` alone proves no interleaving.

## 10. Production migration risk

No production database connection by default. Applying any migration to LIVE needs a separate
release authorisation (Roadmap gates I-LIVE and RELEASE). Before proposing one, state: lock
level and duration of each DDL, table rewrites, constraint validation on existing rows
(`NOT VALID` then `VALIDATE`), behaviour against unknown LIVE data, restart behaviour, and the
backup/restore evidence. Destructive contract steps need an owner-approved manifest.
