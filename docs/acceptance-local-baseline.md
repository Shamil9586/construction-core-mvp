# Техническая приёмка construction-core-mvp

15.09.2026. Продолжен существующий construction-core, архитектура сохранена. Новые продуктовые функции не добавлялись. Полная техническая приёмка НЕ завершена: нет подтверждения native PostgreSQL, Docker, браузерного цикла и тестового портала.

## Фактический аудит

| Категория аудита | Результат |
|---|---|
| VERIFIED | Найдены и изучены frontend/backend, domain, 2 SQL migrations, seed, 11 исходных тестов, env example, Compose/Dockerfile/Caddy и adapters |
| PARTIALLY VERIFIED | Производственный цикл подтверждён HTTP; UI подключён к API, но не пройден браузером |
| NOT VERIFIED | Native PostgreSQL, Docker runtime, HTTPS на сервере, browser E2E, реальная Bitrix установка |
| BLOCKED | Нет Docker CLI/socket; native initdb требует недоступного OS user; cloud browser блокирует localhost; тестовый HTTPS host/Bitrix credentials не предоставлены |

## Acceptance gates

| Пункт | Статус | Доказательство / предел проверки |
|---|---|---|
| Установка зависимостей с нуля | VERIFIED LOCALLY | npm ci в новой temp-копии без node_modules, 391 packages |
| Frontend/backend typecheck + build | VERIFIED LOCALLY | tests/acceptance/build-results.txt; Vite production bundle |
| Frontend и backend запуск | VERIFIED LOCALLY | clean-room-8.txt: Vite routes, Nest health/ready, login, dashboard через proxy |
| Migrations + seed с нуля и повтор | VERIFIED LOCALLY | PGlite disk DB, clean-room-4…7.txt; обе migrations, 10 объектов / 8 подрядчиков / 5 РП / 60 работ |
| План/факт, проценты, график, светофор | VERIFIED LOCALLY | Unit rules + HTTP workflow, 10/20=50%, все четыре health состояния |
| СК/замечания/повторная проверка/фото/допуск | VERIFIED LOCALLY | HTTP workflow, отрицательные запросы, приёмка после устранения |
| ПТО/материалы/ИД/СДО/закрытие | VERIFIED LOCALLY | HTTP workflow с реальным сохранением в PGlite |
| Potential Closing / Dashboard | VERIFIED LOCALLY | Decimal, уменьшение потенциала, object/dashboard reconciliation |
| RBAC forbidden actions | VERIFIED LOCALLY | PM/SDO accept403, PTO finance403, contractor create403, revoked session401 |
| Два наполненных tenant | VERIFIED LOCALLY | Раздельные objects/works/contractors/finance/dashboard/audit, чужие IDs отвергаются |
| Optimistic concurrency | VERIFIED LOCALLY | Две HTTP-сессии, одна запись проходит, другая409; одна строка progress |
| UI обработки конфликтов | NOT VERIFIED | Добавлена кнопка «Обновить данные», typecheck/build; браузерная проверка отсутствует |
| Financial invariants | VERIFIED LOCALLY | negative/NaN/Infinity/3decimals/overflow400; 0.10 точно; две параллельные попытки одного key создают одну запись |
| Idempotency critical operations | VERIFIED LOCALLY | Повтор accept/transfer409 и один audit/transfer; closing retry возвращает существующий id |
| SQL constraints / rollback | VERIFIED LOCALLY | PGlite: UUID/FK/restrict/JSONB/DATE/timestamptz/indexes, injected rollback после financial insert и audit |
| Native PostgreSQL | NOT VERIFIED | Docker не установлен; local native helper fail-fast при root. Не заменять этот статус PGlite результатами |
| Docker build / Compose / restart | NOT VERIFIED | Исправлена конфигурация; docker compose version реально вернул command not found |
| Browser E2E | NOT VERIFIED | Playwright сценарий написан, typechecked, --list нашёл 1 тест; не исполнялся |
| Визуальная QA 9 основных экранов | NOT VERIFIED | Cloud browser: ERR_BLOCKED_BY_CLIENT на localhost; снимки интерфейса не получены |
| HTTPS / test server / backup restore | NOT VERIFIED | Runbook подготовлен, нет удалённого deployment/restore evidence |
| MockBitrix + token crypto / adapter contracts | VERIFIED LOCALLY | Simulated transport, encrypted storage, install/login service, expired_token rotation, portal guard |
| Real Bitrix installation/OAuth/iframe/REST | REQUIRES BITRIX24 TEST PORTAL | Matrix в bitrix24-integration.md; реальный портал не использовался |

Ни один пункт не помечен VERIFIED WITH REAL POSTGRESQL, VERIFIED IN BROWSER, VERIFIED IN DOCKER или VERIFIED ON TEST SERVER: соответствующих доказательств нет.

## Исправления этой итерации

- DATE приведён к YYYY-MM-DD независимо от pg/PGlite представления; PostgreSQL sessions используют UTC. Конкретная совместимость native pg остаётся непроверенной.
- Криптографический тест изолирует БД и закрывает pool. Ошибка выявлена первым clean-room прогоном, повторный прогон прошёл.
- Bitrix refresh сравнивает member с installation; adapter отвергает installation чужого portal до запроса.
- API readiness healthcheck, ожидание healthy API со стороны web, shutdown hooks, корректный trust proxy для закрытой Docker-сети.
- Caddy больше не перезаписывает CSP установочного API HTML своей frontend-политикой.
- Выбор работы содержит имя объекта, исключая неоднозначность одноимённых работ.
- UI конфликта версии предлагает обновление. Активная вкладка объекта сохраняется при обновлении snapshot/открытии формы; исправление проверено сборкой, не браузером.
- Добавлены security/tenancy/financial acceptance tests и simulated Bitrix transport tests; проверки повторного accept/transfer усилены.
- Добавлены Playwright UI workflow, clean-room script, изолированный PostgreSQL Compose test profile и test-deployment-runbook.

## Реально выполненные команды

| Команда | Фактический результат |
|---|---|
| docker compose version | FAILED: command not found; это блокер среды |
| npm run db:local (первоначальная попытка) | FAILED: native initdb/root OS-user restriction; helper исправлен на fail-fast без создания пользователя |
| npm install --save-dev @playwright/test | Exit0, dependency/lock сохранены |
| npm test | 24 tests, 24 pass, 0 fail; см. security-results.txt |
| npm run build | Exit0; typecheck + Vite build; остаётся предупреждение bundle >500KB |
| npm run test:browser -- --list | Exit0, найден один browser workflow; НЕ запуск браузера |
| python scripts/clean-room.py (первая попытка) | npm ci/build прошли, crypto test выявил незакрытый PGlite resource; сохранён first-failure log |
| python scripts/clean-room.py (повтор после исправления) | Exit0, все 9 команд; clean-room.json |
| npm ci --fetch-retries=0 --fetch-timeout=20000 | Exit0 в новой копии, без исходного node_modules |
| npm test в чистой копии | 24 pass / 0 fail |
| npm run db:migrate ×2; npm run db:seed ×2 | Все exit0 на новой PGlite disk DB |
| node --import tsx scripts/runtime-smoke.ts | Exit0: frontend / и /objects, proxy health/ready, mock login, Dashboard10 |
| Cloud browser goto localhost:5173 | FAILED: ERR_BLOCKED_BY_CLIENT, browser-attempt.txt |

Полные журналы находятся в tests/acceptance. Чистая копия создаётся вне проекта, без БД/старых volumes; PGlite запускается последовательно одним процессом. Для PostgreSQL отдельный gate подготовлен в docker-compose.acceptance.yml, но не выполнялся. Тесты не доказывают нагрузочную стабильность или все варианты каскадов/изоляции PostgreSQL.

## Следующий обязательный шаг

На доступном тестовом сервере выполнить docs/test-deployment-runbook.md: Docker build → отдельный PostgreSQL acceptance profile → migrations/seed приложения → HTTPS → Playwright workflow и визуальная оценка screenshots. Исправить найденные ошибки, повторить gates. Затем создать локальное UI-приложение на тестовом Bitrix24 с `/api/auth/bitrix/install` и `/api/auth/bitrix/launch`, задать тестовые credentials и проверить реальный OAuth/iframe/refresh. Production/Marketplace не затронуты.
