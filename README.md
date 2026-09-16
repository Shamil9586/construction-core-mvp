# Текущая продуктовая итерация

Главная страница: подрядчики → объекты → план/факт → СК/ИД/СДО → закрытие. Карточка объекта показывает причины и стадии по каждой работе, ниже доступны существующие формы рабочего процесса.

См. docs/product-status.md для фактических результатов и docs/github-railway-readiness.md для публикации этого проекта. Не подменять им другую кодовую базу construction-erp-mvp без отдельного решения. Архив исходников не содержит node_modules, build output, логов, .env или Excel-отчёта. Старые ссылки на локальные evidence logs ниже относятся к рабочей среде и не входят в GitHub-пакет.

# Контур строительства — Bitrix24 production core MVP

Рабочий вертикальный сценарий: объект → физический факт → СК → замечания → допуск → ПТО/ИД → СДО → финансовое закрытие → Dashboard.

Техническая приёмка 15.09.2026: **24 теста прошли**, чистая установка на PGlite воспроизведена. PostgreSQL/Docker/browser ещё не подтверждены. Точные статусы — `docs/status.md`; серверная процедура — `docs/test-deployment-runbook.md`.

## Фактический статус

IMPLEMENTED AND VERIFIED LOCALLY:
- npm install, TypeScript typecheck, Vite production build.
- NestJS API и Vite frontend запущены; HTTP smoke проверяет также прокси frontend → API.
- PostgreSQL SQL migrations и seed выполнены на PGlite; повторный запуск проверяется тестом.
- 10 объектов, 8 подрядчиков, 5 РП, 60 работ.
- Автоматизированный HTTP E2E проходит весь производственный сценарий с разными ролями.
- Backend RBAC, составные tenant-FK, optimistic concurrency, аудит, блокировки, атомарное закрытие и idempotency проверены тестами.

REQUIRES BITRIX24 TEST PORTAL VERIFICATION:
- Установка, iframe launch, OAuth refresh и реальные вызовы REST.
- Проверка Origin POST-запросов портала, CSP, iframe/sessionStorage, тарифных scopes.

НЕ ПРОВЕРЕНО: Docker build/Compose и обычный PostgreSQL process, внешнее HTTPS-развёртывание, визуальный browser E2E. Здесь нет Docker, native PostgreSQL не может запуститься от доступного системного пользователя, удалённый браузер блокирует localhost. Полный Definition of Done пока не достигнут. Это не готовое production-развёртывание.

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

`npm run test:browser -- --list` только обнаруживает тест. Полный запуск: `BROWSER_BASE_URL=https://your-test-host MOCK_LOGIN_KEY=your-test-key npm run test:browser`, после установки Chromium. Использовать отдельную mock/test среду. Подробности и изолированный PostgreSQL Compose gate — в runbook.
