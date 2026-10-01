# Object team UX — recommendations

Scope: how O01 (read-only) and a future team view present people attached to an object. No schema, role or permission change here.

## Principles
1. **Team is a property of the object, not of the manager.** The UI must never assume "manager changed ⇒ team removed".
   A new manager may inherit the existing team; the default presentation of a manager change leaves the team intact.
2. **Assignment is a relation with its own life** (person ↔ object ↔ responsibility ↔ period). Show it as such.
3. **Responsibilities are explicit labels**, not inferred from role names or system roles.
4. **History is preserved.** Past assignments remain visible as ended, never silently dropped.

## Display
- Team block on O01 (identity area, below details): table «Участник · Ответственность · С даты · Статус».
- Manager is one row flagged «Руководитель проекта»; it is not a container that nests the others.
- Statuses: Активен / Завершён (with end date). Ended rows collapsed under «Завершённые назначения».
- Unassigned responsibility: explicit «Не назначен» (neutral), never an empty cell.
- A responsibility may have several people; show all, ordered by start date.

## Assignment changes (design intent for a future screen)
- Changing the manager is a **single-purpose action** with a clear consequence summary: «Команда объекта сохраняется (N человек)».
- Removing a person from the team is a separate, explicit action with confirmation; it is never a side effect of another change.
- Before commit, show a diff: who is added / ended / unchanged.
- Each change is logged as new history entry (who, when, what).
- Only the current object's team is shown; no cross-object team lists on O01.

## Applies to every lead role
The principle holds for any lead on an object — РП, СК, СДО, начальник ПТО. Example: when a начальник ПТО leaves, the new one may keep the existing
engineers, replace some of them, or take the object over with the current team. The UI offers these as explicit choices and never defaults to clearing the team.

## Out of scope / DPAR
- **DPAR T1:** the parallel backend stream reports **PBX-3A Object Team Foundation** and **OBJ-1 Object onboarding** as implemented, but they are not on this frontend baseline. T1 must be reconciled against what PBX-3A actually provides before any team UI is built; do not assume its shape. Original proposal: a persisted object-team/assignment model with periods and responsibilities (the current API exposes only `projectManagerId` and a `responsibleUserId` per work).
- **DPAR T2:** which roles may view/edit team assignments (permissions review).
Until approved, the UI may show only data already in the API and must not imply a team model exists.
