# GPR-2 R05 — PR #17 execution brief: S2 AreaScope UI

**Date:** 2026-10-30  
**Executor:** Claude Code  
**Owner authority:** direct owner approval in the current Construction Core coordination chat on 2026-10-30 (the owner answered “Разрешаю” to the bounded PR #17 scope below).  
**Status:** EXECUTION BRIEF — NOT ACCEPTANCE, NOT MERGE AUTHORIZATION.

## 1. Exact baseline and source pins

- Product base: `Shamil9586/construction-core-mvp@5469ba0d7631055e667043c20bcc4abc4a043795` (main at task start).
- D1 owner assignment: `construction-core-project-docs@ea90402cca39b5627eb1bae95de4530ed415dfcf`, `assignments/GPR2_R05_Read_API_D1_Owner_Authorized_2026-10-29.md`.
- D1 read API contract: product `5469ba0d7631055e667043c20bcc4abc4a043795`, `docs/gpr-2-r05-read-api-d1.md`.
- R05 contract: product `5469ba0d7631055e667043c20bcc4abc4a043795`, `docs/gpr-2-r05-contract.md`.
- UI readiness analysis (executor-authored, read-only; not normative and not an independent verdict): product `8d3f84eea2eb378d282b82de6e917acb0dff5a2d`, `docs/gpr-2-r05-ui-pilot-readiness.md`.
- Current project governance was read from docs main `a5541086da4a72d8bfbee92bf32432bda3b7346f`; project instructions blob `db4aa2654f9828be3e61af830293eb830d7cef9d`; protocol blob `6fe04021c1fcaebd8feb4cbfafa03ccf614aab5f`.

PR #16 (D1) is merged and its code is present in the baseline. Its PR description says “PENDING INDEPENDENT REVIEW”; GitHub PR review list is empty and no Actions run exists for head `40aed1854cd1d92976cbcd98d63efd8f5e872e68`. Treat independent acceptance of D1 as **NOT VERIFIED**. Do not repeat the full R05 backend review, but the independent reviewer of PR #17 must inspect the exact D1 read API surface used here and its object-scope behavior.

## 2. Owner-approved decisions for this stage

The owner approved the following recommendations in the current chat on 2026-10-30:

- **D2 — UI visibility only:** show the R05 object-catalog entry and allow this screen only for role `PROJECT_MANAGER`. This is presentation/navigation gating only; it is not an authorization boundary and must not grant or imply a backend permission. Backend current-role authorization and object ownership remain authoritative.
- **D4 — AreaScope create route:** approve use of the already implemented proposed command route `POST /api/v2/objects/{objectId}/area-scopes` (`area-scope.create`) for the pilot. No backend/domain/register/OpenAPI change is part of this PR.
- **D5 — pilot scope:** minimum pilot is S2 (AreaScopes) + S3 (object finish systems, without corporate templates) + S4 (generation). Defer S1 (object WorkType management), S5 (Admin catalog and corporate template administration), and corporate templates. This PR implements S2 only.
- **D9 — generated Work optional assignments:** generated Work may initially have null contractor, responsible person, cost and dates; assignment is handled later by the existing production workflow. This PR does not implement Work generation or assignment.

D3 (feature-flag/LIVE enablement), D6 (pilot users), and D7 (R05 UI acceptance profile / hosted CI run) remain unresolved and are NOT authorized by this brief. D8 is already closed by R05-DEC-03. Do not infer any other owner decision.

## 3. PR #17 scope — frontend only

Implement **S2 — “Зоны объекта”** as one screen inside the selected object:

- Entry from O01 / Object Overview, visible only to `PROJECT_MANAGER`.
- Route: `/object/:objectId/finish/areas`.
- Read and create AreaScopes only for the `objectId` in the route.
- Render a parent/child tree from the flat read response using `parentId`.
- Allow creation of a root node or a child under an existing active parent.
- Show the existing measure (quantity + unit), lifecycle and kind.
- Provide loading, empty, error, forbidden/unavailable, and create-in-progress states.
- On successful create, reload the complete paginated tree and show the saved node.
- Keep the design consistent with the existing Visual Baseline v1, design-system tokens and O01/GPR-1 screen patterns. Support 1440px and 390px viewports and accessible labels/keyboard navigation.

Do not add edit/delete/retire controls. AreaScope identity and measure are immutable in the existing contract. Do not add a fixed parent-kind hierarchy: any AreaScope kind may be nested under any other kind; the tree is flexible. The UI may label kinds in Russian but must preserve all contract values.

### AreaScope kinds and units

New AreaScope kinds are exactly: `BUILDING`, `SECTION`, `FLOOR`, `ZONE`, `ROOM`, `SURFACE`, `OTHER`. Suggested Russian labels: Корпус, Секция, Этаж, Захватка, Помещение, Поверхность, Другое.

New measurement units are exactly: `м`, `м²`, `м³`, `т`, `кг`, `шт`, `компл`. Quantity must remain a decimal string; do not convert through JavaScript floating-point arithmetic. Quantity and unit are an optional pair: both absent/null or both supplied. The server validates positive quantity and parent-child measure constraints. Do not calculate or duplicate those business rules in the browser; display server validation errors in human-readable Russian.

### Existing API contract — do not change it

- Read: `GET /api/v2/objects/{objectId}/area-scopes?limit=200&cursor=...`.
- Read response: `{ items: AreaScopeRead[], nextCursor: string | null }`. Follow every cursor until null; detect repeated cursors and fail closed rather than silently displaying a partial tree.
- Each item: `id, parentId, kind, code, name, measureQuantity, measureUnit, lifecycle, version, createdAt, updatedAt`.
- Create: `POST /api/v2/objects/{objectId}/area-scopes`.
- Create payload: `{ parentId?, kind, code, name, measureQuantity?, measureUnit? }`; omit or use null for an unmeasured node. A parent must belong to the same object.
- Create requires `Idempotency-Key`; no expectedVersion or expectedScopeVersion is defined for this command.
- Command success shape: `{ resultIds, appliedVersions, warnings }`.

Use the existing bearer session via `readSessionToken()`. Add a dedicated R05 frontend API client and R05 types if needed. Preserve `code`, `details`, and `requestId` in typed API errors. **Do not modify** the shared `apps/frontend/src/http.ts`; its behavior is frozen for other screens. Keep an idempotency key stable for a retry of the same submitted payload; do not silently retry a create with a new key after an ambiguous network failure.

The API path and all navigation must carry the real route `objectId`; no hardcoded object IDs, demo fallbacks, tenant-wide lists, or cross-object aggregation.

## 4. Frontend architecture boundaries

Follow the existing layering and locations:

- `app/routes/`: route container, object lookup, session/role gate, data loading.
- `app/AppRoutes.tsx` and `app/routePaths.ts`: route registration and path builder.
- `data/`: API client.
- `types/`: response/payload types.
- `view-models/`: pure tree construction / safe mapping, if needed.
- `screens/`: S2 screen and local styles.
- O01: one new navigation callback/link only.

Reuse the existing design system, tokens, `AppShell`, `Breadcrumb`, `PageHeader`, `RouteStatus`, bearer-token helper and established patterns. Do not add a UI library, state library, dependency or new auth model.

For a direct route opened by a non-`PROJECT_MANAGER`, render an explicit unavailable/forbidden state without making an R05 API call. A 403 or 404 from the backend must not be interpreted as an empty tree; use a generic unavailable message that does not disclose whether the object/feature exists.

## 5. Tests and evidence required in this PR

- Pure tests for flat-to-tree mapping, ordering, malformed/orphan/cyclic data handling and unknown kind fallback, if a view-model is added.
- Targeted browser coverage for: PROJECT_MANAGER entry visibility; other roles hidden/blocked; one-object URL and request scoping; empty and populated tree; pagination; create root and child; Idempotency-Key; success reload; server validation error; 403/404 unavailable state; 1440px and 390px layout.
- Browser tests may stub the R05 HTTP calls for this frontend-only stage. Clearly state that mocked browser tests do **not** prove real backend integration.
- Run `npm run build`, `npm run typecheck:strict`, and the focused new tests locally. Report exact commands, exit codes, totals and raw log paths/hashes. If a test cannot be run, state NOT RUN and why; do not claim PASS.
- No dependency changes and no GitHub Actions changes. No workflow dispatch. No acceptance profile registration. No attempt to enable the feature flag.

## 6. Prohibitions / PR disposition

- No changes to `apps/backend/**`, `packages/domain/**`, `infra/**`, `apps/frontend/src/http.ts`, auth/session model, `vite.config.ts`, `.github/**`, secrets, migrations, deployment, Bitrix, Render or LIVE.
- No GPR2 feature-flag enablement. No production database.
- No S1, S3, S4 or S5 implementation in this PR; no corporate templates, WorkType creation, generation, Work assignment or R06.
- No merge. Keep PR #17 **draft** and label the result **IMPLEMENTED — PENDING INDEPENDENT REVIEW** only after implementation and GitHub readback.

The executor must report branch, PR URL, exact base/head/tree SHA, changed files, local test results, and read the final files back from GitHub by exact head SHA. The executor does not accept its own work. Route: EXECUTOR → GITHUB → INDEPENDENT REVIEWER → COORDINATOR → separate owner merge decision.
