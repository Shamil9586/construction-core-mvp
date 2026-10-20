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
