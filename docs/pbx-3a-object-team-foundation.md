# PBX-3A — Object Responsibility & Team Redistribution (PTO)

Implements the locked decisions of *PBX-3 Architecture Contract v1.0* (PBX3-D01…D10) for the PTO function
on a generic, `function_code`-scoped foundation. Baseline: `14ba13bc11b7e6a82771f4371262db3e7e4534c7`.

## Schema (`infra/016_object_team_foundation.sql`, additive)
| Table | Active-row invariant (partial unique, `WHERE ended_at IS NULL`) |
|---|---|
| `functional_team_memberships` | one per `(tenant_id, function_code, member_user_id)`; `CHECK manager<>member` |
| `object_function_lead_assignments` | one per `(tenant_id, object_id, function_code)` |
| `object_function_member_assignments` | one per `(tenant_id, object_id, function_code, member_user_id)`; **no reference to a lead row** |
| `object_function_handovers` | status `OPEN / ACKNOWLEDGED / ADMIN_COMPLETED`, consistency CHECK |

All FKs are tenant-scoped composites `(tenant_id, id)`. Assignment tables are append-only: a trigger forbids
DELETE, freezes every column except `ended_at/ended_by/end_reason/version`, and makes an ended row immutable.
Timestamps use `clock_timestamp()` (not the transaction-start `now()`).
`function_code` accepts `PTO, CONSTRUCTION_CONTROL, SDO, PROJECT_MANAGEMENT`; only `PTO` is written in PBX-3A.
There are no percentage / allocation columns.

## Permissions (`packages/domain`)
| Permission | Roles |
|---|---|
| `FUNCTION_TEAM_MANAGE` | DEPUTY_DIRECTOR, ADMIN |
| `OBJECT_FUNCTION_LEAD_ASSIGN` | DEPUTY_DIRECTOR, ADMIN |
| `PTO_OBJECT_TEAM_MANAGE` | PTO_HEAD, ADMIN (service also requires the actor to be the *current PTO lead of that object*; ADMIN overrides) |
| `PTO_TEAM_READ` | DEPUTY_DIRECTOR, GENERAL_DIRECTOR (read-only), PTO, PTO_HEAD, ADMIN |

DEPUTY_DIRECTOR gains **no** `PTO_EDIT` / `DOCUMENTATION_MANAGE`.

## API
| Route | Who |
|---|---|
| `GET /function-teams/pto/overview` | Deputy, GD, Admin |
| `GET /function-teams/pto/my-team` | PTO_HEAD, PTO |
| `GET /objects/:id/function-team/pto` | team readers (PTO roles only on assigned objects) — current team + history + handovers |
| `POST /function-teams/pto/org-members` | Deputy/Admin — assign/transfer engineer to a head's organizational team |
| `POST /objects/:id/function-team/pto/lead` | Deputy/Admin — assign/replace object PTO_HEAD (members untouched; handover created) |
| `POST /function-teams/pto/redistribute` | Deputy/Admin — atomic: org transfers/ends, lead changes, member ends/adds, handovers |
| `POST /objects/:id/function-team/pto/members` | current object PTO_HEAD — add engineer **from own organizational team** |
| `POST /objects/:id/function-team/pto/members/:userId/end` | current object PTO_HEAD — remove any current engineer (inherited included) |
| `GET /function-handovers`, `POST /function-handovers/:id/acknowledge`, `POST …/admin-complete` | incoming user acknowledges; Deputy/Admin complete with mandatory reason |

Bodies are `.strict()`; tenant, function and `assigned_by` are never client-supplied.

## Concurrency
Every mutating command takes `pg_advisory_xact_lock` on the sorted set of object/user keys it touches, reads
target users `FOR SHARE` in id order, re-validates authorization under the lock, and processes operations in a
deterministic order. The partial unique indexes remain the native backstop (proved with an uncommitted rogue
writer in `tests/pbx3a-object-team-postgres.test.ts`).

## PTO operational scope (PBX3-D08)
`objectAccess()` (used by every PTO write path) now also requires: PTO_HEAD → current PTO lead of the object;
PTO → current PTO object member; ADMIN overrides. The snapshot/`/objects` read model is filtered the same way
for PTO/PTO_HEAD. Responsible-user validation in `createDocumentationPackage` / `editDocumentationPackage`
requires the target to be active and currently on the object's PTO team. Existing rows are never rewritten.

## Deferred / known limitations
- No Construction Control, SDO or Project Management write flows (foundation only).
- No dedicated "end organizational membership" route outside redistribute `orgEnds`.
- The ADMIN responsible-picker still lists all active PTO users; the backend rejects non-team choices with a clear message.
- No automatic backfill of assignments for pre-existing objects: after deploy a Deputy must assign PTO leads/members
  (PTO/PTO_HEAD see no objects until then).
- Bitrix data is never used to infer assignments.
