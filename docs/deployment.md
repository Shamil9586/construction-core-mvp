# Тестовое развёртывание

Docker/Compose конфигурация подготовлена, но не запускалась в данной среде. Не считать её проверенной до выполнения на тестовом хосте.

## Требования

Linux-хост с Docker Compose v2, DNS имя, доступные 80/443. Сеть базы не опубликована на хост. Caddy завершает HTTPS, отдаёт frontend и проксирует `/api` к NestJS. API и worker используют PostgreSQL, а не PGlite. Узлы application выполняются от node user. Секреты в `.env`, файл не включён в архив/образ/git.

## Запуск

1. `cp .env.example .env`.
2. Заменить POSTGRES_PASSWORD, MOCK_LOGIN_KEY, TOKEN_ENCRYPTION_KEY случайными значениями. Для случайных строк можно использовать `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
3. Для test/mock: AUTH_MODE=mock, NODE_ENV=test, APP_HOST=ваш DNS, APP_ORIGIN=https://ваш-DNS. DATABASE_URL в Compose собирается автоматически, пароль должен быть URL-safe.
4. `docker compose up --build -d`.
5. `docker compose run --rm api node --import tsx scripts/seed.ts` — только test/mock; seed помечен demo.local.
6. Проверить `https://APP_HOST/api/health`, `https://APP_HOST/api/ready`, вход и Dashboard.
7. Выполнить `npm test` с E2E_DATABASE_URL для пустой выделенной PostgreSQL БД `_test`, затем ручной browser E2E.

Не подключать seed к реальному tenant. Для настоящего test Bitrix перевести AUTH_MODE=bitrix и пройти установку; demo tenant останется отдельным.

## Lifecycle

Рекомендуемый следующий gate: Docker build, clean migrations, seed, API E2E на PostgreSQL 17, затем browser E2E и тестовый Bitrix. Перед обновлением — резервная копия через pg_dump. До production провести проверку восстановления и миграций на копии. `docker compose down` сохраняет named volumes; `down -v` удаляет БД — не применять для рабочих данных.

APP_HOST=localhost использует локальный CA Caddy, это не публичный сертификат для Bitrix. Нужен реальный DNS и доверенный сертификат. В этой задаче внешний сервер и HTTPS URL не создавались.

## Observability

Request id, JSON access logs без body/Authorization; `/health`, `/ready`. SQL/секреты в пользовательских ошибках не раскрываются. PGlite — только одно приложение в одном процессе. PostgreSQL допускает отдельный worker; он пересчитывает health и локальную эскалацию каждую минуту, не отправляя сообщения в Bitrix.
