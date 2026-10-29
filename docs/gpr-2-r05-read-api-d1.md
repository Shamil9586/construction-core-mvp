# GPR-2 R05 — D1: backend read API (five GET operations)

Owner-authorised on 29.10.2026 (assignment `GPR2_R05_Read_API_D1_Owner_Authorized_2026-10-29.md`, `construction-core-project-docs@ea90402cca39b5627eb1bae95de4530ed415dfcf`).
Base: product main `4ccdd370fe45556a38cd4f6864afa83b4ed11890` (tree `9b62890f2897a144ab3a74ce1575a49f4c1868eb`). Status: **IMPLEMENTED — PENDING INDEPENDENT REVIEW**.

D1 is the read side R05 lacked: the commands of R05 (`docs/gpr-2-r05-contract.md`) are `POST`-only, so no screen could list WorkTypes, AreaScopes, finish
systems, templates or publication requests. D1 adds exactly five `GET` operations. It does not change a migration (029–035 untouched), a POST contract, a
quantity rule, an existing permission grant, the frontend, a workflow or the acceptance gate. D3, D4, D5, D6, D7 and D9 are not decided by it; D8 is closed by
R05-DEC-03 and not touched.

## The five operations

All are mounted only with `GPR2_CONTRACT_ROUTES=enabled` (no new flag; without it they are ordinary 404 routes that do not exist). Public prefix `/api/v2`
(the proxy strips `/api`). Every answer is `200 { items, nextCursor }` with `Cache-Control: no-store`.

| Id | Route | Who may open it | What it returns |
|---|---|---|---|
| Q1 `work-types.list` | `GET /objects/{objectId}/work-types` | РП of that object (`GPR2_OBJECT_CATALOG_MANAGE`) | tenant CORPORATE WorkTypes + OBJECT WorkTypes of THIS object: scope, unit, alias, flags, version |
| Q2 `area-scopes.list` | `GET /objects/{objectId}/area-scopes` | РП of that object | the AreaScope tree of THIS object (flat, with `parentId`): kind, code, measure/unit, lifecycle, version |
| Q3 `finish-systems.list` | `GET /objects/{objectId}/finish-systems` | РП of that object | finish types of THIS object, all system-version summaries, and the stages (+ provenance, exclusions) of the latest PUBLISHED version |
| Q4 `finish-templates.list` | `GET /finish-templates` | РП: PUBLISHED corporate templates only · ADMIN (`GPR2_CORPORATE_PUBLICATION`): DRAFT and PUBLISHED | corporate templates, version summaries, stages of the latest published (and, for ADMIN, the draft) version. No object data. |
| Q5 `work-type-publication-requests.list` | `GET /objects/{objectId}/work-type-publication-requests?state=` | РП: the requests that РП filed on this object · ADMIN: every request of the ONE chosen object | request status/version/decision/reason + the bound WorkType |

There is deliberately no tenant-wide request list ("one screen — one object"): the administrator chooses the object first; a request of another object is never
in the answer. `finish-systems.list` was already catalogued in the endpoint register (`mounted:false`); D1 mounts it. No other query is mounted.

Query string (strict; anything else is 422 `VALIDATION_FAILED`, every violation named, in query-string order): `limit` (1–200, default 100), `cursor`, and for
Q5 `state` ∈ `PENDING|APPROVED|REJECTED`. A repeated or bracketed parameter, an unknown name, `tenantId`/`objectId` as a parameter are refused.

Order and paging: keyset, stable — Q1 `(name, id)`, Q2/Q3/Q4 `(code, id)`, Q5 `(created_at DESC, id DESC)` with a microsecond key. `nextCursor` is opaque and bound
to route + object + view (РП/ADMIN) + `state`; a cursor of another request is 422 on `cursor`. LIMIT+1 rows are read, so the last page says `nextCursor:null`.
Q3/Q4 bound their children (≤100 stages per version, ≤200 parents per page).

## Security model

Order: authenticate (401, actor row read from the database on every request) → **permission from the current role** (403, before any object lookup) → path id + object
scope (**one scope-safe 404** for malformed, missing, another tenant's and another РП's object) → query string (422, after scope) → one snapshot in which the
actor row and the object scope are checked AGAIN on the snapshot's own rows, then the data is read. The tenant is always the actor's; no parameter names one;
every statement filters by it.

* A new authorization kind `ANY_PERMISSION { permissions }` in the register (`permissions.ts`). It adds **no grant**: `GPR2_GRANTS` is unchanged, ADMIN still
  holds only `CORPORATE_PUBLICATION`, so ADMIN is refused Q1–Q3 (403) and opens Q4/Q5 through that one grant. It is a separate kind so that the per-permission
  command rows of the A19 register tests are not mixed with reads.
* No `runGpr2Command`, no idempotency key, no ledger, no audit/event/notification row, no lock, no advisory lock: the reads run in `runSnapshotRead` —
  `REPEATABLE READ READ ONLY`, so PostgreSQL itself refuses a write (SQLSTATE 25006) and every statement of a page sees one committed state. A read neither waits for
  nor blocks a command in flight; it never sees uncommitted data.
* Every statement selects an explicit column list. Not returned: `created_by`, `published_by`, `origin_object_id`, `object_id` of a WorkType, any tenant id; template
  stages name only CORPORATE WorkTypes, system stages name a WorkType only if it is corporate or of THIS object.
* A role/object/activity change is effective on the next read (no cache; `no-store`).

## Contract (register, OpenAPI)

`packages/domain/gpr2/endpoints.ts`: five `QUERY` rows with `mounted:true`, `queryParams`, `ANY_PERMISSION`. `mountedEndpoints()` still returns the 35 commands;
`mountedQueries()` the five reads; `mountedRoutes()` both (the served OpenAPI document carries 40 operations). `packages/domain/gpr2/r05-read.ts`: the query grammar,
the cursor, the response types and the JSON Schemas published as `components.schemas.Read*` (the page schemas are the `200` bodies). The served document and the
register-derived contract are held equal by the existing R01-B05 tests, extended to the reads.

## Interpretations to confirm at review

1. The four routes other than `finish-systems.list` are named by the owner assignment, not by the Technical Design (`x-route-proposed`, like the three R05 POST proposals).
2. Q1 lists the whole corporate catalogue to the РП (what the legacy `GET /dictionaries` already shows) plus the object's own types, including inactive ones (`isActive`).
3. Q3 shows stages for the latest PUBLISHED version only (an upsert publishes at once; older versions are summaries). Q4 shows RETIRED templates with `lifecycle`.
4. Q5 for a РП is "requests this user filed on this object": a request filed by a previous РП of the same object is not shown to the current one; ADMIN sees it.
5. `requires*`/`isActive` of legacy WorkTypes are nullable columns and are returned as stored (`null` is not turned into a default).

## Tests (isolated; no LIVE)

* `tests/gpr2-r05-read-api.test.ts` — 13 tests, real backend on in-memory PGlite, mock auth: shapes against the served schemas; tenant/object/РП isolation; templates
  (DRAFT hidden from РП); own-vs-chosen-object requests; pagination and cursor binding; anonymous 401, every role × every read; 404 indistinguishability; strict query;
  before/after digest of 26 tables (no side effect) and a static check that the module contains no mutating statement/lock; role change / deactivation / reassignment effective at once.
* `tests/gpr2-r05-read-native-pg.test.ts` — native PostgreSQL 16, isolated cluster `gpr2-p1-isolated`, migrations 001–035: exact numeric/timestamp text, keyset order
  under the real collation, READ ONLY (25006), reads concurrent with a command holding the object coordination lock and row locks (no wait, no uncommitted data),
  an open reader does not block a command, no transaction id consumed by 100 reads, no advisory lock left.
* Existing R01 register/OpenAPI/HTTP/flag-off tests updated for the five mounted reads (route counts, `ANY_PERMISSION`, flag-off 404 / flag-on 401 for each read).
