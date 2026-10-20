# Construction Core — engineering orientation

Construction Core is a construction-execution management system. It is not a CRM, a generic
task manager or a document archive. The operational hierarchy is:

```
Company → Object → Work → Execution / Quantity → Inspection → PTO / Documentation → SDO / Closing
```

Physical completion, quality inspection, documentation readiness and financial closing are
separate facts. Never merge them into one status.

## Repository

| Path | Contents |
|---|---|
| `apps/frontend/` | React 19 + TypeScript + Vite UI (design system, view models, screens) |
| `apps/backend/` | NestJS API; services under `apps/backend/src/`, GPR-2 R01 module in `apps/backend/src/modules/gpr2/` |
| `packages/domain/` | Pure domain rules, roles and legacy permissions (`index.ts`); GPR-2 contracts in `packages/domain/gpr2/` |
| `infra/` | Numbered SQL migrations `NNN_*.sql`, Dockerfile, Caddyfile |
| `scripts/` | `migrate.ts`, `local-postgres.ts`, seed, inspection and GPR-2 matrix scripts |
| `tests/` | Node test runner suites, `tests/helpers/`, `tests/fixtures/`, Playwright suites in `tests/*-browser/` |
| `docs/` | Architecture, ADR, business rules, permissions, GPR-1 and GPR-2 R01 documents |

Stack: TypeScript on Node.js, NestJS, React 19, Vite, PostgreSQL through `pg` with raw SQL
(`apps/backend/src/db.ts`), PGlite for explicit local verification, `node:test` and Playwright.
There is no ORM. Do not introduce Prisma, TypeORM or another persistence layer without an
explicit owner decision.

## Authority (highest first)

1. Explicit authorised owner/coordinator decisions and approved normative specifications.
2. Accepted Construction Core product, domain and security decisions (`docs/adr-0001-architecture.md`,
   `docs/business-rules.md`, `docs/domain-model.md`, `docs/permissions.md`).
3. For GPR-2 work: the approved *Construction Core — GPR-2 Final Technical Design* (v1.0, 15.10.2026)
   and *Construction Core — GPR-2 Implementation Roadmap* (v1.0, 15.10.2026).
4. For the existing GPR-1 contour: `docs/gpr-1-production-schedule.md`.
5. Existing implementation contracts and repository conventions (e.g. `docs/gpr-2-r01-contracts.md`).
6. This file and the project skills in `.claude/skills/`.
7. Third-party advisory skills; `.claude/ui-skills-governance.md` ranks them for UI work.

The two GPR-2 documents are **external**: they are not committed to the repository. GPR-2
implementation work needs both available and checksum-verified before it starts; if they are
missing, stop and ask. When two approved sources disagree, report the conflict — do not
invent a reconciliation. Nothing in this file or in a skill amends an approved decision.

## GPR-1 and GPR-2

- GPR-1 is the existing approved production-schedule contour. It stays authoritative where it
  applies until an approved replacement and cutover.
- GPR-2 follows its own Technical Design and the staged Roadmap (R00–R22). R01, the Contract
  Foundation, is accepted; it adds contracts, explicit permissions and a disabled `/v2` command
  guard, not behaviour. Each later stage needs its own authorisation.
- Do not carry a GPR-1 rule into GPR-2 (or back) because two features share a name.

## Invariants

- Strict tenant and object isolation on every read, write, link and replay.
- RP fact, INTERNAL_SC and CUSTOMER_SC quantities are independent; none is derived from another.
- Cumulative quantity integrity: exact decimals, caps enforced, no clamping that hides a conflict.
- Contractor and performer attribution is preserved and never inferred.
- Authorisation and scope ownership are checked before idempotency replay.
- No implicit privilege expansion: ADMIN does not receive GPR-2 grants automatically.
- Domain constraints (DB triggers, append-only history, F12.1 guards) are never bypassed.

## Git and environment safety

- Start from an exact, recorded baseline SHA; work on an isolated feature branch.
- Never change `main` unilaterally. No push, PR, merge or deployment without explicit authorisation.
- No LIVE database connection or mutation; tests never receive a LIVE URL. `npm run db:migrate`
  applies migrations to whatever `DATABASE_URL` names — never point it at production.
- Never touch another executor's working tree, branch or baseline.

## Tests

`npm test` runs `node --import tsx --test tests/*.test.ts`, including native-PostgreSQL suites
that create and drop databases on a local cluster. Prefer focused files
(`node --import tsx --test tests/<file>.test.ts`); use native PostgreSQL for locking/concurrency
claims and Playwright (`npm run test:*-browser`) only for UI changes. `npm run build` type-checks
the whole tree. A Markdown-only change needs no regression run. Details: `backend-testing`.

## Acceptance

An author's self-report is evidence input, not acceptance. Independent review and the final
owner/coordinator decision are separate steps. An author may report
`IMPLEMENTED — PENDING INDEPENDENT REVIEW`, never self-certify acceptance.

## Skills

- [`postgres-engineering`](.claude/skills/postgres-engineering/SKILL.md) — schema, migrations, transactions, locks, quantity integrity.
- [`rbac-authorization`](.claude/skills/rbac-authorization/SKILL.md) — permissions, tenant/object scope, contractor access, auth-before-replay.
- [`backend-testing`](.claude/skills/backend-testing/SKILL.md) — test selection, PGlite vs native PostgreSQL, evidence classification.
- [`independent-acceptance`](.claude/skills/independent-acceptance/SKILL.md) — candidate identity, findings, verdicts.
- Frontend: `frontend-architecture`, `frontend-testing`, `typescript-engineering`,
  `design-system-engineering`, `accessibility`; advisory `impeccable` and `design-taste-frontend`
  under `.claude/ui-skills-governance.md`.
