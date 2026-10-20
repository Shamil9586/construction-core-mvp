---
name: rbac-authorization
description: Construction Core authorization rules — roles, legacy permissions versus the separate GPR-2 permissions, tenant and object isolation, nested-resource ownership, contractor (CONTRACTOR_VIEWER) scope, ADMIN restrictions, scope-safe errors, default-deny capabilities and authorization before idempotency replay. Use when adding or changing a permission or grant, a controller or service access check, a scoped read or write, a GPR-2 endpoint, contractor access, idempotent command replay, or when reviewing a security-relevant change. Not for visual or styling work.
---

# RBAC and authorization — Construction Core

The backend is authoritative; the UI only hides what the backend would refuse. Preserve the
existing model — do not build a new authorization framework. Ranking of sources: `CLAUDE.md`.
For GPR-2 the approved Technical Design §11 is the contract.

## 1. Where roles and rights come from

- Roles: `roles` in `packages/domain/index.ts` (11 roles). `INTERNAL_ASSIGNABLE_ROLES` excludes
  `CONTRACTOR_VIEWER`, the external-participant role.
- The actor: `authenticate()` in `apps/backend/src/security.ts` reads the user (and its current
  role, `is_active`) from the database on **every request** through the session token hash.
  Never trust a role, tenant or object carried in a token payload, DTO or cached result.

## 2. Legacy permissions

- `Permission` enum and `grants` in `packages/domain/index.ts`; checked by `hasPermission` /
  `requirePermission`.
- `ADMIN: Object.values(Permission)` — every member added to that enum goes to ADMIN
  automatically. That is why new GPR-2 rights are **not** added there.
- Do not mass-refactor existing legacy grants; change one only with an approved decision.

## 3. GPR-2 permissions (separate on purpose)

- `packages/domain/gpr2/permissions.ts`: `Gpr2Permission`, explicit `GPR2_GRANTS` for every
  role, `hasGpr2Permission`, `isAuthorized`.
- Current matrix (Technical Design §11.3): PROJECT_MANAGER — schedule/quantity author,
  external outcome record, object catalog, import; DEPUTY_DIRECTOR — schedule and quantity
  review; ADMIN — `CORPORATE_PUBLICATION` only; everyone else — nothing.
  `QUANTITY_REVIEW_NOTE` is held by nobody until an explicit decision.
- Never merge `Gpr2Permission` into `Permission`, never grant GPR-2 rights to ADMIN "for
  convenience", never derive a grant from a job title or org assumption.
- Holding several roles does not let a user approve their own submission: compare
  author/submitter with approver (§11.3). A missing second person is an owner exception, not a
  silent bypass.
- N01 `ESTIMATE_MAPPING_REVIEW` is an object-scoped capability assigned to a named user, not a
  role permission. Default deny: no role (ADMIN included) implies it; with no assignment the
  answer is "no".

## 4. Tenant, object and nested-resource isolation

- Tenant comes from the server session. Every query filters `tenant_id`; `scoped()` reads by
  `(tenant_id, id)`. Composite FKs back this up (`postgres-engineering`).
- Object access: `objectAccess()` — a PROJECT_MANAGER only on objects where they are
  `project_manager_id`; CONTRACTOR_VIEWER only on objects linked through
  `object_contractors_active` for their `contractorId`; PTO roles through
  `ensurePtoObjectScope()`.
- An id in a path or body is never proof of ownership. A nested aggregate must be resolved and
  shown to belong to this tenant **and** this object (`packages/domain/gpr2/resources.ts`,
  `ownershipPermits`; default resolver `DENY_ALL_RESOURCES`).
- Contractor scope: linked objects and own works only, no financial data
  (`docs/architecture.md`, `docs/permissions.md`). Any new read must keep that redaction.

## 5. Mandatory GPR-2 command order

Implemented by `runGpr2Command()` in `apps/backend/src/gpr2-command-guard.ts`
(`docs/gpr-2-r01-contracts.md`). Authentication precedes it at the HTTP boundary.

```
Authenticated actor
  ↓ current role / permission            403 PERMISSION_DENIED, before any scope lookup
  ↓ path identifiers and object scope    404 RESOURCE_NOT_FOUND
  ↓ nested resource ownership            404 RESOURCE_NOT_FOUND
  ↓ command envelope validation          422
  ↓ authorized idempotency replay
  ↓ execution
```

- Do not reorder, skip or weaken a step. A stage supplies its own `Gpr2Hooks` (resolver,
  replay, execute); it cannot move the steps.
- An existing Idempotency-Key never bypasses current authorization: a replay after a role
  change, a revoked permission or a lost object assignment is refused like a fresh call.
- Replay keys are scoped by tenant, actor, command kind and object/aggregate; same key with a
  different payload is `409` (§12.4).

## 6. Scope-safe errors

- GPR-2: a malformed id, a missing object, another tenant's object, another PM's object and a
  nested resource of another object all return the **same** `scopeSafeNotFound()` body
  (`packages/domain/gpr2/errors.ts`). No id, name, count or evidence in error details.
- Legacy endpoints answer some scope failures with 403 and a message; do not change that
  behaviour outside an approved task, and do not copy it into GPR-2.

## 7. Non-negotiables

- Default deny: an unknown role, a missing grant or a missing assignment is "no".
- No implicit privilege expansion — not through ADMIN, enum enumeration, role inheritance,
  cached responses or a fallback branch.
- Do not invent a permission decision the Technical Design leaves open (e.g. who holds
  `QUANTITY_REVIEW_NOTE` or N01); report it as an open decision.

## 8. Required security regression tests

Every new or changed access path needs negative tests for:

- missing permission (including ADMIN on a GPR-2 command it does not hold);
- wrong tenant; wrong object (including another PM's object);
- nested resource that belongs to another object or tenant;
- revoked permission or changed role between two calls;
- replay of a stored Idempotency-Key after that authorization change;
- contractor scope leakage (unlinked object, other contractor's work, financial fields).

Follow existing patterns: `tests/gpr2-r01-permissions.test.ts`,
`tests/gpr2-r01-guard-order.test.ts`, `tests/f12-final-r06-auth-safe-idempotency.test.ts`,
`tests/f8.1-contractor-viewer-scope.test.ts`, `tests/f12-file-01-object-boundary.test.ts`.
Assert status **and** that nothing was written. How to run and report them: `backend-testing`.
