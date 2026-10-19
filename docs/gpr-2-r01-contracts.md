# GPR-2 R01 — contract skeleton, rights and traceability

Stage **R01** of the GPR-2 Implementation Roadmap (authorised for isolated implementation only). It adds **contracts, explicit rights and a decision-to-test
index — and no behaviour**: no table, no migration, no production fact, no business command. Everything it exposes is off unless
`GPR2_CONTRACT_ROUTES=enabled`, and even then an authorised, well-formed call is answered `501 COMMAND_NOT_ENABLED` and writes nothing.

Normative sources (approved 15.10.2026, **not stored in this repository**), identified by sha256:

- *GPR-2 Final Technical Design* — `b80ba7315509b9a011b87a45957f7e9a3eaf802624c1ca241f7072fab8879368`
- *GPR-2 Implementation Roadmap* — `a4c27d19a731b0d32a70c75a14af4f04c289ff93007d4ed78fe308a6ab434f76`

Section marks below (`§11.3`, `D11`, `K02`, `C10`, `A19`) refer to them.

## What R01 adds

| Where | What |
|---|---|
| `packages/domain/gpr2/errors.ts` | Closed error catalogue and its HTTP status (403 / 404 / 409 / 422 / 413 / 415 + 501), scope-safe bodies, allowlisted `details`. |
| `…/decimal.ts` | decimal-as-string: `QUANTITY` numeric(24,4), `SIGNED_QUANTITY`, `NORMATIVE` numeric(30,12); strict grammar, no rounding of input, HALF_UP only in `normalizeDecimal`, `null ≠ 0`. |
| `…/versions.ts` | Four distinct "versions" (aggregate token, scope token, revision sequence, source version id), stale / scope-changed checks, canonical JSON and the command fingerprint. |
| `…/permissions.ts` | Nine explicit GPR-2 permissions, the per-role grant table, the N01 capability (default deny), `isAuthorized`. |
| `…/lifecycle.ts` | Six lifecycles as tables: GPR revision, quantity request, WorkType publication request, ResultUse, external-outcome record, fact-source mode. |
| `…/projection.ts` | The four quantities, physical state, schedule state (11 states, §8.4 order), labor coverage — with their nullability invariants. |
| `…/endpoints.ts` | The §11.2 register (50 rows: 35 commands, 15 queries). Single source for routes, grants, idempotency, tokens, lifecycle links and stages. |
| `…/schemas.ts`, `…/openapi.ts` | zod envelope and the payloads the design fixes; a derived OpenAPI 3.1 document. |
| `apps/backend/src/gpr2-command-guard.ts` | The pipeline every `/v2` command passes through. |
| `apps/backend/src/modules/gpr2/*` | The 32 guarded routes (one controller method per mounted register row). |
| `apps/backend/src/main.ts` | Two additive edits: mount the module only when the flag is exactly `enabled`; put `code` / `details` on the body of a GPR-2 error. Every other error body is unchanged. |
| `tests/gpr2-r01-*.test.ts`, `tests/helpers/gpr2-*.ts` | 116 tests (domain, HTTP, pipeline order, feature gate, OpenAPI, traceability) and their fixtures. |
| `docs/gpr-2-r01-decision-test-matrix.md`, `scripts/gpr2-r01-matrix.ts` | The generated D / K / C → tests matrix and its generator. |

## The rights (A19)

The new permissions live **outside** `Permission` (packages/domain/index.ts), because `ADMIN` is granted `Object.values(Permission)`: any member added there
would reach ADMIN automatically (C10, E10). The legacy enum and every legacy grant are byte-for-byte what they were; a test pins both.

| Permission | Command family | Held by default |
|---|---|---|
| `GPR2_SCHEDULE_AUTHOR` | draft / edit / submit / discard a GPR revision; calendar versions | РП (PROJECT_MANAGER) |
| `GPR2_SCHEDULE_REVIEW` | approve / return a GPR revision | DEPUTY_DIRECTOR |
| `GPR2_QUANTITY_AUTHOR` | propose / submit a quantity change | РП |
| `GPR2_QUANTITY_REVIEW` | approve / return a quantity change | DEPUTY_DIRECTOR |
| `GPR2_QUANTITY_REVIEW_NOTE` | optional PTO review note (not an approval) | **nobody** |
| `GPR2_EXTERNAL_OUTCOME_RECORD` | record an external suitability decision / correction | РП |
| `GPR2_OBJECT_CATALOG_MANAGE` | object WorkType / finish-system adaptation and publication *proposals* | РП |
| `GPR2_CORPORATE_PUBLICATION` | approve / reject corporate WorkType publication | **ADMIN** (the one explicit Admin grant) |
| `GPR2_IMPORT_MANAGE` | BoQ / estimate-labor upload, allocate, commit | РП |
| `ESTIMATE_MAPPING_REVIEW` (N01) | review ambiguous estimate mappings | **nobody** — an object-scoped assignment, not a role |

ADMIN holds no GPR-2 business grant; the deputy holds no editor grant; nobody but an explicit assignment holds N01. An approver must be neither the author nor
the submitter of what they approve.

## The pipeline

`authenticate → permission → path ids + scope → envelope → replay → execute`, always in that order. Permission is decided from the caller's **current** role (read from
the database on every request) before any scope lookup, so a caller without the grant learns nothing about any object; a missing object, a malformed id, another tenant's
object and another РП's object are one and the same `404`; a stored result is looked up only after all of that (so an Idempotency-Key is never an access token).

Command envelope: header `Idempotency-Key` (uuid, like every key in the repository) and body `{ "expectedVersion"?, "expectedScopeVersion"?, "payload" }`; which tokens a
command carries is declared in the register, and a token it does not use is refused. Versions are canonical decimal-integer **strings**.

## Interpretations (where the design leaves room) — please confirm in acceptance

1. **Separate enum, one permission per §11.3 row.** The design requires "explicit, not via `Object.values`"; the means (a separate enum) and the nine names are R01's.
2. **`GPR2_QUANTITY_REVIEW_NOTE` is held by nobody.** §11.2 says "PTO by an explicit review grant" and §11.3 "if allowed"; who holds it is not defined, so it is default-deny (like N01).
3. **Envelope shape.** `expectedVersion` / `expectedScopeVersion` / `payload` as body fields, `Idempotency-Key` as a uuid header, version tokens as strings: the design names the elements, not the wire form.
4. **Status codes.** `422` for a lifecycle violation (`INVALID_TRANSITION`, `REASON_REQUIRED`, `SEPARATION_OF_DUTIES`), `409` only for stale version / changed scope / idempotency mismatch, `404` for a malformed path id, `501 COMMAND_NOT_ENABLED` for the closed gate.
5. **A RETURNED revision is final for its row**; the РП continues in a *new* draft (§8.1 "new DRAFT version", §5.4 "return is not discard"). §11.2 lists only "draft from current / empty", so the payload of `schedule.revision.create` is left open for R11 — how a returned revision seeds a new draft is a question for R11 / R12.
6. **A RETURNED quantity request** is reopened as DRAFT by the РП's `PATCH` (§5.3 "correction creates a new submission version"; the register has no separate command).
7. **Separation of duties applies to approval** (§11.3 states it for approval); a return is a review and is not blocked for the author.
8. **Tenant-level publication routes.** `work-type-publication-requests/{id}/approve|reject` carry no object prefix (corporate act). The route of *corporate template publication* is not named by the design; `finish-template.publish` is a proposal and is not mounted.
9. **Not fixed by the design, hence not fixed here:** import-batch *edges* (only the seven states), calendar-version and template *publication* commands, the payloads of quantity, finish, import and calendar commands (they carry the owning stage in the OpenAPI document).
10. **Lag value** is a `NORMATIVE` decimal string with a lag kind (`WORKING_DAYS` / `ELAPSED_HOURS`); the design says "lag value" without a type.
11. **GPR-1 grants are untouched.** `SCHEDULE_EDIT` is still held by the deputy in the legacy contour, which contradicts D11 *there* until the cutover (R12 / R21); the new `/v2` rights are the ones that implement D11.
12. **CORS.** `main.ts` allows only `Authorization` / `Content-Type` and `GET|POST|PATCH`. A cross-origin browser client would need `Idempotency-Key` and `PUT` (BoQ allocations) added when those commands get behaviour (R03c / R15); same-origin deployments (Caddy) are unaffected.

## Decisions pinned vs. left to later stages

`docs/gpr-2-r01-decision-test-matrix.md` maps all 46 decisions (D01–D24, K01–K04, C01–C18). R01 **pins** 9 (D11, D14, D15, D16, D18, D22, K03, C10, C18), **partially** pins 30 and
has nothing to pin for 7 (D03, D20, D24, C02, C06, C07, C15). It claims no decision is implemented. The register of expectations that later stages cancel (Roadmap §5.2) is in the same file;
R01 changes none of those tests, and a test proves the registered and the protected suites are byte-identical to the base commit.

## Running the tests safely

R01 tests never use a real database: `tests/helpers/gpr2-isolation.ts` (imported **first**) deletes `DATABASE_URL`, `PG*`, `E2E_*` and `POSTGRES_*` and pins `DB_MODE=pglite`,
and `assertInMemoryPool()` proves the pool is PGlite. (`apps/backend/src/db.ts` decides at import time; a test that imported the backend before pinning the environment would
open a node-postgres connection to whatever the `PG*` variables name.)

```
node --import tsx --test tests/gpr2-r01-*.test.ts        # the R01 tests (pure domain + PGlite)
npx tsc --noEmit                                           # types
node --import tsx scripts/gpr2-r01-matrix.ts --write      # regenerate the matrix document
```

The full `npm test` additionally runs the existing native-PostgreSQL suites, which create and drop databases on `127.0.0.1:5432` (or `E2E_*`) — run them only against a disposable local
cluster. Three of them share the database `construction_test` and must not run in parallel with each other (`--test-concurrency=1`).

## Not done in R01 (by design)

No migration (the chain still ends at `025`; the next number is decided by the real branch and ledger), no table, no ledger, no lock protocol (R03), no resolver (R02), no calendar engine
(R10), no schedule / quantity behaviour (R07, R11–R14), no import, no UI, no LIVE inventory (R00b) and no change to Render, Bitrix24 or any environment.
