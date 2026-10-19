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
| `…/projection.ts` | The four quantities, physical state, schedule state (11 states, §8.4 order), labor coverage — with their nullability, identity and coherence invariants and the §5.1/§10.3 source-version metadata (R01-B07). |
| `…/civil-date.ts`, `…/open-value.ts`, `…/resources.ts` | Corrective (R01-B01/B03/B04): calendar dates by arithmetic, the safe shape of an open payload, the nested-resource ownership contract. |
| `…/endpoints.ts` | The §11.2 register (50 rows: 35 commands, 15 queries). Single source for routes, grants, idempotency, tokens, lifecycle links (one endpoint may serve several rows), the aggregate behind every `{id}` and stages. |
| `…/schemas.ts`, `…/openapi.ts` | zod envelope and the payloads the design fixes (including the approve/commit fence); the OpenAPI 3.1 document derived from the register — and `mountGpr2Contract()`, which makes the **served** `/api-docs-json` carry exactly that contract for every `/v2` route. |
| `apps/backend/src/gpr2-command-guard.ts` | The pipeline every `/v2` command passes through. |
| `apps/backend/src/modules/gpr2/*` | The 32 guarded routes (one controller method per mounted register row). |
| `apps/backend/src/main.ts` | Additive edits only: mount the module only when the flag is exactly `enabled`; put `code` / `details` on the body of a GPR-2 error (every other error body is unchanged); with the flag on, merge the derived GPR-2 contract into the served API document (the rest of that document is byte-identical with the flag on and off — a test fingerprints it). |
| `tests/gpr2-r01-*.test.ts`, `tests/helpers/gpr2-*.ts`, `tests/fixtures/` | The R01 tests (domain, HTTP, pipeline order, feature gate, OpenAPI incl. the live Swagger document, projections, traceability, normative expectations) and their fixtures. Test doubles for the resource preflight and a small independent JSON-Schema validator live in `tests/helpers/` and are imported by nothing in the application. |
| `docs/gpr-2-r01-decision-test-matrix.md`, `scripts/gpr2-r01-matrix.ts` | The generated D / K / C → tests matrix and its generator. |
| `scripts/gpr2-extract-normative.ts`, `tests/fixtures/gpr2-normative-expectations.json` | The expected acceptance scenarios and stages of every decision, read from the two approved documents (every range expanded), with their sha256. The documents themselves stay outside the repository. |

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

`authenticate → permission → object scope → nested-resource ownership preflight → envelope → replay → execute`, always in that order.

1. **Permission** is decided from the caller's *current* role (read from the database on every request) before any scope lookup, so a caller without the grant learns nothing about any object.
2. **Object scope**: a missing object, a malformed id, another tenant's object and another РП's object are one and the same `404`.
3. **Nested-resource preflight** (R01-B04). A well-formed `{id}` proves nothing about the aggregate behind it. Every route with an `{id}` declares the kind of aggregate (`endpoint.resource`); the mandatory `Gpr2Hooks.resources` resolver is asked who owns it, and the guard lets the call through only if that aggregate belongs to the caller's tenant **and** to the object of the path (a tenant-level request — corporate publication — to the tenant and to no object). Everything else — missing, another object's, another tenant's, a doubtful answer — is the same single `404`. There is no persistence for these aggregates yet (R03/R05/R07/R11/R15–R17 add it), so the default resolver (`DENY_ALL_RESOURCES`) knows none: **until a stage supplies a resolver that has verified its owner, a command addressed to an aggregate answers `404` and never reaches replay or execute**. A command with no `{id}` (create, upload) addresses nothing and is not affected. A resolver that throws is not an answer: the call fails closed (`500`, no detail). Hooks without a resolver are refused as a configuration error before anything runs.
4. **Envelope**; 5. **replay** — a stored result is looked up only after all of the above (so an Idempotency-Key is never an access token, and a result is not returned for an aggregate the caller no longer owns); 6. **execute**.

Command envelope: header `Idempotency-Key` (uuid, like every key in the repository) and body `{ "expectedVersion"?, "expectedScopeVersion"?, "payload" }`; which tokens a command carries is declared in the register, and a token it does not use is refused. Versions are canonical decimal-integer **strings**. `Idempotency-Key`: where it is optional (the three pure previews) an absent header is fine, a uuid is fine, and a header that is sent **empty** or malformed is `422 IDEMPOTENCY_KEY_MALFORMED` (the OpenAPI parameter says so); where it is required, absent or empty is `IDEMPOTENCY_KEY_REQUIRED`. `expectedSourceVersions` refuses the name `__proto__` in the published schema (`SourceVersions.propertyNames`) exactly as the parser does. An applied command answers **200** with the `CommandResult` (not the POST default of 201); a closed gate answers `501`.

**Payloads (R01-B03).** *Approve and commit* (`quantity.request.approve`, `imports.boq.commit`, `imports.estimate-labor.commit`, `schedule.revision.approve`) carry the common fence of TD §11.1: `inputFingerprint` (sha256 hex) and `expectedSourceVersions` (at least one named immutable source version, uuid); a body without them is `422` before replay. Their stage-specific fields are *deferred extensions*: accepted as plain JSON, never interpreted by R01 (the schedule approval stays a closed object). `finish-change.record-correction` requires a `reason`, like its lifecycle row. Every other payload the design leaves to a stage is an **open object that must be plain JSON** (null, boolean, string, a safe integer, arrays/objects of those, at most 32 levels deep, no `__proto__`): a fraction is `DECIMAL_NOT_A_STRING`, so nothing a client sends can make the command fingerprint throw (that used to be a `500`).

**One API contract (R01-B05).** The served `/api-docs-json` carries, for every mounted `/v2` route, the operation derived from the register (operationId, UUID path parameters, `Idempotency-Key`, body envelope, `200/401/403/404/409/422/501`); the lifecycle rows an endpoint performs and what they do to history are in `x-lifecycle-transitions`, rules JSON Schema cannot state (one field compared with another) in `x-cross-field-rules`. Tests compare the served document with the derived one and with the live routes in both directions (what the document accepts the server accepts, and the reverse).

## The quantity request PATCH (R01-B02)

`PATCH …/quantity-change-requests/{id}` is **one** editing command and two rows of the lifecycle, told apart by the state it finds: `DRAFT --edit--> DRAFT` (an ordinary edit; nothing was submitted, so nothing is versioned) and `RETURNED --revise--> DRAFT` (the correction: the request is reopened and its next submission is a *new submission version*; past versions and the decision history stay immutable). `SUBMITTED` and `APPROVED` have no PATCH row — fail closed. A future handler obtains its row from `transitionForEndpoint(lifecycle, state, endpointId)`, which refuses those states, instead of testing the state itself. R01 stores nothing; persistence of versions is R07.

## Interpretations (where the design leaves room) — please confirm in acceptance

1. **Separate enum, one permission per §11.3 row.** The design requires "explicit, not via `Object.values`"; the means (a separate enum) and the nine names are R01's.
2. **`GPR2_QUANTITY_REVIEW_NOTE` is held by nobody.** §11.2 says "PTO by an explicit review grant" and §11.3 "if allowed"; who holds it is not defined, so it is default-deny (like N01).
3. **Envelope shape.** `expectedVersion` / `expectedScopeVersion` / `payload` as body fields, `Idempotency-Key` as a uuid header, version tokens as strings: the design names the elements, not the wire form.
4. **Status codes.** `422` for a lifecycle violation (`INVALID_TRANSITION`, `REASON_REQUIRED`, `SEPARATION_OF_DUTIES`), `409` only for stale version / changed scope / idempotency mismatch, `404` for a malformed path id, `501 COMMAND_NOT_ENABLED` for the closed gate.
5. **A RETURNED revision is final for its row**; the РП continues in a *new* draft (§8.1 "new DRAFT version", §5.4 "return is not discard"). §11.2 lists only "draft from current / empty", so the payload of `schedule.revision.create` is left open for R11 — how a returned revision seeds a new draft is a question for R11 / R12.
6. **The quantity request `PATCH`** is both the ordinary edit of a DRAFT and the correction of a RETURNED request (§5.3 "correction creates a new submission version"; the register has no separate command) — see the section above. Reviewer notes on a submitted request are a separate command and are not a state change.
7. **Separation of duties applies to approval** (§11.3 states it for approval); a return is a review and is not blocked for the author.
8. **Tenant-level publication routes.** `work-type-publication-requests/{id}/approve|reject` carry no object prefix (corporate act). The route of *corporate template publication* is not named by the design; `finish-template.publish` is a proposal and is not mounted.
9. **Not fixed by the design, hence not fixed here:** import-batch *edges* (only the seven states), calendar-version and template *publication* commands, the *stage-specific* fields of the payloads of quantity, finish, import and calendar commands (they are open objects that carry the owning stage in the OpenAPI document; only their safe-JSON shape and, for approve/commit/correction, the common fence are R01's).
10. **Lag value** is a `NORMATIVE` decimal string with a lag kind (`WORKING_DAYS` / `ELAPSED_HOURS`); the design says "lag value" without a type.
11. **GPR-1 grants are untouched.** `SCHEDULE_EDIT` is still held by the deputy in the legacy contour, which contradicts D11 *there* until the cutover (R12 / R21); the new `/v2` rights are the ones that implement D11.
12. **CORS.** `main.ts` allows only `Authorization` / `Content-Type` and `GET|POST|PATCH`. A cross-origin browser client would need `Idempotency-Key` and `PUT` (BoQ allocations) added when those commands get behaviour (R03c / R15); same-origin deployments (Caddy) are unaffected.
13. **The fence needs at least one source.** An empty `expectedSourceVersions` map fences nothing and is refused like a missing one — this also tightens `schedule.revision.approve` (which accepted `{}`). The *names* of the sources (calendar, quantity, import …) belong to the owning stage; R01 only requires a safe name and a uuid.
14. **In an open payload a number is only a safe integer.** R01 cannot tell an integer count from an integer quantity by its value; a stage that owns a decimal field types it (decimal-as-string) in its own schema. A fraction, `Infinity` and anything beyond 2⁵³−1 are refused.
15. **Payload-embedded ids** (`workId`, `calendarVersionId`, `aliasOfWorkTypeId` …) are checked for syntax by the envelope; their ownership is the owning stage's, inside its transaction. The preflight covers the ids of the *path*.
16. **`coverage_state` (TD §5.1) for the quantity and schedule projections** is read as their own state field (`physicalState`, `scheduleState`); the labor projection has `coverageState`. No third enum is invented. `sourceVersion` is one token naming the set; `sourceVersionIds` are the named uuids (TD §12.2).
17. **Structural reading of the verdicts** (R01-B07): `ON_PLAN` means a *known* zero gap and zero lag, `BEHIND` a positive gap and a positive lag, `COMPLETED_ON_TIME` / `COMPLETED_LATE` a zero / positive final lag, `COMPLETED_COMPLETION_DATE_UNKNOWN` no lag at all; a comparison needs an approved baseline (revision, calendar version, timezone, evaluation date, operative dates, positive baseline quantity). A labor percent needs COMPLETE coverage, a positive denominator and a *known* numerator; a zero denominator is `ZERO_WORKER_DENOMINATOR`, never COMPLETE. These follow from §7.5–7.6, §8.3–8.4; R13/R17 may refine but not weaken them.
18. **Reason length** is counted after trimming, in UTF-16 code units (as the parser does); the document states it as a pattern, so a consumer that counts code points is at most more lenient for astral characters.

## Decisions pinned vs. left to later stages

`docs/gpr-2-r01-decision-test-matrix.md` maps all 46 decisions (D01–D24, K01–K04, C01–C18). R01 **pins** 8 (D11, D14, D15, D16, D18, D22, K03, C10), **partially** pins 31 (C18 among them: it is accepted by A01–A30 across every stage and cannot be completed by one) and
has nothing to pin for 7 (D03, D20, D24, C02, C06, C07, C15). The status words describe *contract coverage*, never business completeness; every decision's acceptance scenarios and stages are the full expansion of the Technical Design's ranges, and a test compares them with a fixture extracted from the documents. It claims no decision is implemented. The register of expectations that later stages cancel (Roadmap §5.2) is in the same file;
R01 changes none of those tests, and a test proves the registered and the protected suites are byte-identical to the base commit.

## Running the tests safely

R01 tests never use a real database: `tests/helpers/gpr2-isolation.ts` (imported **first**) deletes `DATABASE_URL`, `PG*`, `E2E_*` and `POSTGRES_*` and pins `DB_MODE=pglite`,
and `assertInMemoryPool()` proves the pool is PGlite. (`apps/backend/src/db.ts` decides at import time; a test that imported the backend before pinning the environment would
open a node-postgres connection to whatever the `PG*` variables name.)

```
node --import tsx --test tests/gpr2-r01-*.test.ts        # the R01 tests (pure domain + PGlite)
npx tsc --noEmit                                           # types
node --import tsx scripts/gpr2-r01-matrix.ts --write      # regenerate the matrix document
# re-derive the normative expectations (the two approved documents are NOT in the repository; pass their paths):
node --import tsx scripts/gpr2-extract-normative.ts <Technical_Design.md> <Implementation_Roadmap.md> --write
GPR2_TD_PATH=<Technical_Design.md> GPR2_ROADMAP_PATH=<Implementation_Roadmap.md> node --import tsx --test tests/gpr2-r01-normative-expectations.test.ts
```

The full `npm test` additionally runs the existing native-PostgreSQL suites, which create and drop databases on `127.0.0.1:5432` (or `E2E_*`) — run them only against a disposable local
cluster. Three of them share the database `construction_test` and must not run in parallel with each other (`--test-concurrency=1`).

## Not done in R01 (by design)

No migration (the chain still ends at `025`; the next number is decided by the real branch and ledger), no table, no ledger, no lock protocol (R03), no resolver (R02), no calendar engine
(R10), no schedule / quantity behaviour (R07, R11–R14), no import, no UI, no LIVE inventory (R00b) and no change to Render, Bitrix24 or any environment.
