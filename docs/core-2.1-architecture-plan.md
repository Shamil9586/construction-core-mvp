# Core 2.1 — Architecture Plan (только план, implementation не выполнялся)

Источники: `docs/core-2.0-regression-map.md`, `docs/domain-parity-core-erp.md`,
`docs/decision-log-core-2.0.md`. Scope зафиксирован владельцем продукта после
review этого документа (2026-09-18):

**Core 2.1 = пункты 1+2+3 ниже.** Пункты 4 и 5 отложены в Core 2.2+. Пункты 6 и
7 не трогаются — ни реализация, ни удаление — до отдельного product decision.

Ограничения этого документа: не создавать новые таблицы, не менять
архитектуру (raw `pg` + SQL-миграции + PGlite остаются), не выполнять
implementation. Ниже — план, не код.

---

## 1. Scope Core 2.1

| # | Пункт | Статус |
|---|---|---|
| 1 | Управление подрядчиками объекта после создания (assign/remove + `?contractorId=` фильтр), **с сохранением истории связи** | **В scope Core 2.1** |
| 2 | `OBJECT_MANAGE_CONTRACTORS` permission — отдельный от `OBJECT_EDIT`, только для assign/remove | **В scope Core 2.1** |
| 3 | Object edit endpoint — ограниченный whitelist полей | **В scope Core 2.1** |
| 4 | Частичная приёмка объёма (`acceptedQuantity`) | **Отложено в Core 2.2+** — самый высокий риск регрессии (31 существующий тест неявно предполагает `acceptedQuantity == plannedQuantity`), задевает `PotentialClosingService`/`WorkTransitionPolicy`/dashboard одновременно, нужен отдельный decision-log проход перед реализацией |
| 5 | Многоработные пакеты ИД / SdoCase 1:N | **Отложено в Core 2.2+** — ломающая миграция уникальных индексов (`sdo_one_per_work`, `sdo_cases_unique`), нет доказанного спроса для MVP |
| 6 | `dictionary_items` (мёртвая таблица) | **Не трогать** — ни реализация, ни удаление, до отдельного product decision |
| 7 | `work_templates` (мёртвая таблица) | **Не трогать** — аналогично п.6 |

Рекомендованный порядок внутри scope: **1 → 2 → 3** (2 не имеет смысла без 1;
3 технически независим, но использует тот же паттерн `checkVersion`+
`transaction`+`audit`, поэтому логично делать после 1+2, не параллельно).

---

## 2. Пункт 1 — Contractor management: зафиксированное поведение

Owner-решение: **сохранение истории обязательно.** Нельзя физически удалять
подрядчика как сущность и нельзя терять факт его прежнего участия в объекте.
Снятие подрядчика — soft-remove, не `DELETE FROM object_contractors`.

Существующая relationship-таблица `object_contractors` (`infra/001_initial.sql`)
достаточна — **новая таблица не создаётся.**

### Предлагаемая SQL-миграция (не применена, только план)

Файл: `infra/004_object_contractor_history.sql` (следующий номер после
`003_bitrix_application_token.sql`).

```sql
ALTER TABLE object_contractors ADD COLUMN removed_at timestamptz;
ALTER TABLE object_contractors ADD COLUMN removed_by uuid;
ALTER TABLE object_contractors ADD FOREIGN KEY(tenant_id,removed_by) REFERENCES users(tenant_id,id);
-- Существующий UNIQUE(tenant_id,object_id,contractor_id) ("object_contractors_unique",
-- infra/001_initial.sql) не подходит после первого remove+повторного assign:
-- он не различает активную и снятую связь. Заменяем на частичный уникальный
-- индекс, действующий только для активных строк.
DROP INDEX object_contractors_unique;
CREATE UNIQUE INDEX object_contractors_active_unique
    ON object_contractors(tenant_id,object_id,contractor_id)
    WHERE removed_at IS NULL;
```

**Почему частичный индекс, а не просто снять `UNIQUE`:** без него повторное
assign того же подрядчика после remove создаёт вторую строку с тем же
`(tenant_id,object_id,contractor_id)`, что раньше запрещал старый `UNIQUE`.
Частичный индекс по `WHERE removed_at IS NULL` разрешает множественные
исторические (снятые) строки, но не более одной активной — это и есть
"повторное назначение того же подрядчика корректно обработано" из
требования владельца продукта.

**Что не меняется:** `works.contractor_id` — прямая FK-ссылка на
`contractors`, не на `object_contractors`. Соответственно, снятие подрядчика
с объекта физически не может "переписать" исторические `works` — это уже
гарантировано существующей схемой, миграция этого не трогает. Бизнес-инвариант
(нельзя снять подрядчика, у которого на этом объекте есть работы) — это
application-level проверка в `service.ts`, не ограничение схемы.

---

## 3. Пункт 1 — API

Важная находка при проверке кода: `apps/backend/src/main.ts` конфигурирует
CORS с `methods: ['GET', 'POST']` — **PATCH/DELETE не разрешены ни на одном
уровне сейчас**, и ни один существующий контроллер во всём `apps/backend/src`
не использует `@Patch`/`@Delete`/`@Put` (проверено `grep`) — 100% мутаций в
Core оформлены как `POST` с суффиксом действия (`/start`, `/progress`,
`/accept`, `/approve`, `/ready`, `/transfer-sdo` и т.д.). Более ранняя версия
этого плана предполагала `PATCH`/`DELETE` — это расходится с фактическим
кодом и потребовало бы менять CORS-конфигурацию в `main.ts` без явной
необходимости. Ниже план скорректирован на действующую конвенцию (только
`POST`), что не требует изменений в `main.ts` вообще.

| Endpoint | Метод | Назначение |
|---|---|---|
| `POST /objects/:id/contractors` | POST | Assign — добавить подрядчика на объект. 409, если уже есть **активная** связь (частичный индекс это гарантирует на уровне БД; на уровне API — то же самое, но с понятным сообщением до похода в БД) |
| `POST /objects/:id/contractors/:contractorId/remove` | POST | Soft-remove — `removed_at=now()`, `removed_by=a.id`. 409-guard: нельзя снять, если у этого подрядчика есть **активные** (не `COMPLETED`) работы на этом объекте — прямая копия инварианта из ERP integrity-fix п.3 |
| `GET /objects?contractorId=` | GET | Фильтр списка объектов — только объекты с **активной** связью на этого подрядчика |

---

## 4. Пункт 2 — RBAC

Новый `Permission.OBJECT_MANAGE_CONTRACTORS` в `packages/domain/index.ts`,
назначается тем же ролям, что уже имеют `OBJECT_EDIT` в объектной области
(`PROJECT_MANAGER`, `TECHNICAL_DIRECTOR`, `ADMIN`) — но использован **только**
в `requirePermission()` двух новых endpoint'ов (assign/remove). `OBJECT_EDIT`
для этого не используется — ровно то, что было зафиксировано в decision log
Core 2.0 п.4, повторяю здесь для полноты плана Core 2.1.

---

## 5. Пункт 3 — Object edit: зафиксированный field whitelist

Owner-решение, поля фиксированы (не выбираются реализацией самостоятельно):

**Редактируемо через `POST /objects/:id/edit`:**
- `name`
- `address`
- `customerName`
- `plannedFinishDate` (фактическое имя поля в `objects`, `infra/001_initial.sql`)

**`projectManagerId`:** редактируется через тот же endpoint, но только ролями
`TECHNICAL_DIRECTOR`/`ADMIN` — не самим РП (отдельная RBAC-развилка внутри
одного endpoint'а, а не отдельный permission). Причина зафиксирована владельцем
продукта: РП не должен мочь переназначить объект на себя или снять с себя
ответственность за проблемный объект.

**Не редактируется через этот endpoint (зафиксировано владельцем продукта):**
- `contractValue` — финансово значимое поле, целостность финансового следа
  важнее удобства правки постфактум.
- `status`/`healthStatus` объекта — статус должен меняться только через
  существующий управляемый workflow (в текущем Core объект не имеет explicit
  state-transition эндпоинта; пока такого механизма нет — `status` остаётся
  неизменяемым через любой edit-путь, а не "временно доступным" через PATCH).
- Contractor assignments — это пункт 1, отдельный endpoint, не часть edit.
- Tenant/company ownership (`tenantId`) — структурно не в DTO, не в scope.
- `id`, `version`, `createdAt`/`updatedAt`, `externalCode`/`source` — системные
  поля, не выставляются в DTO редактирования вообще.

**`startDate`, `organizationName`** — упомянуты в исходном плане как
кандидаты, но не подтверждены владельцем продукта явно как разрешённые.
**Не включены в whitelist** до отдельного подтверждения — план не решает это
самостоятельно.

### Обязательные для этого endpoint'а (без исключений)

- `checkVersion` (используется существующий `objects.version`, миграция не
  нужна — колонка уже есть).
- `transaction` (существующий паттерн `db.ts`).
- `audit` event (`entityType: 'Object'`, `action: 'EDIT'` или аналогичный,
  через существующий `audit(c, a, ...)` в `security.ts`).
- Tenant isolation — через существующий `scoped(c, 'objects', id, a, true)`.
- `objectAccess` guard — существующая проверка (РП может редактировать только
  свой объект; при смене `projectManagerId` — только TECHNICAL_DIRECTOR/ADMIN,
  см. выше).

---

## 6. Пункты 4 и 5 — статус "отложено", не детализируется в этом плане

Технический анализ (миграции, риски, зависимости) для частичной приёмки и
многоработных пакетов ИД был выполнен на предыдущем проходе review и остаётся
верным, но **не входит в активный scope Core 2.1** — переносится в Core 2.2+
без потери: полный анализ — в `docs/decision-log-core-2.0.md`
(накопленный список MISSING_BEHAVIOR) и в истории git этого файла
(`git log -p -- docs/core-2.1-architecture-plan.md`). Реализация не начнётся
без отдельного product decision по каждому пункту:
- п.4: нужна ли частичная приёмка вообще; разблокирует ли она зависимую работу.
- п.5: есть ли конкретный кейс, оправдывающий ломающую миграцию уникальных
  индексов на `sdo_cases`/`executive_packages`.

---

## 7. Пункты 6 и 7 — не трогать

`dictionary_items` и `work_templates` остаются мёртвыми таблицами в схеме.
Не реализуется функциональность их использования, не удаляются сами таблицы.
Решение "use vs remove" — отдельное product decision, вне scope Core 2.1.

---

## 8. Что нельзя делать до Bitrix24 integration

Ничего из пунктов 1-3 (активный scope Core 2.1) **не требует** реальной
Bitrix24-интеграции — всё работает в рамках `MockBitrixAdapter`/
`AUTH_MODE=mock`. Отдельно, по итогам `domain-parity-core-erp.md`, явно
нельзя делать до отдельного разрешения на подключение тестового Bitrix24-
портала:

- Отслеживание жизненного цикла установки (`BitrixInstallation.status`).
- Автоматическая синхронизация `department`/`departmentName` с оргструктурой
  Bitrix24.
- Реальная отправка уведомлений в Bitrix24 (`Notification.sentToBitrix`).
- Любые изменения `RealBitrixAdapter`, `BITRIX_INSTALL_WEBHOOK_ENABLED`,
  OAuth/refresh-логики.

Ограничение унаследовано из `docs/status.md` и остаётся в силе для Core 2.1.

---

## 9. Риски (scope Core 2.1: пункты 1-3)

| Пункт | Риск | Смягчение |
|---|---|---|
| 1. Contractor management | Снятие подрядчика с объекта, у которого уже есть **активные** работы, могло бы молча создать несогласованность (работа продолжается, а подрядчик формально снят с объекта) | Обязателен 409-guard "нельзя снять, пока есть активные (не COMPLETED) работы этого подрядчика на объекте" — прямая копия проверенного инварианта из ERP integrity-fix п.3 |
| 1. Contractor management | Повторное assign после remove должно попадать в новую строку, а не пытаться "восстановить" старую (иначе история искажается) | Частичный уникальный индекс (`WHERE removed_at IS NULL`) технически гарантирует, что assign всегда создаёт новую активную строку — старая снятая остаётся неизменной историей |
| 2. Permission | Риск повторить дефект ERP (использовать существующий `OBJECT_EDIT` вместо нового permission) | Явно запрещено в decision log Core 2.0 п.4 и повторено здесь — `requirePermission` для assign/remove обязан ссылаться на `OBJECT_MANAGE_CONTRACTORS`, code review должен это проверить |
| 3. Object edit | Обход `objectAccess`/RBAC при смене `projectManagerId` (РП передаёт объект себе или снимает с себя ответственность) | RBAC-развилка внутри endpoint'а: смена `projectManagerId` разрешена только `TECHNICAL_DIRECTOR`/`ADMIN`, обычный `objectAccess` не даёt РП это сделать в принципе (роль PROJECT_MANAGER не входит в разрешённые для этого поля) |
| 3. Object edit | Расширение whitelist без явного решения (незаметный дрифт в сторону "общего CRUD") | Whitelist зафиксирован в этом документе как owner-решение; любое новое поле требует отдельного запроса, не добавляется реализацией по умолчанию |
| Общий риск | Любое из изменений может незаметно сломать один из 31 существующих тестов Core 2.0 hardening | Полный `npm test` (31/31) + Playwright после каждого коммита, не пакетом в конце — см. implementation plan |

---

## Не входит в этот план (осознанно)

- Значения `RED escalation`/`staleDays` — уже решены в Core 2.0 decision log
  п.1-2, изменений не требуют.
- Severity-модель замечаний / правило блокировки приёмки — уже решено
  (Core 2.0 decision log п.5), оставлено как есть.
- Любой перенос кода/схемы из `construction-erp-mvp` — по-прежнему запрещён,
  reference остаётся только источником сценариев, не кода.
- Частичная приёмка и многоработные пакеты ИД — Core 2.2+, см. раздел 6.
- `dictionary_items`/`work_templates` — не трогать, см. раздел 7.
