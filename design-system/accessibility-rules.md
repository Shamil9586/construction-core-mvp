# Accessibility rules

Baseline: WCAG 2.1 AA; see also `.claude/skills/accessibility`.

1. **Colour is never the only carrier of meaning.** Every status has a text label; badges and bars have text or accessible names.
2. **Contrast:** text ≥ 4.5:1 (large ≥ 3:1); UI boundaries and focus indicators ≥ 3:1 on both light and dark surfaces.
3. **Keyboard:** all actions reachable; interactive table rows are real buttons (Enter/Space); overlays trap focus and restore it on close; no keyboard traps.
4. **Focus:** always visible, never removed without replacement.
5. **Semantics:** landmarks `aside/header/main/nav`; one `h1` per screen, headings in order; tables use real `th`/scope; lists for queues/blockers.
6. **ProgressBar:** `role=progressbar` with name and value, or `decorative` when the value is adjacent; `null` is announced via its caption.
7. **StatusBadge:** text is the status; no `title`-only content.
8. **Errors/empty/loading:** text, not just icon/colour; loading announced politely.
9. **Targets:** interactive targets ≥ 24×24 CSS px (prefer 40 on touch).
10. **Reflow/zoom:** usable at 320 px width and 200% zoom without two-dimensional scrolling for non-table content.
11. **Motion:** none required for meaning; respect `prefers-reduced-motion`.
12. **Language:** `lang="ru"`; abbreviations (СК, ИД, СДО, СМР) expanded on first use or via `abbr`.
