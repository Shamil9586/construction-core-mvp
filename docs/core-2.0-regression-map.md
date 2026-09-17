# Core 2.0 — Regression Map (ERP → Core), Этап 1

Сопоставление критических бизнес-сценариев `construction-erp-mvp` (reference,
код не переносился) с фактическим поведением `construction-core`. Источники
ERP: `docs/verification-report-2026-09-16.md`,
`apps/backend/test/critical-path.e2e-spec.ts` (40 сценариев), `docs/business-rules.md`,
`docs/permissions.md` — все из `reference/construction-erp-mvp/`.

Тесты для строк `MISSING_TEST` написаны против HTTP API Core в
`tests/regression-erp-parity.test.ts` (новый файл, 8 сценариев A–H, все зелёные,
без изменений production-кода — только тесты). Ссылки на сценарий даются в
колонке «Тест».

Статусы: `covered` / `partial` / `missing` / `not applicable`.

## ⚠️ Незакрытый stash (не относится к этой задаче)

`stash@{0}` = `359b97c` — anti-flake доработка `tests/browser/workflow.spec.ts`
для более раннего фикса `c4469f8` (Admin/Excel-import state lifting). Решение —
за пользователем, вне scope Core 2.0 hardening.

---

## 1. Объект

| ERP scenario | Core endpoint/process | Status | Type | Тест |
|---|---|---|---|---|
| РП создаёт объект (шаг 1) | `POST /objects` (`ProductionService.createObject`) | covered | — | существующий (workflow.test.ts) |
| РП назначает субподрядчика на объект отдельным вызовом (шаг 1б, `POST /objects/:id/contractors`) | нет отдельного endpoint — `contractorIds` передаются только при создании объекта (`objectDto.contractorIds`, `createObject`) | missing | **MISSING_BEHAVIOR** | — |
| Фильтр объектов по `?contractorId=` (шаг 1б) | `GET /objects` без query-параметров (`ReadService.snapshot`) | missing | **MISSING_BEHAVIOR** | — |
| Tenant isolation при назначении/снятии подрядчика чужим тенантом — 404 (шаг 1в) | N/A, т.к. самого endpoint'а нет | not applicable | — | (следствие строки выше) |
| Снятие подрядчика с объекта, у которого есть работы этого подрядчика — 409 (п.3 integrity-fix) | нет endpoint снятия подрядчика | missing | **MISSING_BEHAVIOR** | — |
| РП может создать объект только для себя (business-rules.md/permissions.md — РП ведёт свой объект) | `ensure(pm.id === a.id, ...)` в `createObject` — уже реализовано | covered (test added) | **MISSING_TEST → закрыт** | сценарий A |
| Tenant isolation чтения объекта (чужой tenant/пользователь) | `objectAccess`/`scoped` — 401/403/404 в зависимости от случая | covered | — | существующий (acceptance.test.ts, workflow.test.ts) |
| `OBJECT_MANAGE_CONTRACTORS` отдельно от `OBJECT_EDIT` (permissions.md) | permission не существует в Core (`packages/domain/index.ts`); `OBJECT_EDIT` присвоен ролям, но нигде не проверяется (`requirePermission(..., OBJECT_EDIT)` не встречается ни в одном контроллере) | missing | **MISSING_BEHAVIOR** (RBAC) — решение по Этапу 2, п.4 | — |

**Вывод по разделу**: создание объекта и его атомарная привязка к подрядчикам —
covered. Управление подрядчиками объекта **после** создания — целиком
отсутствующая возможность в Core (архитектурная разница: ERP допускает
пере-назначение, Core — только назначение в момент создания). Это
`MISSING_BEHAVIOR`, реализация не производилась — фиксируется как
**Core 2.0 Phase 2**.

## 2. Работы

| ERP scenario | Core endpoint/process | Status | Type | Тест |
|---|---|---|---|---|
| Создание работы (шаг 2) | `POST /works` (`createWork`) | covered | — | существующий |
| Работа с `contractorId`, не назначенным на объект, — 400 (шаг 2в, ERP-хардненинг) | Core реализует ТОТ ЖЕ инвариант (`ensure(... 'Субподрядчик не назначен на объект')`) — уже был в коде, теста не было | covered (test added) | **MISSING_TEST → закрыт** | сценарий B |
| Технологическая зависимость и блокировка старта (шаги 2б, 8, 12) | `POST /work-dependencies`, `GET /works/:id/transition`, `POST /works/:id/start` (`WorkTransitionPolicy`) | covered | — | существующий |
| Циклическая зависимость | Core-специфичная защита (рекурсивный CTE в `dependency()`), в ERP critical-path не проверяется вовсе | covered (test added) | **MISSING_TEST → закрыт** (Core superset, не из ERP) | сценарий C |
| Зависимость нельзя добавить к уже начатой работе | Core-специфичная проверка (`actualQuantity===0 && status==='PLANNED'`), в ERP critical-path не проверяется | covered (test added) | **MISSING_TEST → закрыт** (Core superset) | сценарий D |

**Вывод**: раздел «Работы» полностью покрыт, включая инварианты, которых нет в
явном виде в ERP reference (Core здесь строже).

## 3. План/факт

| ERP scenario | Core endpoint/process | Status | Type | Тест |
|---|---|---|---|---|
| Процент = `actual/planned*100`, не вводится вручную (business-rules.md §1) | `ProgressCalculationService.calculate` | covered | — | существующий (domain.test.ts, workflow.test.ts) |
| `isOverperformed = rawProgressPercent > 100` — явный сигнал перевыполнения | Core клампит `progressPercent` в `[0,100]` (`Decimal.min(100, Decimal.max(0,...))`) и **не хранит/не возвращает** необрезанное значение или флаг перевыполнения | missing | **MISSING_BEHAVIOR** — решение по Этапу 2, п.3 | — |
| План/факт светофор, пороги (business-rules.md §2) | `ScheduleStatusService` (3 статуса GREEN/YELLOW/RED + GRAY при отсутствии данных, у ERP — 4 статуса DONE/ON_TRACK/BEHIND/CRITICAL) | covered (эквивалентно по существу, различается только именование состояний) | not applicable (архитектурная/номенклатурная разница, не поведенческий gap) | существующий |
| Внесение факта заблокировано после предъявления на СК, до отклонения (нет прямого аналога в ERP critical-path, но это тот же принцип «факт нельзя тихо поменять во время проверки») | `ensure(!inspection exists ...)` в `progress()` — уже реализовано, не было теста | covered (test added) | **MISSING_TEST → закрыт** | сценарий E |

**Вывод**: расчёт процента и светофора — covered. Отсутствие явного сигнала
`isOverperformed` — реальный, но небольшой домен-геп, вынесен в decision log
(Этап 2).

## 4. Строительный контроль

| ERP scenario | Core endpoint/process | Status | Type | Тест |
|---|---|---|---|---|
| Предъявление на СК (шаг 5), WAITING→ISSUES_FOUND→REINSPECTION→ACCEPTED/REJECTED (business-rules.md §5) | `POST /inspections` (через `requestInspection`), `inspectionAction` | covered | — | существующий |
| RBAC: РП не может принять работу СК (шаг 6) | `requirePermission(a, INSPECTION_ACCEPT)` | covered | — | существующий |
| Обязательная фотофиксация перед приёмкой | Core требует хотя бы одно `inspection_photos` перед `accept` — доп. инвариант, которого нет в ERP critical-path | covered | not applicable (Core superset) | существующий (workflow.test.ts) |
| Атомарная приёмка (транзакция, статус+audit+recalculation) (business-rules.md §5) | `inspectionAction('accept')` в `transaction()` | covered | — | существующий |

**Вывод**: раздел полностью covered, Core местами строже ERP (обязательное фото).

## 5. Замечания

| ERP scenario | Core endpoint/process | Status | Type | Тест |
|---|---|---|---|---|
| Замечание MINOR\|CRITICAL, только открытое CRITICAL блокирует приёмку целиком (business-rules.md §5) | Core: 4 уровня severity (LOW/MEDIUM/HIGH/CRITICAL, `issues.severity` CHECK), но `inspectionAction('accept')` блокируется **любым** незакрытым замечанием независимо от severity | **partial** — реализовано, но с иным правилом, чем в ERP | **business-rule divergence**, не MISSING_TEST/MISSING_BEHAVIOR в чистом виде — решение по Этапу 2, п.5 (READY_FOR_VERIFICATION) | сценарий F (закрепляет ТЕКУЩЕЕ поведение Core) |
| `READY_FOR_VERIFICATION` — статус «ожидает проверки устранения», в ERP явно **не блокирует** финальную приёмку (verification-report, «Defects found... #2») | В Core любой статус `<> 'CLOSED'` (включая `READY_FOR_VERIFICATION`) **блокирует** `accept` до `verify()` | **partial** (обратное поведение относительно ERP) | требует явного решения, Этап 2 п.5 | сценарий F |
| Технологическая блокировка учитывает только `CRITICAL`-замечания (`read-service.ts` blockers, `severity==='CRITICAL'`) | Согласуется с ERP на уровне разблокировки следующей работы, но **не согласуется** с правилом приёмки той же работы (см. выше) — то есть в Core критичность используется непоследовательно между двумя разными проверками | partial | наблюдение к decision log, Этап 2 п.5 | сценарий F косвенно демонстрирует |

**Вывод**: это единственный раздел с содержательным расхождением бизнес-правила
(не архитектурным, а именно логическим). Зафиксировано тестом (сценарий F),
закрепляющим ФАКТИЧЕСКОЕ поведение Core, не переписывающим его. Решение —
Этап 2.

## 6. Приёмка

| ERP scenario | Core endpoint/process | Status | Type | Тест |
|---|---|---|---|---|
| Приёмка после устранения замечания (шаги 10-11) | `issueAction('resolve')` → `inspectionAction('accept')` | covered | — | существующий |
| Идемпотентность повторной приёмки (409 при устаревшей версии) | `checkVersion` на `inspections` | covered | — | существующий (workflow.test.ts) |
| Разблокировка зависимой работы после приёмки (шаг 12) | `transition()` пересчитывается на лету через `GET /works/:id/transition` | covered | — | существующий |

**Вывод**: полностью covered.

## 7. Исполнительная документация (ИД)

| ERP scenario | Core endpoint/process | Status | Type | Тест |
|---|---|---|---|---|
| Документ стартует со статуса DRAFT, подтверждение ПТО → APPROVED (business-rules.md §6) | `createDocument`/`approveDocument` | covered | — | существующий |
| Повторное подтверждение уже подтверждённого документа | `ensure(doc.status !== 'APPROVED', ...)` — уже реализовано, теста не было | covered (test added) | **MISSING_TEST → закрыт** | сценарий G |
| Пакет ИД по нескольким работам одного объекта → несколько `SdoCase` (п.1 integrity-fix, SdoCase 1:N) | Core: `executive_packages.object_work_id` — пакет привязан **строго к одной работе** (1 пакет = 1 работа), многоработных пакетов не существует в принципе | not applicable / архитектурная разница | **MISSING_BEHAVIOR** (батчинг по нескольким работам в одном пакете) — Core 2.0 Phase 2, требует изменения схемы (запрещено в этой задаче) | — |
| tenant/object-целостность документа и пакета (п.2а/2б/2в integrity-fix — objectWorkId с чужого объекта/tenant) | Структурно невозможно в Core: `createDocument` берёт `objectId`/`objectWorkId` из уже привязанного `packageId` (`p.objectWorkId`, `p.objectId`), а не принимает их отдельными полями от клиента — тот класс ошибки, что чинили в ERP, в Core не может возникнуть по дизайну | not applicable (структурно исключено, не проверка, а архитектура) | — | — |

**Вывод**: раздел covered в объёме, применимом к архитектуре Core. Многоработные
пакеты — не воспроизводимая в Core 2.0 без изменения схемы возможность,
зафиксирована как Phase 2.

## 8. ПТО

| ERP scenario | Core endpoint/process | Status | Type | Тест |
|---|---|---|---|---|
| `PtoPackageValidationService` — accepted, документы APPROVED, АОСР обязателен, материалы (business-rules.md §6) | `packageValidation()` (идентичная логика) | covered | — | существующий + domain.test.ts |
| Атомарность/идемпотентность передачи в СДО, повторный transfer отклонён (шаг 17б) | `packageAction('transfer-sdo')`, `ensure(p.status !== 'TRANSFERRED_TO_SDO', ...)` | covered | — | существующий (workflow.test.ts, 409 due to version+status) |

**Вывод**: covered.

## 9. СДО

| ERP scenario | Core endpoint/process | Status | Type | Тест |
|---|---|---|---|---|
| СДО осмечивает дело вручную, вне системы (business-rules.md §7) | `calculateSdo()` | covered | — | существующий |
| Финансовое закрытие одной суммой = расчётной стоимости (шаг 20) | `close()` | covered | — | существующий |
| Частичное закрытие в несколько траншей (READY_TO_CLOSE → CLOSED) — Core-специфичное расширение, отсутствует в ERP critical-path | `close()` — сумма закрытий сравнивается с `acceptedClosingValue`, статус переключается между `READY_TO_CLOSE`/`CLOSED` | covered (test added) | **MISSING_TEST → закрыт** (Core superset) | сценарий H |

**Вывод**: covered, включая ранее непротестированную функциональность, которой
нет в ERP reference.

## 10. Финансовое закрытие / Dashboard

| ERP scenario | Core endpoint/process | Status | Type | Тест |
|---|---|---|---|---|
| «Потенциал закрытия» — воронка по стадиям (business-rules.md §8) | `PotentialClosingService` (5 бакетов: notAccepted/pto/ready/sdo/calculated ≈ 5 стадий ERP) | covered | — | существующий (domain.test.ts) |
| Идемпотентность закрытия по `idempotencyKey` | `close()` | covered | — | существующий |
| Превышение суммы закрытия отклоняется | `ensure(sum.add(amount).lte(acceptedClosingValue), 'Сумма превышает доступное закрытие')` | covered | — | существующий (acceptance.test.ts) |
| Аудит (business-rules.md §11) — append-only, покрывает весь путь | `audit_logs` + trigger `immutable_history()` | covered | — | существующий |
| Эскалация по дням в RED (business-rules.md §9) | `EscalationService` — структура эквивалентна, **значения порогов отличаются** (см. Этап 2, п.1) | covered структурно / **значения — решение Этапа 2** | не MISSING, а decision | существующий (domain.test.ts) |

**Вывод**: covered; конкретные значения порогов (RED escalation, staleDays) —
предмет Этапа 2, не Этапа 1.

---

## Сводка

| Категория | covered | partial | missing (MISSING_BEHAVIOR) | Тесты добавлены |
|---|---:|---:|---:|---:|
| 1. Объект | 3 | 0 | 4 | 1 (сценарий A) |
| 2. Работы | 2 | 0 | 0 | 2 (сценарии C, D) + 1 (B) |
| 3. План/факт | 2 | 0 | 1 | 1 (сценарий E) |
| 4. СК | 3 | 0 | 0 | 0 |
| 5. Замечания | 0 | 3 | 0 | 1 (сценарий F) |
| 6. Приёмка | 3 | 0 | 0 | 0 |
| 7. ИД | 1 | 0 | 1 (+1 not applicable) | 1 (сценарий G) |
| 8. ПТО | 2 | 0 | 0 | 0 |
| 9. СДО | 2 | 0 | 0 | 1 (сценарий H) |
| 10. Финансы/Dashboard | 4 | 1 | 0 | 0 |

**MISSING_BEHAVIOR, зафиксированные как Core 2.0 Phase 2** (не реализовывались,
требуют отдельного решения пользователя):

1. Управление подрядчиками объекта после создания (assign/remove +
   `?contractorId=` фильтр) — раздел 1.
2. `OBJECT_MANAGE_CONTRACTORS` как отдельный permission — раздел 1 / Этап 2 п.4.
3. Явный сигнал `isOverperformed` — раздел 3 / Этап 2 п.3.
4. Многоработные пакеты ИД (SdoCase 1:N) — раздел 7, требует изменения схемы,
   запрещённого в этой задаче.

**Business-rule divergence, требующая решения (не implementation gap)**:

5. Правило блокировки приёмки открытым замечанием — Core блокирует любой
   severity и любой незакрытый статус (включая `READY_FOR_VERIFICATION`), ERP —
   только `CRITICAL` в статусах OPEN/IN_PROGRESS — раздел 5 / Этап 2 п.5.

Все прочие проверенные сценарии — **covered**, либо изначально (существующие
тесты Core), либо после добавления `tests/regression-erp-parity.test.ts`
(8 сценариев A–H, 0 изменений production-кода).
