# GPR-2 R05 — UI & Pilot Readiness (READ-ONLY анализ)

Режим: READ-ONLY / ANALYSIS. Исполнитель: Claude Code. Baseline: `4ccdd370fe45556a38cd4f6864afa83b4ed11890` (merge PR #15, `feature/gpr2-r05-integration-20261029`).
Изменён только этот документ. Product code, миграции, CI, deployment, LIVE и secrets не затрагивались. Закрытые технические проверки R05
(`docs/gpr-2-r05-contract.md`) не повторялись; R06 не начинался. Статус: **ANALYSIS DELIVERED — PENDING OWNER REVIEW**.

Метки: **ГОТОВО** — подтверждено чтением кода на baseline. **ОТСУТСТВУЕТ** — в коде нет. **ТРЕБУЕТ ПРОВЕРКИ** — по коду не решить, нужен прогон или решение.
Ничего ниже не запускалось: все «ГОТОВО» — результат чтения, не прогона.

## 1. Главный вывод

Backend R05 — командная часть, закрытая и принятая технически. **Интерфейса нет вообще, и одним frontend-PR он не появится**: у R05 нет ни одного
чтения. Контроллер (`apps/backend/src/modules/gpr2/gpr2.controller.ts`) содержит только `POST`; реестр `packages/domain/gpr2/endpoints.ts` описывает
единственный R05-запрос `finish-systems.list`, но он `mounted: false` и обработчика не имеет. Фронтенд не содержит ни одного обращения к `/v2`.
Старый `GET /dictionaries` намеренно возвращает только `scope='CORPORATE'` WorkType, так что объектные типы не видны нигде.

Следствие: минимальный объём — **небольшой backend read-срез (только SELECT, без миграций) + frontend**. Без чтений экран можно построить лишь как «пишущую форму
с памятью на одну сессию»: после перезагрузки РП не увидит ни своих AreaScope, ни finish-систем, ни статуса заявки на публикацию. Для пилота это не годится.

## 2. Что фактически реализовано (R05)

### 2.1 API (все `POST`, все `200`, префикс `/api/v2`, включены только при `GPR2_CONTRACT_ROUTES=enabled`)

| Команда | Роль / право | Идемпотентность и версии | Результат (`resultIds`) |
|---|---|---|---|
| `POST /objects/{o}/work-types` | РП, `GPR2_OBJECT_CATALOG_MANAGE` | Idempotency-Key | `[workTypeId]`; warning `SAME_NAME_EXISTS` |
| `POST /objects/{o}/work-types/{id}/publication-requests` | РП | Key + `expectedVersion` | `[requestId]` |
| `POST /work-type-publication-requests/{id}/approve` · `/reject` | Admin, `GPR2_CORPORATE_PUBLICATION` | Key + `expectedVersion` | `[requestId, workTypeId]` / `[requestId]` |
| `POST /objects/{o}/area-scopes` *(маршрут — предложение)* | РП | Key | `[areaScopeId]` |
| `POST /finish-templates` · `/{id}/publish` *(предложение)* | Admin | Key (+ `expectedVersion` на publish) | `[templateId, versionId, …stageIds]` |
| `POST /objects/{o}/finish-systems` | РП | Key | `[finishTypeId, systemVersionId, …]` |
| `POST /objects/{o}/finish-systems/{id}/preview` | РП | без Key (pure), `expectedVersion` | `{ preview, appliedVersions, resultIds: [], warnings }` — не `CommandResult` |
| `POST /objects/{o}/finish-systems/{id}/confirm` | РП **и** legacy `WORK_CREATE` | Key + `expectedVersion` + `expectedScopeVersion` | `resultIds` = id созданных Work |

Источники: `gpr2.controller.ts`, `gpr2-r05-hooks.ts`, `gpr2-r05-catalog.ts`, `gpr2-r05-generation.ts`, `packages/domain/gpr2/r05.ts` (payload-схемы).

### 2.2 Feature flag

Один флаг: `GPR2_CONTRACT_ROUTES=enabled` (`main.ts:44`). При другом значении модуль не подключается, `/api/v2/*` отвечает обычным 404 Nest. Флаг — на уровне
процесса, не per-tenant и не per-user. Фронтенд не может спросить, включён ли он (нет `/features`, `/api/health` его не отдаёт) — **ОТСУТСТВУЕТ**.
`/api-docs` при включённом флаге дополняется контрактом GPR-2 (`mountGpr2Contract`).
Побочный эффект: флаг включает также 25 **не-R05** маршрутов (35 смонтированных, 10 из них R05) (calendar, schedule revisions, quantity, imports…) — они отвечают 501 `COMMAND_NOT_ENABLED`, ничего не пишут,
но существуют в OpenAPI и получают rate-limit. Отдельного «только R05» флага нет.

### 2.3 Права

`GPR2_GRANTS` (`packages/domain/gpr2/permissions.ts`): РП → `OBJECT_CATALOG_MANAGE` (WorkType, AreaScope, finish-system, preview, confirm); ADMIN → только
`CORPORATE_PUBLICATION` (approve/reject заявок, шаблоны). ADMIN **не** получает права РП автоматически и не может создавать AreaScope или генерировать Work;
DEPUTY_DIRECTOR не имеет R05-прав. Проверка — по роли из таблицы пользователей на момент команды (`reauthorize`), плюс доступ к объекту (`objectAccess`) и
владение вложенным ресурсом; не-найденное и чужое неразличимы (scope-safe 404). Confirm дополнительно требует legacy `WORK_CREATE`.
Фронтенд знает роль (`session.user.role`), но **не знает ни GPR-2 права, ни скоупа объекта** — UI-гейтинг можно построить только по роли (удобство, не безопасность). **ТРЕБУЕТ РЕШЕНИЯ** — D2.

### 2.4 Зависимость от миграций 029–035

Все семь аддитивны (`-- migration-class: additive`), порядок 029→035 обязателен: 033/034/035 — корректирующие триггеры поверх 029–032, 034 и 035 содержат
precondition-проверки, которые **роняют прогон**, если данные уже нарушают инвариант. Код R05 без 029–035 неработоспособен (колонки `work_types.scope`, таблицы
`object_*`, `finish_*`, `work_scope_*`). Без R05-кода миграции безвредны (пустые таблицы, существующие WorkType читаются как `CORPORATE`). Следовательно:
**миграции можно применить раньше флага**, а флаг — раньше интерфейса; обратный порядок невозможен. Migration-ledger: `scripts/migrate.ts --plan` показывает план без применения.
Откатов (down) нет — только forward; откат = restore из backup (см. §7).

## 3. Существующий frontend и карточка объекта

React 19 + Vite, маршруты react-router (`app/routePaths.ts`), экраны `screens/*` отделены от маршрутов `app/routes/*`, API-клиенты `data/*Api.ts`, view-model `view-models/*`.
Объект: `/object/:objectId` → `ObjectRoute` → `screens/O01` (карточка), с кнопками-переходами в `/object/:id/schedule` (GPR-1) и `/object/:id/documentation` (реестр ИД).
Готовый шаблон для нового раздела — именно GPR-1: свой `scheduleApi.ts` (fetch + Bearer + `Idempotency-Key`-подобная логика ключа в формах: `crypto.randomUUID()` в W01/PackageDetail/SdoCaseDetail),
валидация ответа до рендера, отдельный 403-исход, отдельный маршрут внутри объекта. Playwright-гейты с реальным backend на PGlite существуют (`tests/gpr-1-browser`).

Что не подходит «как есть»:

* `http.ts → parseResponse` достаёт из ошибки только `message`. R05 различает исходы по `code` и `details` (`STALE_PREVIEW`, `ONE_PRODUCER_CONFLICT`, `VALIDATION_FAILED` с `rule`/`path`…) — их текущий клиент теряет. Нужен R05-клиент, читающий `code/details`.
* Нет клиента `/v2` вообще, нет обработки `Idempotency-Key` на уровне клиента (в других экранах ключ живёт в состоянии формы — этот паттерн годится).
* Прокси (Vite dev и Caddy) пропускают `/api/*`, CORS не мешает (same-origin); заголовок `Idempotency-Key` не входит в `allowedHeaders` CORS (`main.ts`) — **важно только при cross-origin запуске**, в штатной схеме (Caddy / Bitrix iframe на том же origin) не проявляется. ТРЕБУЕТ ПРОВЕРКИ на тестовом Bitrix-контуре.
* Snapshot `works` допускает `contractorId/responsibleUserId = null` (`types/api.ts:257`) — сгенерированные Work (без подрядчика/ответственного/стоимости/дат) должны отобразиться в W01/GPR без падения. **ТРЕБУЕТ ПРОВЕРКИ** браузером (после R04 CP-01 даты nullable уже покрыты, исполнитель — нет).

## 4. UI Gap Matrix

| # | Возможность | Backend | Чтение | Экран | Статус | Комментарий |
|---|---|---|---|---|---|---|
| 1 | Список / просмотр WorkType объекта | команда есть (create) | **нет** | нет | ОТСУТСТВУЕТ | `/dictionaries` отдаёт только CORPORATE. Нужен `GET …/work-types` (CORPORATE + OBJECT этого объекта + alias/promoted-состояние) |
| 2 | Создание объектного WorkType | ГОТОВО | — | нет | ОТСУТСТВУЕТ | нужны категория (есть в `/dictionaries`), единица из `R05_UNITS`, три флага |
| 3 | Заявка на публикацию WorkType (РП) | ГОТОВО | нет списка заявок | нет | ОТСУТСТВУЕТ | нужен `expectedVersion` — берётся из чтения |
| 4 | Решение по заявке (Admin: approve/reject) | ГОТОВО | **нет очереди заявок** | нет | ОТСУТСТВУЕТ | без очереди Admin не узнает, что решать; нужен `GET /work-type-publication-requests?state=PENDING` |
| 5 | Типы отделки объекта (finish types) | ГОТОВО (создаются через upsert) | **нет** (`finish-systems.list` в реестре, не смонтирован) | нет | ОТСУТСТВУЕТ | |
| 6 | AreaScope: дерево, создание | ГОТОВО (create) | **нет** | нет | ОТСУТСТВУЕТ | родитель/код/мера неизменны; удаления нет; нужно дерево целиком |
| 7 | Шаблоны отделки (Admin: draft/publish) | ГОТОВО | **нет** | нет | ОТСУТСТВУЕТ | маршруты — предложения (`routeFixedByTd:false`), нужно решение владельца O3 |
| 8 | Finish-система объекта (upsert версии, этапы, inherited/overridden/added) | ГОТОВО | **нет** | нет | ОТСУТСТВУЕТ | самая сложная форма; допускает режим «из шаблона без правок» |
| 9 | Preview генерации | ГОТОВО (pure) | — | нет | ОТСУТСТВУЕТ | ответ содержит items/blockers/warnings/missingInputs/existingWorks/fingerprint — контракт чёткий (`GenerationPreview`) |
| 10 | Confirm генерации | ГОТОВО | — | нет | ОТСУТСТВУЕТ | требует fingerprint + `expectedSourceVersions.systemVersion` + `expectedVersion` + `expectedScopeVersion` + Key |
| 11 | Защита от повторной генерации | ГОТОВО (БД: один producer на obligation; ledger-replay; STALE_PREVIEW) | — | нет | ОТСУТСТВУЕТ | UI должен показывать EXISTING и отключать confirm при `canConfirm=false` |
| 12 | Показ созданных Work | ГОТОВО (обычные Work) | через общий snapshot | W01/GPR | ТРЕБУЕТ ПРОВЕРКИ | null-исполнитель/ответственный; связь Work → binding/occurrence для пользователя не читается |
| 13 | Feature detection / скрытие раздела | флаг есть | **нет** | нет | ОТСУТСТВУЕТ | достаточно reuse существующего подхода «403/404 → блок отсутствует» (как GPR-1 `Hidden`) |
| 14 | Разбор ошибок GPR-2 (`code/details`) | ГОТОВО (на сервере) | — | нет | ОТСУТСТВУЕТ | `http.ts` теряет `code` |
| 15 | Legacy mapping/classification (R19) | сервис без маршрута | — | — | ВНЕ ОБЪЁМА | сознательно не в R05 |
| 16 | Quantity / surface change / reuse (R06/R07/R09) | — | — | — | ВНЕ ОБЪЁМА | |

Итог: готово — 100% командной стороны; отсутствует — 100% чтений и экранов; проверок требуют 4 пункта (§8).

## 5. Сценарии

### 5.1 РП (минимальный сквозной путь)

1. Открывает «Отделка и состав работ» на карточке объекта (кнопка рядом с «График»).
2. (При необходимости) создаёт объектный WorkType → `work-type.create`; видит `SAME_NAME_EXISTS` как предупреждение, не ошибку.
3. Строит дерево AreaScope (здание → этаж → помещение; мера — на листьях или на родителе, дети не превышают родителя) → `area-scope.create`.
4. Выбирает тип отделки и либо шаблон (опубликованная версия), либо собственные этапы → `finish-system.upsert` → получает `systemVersionId`.
5. Выбирает листовые AreaScope, при LOCAL-этапах вводит локальные количества → **Preview** → читает PROPOSED / EXISTING / BLOCKED, `missingInputs`, `warnings`.
6. Confirm доступен только при `canConfirm=true`; отправляется с fingerprint, версиями и новым Idempotency-Key → Work созданы, переход к списку Work объекта.
7. Параллельно: заявка на публикацию объектного WorkType → ожидание решения Admin.

### 5.2 Администратор

Очередь заявок → approve (PROMOTED либо ALIASED на корпоративный тип той же единицы) / reject с причиной; корпоративные шаблоны: draft → publish (DRAFT → PUBLISHED необратимо).
Администратор **не** создаёт AreaScope и не подтверждает генерацию (нет права и объектного доступа) — экран должен это показывать как ограничение роли, а не как ошибку.

### 5.3 Preview → confirm и защита от повторной генерации

* Preview — чистая проекция без записи; возвращает `previewFingerprint`, `scopeVersion`, `canConfirm`. UI **не должен** вычислять что-либо сам: показывать только то, что вернул сервер.
* Confirm повторно считает preview под блокировкой. Расхождение → 409 `STALE_PREVIEW` (мир изменился: показать «данные изменились», перезапросить preview, **новый** Idempotency-Key только после нового preview), `STALE_SOURCE_VERSION`, 409 `SCOPE_VERSION_CHANGED`.
* Тот же Key + то же тело = безопасный replay (результат тот же, ничего не создаётся); тот же Key + другое тело = 409 `IDEMPOTENCY_PAYLOAD_MISMATCH`. Поэтому ключ должен жить в состоянии формы, обновляться только после успеха/осознанного изменения ввода — как в W01.
* Вторая попытка с другим Key на те же AreaScope: существующие producers → EXISTING, confirm без PROPOSED отказывается (`NOTHING_TO_GENERATE`); на уровне БД второй producer невозможен.
* Блокеры, которые UI должен уметь объяснить человеческим языком (по `rule`): `QUANTITY_MISSING`, `UNIT_MISSING/MISMATCH`, `AREA_OVERLAP`, `AREA_COVERAGE_INCOMPLETE`, `PRODUCER_INCOMPATIBLE`, `PRODUCER_QUANTITY_CHANGED`, `NOTHING_TO_GENERATE`, `DUPLICATE_VALUE` (в т.ч. повтор `localQuantities`).

### 5.4 Ошибки API (форма ответа: `{ statusCode, message, code?, details?, requestId }`)

401 сессия · 403 нет права · 404 флаг выключен **или** чужой/несуществующий ресурс (неразличимы по замыслу) · 409 `STALE_VERSION/STALE_PREVIEW/STALE_SOURCE_VERSION/SCOPE_VERSION_CHANGED` ·
422 `VALIDATION_FAILED` (`details`: `path`, `rule`), `ONE_PRODUCER_CONFLICT`, `MISSING_REQUIRED_DATA`, `INVALID_MEASUREMENT`, `CROSS_SCOPE_REFERENCE`, `AREA_SCOPE_CONFLICT`, `VERSION_IMMUTABLE`, `INVALID_TRANSITION` ·
429 rate-limit (HTML, уже обрабатывается `http.ts`) · 501 `COMMAND_NOT_ENABLED` (команды вне R05) · 40001 сериализации как повторяемый сбой. 5xx никогда не повторять автоматически confirm с новым ключом.

## 6. Минимальный план frontend-реализации

Принцип: один новый раздел внутри объекта по образцу GPR-1; без изменения существующих экранов, кроме одной кнопки в O01. Не вводить новую библиотеку состояния.

### 6.0 Предусловие — backend read-срез (отдельный authorised stage, не frontend)

Только SELECT, tenant/object-scope, auth через те же `objectAccess`/роль; **без миграций**. Минимум:

| Маршрут | Содержимое | Для экрана |
|---|---|---|
| `GET /v2/objects/{o}/work-types` | CORPORATE + OBJECT-типы объекта, `version`, scope, alias, unit, флаги | S1, выбор в S3 |
| `GET /v2/objects/{o}/area-scopes` | дерево целиком (parent, code, kind, measure, lifecycle, revision) | S2, выбор в S4 |
| `GET /v2/objects/{o}/finish-systems` | finish types + текущая версия системы + этапы (provenance) | S3, S4 (`finish-systems.list` уже в реестре) |
| `GET /v2/finish-templates` | шаблоны + опубликованные версии + этапы | S3, S5 |
| `GET /v2/work-type-publication-requests?state=` | очередь заявок (Admin: tenant; РП: свой объект) | S1, S5 |

Это уточняет реестр (новые query-строки + OpenAPI) и требует собственных тестов tenant/object isolation. Это **новый scope за пределами «UI»** — нужна авторизация владельца (D1).

### 6.1 Экраны и клиентские файлы

Все пути внутри `apps/frontend/src/`. Маршруты в `routePaths.ts`.

| Экран | Маршрут | Роль | API | Содержимое |
|---|---|---|---|---|
| **S0** Вход в раздел | кнопка в `screens/O01` («Отделка и состав работ») | РП (виден), прочие — скрыт | — | показывается по роли; при 404/403 на первом чтении — раздел недоступен |
| **S1** Виды работ объекта | `/object/:id/finish/work-types` | РП | GET work-types; `work-type.create`; `publication-requests` | таблица, форма создания, кнопка «Предложить в корпоративный справочник» с `expectedVersion`, статус заявки |
| **S2** Зоны (AreaScope) | `/object/:id/finish/areas` | РП | GET area-scopes; `area-scope.create` | дерево, добавление дочернего узла, мера/единица, подсветка превышения родителя (ответ сервера, не расчёт) |
| **S3** Системы отделки | `/object/:id/finish/systems` | РП | GET finish-systems, GET templates; `finish-system.upsert` | выбор типа/шаблона, таблица этапов (INHERITED / OVERRIDDEN с причиной / ADDED_LOCAL), исключения с причиной, версия иммутабельна |
| **S4** Генерация работ | `/object/:id/finish/systems/:finishTypeId/generate` | РП (+ `WORK_CREATE`) | `preview`, `confirm` | выбор листовых AreaScope, optional-этапы, LOCAL-количества, группировка; результат preview (PROPOSED/EXISTING/BLOCKED, блокеры, пробелы), confirm отключён при `!canConfirm`, итог — ссылки на созданные Work |
| **S5** Администрирование каталога | `/admin/finish-catalog` | ADMIN | GET requests/templates; `approve/reject`; `template.draft/publish` | очередь заявок (PROMOTED/ALIASED + причина отказа), шаблоны DRAFT → PUBLISHED |

Файлы: `data/gpr2R05Api.ts` (fetch, Bearer, разбор `code/details`; **не** трогает `http.ts`, чтобы не менять поведение остальных экранов), `types/gpr2R05.ts`,
`view-models/finishCatalog.ts` + `finishGeneration.ts` (чистые функции: карта блокеров → русский текст, состояние confirm), `screens/FinishCatalog/*`, `app/routes/Finish*Route.tsx`,
`app/useGenerationFlow.ts` (preview → confirm, ключ идемпотентности, сброс при смене входа). Тесты: view-model — node:test; браузер — отдельный `playwright.r05-ui.config.ts` + `tests/r05-ui-browser/` по образцу `gpr-1-browser`.

### 6.2 Порядок поставки (каждый шаг — отдельный authorised PR)

1. Backend read-срез + его тесты (§6.0).
2. Клиент + view-model + S4 (preview→confirm) на seed-данных — самая ценная часть, закрывает «защиту от повторной генерации» в UI.
3. S2 + S3 (подготовка входных данных).
4. S1 + S5 (публикация и админ).

Допустимое сокращение пилота: S1/S5 и шаблоны (S3 «из шаблона») можно отложить, если владелец согласен, что на пилоте корпоративный справочник и шаблоны наполняются через утверждённую процедуру/API-скрипт. Тогда минимум: чтения + S2 + S3 (без шаблонов) + S4.

## 7. План изолированной приёмки и pre-LIVE checklist

### 7.1 Существующая инфраструктура

| Средство | Что умеет | Ограничение для R05-UI |
|---|---|---|
| `gpr2-acceptance.yml` (универсальный) | manual `workflow_dispatch`, только `main`, только `Shamil9586`, authorize → runtime (read-only token, без secrets) → seal; PostgreSQL + Chromium; профиль `.github/acceptance/profiles/<id>.json` | профиль R05-UI **не зарегистрирован** (есть `r04-cp02`, `r04-main-integration`, `stage-template`); регистрация — reviewed PR в `main` + решение владельца |
| `gpr2-independent-acceptance.yml` | заморожен под один SHA R04 | не годится |
| `cr01-full-regression-postgres.yml` | полный `npm test` на postgres:17, без LIVE | триггерится на ветке `fix/cr01-*`; для R05-UI — только вручную после решения |
| Playwright-гейты + `tests/helpers/gpr-fixtures.ts` | реальный backend на PGlite, mock-auth, сценарий через реальное API | PGlite ≠ native PostgreSQL: блокировки/40001 R05 доказаны только на native (`tests/gpr2-r05-*-native-pg.test.ts`); для браузерного гейта PGlite достаточен, для concurrency — нет |

Профиль R05-UI: checks = `native-pg` (R05-наборы, без пропусков), `pglite-migration`, `browser-r05-ui`, `typecheck-build`. **Запуск CI в этом анализе не выполнялся** (запрещено); план — для следующего stage.

### 7.2 Сценарии изолированной приёмки (disposable PostgreSQL 16/17 + Chromium, fresh DB, миграции 001–035)

A. РП: WorkType → AreaScope-дерево → finish-система → preview → confirm → Work видны в O01/W01/GPR (в т.ч. null-исполнитель).
B. Повтор confirm тем же Key (replay), другим Key (EXISTING / NOTHING_TO_GENERATE), после правки дерева (STALE_PREVIEW), двумя вкладками (одна выигрывает, вторая получает 409/422, дубль Work не создаётся).
C. Блокеры: нет количества, несовпадение единиц, перекрытие областей, неполное покрытие родителя, повтор `localQuantities`, смена количества LOCAL.
D. Admin: заявка → approve (PROMOTED, ALIASED) / reject; повторное решение → `INVALID_TRANSITION`; шаблон draft → publish → иммутабелен.
E. Права: ADMIN/DEPUTY/PTO/SDO/CONTRACTOR_VIEWER не видят и не могут выполнить команды РП; РП чужого объекта получает «не найдено»; смена роли между preview и confirm → отказ (A19).
F. Флаг: `GPR2_CONTRACT_ROUTES` выключен → раздел скрыт, остальное приложение без изменений (регресс GPR-1/W01/PTO/SDO).
G. Доступность: клавиатура, фокус, цвет не единственный носитель смысла (skills `accessibility`, `frontend-testing`).

### 7.3 Pre-LIVE readiness checklist (только проверки; ничего не выполнять без решения владельца)

| № | Пункт | Статус на baseline |
|---|---|---|
| 1 | Backup LIVE-БД `pg_dump -Fc` перед миграциями + журнал SHA256 | процедура описана (`docs/test-deployment-runbook.md`), **restore drill не выполнен** — ТРЕБУЕТ ПРОВЕРКИ на тестовой копии |
| 2 | `npm run db:migrate -- --plan` на копии LIVE: ровно 029–035 pending, checksum-гэпов нет | не выполнялся |
| 3 | Precondition-проверки 033/034/035 на данных копии LIVE (нет OBJECT WorkType без origin, нет нарушений NEW-01…04, R3-B01) | не выполнялись; на LIVE не должны содержать нарушающих данных, т.к. R05-данных ещё нет — ТРЕБУЕТ ПРОВЕРКИ |
| 4 | Миграции применяются **отдельным controlled шагом** до деплоя кода (API не мигрирует при старте — `infra/Dockerfile`, CR01) | принцип зафиксирован |
| 5 | Порядок: backup → migrate (029–035) → deploy backend с флагом OFF → smoke (health/ready, GPR-1, W01) → флаг ON для пилота → deploy frontend → smoke под ролями РП/Admin | предлагается |
| 6 | Время работы миграций 029–035: DDL на `work_types` (добавление колонок, NOT VALID + VALIDATE CHECK, индекс) | оценить на копии; блокировки таблиц — ТРЕБУЕТ ПРОВЕРКИ |
| 7 | Откат: down-миграций нет; backend с флагом OFF ведёт себя как до R05 (миграции аддитивны и безвредны); откат схемы = restore | подтверждено чтением, не прогоном |
| 8 | Пилотный объект и РП назначены; Admin с `CORPORATE_PUBLICATION` назначен | решение владельца |
| 9 | Сид: корпоративные WorkType/категории существуют; `seed` на LIVE не запускать | принцип зафиксирован |
| 10 | Мониторинг: `X-Request-Id`, JSON-логи, `/ready`; алерт на 5xx `/api/v2/*` | существует, правила алертов — вне репозитория |
| 11 | Нет LIVE-секретов в CI; acceptance-ветка не получает production URL | заявлено в шапке `gpr2-acceptance.yml` (runtime-job без secrets, read-only token); сам workflow не запускался |
| 12 | Конфликт с принципом «один флаг на все GPR-2 маршруты» (§2.2) принят или разделён | решение D3 |

Ограничения LIVE: LIVE не трогался; подключение к LIVE-БД и применение миграций запрещены условиями и CLAUDE.md. Фактическое состояние LIVE-схемы (применены ли 026–028 и какие checksum-ы) из репозитория **не известно**.

## 8. Что требует проверки (оставшиеся неопределённости)

1. Отображение сгенерированных Work (null `contractorId/responsibleUserId`) в W01, O01, GPR-1, PTO, SDO — браузерный прогон.
2. Поведение `Idempotency-Key` при cross-origin (CORS `allowedHeaders`) в тестовом Bitrix-контуре.
3. Время/блокировки миграций 029–035 на объёме LIVE (на копии).
4. Реальное состояние ledger миграций на LIVE (опубликованный `migrations.legacy.sha256.json` и R03d-checksum-ы).

## 9. Решения владельца (действительно необходимые)

| № | Вопрос | Рекомендация | Блокирует |
|---|---|---|---|
| **D1** | Авторизовать backend read-срез (§6.0) как отдельный stage до UI? Без него UI невозможен. | Да, только SELECT, без миграций | всё |
| **D2** | Нужен ли UI-гейтинг по GPR-2-правам (эндпоинт «мои права»), или достаточно роли + реакции на 403/404? | Роль + реакция на ошибки; не расширять auth-контракт | S0 |
| **D3** | Один флаг `GPR2_CONTRACT_ROUTES` включает и не-R05 маршруты (501). Принять или ввести узкий флаг R05? | Принять на пилоте (501 ничего не пишет) | включение на LIVE |
| **D4** | Утвердить предложенные маршруты `area-scope.create`, `finish-template.draft/publish` (`routeFixedByTd:false`) — UI закрепит их | Утвердить как есть | S2, S5 |
| **D5** | Объём пилота: полный (S1–S5) или сокращённый (чтения + S2 + S3 без шаблонов + S4; справочник/шаблоны — вне UI) | Сокращённый | план |
| **D6** | Кто Admin с `CORPORATE_PUBLICATION` на пилоте и какой РП/объект — пилотные | назвать конкретно | сценарии D/E |
| **D7** | Регистрация профиля приёмки R05-UI в `main` (reviewed PR) и разрешение на запуск изолированного CI | Да, после готового кандидата | §7 |
| **D8** | Открытое решение R05 «stating none» для LOCAL-количества (`docs/gpr-2-r05-contract.md`, «Producer semantics») — влияет на текст в preview | Зафиксировать до разработки S4 | S4 |
| **D9** | Допускается ли на пилоте, что после generate Work не имеют подрядчика/ответственного/дат (назначаются обычным путём R04/GPR-1)? | Да — так задумано R05 | приёмка A |

Все остальные вопросы (структура файлов, компоненты, тексты, порядок PR) решаются исполнителем по CLAUDE.md и профильным skills и решений владельца не требуют.

## 10. Не сделано намеренно

Не изменялся product code; не создавались PR; не запускался CI и тесты; не применялись миграции; не выполнялось подключение к LIVE; не читались secrets;
R05 не пересматривался; R06+ не начинался. Это отчёт исполнителя: приёмку и итоговое решение даёт независимая проверка и владелец.
