# UI skills governance

This file records how the third-party UI/design skills under `.claude/skills/`
(Impeccable, `design-taste-frontend`) relate to Construction Core's own accepted
product and design decisions. It is a governance note, not a skill: nothing
here is a capability to invoke, and nothing here overrides project docs.

## Precedence

When a UI skill's advice conflicts with Construction Core's own decisions, the
order below wins, highest first:

1. Accepted Construction Core Product / UX Architecture
2. Accepted business/domain workflows and terminology
3. Existing Construction Core Design System (`.claude/skills/design-system-engineering`,
   `.claude/skills/accessibility`, `.claude/skills/frontend-architecture`)
4. Existing repository conventions
5. Impeccable
6. `design-taste-frontend`

These skills are **advisory**. They must never be treated as authorities over
the items above, and must never be used to change:

- domain semantics, API contracts, roles/permissions, quantity logic;
- the SC / PTO / ID / SDO / Closing workflows;
- object/tenant boundaries or the accepted navigation architecture.

## Invariants no skill may erode

- Company → Object → Work execution context; no mixing unrelated objects on
  one operational screen.
- Physical readiness = factual СМР execution. Plan ≠ Fact. Unknown ≠ positive.
  No data ≠ no problems.
- Schedule ≠ health ≠ documentation ≠ finance. Color ≠ business status.
- The Work Card stays central. Accepted terminology stays as-is.
- Dense, professional construction-management UI — this is an operational
  tool, not a marketing site, portfolio, or visual showcase.

## Impeccable

Project-scoped, Claude Code only (`.claude/skills/impeccable`,
`.claude/agents/impeccable-*.md`). It offers advisory anti-pattern detection and design
commands (`/impeccable craft`, `audit`, `polish`, etc.). Nothing here runs automatically,
and its output is a suggestion subject to the precedence above:

- `/impeccable init` is not part of the project workflow. Construction Core already has
  accepted Product/UX architecture; generating `PRODUCT.md`/`DESIGN.md` from scratch is a
  separate decision for a human to make deliberately, not a side effect of having the
  skill installed.
- The per-edit/Stop design-detector hook is not committed to the repository. Upstream's
  default is machine-local opt-in (`.claude/settings.local.json`, which is gitignored)
  rather than an always-on, repo-wide hook. A developer who wants live checks can opt in
  locally by following `.claude/skills/impeccable/reference/hooks.md`; do not add the hook
  to shared settings without a separate decision.
- Per the skill's own `SKILL.md`, its launcher (`scripts/impeccable`) runs a binary that
  ships next to it or is downloaded once on first run. Running any `impeccable` command
  can therefore start that download. Treat running the skill's commands as a deliberate
  action by a human, not something to do incidentally while editing documentation or
  unrelated code.
- Its sub-agents (`.claude/agents/impeccable-*.md`) are used only when an Impeccable
  command is deliberately invoked.

## design-taste-frontend ("Taste")

Project-scoped, Claude Code only, a single skill out of the `Leonxlnx/taste-skill`
bundle (`.claude/skills/design-taste-frontend`, tracked via `skills-lock.json`).

Construction Core is a dense operational construction-management application,
not a landing page, portfolio, or experimental visual showcase — the audience
this skill's own defaults target. Taste's "three dials" are **prompt-level
guidance written into `SKILL.md` itself** (`DESIGN_VARIANCE`, `MOTION_INTENSITY`,
`VISUAL_DENSITY`, defaulting to 8/6/4 in the upstream skill) — there is no
project config file or CLI flag that sets them; nothing in this repository
enforces the values below, because the installed skill has no such mechanism.

Future use of this skill on Construction Core should favor approximately:

```
DESIGN_VARIANCE  = 2   (near-symmetric, not artsy/chaotic)
MOTION_INTENSITY = 2   (near-static, not cinematic)
VISUAL_DENSITY   = 8   (cockpit/packed data, not airy)
```

i.e. close to the inverse of the skill's own out-of-the-box bias. Taste must
not be used to push this product toward oversized hero typography, excessive
whitespace, decorative gradients, novelty navigation, excessive card nesting,
reduced information density, or marketing-style composition.

## Motion

At the time of writing, the repository declares no Motion skill, no Motion MCP server
and no Motion runtime dependency (`motion`, `framer-motion` or otherwise) in
`package.json`; re-check `package.json` and `.claude/` rather than relying on this
sentence. Adding any of them is a separate decision, and an earlier session's notes about
Motion's install path, or about the F11 UI Quality / Responsive pass, are historical and
must not be read as current project status. If animation guidance is needed, re-verify
current official guidance from scratch.

Whatever animation is used, from any skill or library:

- it stays subordinate to usability — drawer/panel opens, disclosure, status feedback,
  queue add/remove, success/error feedback, subtle layout transitions — not decorative
  page transitions, parallax, magnetic effects, bounce-heavy interaction, or continuous
  background animation;
- it prefers CSS for simple transitions;
- it must respect `prefers-reduced-motion`.

## Accessibility

Third-party UI skills do not relax the project's accessibility requirements. Contrast,
focus visibility, keyboard operation and "colour never carries meaning alone" are governed
by `.claude/skills/accessibility`, which ranks above both Impeccable and
`design-taste-frontend` in the precedence list.

## Automatic UI changes

A third-party skill's suggestion is never applied automatically. Do not use Impeccable or
`design-taste-frontend` to rewrite existing screens, tokens or design-system components in
bulk, and do not accept a suggested redesign without checking it against the precedence
list and the invariants above. UI changes follow the Construction Core design system and a
human-approved scope.
