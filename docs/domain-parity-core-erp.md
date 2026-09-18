# Domain Parity — Core vs ERP, Этап 1.5

Сравнение предметной модели `construction-erp-mvp` (Prisma) и `construction-core`
(raw SQL). Domain parity **не означает** совпадение таблиц 1:1 — разные
структуры хранения допустимы (Core активно использует "вычислить на лету"
там, где ERP материализует поле в БД). Цель — проверить **полноту** предметной
модели, не тождественность схем. Ни одна таблица/колонка в этой задаче не
добавлялась и не менялась — Этап 1.5 только документирует.

## Источник истины для списка сущностей

Список ниже получен **автоматически**, полным перечислением всех блоков
`model` в `reference/construction-erp-mvp/apps/backend/prisma/schema.prisma`
командой:

```
grep -n "^model " apps/backend/prisma/schema.prisma
```

Результат (29 моделей, в порядке появления в файле) — единственный источник
истины для этого этапа, ничего не добавлено и не переставлено вручную:

```
Tenant, BitrixInstallation, User, RiskSettings, ConstructionObject, Contractor,
ObjectContractor, WorkCategory, WorkType, ObjectWork, WorkDependency,
WorkProgress, ConstructionInspection, InspectionIssue, InspectionPhoto,
Material, MaterialBatch, MaterialDocument, WorkMaterial, ExecutiveDocument,
ExecutiveDocumentPackage, ExecutiveDocumentPackageItem, PtoTransfer, SdoCase,
FinancialClosing, Attachment, AuditLog, Notification, DictionaryItem
```

Роль пользователя (`User.role`) в обеих системах — поле, а не отдельная
таблица (учтено ниже, строка `User`).

## Стэш `359b97c` — закрыт

См. закрытие в `docs/core-2.0-regression-map.md` — применён коммитом `2fef5ca`,
вошедшим в `main`, production-поведение не менялось.

---

## Таблица соответствия

| Entity | ERP | Core | Gap | Решение |
|---|---|---|---|---|
| Tenant | `tenants`-эквивалент, `portal`/`memberId` unique | `tenants` (`portal`,`member_id` unique) | нет значимого разрыва | не требуется |
| BitrixInstallation | `status` (ACTIVE/UNINSTALLED/TOKEN_INVALID), `scope`, `installedByBitrixId`, `encryptedApplicationToken` | `bitrix_installations`: нет `status`/`scope`/`installedByBitrixId`; `encrypted_application_token` есть (`003_bitrix_application_token.sql`) | Core не отслеживает жизненный цикл установки (деинсталляция/невалидный токен) как явный статус | Не реализовывать: реальная Bitrix24-интеграция вне scope этой задачи ("RealBitrixAdapter только в текущем состоянии", тестовый портал не подключается). Зафиксировать как Core 2.0 Phase 2, если/когда появится реальная интеграция |
| User | `role: Role` — поле, не таблица; `email`, `departmentId`, `departmentName` | `role text` — поле (совпадает с ERP); `email`, `department_id` есть, `department_name` — нет; **дополнительно** `contractor_id` (которого нет в ERP User) | Незначительный: нет `departmentName`. Core добавляет `contractor_id` для прямой привязки CONTRACTOR_VIEWER к организации (в ERP это не смоделировано на User напрямую) | Не менять схему из-за одного текстового поля; Core-добавление `contractor_id` — осознанное расширение, не дефект |
| RiskSettings | `greenVarianceThreshold`/`yellowVarianceThreshold`, `escalateToTechDirectorAfterDays`(7)/`escalateToGeneralDirectorAfterDays`(14), `staleProgressAfterDays`(10) | `yellow_variance`/`red_variance`, `escalate_technical_days`(3)/`escalate_director_days`(7), `stale_days`(7); **плюс** `pto_days`, `sdo_days` (которых нет в ERP RiskSettings) | Значения порогов расходятся (уже в decision log, Этап 2 п.1-2); Core добавляет `pto_days`/`sdo_days` для PTO/SDO backlog, которых как настроечных полей у ERP нет | Значения — решение Этапа 2. Дополнительные поля Core — не гэп, а расширение, оставить |
| ConstructionObject | `healthReasons Json?` — персистентные причины статуса объекта; статусы включают `AT_RISK`/`DELAYED`/`SUSPENDED` | `objects` без колонки причин; здоровье считается на лету (`ObjectHealthService`), а человекочитаемые причины формируются **на уровне дашборда** (`ReadService.attentionRequired`), не персистентно на объекте; статусы `AT_RISK`/`DELAYED`/`SUSPENDED` в Core не используются | Функционально близкий эквивалент существует (attentionRequired), но не привязан 1:1 к объекту и не персистентен — при прямом запросе одного объекта вне дашборда причины недоступны | Не менять схему в рамках этой задачи (запрещено). Если персистентные `healthReasons` понадобятся — Core 2.0 Phase 2 |
| Contractor | `status: ContractorStatus` enum (ACTIVE/SUSPENDED/BLOCKLISTED) | `status text DEFAULT 'ACTIVE'`, без CHECK-ограничения на допустимые значения | Незначительный: Core не валидирует значения `status` на уровне БД | Низкий приоритет, не требует решения сейчас |
| ObjectContractor | `role` (генподрядчик/субподрядчик/поставщик) | `object_contractors` без `role`-текста; назначение только при создании объекта, снятие невозможно | Уже зафиксировано в Этапе 1 (regression map, раздел 1) как MISSING_BEHAVIOR — не создаю здесь новое/отдельное решение, ссылаюсь на ту же фиксацию: Core 2.0 Phase 2 | см. `docs/core-2.0-regression-map.md`, раздел 1 |
| WorkCategory | иерархия `parentId`/`children` | `work_categories.parent_id` — самоссылка есть | нет значимого разрыва | не требуется |
| WorkType | `requiresInspection`/`requiresExecutiveDocs`/`requiresMaterials` | `work_types` — те же три флага | нет разрыва | не требуется |
| ObjectWork | персистентные `progressPercent`, `scheduleStatus`, `varianceP`, `delayDays`, **и funnel-колонки `acceptedQuantity`, `executiveDocsReadyQuantity`, `transferredToSdoQuantity`** | `works` — без этих колонок; `progressPercent`/`scheduleStatus`/variance считаются на лету (`ReadService.snapshot`); funnel (стадии 1-5) считается на лету через живые JOIN'ы к inspections/packages/sdo/closings, а не через персистентные quantity-поля на работе | Разная стратегия хранения (ERP: денормализовано на работе, Core: вычисляется запросом) — по регламенту допустимо, если результат эквивалентен. Отдельно: у Core в принципе нет способа узнать "сколько именно из отчитанного объёма официально принято", см. следующую строку (`ConstructionInspection`) — это НЕ то же самое, что отсутствие вычисляемых полей | Хранение — не гэп (разрешено договором задачи). См. решение по `acceptedQuantity` ниже |
| WorkDependency | `requiresAcceptance`, один `dependencyType` (FINISH_TO_START) | `work_dependencies` — то же, плюс `requires_document` (используется в `WorkTransitionPolicy`, у ERP такого явного поля на зависимости нет, но есть `predecessorMissingRequiredDocument` в бизнес-правиле — семантически близко) | нет значимого разрыва | не требуется |
| WorkProgress | append-only по конвенции (нет explicit DB-триггера в приведённых источниках) | `work_progress` + DB-триггер `progress_immutable`, физически запрещающий UPDATE/DELETE | Core строже ERP (хорошо) | не гэп, не требует решения |
| ConstructionInspection | `acceptedQuantity Decimal?` — сколько именно объёма официально принято СК (может быть меньше отчитанного/предъявленного — частичная приёмка) | `inspections` — **нет** колонки принятого объёма вообще; ни `inspections`, ни `works` не хранят "сколько принято" отдельно от "сколько отчитано". `POST /inspections/:id/accept` не принимает `acceptedQuantity` в теле запроса вовсе (`validation.ts` не определяет такое поле) | **Реальный домен-геп, не замеченный на Этапе 1** (там тестировался только сценарий полного совпадения план=факт=принято): Core не может выразить частичную приёмку — RBAC/workflow предполагают, что принимается ровно весь предъявленный объём | **Не реализовывать в рамках этой задачи** (изменение схемы `inspections`/`works` запрещено на Этапе 1.5). Зафиксировать как **MISSING_BEHAVIOR → Core 2.0 Phase 2**, требует отдельного решения пользователя (нужна ли частичная приёмка в Core 2.0) |
| InspectionIssue | `severity: MINOR \| CRITICAL` | `issues.severity`: `LOW/MEDIUM/HIGH/CRITICAL` (4 уровня) | Уже зафиксировано в Этапе 1 (regression map, раздел 5) как business-rule divergence — не создаю новое решение здесь | см. `docs/core-2.0-regression-map.md`, раздел 5 / Этап 2 п.5 |
| InspectionPhoto | `fileProvider`+`externalFileId` (Bitrix24.Disk/local, без байтов в БД) | `inspection_photos.attachment_id` → `attachments.content bytea` (байты хранятся в Postgres) | Разная стратегия хранения файлов, обе валидны | не гэп |
| Material | `brand`, `type` | `materials` — нет `brand`/`type` | Незначительный, поля не используются в бизнес-логике ни ERP, ни Core | низкий приоритет, не требует решения сейчас |
| MaterialBatch | — | `material_batches` | нет разрыва | не требуется |
| MaterialDocument | `type: MaterialDocumentType` enum | `material_documents.type text`, без CHECK-ограничения | незначительный | низкий приоритет |
| WorkMaterial | — | `work_materials` | нет разрыва | не требуется |
| ExecutiveDocument | `status: ExecutiveDocumentStatus` (8 значений) | `executive_documents.status` CHECK — те же 8 значений 1:1 | нет разрыва (Core code сейчас использует только DRAFT/APPROVED из восьми — остальные валидны, но не задействованы) | не требуется |
| ExecutiveDocumentPackage | `objectWorkId String?` (опционально — пакет может покрывать несколько работ через документы) | `executive_packages.object_work_id uuid NOT NULL` (пакет = ровно одна работа) | Уже зафиксировано в Этапе 1 (regression map, раздел 7) как MISSING_BEHAVIOR (SdoCase 1:N) — **не создаю здесь отдельное/потенциально иное решение**, использую ту же фиксацию | см. `docs/core-2.0-regression-map.md`, раздел 7: **Core 2.0 Phase 2**, требует изменения схемы |
| ExecutiveDocumentPackageItem | — | `package_documents` | нет разрыва | не требуется |
| PtoTransfer | — | `pto_transfers` | нет разрыва | не требуется |
| SdoCase | `executiveDocumentPackageId String?` + составной `@@unique([executiveDocumentPackageId, objectWorkId])` (поддержка 1:N) | `sdo_cases`: `executive_document_package_id NOT NULL`, `UNIQUE(tenant_id, executive_document_package_id)` **и отдельно** `UNIQUE(tenant_id, object_work_id)` — строго 1:1:1 | Прямое следствие той же архитектурной разницы (пакет=одна работа) — та же фиксация, что и по `ExecutiveDocumentPackage` выше | см. `docs/core-2.0-regression-map.md`, раздел 7 |
| FinancialClosing | нет поля идемпотентности в модели | `financial_closings.idempotency_key uuid UNIQUE` — Core-добавление | Core богаче ERP здесь | не гэп |
| Attachment | полиморфный (`entityType`+`entityId`), файл — по ссылке (Bitrix24.Disk/local), без байтов в БД | `attachments.content bytea`, привязка через прямые FK от конкретных сущностей (`material_documents.file_id`, `executive_documents.file_id`, `inspection_photos.attachment_id`), не полиморфная | Разная стратегия хранения и связывания, обе покрывают потребность | не гэп |
| AuditLog | Неизменяемость обеспечена только отсутствием PATCH/DELETE в контроллере (permissions.md) | `audit_logs` + DB-триггер `immutable_history()`, физически запрещающий UPDATE/DELETE | Core строже (защита на уровне БД, а не только API) | не гэп, не требует решения |
| Notification | `type`, `body`, `sentToBitrix` | `notifications` — нет `type`/`body`/`sentToBitrix`; `dedupe_key` unique per tenant — совпадает с ERP `dedupKey` | Незначительный: Core не различает тип уведомления отдельным полем и не отслеживает отправку в Bitrix (согласуется с тем, что реальная Bitrix-интеграция вне scope) | низкий приоритет, не требует решения сейчас |
| DictionaryItem | `category`/`code`/`label` — универсальный справочник (напр. `ISSUE_SEVERITY`, `MATERIAL_TYPE`) | `dictionary_items` таблица **существует в схеме, но не используется ни одним контроллером/сервисом** (проверено `grep` по `apps/backend/src` — только в whitelist `db.ts` и генераторе `scripts/schema.py`); фактические справочники Core (`work_categories`/`work_types`) — отдельные предметные таблицы, не через `dictionary_items` | `dictionary_items` — мёртвая таблица в Core: создана, но ничем не наполняется и нигде не читается | Не удалять и не менять в рамках этой задачи (изменение схемы запрещено). Зафиксировать для отдельного решения: либо начать использовать (напр. для `ISSUE_SEVERITY`-справочника), либо оставить как задел на Phase 2 |

---

## Сущности Core, которых нет в модели ERP (для полноты, не входят в основную таблицу — список 29 моделей ERP уже покрыт выше)

Domain parity — двусторонняя проверка полноты; ниже — то, что Core добавляет
сверх модели ERP (не гэп, а расширение; перечислено для прозрачности, схема не
менялась):

- `work_templates` — есть в схеме, **не используется** нигде в коде Core (аналогично `dictionary_items`, мёртвая таблица).
- `monthly_plans` — используется (`importer.ts` пишет, `read-service.ts` читает для `dashboard.plannedClosing`); в ERP-схеме такой сущности нет вовсе.
- `domain_events` — используется (`security.ts audit()`, событийная рассылка уведомлений); в ERP-схеме нет отдельной таблицы событий (уведомления там создаются иначе).
- `sessions` — Core использует собственные сессии с токеном (`security.ts session()`); ERP полагается на Bitrix24-контекст (`X-Tenant-Id`/`X-Bitrix-User-Id` в demo-режиме) без отдельной таблицы сессий.
- `import_reports` — Excel-импорт объектов (`importer.ts`) — функциональность, которой в ERP reference нет вовсе.

**Наблюдение**: `work_templates` и `dictionary_items` — обе мёртвые таблицы в
Core (существуют в схеме, не используются кодом). Изменение схемы запрещено
этой задачей, поэтому они не удаляются и не документируются как "дефект" —
только фиксируются как факт для возможного решения в будущем.

---

## Сводка

**MISSING_BEHAVIOR, требующие отдельного решения пользователя** (новые, не
дублирующие Этап 1, кроме явно помеченных ссылок):

1. **Частичная приёмка объёма** (`acceptedQuantity` на инспекции/работе) —
   Core не может выразить "принято меньше, чем отчитано"; ERP может. Это
   единственный содержательный **новый** domain-геп, выявленный на Этапе 1.5,
   которого не было в Этапе 1 (там проверялись только сценарии полного
   совпадения план=факт=принято). Решение — пользователя, изменение схемы не
   производилось.
2. `dictionary_items` и `work_templates` — мёртвые таблицы, задел на будущее
   или кандидаты на явное решение "не использовать" — не гэп в строгом
   смысле, но стоит зафиксировать сознательно.

**Ссылки на уже принятые в Этапе 1 фиксации** (не пересматриваются заново,
по вашему указанию):

3. Управление подрядчиками объекта после создания — `docs/core-2.0-regression-map.md`, раздел 1.
4. Многоработные пакеты ИД / SdoCase 1:N — `docs/core-2.0-regression-map.md`, раздел 7 (**Core 2.0 Phase 2**, решение не пересматривается).
5. Severity-модель замечаний (2 vs 4 уровня, правило блокировки приёмки) — `docs/core-2.0-regression-map.md`, раздел 5 / Этап 2 п.5.
6. Значения RiskSettings (RED escalation, staleDays) — Этап 2 п.1-2.

**Не гэпы** (разная, но эквивалентная по полноте стратегия хранения,
допустимая по регламенту задачи): персистентные vs вычисляемые
progress/schedule-поля на работе, полиморфные vs прямые FK-вложения файлов,
API-уровень vs DB-уровень неизменяемости аудита, отсутствие/наличие
идемпотентности как отдельного поля.

Схема БД не менялась. Никакие таблицы не добавлялись.
