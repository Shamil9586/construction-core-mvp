# GPR-2 R03 — transaction context, lock protocol, command ledger, migration safety

Stage **R03a–R03d** of the GPR-2 Implementation Roadmap (P1, offline implementation). Base `678e795f8802a76ac025f28b0d698351af8b7721`; R02 is the parent of R03a.
Normative sources (sha256, verified before work began): Technical Design `b80ba7315509b9a011b87a45957f7e9a3eaf802624c1ca241f7072fab8879368`, Roadmap
`a4c27d19a731b0d32a70c75a14af4f04c289ff93007d4ed78fe308a6ab434f76`. Decisions: C16, C17 (and C10 for the ledger's authorisation order). Scenarios A06, A19, A29, A30.

Each sub-stage is its own commit and has its own tests and results; they are reviewed separately (the Roadmap asks for R03b's blast radius to be reviewed apart from a/c/d).

---

## R03a — one transaction context for a business operation

`apps/backend/src/tx-context.ts`, plus a guard in `apps/backend/src/db.ts`.

| Entry point | Does |
|---|---|
| `runCommandTx(fn, {isolation?, maxAttempts?})` | one connection: `BEGIN` … `COMMIT`, `ROLLBACK` on any error. Optional **bounded** retry of PostgreSQL's own "try again" failures only — `40001` serialization_failure and `40P01` deadlock_detected — never of a business error; default one attempt; hard ceiling `MAX_ATTEMPTS_CEILING = 5` whatever is asked. |
| `runSnapshotRead(fn)` | `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`: every statement sees one snapshot. A response assembled from quantity, baseline, facts and SC cannot mix two moments (TD §12.2). |

**Nested independent pool reads are refused.** While the callback runs, `pool.query()` / `pool.connect()` / `transaction()` — called directly or from any helper the callback awaits, in any
async branch — throw `NestedPoolAccessError` (an `AsyncLocalStorage` scope set only by these two entry points). A second connection inside one operation can neither see the operation's
uncommitted writes nor belong to its snapshot, and can deadlock against its locks. The guard follows `await`, `Promise.all` branches and timers. Outside a context the pool is exactly what it was.

`transaction()` (legacy) now also marks its client as a transaction client (`isTransactionClient`), which R03b needs; its behaviour is otherwise unchanged. Existing services are **not** rewritten
onto the context — they are brought under the lock protocol by R03b; the context is for new commands and projections (R03c, R04+).

| Evidence | Test |
|---|---|
| guard directly / via `rows()` / `one()` / nested `transaction()` / async branches; free outside | `gpr2-r03a-tx-context` (PGlite) |
| commit-as-one, rollback-as-one, connection returned clean | `gpr2-r03a-tx-context`, `gpr2-r03a-snapshot-pg` |
| retry: only 40001/40P01, bounded, business errors final | `gpr2-r03a-tx-context`; a **real** 40001 in `gpr2-r03a-snapshot-pg` (attempt 1 fails, attempt 2 re-runs on a fresh snapshot, effect applied once) |
| **A30** snapshot across a concurrent commit (native PG, commit forced *between* the two statements by a barrier) | `gpr2-r03a-snapshot-pg` |
| **A30** aborted command leaves nothing, including when the failure is the `COMMIT` (deferred FK) | `gpr2-r03a-snapshot-pg` |

---

## R03b — the object coordination lock and the writer register

`apps/backend/src/coordination-lock.ts`, `apps/backend/src/writer-registry.ts`, and one first statement in every coordinated writer. **Reviewed apart from a/c/d: this is the blast radius.**

### The protocol (TD §12.3)

One transaction-scoped PostgreSQL advisory lock per `(tenant, object)`, in two modes:

| Mode | Taken by | Excludes |
|---|---|---|
| `SHARED` (`pg_advisory_xact_lock_shared`) | every ordinary fact / SC / issue / PTO / SDO / AOSR writer, GPR-1 draft edits | only EXCLUSIVE |
| `EXCLUSIVE` (`pg_advisory_xact_lock`) | scope-changing writers: `createWork` (Work generation), `dependency` (topology), GPR-1 `approveDraft` (baseline switch). Quantity approval and GPR-2 approval join in R07/R12 | everything on that object |

* **First, before any row lock.** `acquireCoordination()` asks PostgreSQL whether the transaction has an id yet (`pg_current_xact_id_if_assigned()` — it has one as soon as it writes **or row-locks** anything) and throws `COORDINATION_AFTER_ROW_LOCK` if so. A writer can therefore never queue the coordination lock behind a package / case / portion lock it took first (TD §12.3 item 2): the F12 order *package → case → portion* is untouched, the new lock simply precedes it.
* **Resolving the object takes no lock.** `coordinate()` finds the object with one plain `SELECT` (work → object, portion → unit → work, package → work, SDO case → package → work, …) — no `FOR UPDATE`, no transaction id. An id that resolves to nothing takes no lock and the writer's own `scoped()` answers 404 as before.
* **One object per transaction; no upgrade.** A second object, or `SHARED → EXCLUSIVE` inside one transaction, throws (the two ways an advisory protocol deadlocks with itself). `EXCLUSIVE` then `SHARED` is a no-op.
* **Bounded wait.** `lock_timeout` (default 15 s, `GPR2_COORDINATION_WAIT_MS` or `waitMs`) turns an unbounded queue into `COORDINATION_TIMEOUT`; the setting is restored after a successful acquire.
* **Key.** `sha256("construction-core:gpr2:object-coordination:v1" \0 tenant \0 object)` → signed 64-bit; a collision can only over-serialise two objects, never admit one that should wait; never equals the migration lock `830017`.
* **Held state belongs to the transaction.** A pooled connection outlives its transactions; what a transaction holds is remembered with a per-transaction token (`db.ts markTransactionClient` / `transactionToken`). *The native test found this defect in the first version:* keyed by the client object alone, a later transaction on a reused connection believed it already held the lock and skipped it. `transaction()` and `runCommandTx()` now mint a token per transaction and drop it at the end; a regression test reuses a pooled connection while another session holds EXCLUSIVE and proves it waits.

### The register — complete, and closed by a test

`writer-registry.ts` has one row per code path that writes to the database (**90**): mode `SHARED` / `EXCLUSIVE` / `NONE` and a reason. `NONE` is a decision a reviewer can contest, not an omission — e.g. `createObject` and `commitImport` (they create *new* objects and no Work: nothing can contend for an object that does not exist yet), team and organisation assignment (they change who may act; every command re-authorises against the current rows), tenant dictionaries, Bitrix installation state, the outbox, the risk worker.

`tests/gpr2-r03b-writer-registry.test.ts` reads `apps/backend/src` with the TypeScript compiler and fails when
* a `transaction(…)` / `getFileStore().transaction(…)` call or a write issued straight on the pool (`pool.query('INSERT …')`, `insert(pool, …)`, `one/rows(pool, 'UPDATE …')`) exists and is **not a row** — the *bypass-path check*: a new writer, a legacy endpoint, an importer, a controller cannot appear unclassified;
* a row names a writer that no longer exists, or two sites share a key;
* a `SHARED`/`EXCLUSIVE` writer does not call `await coordinate(c, <its own id>, …)` as the **first statement** of its transaction callback (the checker is itself tested: a late, misnamed, un-awaited or missing call is caught);
* the `EXCLUSIVE` set differs from `createWork`, `dependency`, `approveDraft`, or a fact/SC/PTO/SDO writer named by the Technical Design is not `SHARED`.

**Bypass paths examined and their classification:** the legacy HTTP endpoints (all reach `service.ts` / `aosr-service.ts` / `schedule-service.ts` writers, all registered), the financial importer (`importer.ts`: `commitImport` creates objects only → `NONE`, `previewImport` writes a report → `NONE`), the controllers that open their own transaction (`inspections#photo`, `materials#bindMaterial` → `SHARED`; users, contractors, dictionaries → `NONE`), the AOSR file-store transactions (`getFileStore().transaction`, 4 sites → `SHARED`), the background workers (`risk-worker`, Bitrix outbox → `NONE`). `scripts/seed.ts` and `scripts/migrate.ts` are operator tooling run outside the application, not request-time writers. **The new scope-changing GPR-2 endpoints stay off:** the R01 `/v2` surface is still flag-gated and answers `501`, so no new scope-changing command can run before this register is accepted.

### Interpretations and limits to confirm at acceptance

1. **Lock before object authorisation.** `coordinate()` runs as the first statement, i.e. before `objectAccess()`. A caller who holds the *permission* but not the object can therefore take the object's lock for the few milliseconds until their request is refused and rolled back (the key includes the tenant, so never across tenants). It is a short, rate-limited griefing window, not a data exposure. Moving authorisation ahead of the lock is impossible without a row lock or a second round trip (the very thing the protocol forbids); the alternative — resolving and authorising through a plain `SELECT` first — is a design change for the reviewer to choose.
2. **`NONE` rows are decisions.** Team/organisation assignment is `NONE` on the reasoning that every command re-authorises against current rows; a reviewer who wants assignment changes serialised with fact writers can flip a row to `SHARED` (one registry line, one `coordinate()` call — the static test then enforces the call).
3. **`commitImport` creates objects only** (checked in the code: `insert(objects)`, `object_contractors`, `monthly_plans`; no Work) — hence `NONE`. If a later change makes it generate Works on an existing object it must become `EXCLUSIVE`; the registry test cannot know that, a reviewer of that change must.
4. **Quantity approval is not wired** (R07). The EXCLUSIVE section used in the A06 test is a probe taking the same lock; the register's EXCLUSIVE set is exactly the three scope-changing writers that exist today.
5. **The wait bound (15 s) is a default**, not a measured value; the release plan should set `GPR2_COORDINATION_WAIT_MS` after load measurements (R21/R22).

### Evidence (native PostgreSQL 16, isolated cluster; each race staged with a barrier PostgreSQL reports)

| Claim | Test (`gpr2-r03b-coordination-pg`) |
|---|---|
| S+S coexist; X waits for S; a *waiting* X holds a later S back (no starvation); X excludes X and S; released by commit, by rollback and by a dead connection; other objects and other tenants never interact | lock matrix |
| bounded wait → `COORDINATION_TIMEOUT`, nothing left queued | bounded wait |
| after-row-lock, second object, upgrade, outside a transaction all refused and take no lock | misuse |
| pooled connection reused by a later transaction takes the lock again | pooled reuse |
| **A06**: an in-flight fact writer (stopped on its portion row by a barrier) holds SHARED; the scope-change EXCLUSIVE is proved blocked, runs after the writer committed, sees its fact; while it is open a new fact writer is proved blocked, the protected floor read inside the section is unchanged at its end, and the fact lands strictly after the section's commit | A06 |
| all three EXCLUSIVE writers (through `createWork`, `dependency`, GPR-1 `approveDraft`) and a SHARED writer wait together behind an open scope-changing section; nothing applied while it was open | exclusive writers |
| 18 facts on 6 portions + 3 exclusive sections at random moments: no deadlock, no lost write, no timeout | stress |
| existing package-first / F12 ordering unchanged | the unmodified native suites `f8.3-postgres-concurrency`, `f12-final-corrective-postgres-concurrency` and the rest, run per file on the isolated cluster (P1-B package) |

---

## R03c — the command ledger

`apps/backend/src/command-ledger.ts` over migration `027_gpr2_command_ledger.sql` (class: additive, one new table, nothing existing altered). One mechanism for every new command — **not a cache per command**; the older `idempotent_commands` ledger (014) keeps serving the five F12 commands exactly as it does.

A row says: *this actor, in this tenant, issued this command kind against this object-or-aggregate under this Idempotency-Key, with this input fingerprint, and this is the result.* `UNIQUE(tenant, actor, command_kind, scope, key)` — knowing a key opens nothing: another actor's identical key is another row, the same key on another aggregate or command is another row. The row id **is** the `commandId` the client receives.

### The order, fixed in code and proved from a trace (`runLedgered`)

1. **`authorize()`** — always, with the caller's rights *now*, before any look-up (§12.4). In the HTTP path the R01 pipeline has already done authenticate → permission → scope → ownership → envelope before the `replay` hook is reached; `authorize` repeats the check inside the transaction.
2. **claim** — `INSERT … ON CONFLICT DO NOTHING` on the unique scope. A concurrent twin **waits inside PostgreSQL** on the first transaction's uncommitted row; if that commits it sees the conflict, if that rolls back it proceeds.
3. **compare** — stored fingerprint vs this call's: different → `409 IDEMPOTENCY_PAYLOAD_MISMATCH`, nothing executed. The fingerprint is R01's canonical one (key order and whitespace cannot change it; payload, expected versions and source versions always do).
4. **replay or run** — same fingerprint on a completed row → the stored result, no second effect; otherwise `execute(commandId)`.
5. **complete** — the result (validated against R01's `commandResultSchema`) is written onto the claimed row **in the same transaction** as the business mutation.

Schema defends it: a deferred constraint trigger refuses to `COMMIT` a claimed row that never received its result; a completed row is immutable; a row cannot be deleted; only the result may be written onto a claim; `result` and `completed_at` come together; fingerprint is 64 hex, command kind a dotted id.

`ledgerReplayHook(pool)` is the pipeline's `replay` hook (R01 step 6): a read-only look-up, reached only by a caller who has already passed every earlier step; the claim in step 2 remains the authority for a race the look-up cannot see. `ledgerScopeId` = the aggregate named by the path, else the object, else the tenant.

| Claim | Test |
|---|---|
| first call runs once; **lost-response retry** returns the same result/ids and does not execute (trace: only the replay hook ran) | `gpr2-r03c-command-ledger` |
| same key + other payload → 409 before execute; canonical fingerprint | `gpr2-r03c-command-ledger` |
| **A19** changed role, ADMIN, another РП holding the key → 403/404 and the replay hook is *never called*; owner still served | `gpr2-r03c-command-ledger` |
| key scoped by tenant/actor/kind/aggregate | `gpr2-r03c-command-ledger` |
| **A30** aborted mutation leaves no ledger row and no effect; later retry is a clean first execution | `gpr2-r03c-command-ledger` |
| `authorize` first and alone on refusal; malformed result rolled back; no key ⇒ no row; in-transaction twin = authorize→claim→compare→replay | `gpr2-r03c-command-ledger` |
| table triggers / checks | `gpr2-r03c-command-ledger` |
| **native**: two connections, one key — the second observed *blocked in the INSERT* until the first finishes, then replays (one effect, one command id) | `gpr2-r03c-ledger-pg` |
| **native**: the first aborts while the second waits — claim vanishes, second runs as a first execution | `gpr2-r03c-ledger-pg` |
| **native**: same key, different payload, concurrently → loser gets the mismatch, nothing else executes | `gpr2-r03c-ledger-pg` |
| **native**: different keys never queue; 8 concurrent retries → 1 execution, 7 replays, 1 command id | `gpr2-r03c-ledger-pg` |

**Not done here:** no real command uses the ledger yet — the R01 `/v2` handlers are still `501` (their stages R04–R17 call `runLedgered`). Retention/archival of ledger rows is a release-plan question (R22).
