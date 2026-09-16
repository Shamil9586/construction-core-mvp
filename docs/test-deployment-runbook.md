# Техническая приёмка на тестовом сервере (self-hosted)

Статус 15.09.2026: подготовлено, НЕ выполнено в Docker/на выделенном сервере
этого профиля. Локальные доказательства — `status.md` и `tests/acceptance`.
Production не использовать. Фактически исполненная и проверенная test-среда
(Render, не self-hosted) — [`deployment-render.md`](deployment-render.md).

## Сервер и сеть

Рекомендуемый минимум для теста: Linux x86_64, 2 vCPU, 4 GB RAM, 20 GB свободного диска, Docker Engine с Compose v2. DNS A/AAAA для отдельного тестового имени. Входящие 80/443 для Caddy/ACME; PostgreSQL и API не публикуются. Исходящие HTTPS к registry/npm, ACME и официальным Bitrix/OAuth endpoints. Node.js 24 нужен на машине, выполняющей Playwright, Python 3 — только для локального clean-room script.

## Установка из архива

Распаковать в отдельный release-каталог. Все команды далее из корня проекта. Команды в этом документе — инструкции предстоящей серверной проверки, а не журнал выполненных команд.

```bash
cp .env.example .env
chmod 600 .env
```

Заполнить `.env`:

| Переменная | Значение |
|---|---|
| APP_HOST | DNS-имя без схемы, например construction-test.example.com |
| APP_ORIGIN | https://construction-test.example.com, без завершающего / |
| AUTH_MODE | mock на этапе технической приёмки |
| MOCK_LOGIN_KEY | Случайный пароль только этой тестовой среды |
| POSTGRES_PASSWORD | Случайный URL-safe пароль; например 32 случайных байта в hex |
| TOKEN_ENCRYPTION_KEY | 32 случайных байта в hex, хранить отдельно от backup БД |
| NODE_ENV | test |
| DB_MODE | postgres (Compose принудительно устанавливает) |
| BITRIX_FRAME_ORIGIN | Точный HTTPS origin будущего тестового портала |
| BITRIX_* | До этапа интеграции credentials не заполнять |

Сгенерировать каждый секрет независимо через `openssl rand -hex 32`. Не копировать вывод в issue/log. DATABASE_URL внутри контейнеров задаёт Compose. Внешняя .env DATABASE_URL используется только при ручном запуске Node; npm сам .env не загружает. TRUST_PROXY_HOPS=1 устанавливает Compose для API, доступного только за Caddy.

```bash
docker compose config --quiet
docker compose build
docker compose up -d db migrate
docker compose wait migrate
docker compose run --rm --no-deps api node --import tsx scripts/seed.ts
docker compose up -d api worker web
docker compose ps
docker compose exec db pg_isready -U construction -d construction
docker compose exec api node scripts/healthcheck.mjs
curl --fail https://construction-test.example.com/api/health
curl --fail https://construction-test.example.com/api/ready
```

migrate должен завершиться с 0; api healthy. Seed — только mock/test, повторный запуск идемпотентен. Caddy выдаёт HTTPS сертификат; frontend `/`, backend `/api`, OpenAPI `/api/api-docs`. `/ready` проверяет доступ к БД. После перезапуска API повторить readiness и UI login; после перезапуска db дождаться восстановления API. Persistent volumes: pgdata, caddydata, caddyconfig. Вложения MVP находятся в БД и входят в backup. Не запускать seed после перехода к реальным данным портала.

## Изолированная PostgreSQL приёмка

Данный профиль НЕ использует pgdata приложения. БД construction_test хранится в tmpfs. Для повторного прогона удалить только два контейнера acceptance, не рабочие volumes.

```bash
export ACCEPTANCE_DB_PASSWORD="$(openssl rand -hex 24)"
docker compose -f docker-compose.yml -f docker-compose.acceptance.yml --profile acceptance up --build --abort-on-container-exit --exit-code-from acceptance-tests acceptance-tests
```

Ожидается 24 tests / 0 failed. HTTP/security tests используют настоящий pg драйвер; криптографические/Bitrix transport unit tests остаются на PGlite намеренно. Migrations применяются по порядку под advisory lock; два применения не создают дубликаты. Проверяются numeric/UUID/DATE UTC/timestamptz/JSONB/FK/indexes/restrict, rollback, версии, два tenant, RBAC, повтор приёмки/передачи/закрытия. Проверки охватывают используемые ключевые ограничения, не все возможные комбинации FK/cascade.

```bash
docker compose -f docker-compose.yml -f docker-compose.acceptance.yml --profile acceptance rm -sf acceptance-tests acceptance-db
```

Эта команда удаляет только одноразовые тестовые контейнеры. Не использовать `down -v` для основного проекта.

## Browser E2E и визуальная проверка

На тестовой машине с Node 24, доступом к HTTPS приложения и браузером:

```bash
npm ci
npx playwright install --with-deps chromium
export BROWSER_BASE_URL=https://construction-test.example.com
read -rs MOCK_LOGIN_KEY
export MOCK_LOGIN_KEY
npm run test:browser
```

Ввести установленный mock key в read. Тест создаёт уникальный объект, назначает существующих РП и подрядчика через UI, выполняет физический факт 10/20 → 20/20, СК/фото/замечание/повторную проверку, блокировку/допуск, материалы, ИД, СДО и закрытие. Проверяет видимые проценты, отклонение, изменения KPI и аудит. Визуальные артефакты в test-results; HTML отчёт playwright-report. Тест использует ADMIN для сквозного UI; запреты каждой роли проверяются отдельными HTTP тестами. Тестовые документы — синтетические, не юридические файлы.

Browser test пока только typechecked/discovered, не исполнялся. Его первый запуск может выявить ошибки селекторов/синхронизации; исправить и прогнать снова, не считать HTTP E2E заменой.

При ручной визуальной приёмке просмотреть Dashboard, объекты/карточку, производство, СК, ПТО, СДО, финансы и подрядчиков в 1440×1000. Проверить таблицы, суммы/даты, причины блокировок, подписи светофора, loading/error/empty. Тест проверяет отсутствие переполнения страницы и сохраняет screenshots, но не заменяет визуальную оценку текста/таблиц. Не выставлять VERIFIED IN BROWSER до полного успешного сценария и просмотра снимков.

## Backup / rollback

До обновления сохранить release-архив, конфигурацию и ключ шифрования в защищённом хранилище. Backup содержит персональные данные и вложения.

```bash
umask 077
mkdir -p backups
docker compose exec -T db pg_dump -U construction -d construction -Fc > backups/construction-before-update.dump
```

Проверить restore в отдельной пустой тестовой БД через `pg_restore --exit-on-error`; зафиксировать результат. В этой итерации restore drill не выполнялся. Миграции только вперёд; автоматических down migrations нет. Для rollback при совместимой схеме остановить API/worker/web и запустить предыдущие образы. При несовместимой схеме восстановить backup в отдельный PostgreSQL instance/volume, проверить readiness и переключить DATABASE_URL. Не восстанавливать поверх текущей БД без отдельного разрешения на потерю изменений. Не удалять рабочие volumes.

## Точный следующий шаг Bitrix24

После успешных PostgreSQL + browser gates создать локальное серверное приложение с UI на ТЕСТОВОМ портале. Handler `https://APP_HOST/api/auth/bitrix/launch`, installation handler `https://APP_HOST/api/auth/bitrix/install`. Заполнить BITRIX_PORTAL (без схемы), BITRIX_MEMBER_ID, BITRIX_CLIENT_ID, BITRIX_CLIENT_SECRET, BITRIX_ADMIN_USER_ID, точный BITRIX_FRAME_ORIGIN; переключить AUTH_MODE=bitrix и пересоздать API/worker. Минимально user scope; остальные только для проверки используемых providers, см. integration matrix.

Проверить установку мастером, BX24.installFinish, повторный iframe launch, user.current, двух назначенных пользователей/роли, encrypted token storage, refresh/rotation и отказ чужому portal/member. Не печатать токены. Проверить реальный Origin POST/CSP/sessionStorage. При неизвестном формате ответа сохранять редактированный пример без секретов и исправлять parser; не отключать проверки. Только после этого отдельно тестировать Disk/im/task providers. Реальная интеграция пока REQUIRES BITRIX24 TEST PORTAL.


## Исполняемая проверка восстановления

Только на выделенном тестовом deployment:

```bash
CONFIRM_TEST_ENVIRONMENT=yes bash scripts/backup-restore-check.sh
```

Script делает pg_dump в защищённый файл, создаёт новую уникальную recovery_*_test БД, выполняет `pg_restore --exit-on-error --single-transaction`, проверяет migrations/объекты/работы/audit/суммы и пробную транзакцию с rollback. Исходная БД/volumes не удаляются и не перезаписываются. Recovery БД оставляется для проверки. Команды восстановления теперь воспроизводимы, но здесь НЕ выполнены: запуск остановился из-за отсутствия Docker. Дополнительно на сервере нужно проверить приложение с восстановленной БД и сравнить содержимое с backup snapshot, прежде чем принимать recovery gate.
