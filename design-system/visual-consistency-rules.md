# Visual consistency rules

- **Tokens only:** primitive `--cc-p-*` never in components; use semantic/component tokens; no raw hex/px.
- **Typography:** the 16-class `cc-type-*` scale only; `display` once per screen (O01 readiness); tabular figures for numbers; meta text is a `<span>`, never `<small>`.
- **Status vocabulary (5):** OnTrack · Delayed · Attention · Blocked · Neutral. No additional levels (no invented risk scale). Delayed and Attention intentionally share amber.
- **Density:** dense cockpit layout (target density ≈ 8/10, variance 2, motion 2); no hero sections, no decorative cards.
- **Alignment:** numeric columns right-aligned/tabular; labels left; consistent row heights from table tokens.
- **Numbers:** `%` for percentages; quantities via formatters in view-models; date format consistent (DD.MM.YYYY).
- **Terminology:** accepted Russian terms unchanged: Физическая готовность СМР, Подтверждение СК, ИД, СДО, Работа, Объект. Do not rename or synonym-swap.
- **Surfaces:** flat; border separation; shadow only for overlays; selected state via `background.selected`.
- **Responsive:** see `frontend-handoff.md`; same content hierarchy at every width.
- **Consistency of states:** every list/table implements Default/Loading/Empty/Error the same way.
