# Контур строительства — Bitrix24 production core MVP

Рабочий вертикальный сценарий: объект → физический факт → СК → замечания → допуск → ПТО/ИД → СДО → финансовое закрытие → Dashboard. Главная страница: подрядчики → объекты → план/факт → СК/ИД/СДО → закрытие; карточка объекта показывает причины и стадии по каждой работе.

Полный и актуальный статус — единственный источник истины: [`docs/status.md`](docs/status.md). Ниже — сокращённая выжимка, синхронизированная с ним; при расхождении верить `docs/status.md`.

## Фактический статус

MVP слит из construction-core + construction-erp, задеплоен на Render TEST и полностью проверен end-to-end:

| Gate | Статус |
|---|---|
| Локальные тесты (PGlite) | VERIFIED — 28/28 на `main`; на ветке `hardening/core-2.0` — 31/31 (regression-сетка + decision log, см. ниже) |
| Сборка (TypeScript + Vite) | VERIFIED |
| PostgreSQL (не PGlite), Docker build/runtime, HTTPS test-сервер | VERIFIED на Render — https://construction-core-web.onrender.com |
| Browser E2E (Playwright) | VERIFIED — `director.spec.ts` + `workflow.spec.ts` |
| Bitrix24 test portal | NOT VERIFIED — намеренно отложено, остаётся на `MockBitrixAdapter`; требует отдельного разрешения перед подключением реального/тестового портала |
| Production | Не разворачивался и не разрешён |

Детали деплоя, платформенные баги и фиксы — [`docs/deployment-render.md`](docs/deployment-render.md).

## Core 2.0 hardening (ветка `hardening/core-2.0`)

Отдельная задача поверх этого статуса — сопоставление критических бизнес-сценариев с reference-реализацией `construction-erp-mvp` (без переноса её кода: Core остаётся на raw `pg` + SQL-миграциях + PGlite), regression-сетка и business decision log. Документы: [`docs/core-2.0-regression-map.md`](docs/core-2.0-regression-map.md), [`docs/domain-parity-core-erp.md`](docs/domain-parity-core-erp.md), [`docs/decision-log-core-2.0.md`](docs/decision-log-core-2.0.md). Ветка не смёржена в `main`, ожидает отдельного review.

## Быстрый локальный запуск (PGlite, Node.js 24)

```bash
npm ci
export DB_MODE=pglite
export AUTH_MODE=mock
export MOCK_LOGIN_KEY="your-random-test-key"
npm run db:migrate
npm run db:seed
npm run dev:api
```

Во втором терминале из этой же директории:

```bash
npm run dev:web
```

Открыть http://localhost:5173. Выбрать роль и ввести заданный MOCK_LOGIN_KEY. Для первичного просмотра — «Генеральный директор», для полного сценария с переключением — роли РП, СК, ПТО, СДО. Администратор имеет все разрешения для настройки и тестирования.

PGlite допускает только один процесс, владеющий каталогом. Остановить API перед migrate/seed. Для нескольких процессов (API + worker) использовать PostgreSQL. Не запускать риск-worker параллельно с API на одном PGlite-каталоге.

## Проверки

```bash
npm test
npm run build
AUTH_MODE=mock MOCK_LOGIN_KEY=runtime-test DB_MODE=pglite PGLITE_DIR=memory:// node --import tsx scripts/runtime-smoke.ts
```

E2E создаёт изолированный PostgreSQL WASM database в памяти. Для настоящего PostgreSQL создать **пустую отдельную** БД с именем, заканчивающимся `_test`, и передать `E2E_DATABASE_URL`. Тест применяет миграции и seed; не указывать рабочую БД. Сохранённый тестовый вывод находится в `tests/latest-results.txt`, `tests/build-results.txt`, `tests/runtime-smoke-results.txt`.

## PostgreSQL + HTTPS в Docker

Скопировать `.env.example` в `.env`, заполнить случайные тестовые пароли, APP_HOST и APP_ORIGIN. Команды ниже подготовлены, но в этой среде не выполнялись:

```bash
docker compose up --build -d
docker compose run --rm api node --import tsx scripts/seed.ts
```

Caddy получает TLS-сертификат для вашего DNS-имени при доступных 80/443. В приложении авторизация обязательна; seed предназначен только для mock/test. Подробности — `docs/deployment.md` и `docs/bitrix24-integration.md`.

## Структура

- `apps/frontend` — интерфейс, формы и обращения к API.
- `apps/backend/src` — NestJS presentation, application services, repositories и adapters.
- `packages/domain` — чистые правила и provider interfaces.
- `infra` — 2 SQL-миграции, Dockerfile, Caddy.
- `scripts` — миграции, seed, локальные проверки, worker, анализ Excel.
- `docs` — принятые решения, правила и точные ограничения.

## Excel

Исходный файл проанализирован. Результат — `docs/excel-source-report.json`: 65 валидных строк, 58 строк с ошибками, 56 предупреждений при выбранном масштабе млн ₽. Это preview, реальный импорт в seed не выполнялся. В UI администратора есть validation → выбор строк → import → ImportReport. РП, срок и подрядчик назначаются при подтверждении выбранной группы строк. Подробности в business-rules.

## Ограничения MVP

Факт/приёмка/передача реализованы для целой работы, без частичного актирования по участкам. АОСР — текстовый черновик плюс загрузка и подтверждение проверенного файла. Документы не подписываются электронной подписью. Уведомления и эскалация локальные; автоматическая отправка в Bitrix не включена. Внешний антивирус, restore drill, production security review и нагрузочная проверка ещё нужны перед production. Детальный backlog — `docs/status.md`.

## Приёмочные проверки

`python scripts/clean-room.py` создаёт новую временную копию без node_modules/БД, выполняет npm ci, build, tests, migrations ×2, seed ×2 и HTTP smoke на PGlite. Журнал — tests/acceptance/clean-room.json. Ничего не удаляет в рабочем проекте.

Полный запуск браузерных тестов: `BROWSER_BASE_URL=https://your-test-host MOCK_LOGIN_KEY=your-test-key npm run test:browser`, после установки Chromium. Использовать отдельную mock/test среду. Уже выполнялся и проходит (`director.spec.ts` + `workflow.spec.ts`, см. `docs/status.md`). Подробности и изолированный PostgreSQL Compose gate — в runbook.
