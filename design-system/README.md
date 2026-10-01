# Construction Core — Design System documentation (F13.1)

Documentation-only stream. **No code, no dependencies, no backend, no API contract is changed by anything here.**
The implemented components live in `apps/frontend/src/design-system/` (see its README); this folder
holds the rules, UX specifications and handoff notes that govern them.

## Scope and context limiter

The authoritative scope limiter is `docs/design/Construction-Core-Parallel-Design-Context.md` (added in F13.1.1).
F13.1 was written before it was in the repository, using the task brief, `apps/frontend/src/design-system/README.md` and
`.claude/ui-skills-governance.md`; F13.1.1 re-checked these files against it. Where this folder and the context document disagree, the context document wins.

Role labels: where a management role label is needed in UI, it is `DEPUTY_DIRECTOR` / «Заместитель директора».
`TECHNICAL_DIRECTOR`, `DEPARTMENT_HEAD` and a separate Director of Construction are being retired by backend ROLE-CLEANUP and must not appear in Design material.

Anything that would need backend, domain, API, auth, permissions, roles, schema, migrations, seed, Render or
deployment changes is written only as **"Design proposal requiring architecture review"** (DPAR) and is not implemented.

## Contents

| File | Purpose |
|---|---|
| `specs/C01-company-control-center.md` | C01 UX specification and states |
| `specs/O01-object-overview.md` | O01 UX specification and states |
| `specs/W01-work-card.md` | W01 UX specification and states |
| `specs/object-team-ux.md` | Object team display / assignments / responsibilities |
| `component-rules.md` | Component usage rules (ProgressBar, StatusBadge, ...) |
| `accessibility-rules.md` | Accessibility rules |
| `forbidden-patterns.md` | Patterns that must be rejected in review |
| `visual-consistency-rules.md` | Colour, type, spacing, density |
| `ai-tooling-policy.md` | DESIGN.MD, UI Rules Audit, Playwright UI Gate, 21st.dev |
| `frontend-handoff.md` | Component mapping, screen states, responsive, implementation notes, open DPARs |

## Locked principles (all documents inherit these)

1. Object is selected first; no operational screen mixes objects.
2. Work Card is the central production entity. Hierarchy: Company → Object → Work Card → Process.
3. Object Overview does not mix physical readiness, schedule, quality control, executive documentation (ИД), financial closing.
4. «Физическая готовность СМР» is independent from ИД, СДО and closing.
5. Execution fact ≠ acceptance. History keeps `RP fact ≠ Internal SC ≠ Customer SC`.
   (SC = СК, строительный контроль, as used in the product UI: «Подтверждение СК».)
