---
name: accessibility
description: Accessibility requirements for the Construction Core frontend — WCAG 2.1 AA contrast, focus rings on light and dark surfaces, keyboard interaction for table rows and overlays, and the rule that colour never carries meaning alone. Use whenever building or reviewing an interactive component, a table row, a badge, a button, an overlay or a form field, whenever choosing a border or focus colour, and before declaring any component finished.
---

# Accessibility — Construction Core

The whole text layer of the palette was verified against WCAG 2.1 AA and passes. That
result is a property of the tokens, so it only holds while components use the tokens as
specified. Picking a colour by eye is how it stops holding.

## Contrast

Verified text pairs include `text.primary` 14.55:1, `text.secondary` 6.04:1,
`text.link` 7.22:1, `text.on-navigation-muted` 8.41:1 on navy, and every status
fill/text pair between 5.37:1 and 6.07:1.

Two corrections are already baked into v1 and must not be undone:

- **Control borders use `border.interactive` (`#778C9C`, 3.49:1), not `border.default`.**
  `border.default` is 1.26:1 — decorative only, fine for a card edge or a divider where
  the surface change already does the separating, but it fails WCAG 1.4.11 for anything
  the user operates. Every secondary button and every future input takes
  `border.interactive` (D-03).
- **Focus on the sidebar uses `focus.ring-inverse` (`#7FB4E0`, 6.53:1).** The normal
  `focus.ring` is 2.0:1 against navy — effectively invisible, and keyboard navigation
  starts at the sidebar, so an invisible ring on the first element devalues the rest of
  the keyboard support (D-04).

## Colour is never the only carrier

Every semantic fill ships with a text label: «По графику», «Есть отставание», «Требует
внимания», «Заблокировано», «Подтверждено частично», «Не предъявлено», «Нет данных». This
matters twice over here — `Delayed` and `Attention` are deliberately the same amber, so
without the label they are genuinely indistinguishable, not merely hard to tell apart.

## Keyboard

- Table rows open on `Enter`; `Tab` moves between interactive rows.
- Buttons activate on `Enter` and `Space` — which comes free with a real `<button>`, and
  is a reason to use one rather than a clickable `div`.
- Overlay closes on `Escape` and on its own button, traps focus while open, and returns
  focus to the element that opened it.
- Focus is always visible. Never remove the outline without replacing it with the ring.

## Semantics

Use the element that already has the behaviour: `<button>` for actions, `<a>`/router
`Link` for navigation, `<table>` for tabular data, `<h1>` once per screen. Status text
belongs in the accessible name, not only in a colour class. The document is `lang="ru"`.

## Empty and zero

`0 м²` on floor 2 is a real measured zero and is announced as zero. `—` means nothing was
submitted. A skeleton or an empty state must not collapse into `0%`, because a screen
reader would then report a confident figure the system does not actually have.

## Before calling a component done

Tab to it, operate it from the keyboard only, confirm the ring is visible against its own
background, confirm every colour-coded state also reads as text, and confirm no value was
invented to fill a gap.
