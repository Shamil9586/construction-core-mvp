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
7. Motion (`.claude/skills/motion` — skill text only, no MCP server; see below)

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

Installed project-scoped, Claude Code only (`.claude/skills/impeccable`,
`.claude/agents/impeccable-*.md`). Advisory anti-pattern detection and design
commands (`/impeccable craft`, `audit`, `polish`, etc.) — nothing here runs
automatically:

- `/impeccable init` has **not** been run. Construction Core already has
  accepted Product/UX architecture; generating `PRODUCT.md`/`DESIGN.md` from
  scratch is a separate decision for a human to make deliberately, not a side
  effect of installing the skill.
- The per-edit/Stop design-detector **hook is not wired**. Upstream's own
  default is machine-local opt-in (`.claude/settings.local.json`, gitignored)
  rather than an always-on, repo-wide hook — this integration follows that
  default. A developer who wants live checks can opt in locally by following
  `.claude/skills/impeccable/reference/hooks.md`.
- The skill's own commands (`scripts/impeccable`) fetch a checksum-verified
  engine binary from the project's public release channel on first real use.
  That download did not complete in this session's sandboxed network policy;
  it is expected to work normally on a developer's own machine or a
  differently-configured session.

## design-taste-frontend ("Taste")

Installed project-scoped, Claude Code only, as a single skill out of the
`Leonxlnx/taste-skill` bundle (`.claude/skills/design-taste-frontend`,
tracked via `skills-lock.json`).

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

The task that requested this integration named an official Motion skill
`motion-react` at `https://motion.dev/docs/react-app-builders`. That page and
skill name do not appear to exist: Motion's actual current offering for
coding agents is **Motion AI Kit** (`motion.dev/docs/ai-kit`,
`github.com/motiondivision/ai-kit`, installer package `motion-ai`), whose
skill is named `motion` (not `motion-react`) and whose installer also
registers Motion's hosted MCP servers — a materially larger, network-service
footprint than "install one advisory skill," and one this task's own scope
rules did not authorize.

What's installed here is a deliberately narrower slice: `SKILL.md` and the
static `best-practices/*.md` reference (vanilla JS, React, Vue, Base UI/Radix)
copied verbatim from the official `motion-ai` package, under
`.claude/skills/motion/`. No MCP server is registered, no `add-mcp`-managed
config was written, and the `motion` npm package was **not** added to the
application. This is intentional, not an oversight: the upstream `SKILL.md`
itself documents this exact degraded mode ("If the Motion MCP server is
unavailable: `best-practices/` is self-contained and works with no server at
all — use it directly... If it is missing, tell the user the Motion MCP
server is not connected"). Anything in the skill that depends on the MCP
server (doc/example search, CSS spring generation, MotionScore performance
audits, the visual transition editor, and the "Upgrading Motion" workflow)
is unavailable until a human deliberately decides to install Motion AI Kit's
full MCP integration — a separate decision from this one, in scope for a
future workstream, not this one.

Regardless of how much of Motion ends up installed, it stays subordinate to
usability (drawer/panel opens, disclosure, status feedback, queue
add/remove, success/error feedback, subtle layout transitions — not
decorative page transitions, parallax, magnetic effects, bounce-heavy
interaction, or continuous background animation), prefers CSS for simple
transitions, and must respect `prefers-reduced-motion`. No animation has been
implemented in Construction Core as part of this integration.
