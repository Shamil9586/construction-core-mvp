# Core 2.1 — Final Correction Gate (corrective pass on `feature/core-2.1`)

Каждое решение ниже принято **до** изменения кода, где решение требовалось
(порядок: finding → решение → изменение → тест), тем же порядком, что
`docs/decision-log-core-2.0.md`. Ветка на момент старта этого прохода:
`feature/core-2.1` @ `1e51f27` (safety branch:
`safety/core-2.1-before-claude-limit`). Все корректирующие коммиты —
`1e51f27..HEAD` на этой ветке; хэши указаны ниже для трассируемости.

Контекст прохода: security-guidance review (file:line + call path,
до изменения кода — см. п.0) обнаружил, что два из исходных
corrective items противоречат уже закоммиченному и протестированному
поведению той же ветки (`a8ef5f7`). Оба случая эскалированы владельцу
продукта в этой сессии до изменения кода; решения ниже отражают его выбор,
не решение реализации "по умолчанию".

---

## 0. Security-guidance review — что проверено

Прочитаны end-to-end: `objects.controller.ts`, `contractors.controller.ts`,
`service.ts`, `security.ts`, `validation.ts`, `read-service.ts`, `db.ts`,
`main.ts`, `infra/004_object_contractor_history.sql`,
`tests/core-2.1-contractors.test.ts`. Каждый corrective item ниже
подтверждён конкретным file:line и call path до какого-либо изменения кода.

---

## 1. Duplicate active assign → 409

**Было**: `service.ts` `assignContractor` — `ensure(!row, ...)` → 400.
**Finding**: `docs/core-2.1-architecture-plan.md:94` (утверждённый план) уже
явно специфицирует 409 для этого случая — расхождение было отклонением
реализации от собственного утверждённого плана, а не намеренным
редизайном. Конкурентный дубль-assign уже корректно возвращал 409 через
partial unique index (`infra/004`) + global 23505→409 mapping
(`main.ts:30`) — только последовательный путь был 400.

**Решение**: 409 (`ConflictException`), последовательный и конкурентный
путь теперь согласованы.

**Изменение кода**: `service.ts` `assignContractor`. **Тест**:
`tests/core-2.1-contractors.test.ts` (assert 409 + updated comment).
**Коммит**: `5f54030`.

---

## 2. Remove-guard: строго `status IN ('PLANNED','ACTIVE')`

**Было**: `status<>'COMPLETED'` — исключающий blacklist над `works.status`,
у которой нет DB CHECK constraint (в отличие от inspections/issues/
executive_packages/sdo_cases — все имеют явный CHECK, `infra/002`).

**Решение**: явный allowlist. Поведенчески эквивалентно сегодня (PLANNED/
ACTIVE/COMPLETED — единственные статусы, которые пишет приложение), но
не блокирует снятие подрядчика молча, если в будущем появится
неактивный терминальный статус (например, CANCELLED).

**Изменение кода**: `service.ts` `removeContractor`. **Тест**: без
изменений (эквивалентное поведение для существующих 3 статусов).
**Коммит**: `1e2f2ad`.

---

## 3. Partial Object Edit + `projectManagerId` presence → 403 (owner decision)

**Было**: `objectEditDto` требовал все поля кроме `customerName` при каждом
edit (не partial). `editObject` проверял permission на смену РП только
при фактическом изменении значения (`d.projectManagerId !== o.projectManagerId`)
→ `ensure()` → 400. `tests/core-2.1-contractors.test.ts:171-174` (в составе
того же `a8ef5f7`) явно тестировал именно это поведение (400).

**Finding, эскалирован владельцу продукта**: смена на presence-based 403
(отклонение по факту наличия ключа `projectManagerId` в payload, а не
только по факту изменения значения) — прямое противоречие уже
запротестированному поведению той же ветки. Требует также правки
фронтенда (`main.tsx` слал `projectManagerId` неизменным даже для РП).

**Решение владельца продукта (в этой сессии)**: presence-based 403,
подтверждено явно. Не расценивается как новое решение реализации.

**Изменение кода**: `validation.ts` (`objectEditDto` — все поля кроме
`version` теперь `.optional()`, partial-семантика: отсутствующее поле
не изменяется, а не обнуляется), `service.ts` `editObject` (presence-check
→ `ForbiddenException`, merge пропущенных полей с текущей строкой,
`plannedFinishDate` валидируется против `o.startDate` с учётом merge),
`main.tsx` (убран фиксированный `projectManagerId` extra-param для
не-TECHNICAL_DIRECTOR edit). **Тест**: переписан под partial-семантику +
новый explicit-403 case (presence при неизменном значении).
**Коммит**: `f9c906e`.

---

## 4. Единый active-contractor read source

**Finding**: 6 независимых мест повторяли один и тот же предикат
`object_contractors ... WHERE removed_at IS NULL`: `security.ts`
`objectAccess`, `read-service.ts` (×3: CONTRACTOR_VIEWER filter,
`contractorId` filter, bulk `activeAssignments`), `objects.controller.ts`
(`GET .../contractors`), `service.ts` (×3: `assignContractor`,
`removeContractor`, `createWork`). Тот же класс риска, что уже один раз
проявился в баге membership `ContractorPanel` (исправлен в `b1a3764`).

**Решение**: `infra/005_active_contractor_view.sql` — view
`object_contractors_active` (простой single-table filter, без агрегации/
DISTINCT/UNION → "simply updatable", `SELECT ... FOR UPDATE` через неё
блокирует ту же строку `object_contractors`, что и напрямую). Все 6 мест
переведены на чтение через view; записи (`INSERT`/`UPDATE`) остаются на
базовой таблице.

**Изменение кода**: `infra/005_active_contractor_view.sql` (новая
миграция), `security.ts`, `read-service.ts`, `objects.controller.ts`,
`service.ts`. **Тест**: без изменений (поведенчески эквивалентно,
подтверждено полным прогоном). **Коммит**: `3531ff4`.

---

## 5. Concurrency invariant: `createWork` ↔ `removeContractor`

**Finding**: `removeContractor` брал `FOR UPDATE` на строку
`object_contractors_active`; `createWork`'s проверка активного назначения
была обычным (non-locking) `SELECT`. Под READ COMMITTED обычный `SELECT`
не ждёт чужой row lock → гонка: работа могла быть создана для подрядчика
в процессе снятия, оставляя после коммита обеих транзакций работу,
ссылающуюся на подрядчика, уже не привязанного к объекту.

**Решение**: `FOR UPDATE` добавлен к проверке в `createWork` — обе
операции сериализуются на одной строке; проигравшая транзакция
перечитывает post-commit состояние и корректно падает (либо "не
назначен", либо "есть незавершённые работы").

**Изменение кода**: `service.ts` `createWork`. **Тест**: новый
concurrency-regression case в `tests/core-2.1-contractors.test.ts`
(конкурентные `createWork`/`removeContractor` на одном подрядчике,
инвариант проверяется на итоговом состоянии). Явная оговорка в
комментарии теста: `DB_MODE=pglite` сериализует транзакции целиком на
уровне `connect()` (`db.ts` `localPool()`), поэтому тест доказывает
инвариант конечного состояния, но не эксплуатирует настоящую
конкурентную блокировку — это требует прогона с `E2E_DATABASE_URL`
(реальный Postgres). **Коммит**: `1a86dc5`.

---

## 5.5. Remove-guard 409, plan-conformance (не новое scope-решение)

**Finding**: `docs/core-2.1-architecture-plan.md:95` (утверждённый план)
уже документирует active-work guard в `removeContractor` как
"409-guard", но реализация всегда бросала его через `ensure()` → 400;
п.2 этого документа менял только набор блокирующих статусов, не код
ответа.

**Статус**: не новое решение владельца — приведение реализации в
соответствие с уже утверждённым планом и явно зафиксировано как
authoritative в Final Correction Gate (PLANNED/ACTIVE работа блокирует
remove → 409; COMPLETED не блокирует).

**Изменение кода**: `service.ts` `removeContractor` (`ConflictException`
вместо `ensure()`). **Тест**: assert 409 вместо 400.
**Коммит**: `1d2b016`.

---

## Итог

| # | Corrective item | Статус код до | Статус код после | Коммит |
|---|---|---|---|---|
| 1 | Duplicate active assign | 400 | 409 | `5f54030` |
| 2 | Remove-guard status set | 400 (blacklist) | 400 (allowlist) | `1e2f2ad` |
| 3 | Partial edit + PM presence | 400 (value-based) | 403 (presence-based) | `f9c906e` |
| 4 | Unified read source | — (refactor) | — (refactor) | `3531ff4` |
| 5 | createWork↔removeContractor race | unlocked read | `FOR UPDATE` serialized | `1a86dc5` |
| 5.5 | Remove-guard status code | 400 | 409 | `1d2b016` |

Оставшиеся пункты Final Correction Gate (migration gates, browser-flake
baseline proof, final full gates) — верификационные шаги без изменения
production-кода, выполняются после этого документа.
