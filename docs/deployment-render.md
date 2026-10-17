# Render test deployment — historical verified record

Статус: **HISTORICALLY DEPLOYED AND VERIFIED**, 16.09.2026. Документ фиксирует
конфигурацию и проверки на указанную дату, а не гарантирует текущее состояние
LIVE. Кандидат CR01 startup patch `544ca38a120007849c74bbe34f0376278b670e60`
не принят окончательно и не опубликован в LIVE. До отдельного разрешённого
релиза фактическое поведение LIVE определяется реально развёрнутым SHA и
настройками Render. Не используйте исторические команды этого документа как
актуальную инструкцию по выполнению миграций.

Это исторический журнал того, что было создано и проверено, а не план на будущее
(в отличие от `test-deployment-runbook.md`, который описывает отдельный self-hosted
Docker Compose трек на произвольном Linux-хосте).

Deployment target изначально планировался как Railway (см. историю в
`status.md`), но был **сменён на Render** в этой итерации: у существующего
Railway-аккаунта free plan отказал в создании нового проекта
(`Free plan resource provision limit exceeded`, аккаунт уже занят двумя
проектами параллельного эффорта `construction-erp-mvp*`). Приложение не
привязано к Railway — `infra/Dockerfile` собирает стандартные `api`/`web`
стадии через `APP_TARGET` build ARG, поэтому перенос на другой Docker-хостинг
не потребовал изменения продукта, только деплой-конфигурации.

## Живые сервисы

| Сервис | Тип | URL |
|---|---|---|
| `construction-core-web` | Docker web service (Caddy, стадия `web`) | https://construction-core-web.onrender.com |
| `construction-core-mvpconstruction-core-api` | Docker web service (Node, стадия `api`) | https://construction-core-mvpconstruction-core.onrender.com |
| `construction-core-db` | Managed PostgreSQL 18 | внутренний, приватная сеть Frankfurt |

Все три — план **Free**, регион Frankfurt. Backend-сервис получил кривое имя
`construction-core-mvpconstruction-core-api` из-за известного глюка Render UI
(поле Name не всегда очищает автоподставленное значение через синтетический
ввод — сработало только через установку `.value` напрямую с диспатчем React
события). Это чисто косметическая проблема; URL рабочий, переименование не
выполнялось намеренно, чтобы не тратить второй раунд перепривязки
`APP_ORIGIN`/`BACKEND_UPSTREAM`.

## Ограничения free-плана, зафиксированные 16.09.2026

- **Cold start** (наблюдение на 16.09.2026): инстансы засыпали после ~15 минут
  бездействия; первый запрос после сна мог занимать 30–60 секунд.
- PostgreSQL free-тариф и grace period были описаны по условиям на 16.09.2026.
  Перед любым восстановлением проверьте текущий план, срок хранения и доступные
  операции в Render: эти условия могут измениться.
- На дату исторического deployment free-план не предоставлял доступный
  отдельный one-off/pre-deploy migration job. Поэтому **старая развёрнутая
  ревизия** включала миграции и seed в Docker CMD. Это историческое описание,
  а не рекомендуемый порядок для CR01. Кандидат CR01 намеренно убирает миграции
  и seed из обычного API startup. Без отдельного проверенного и разрешённого
  migration path нельзя считать безопасным пересоздание базы или deployment.

## Два платформенных бага, найденных и исправленных в этой итерации

Оба — реальные несовместимости Render с общеизвестными Docker-образами, не
ошибки в коде приложения; воспроизводимы у любого пользователя Render с
похожим стеком (см. ссылки на community.render.com в git-истории коммитов
`d811fa6`, `b305d9a`).

### 1. `caddy:2-alpine` — `exec /usr/bin/caddy: operation not permitted`

Официальный образ Caddy помечает свой бинарник Linux file capability
`cap_net_bind_service` (чтобы слушать порты <1024 без root). Песочница
Render запрещает exec бинарника с такой capability — контейнер падает сразу
на старте с `exit status 126`. Fix в `infra/Dockerfile`, стадия `web`:

```dockerfile
RUN apk add --no-cache libcap-utils && setcap -r /usr/bin/caddy && apk del libcap-utils
```

Render всегда назначает `PORT` ≥1024 сам, так что capability и не нужна.

### 2. `express-rate-limit` — `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`

Backend стоит за прокси и Render, и Caddy (frontend-сервис проксирует
`/api/*` на backend через `BACKEND_UPSTREAM`), поэтому запросы приходят с
заголовком `X-Forwarded-For`. Без `app.set('trust proxy', ...)` Express
считает это подозрительным и `express-rate-limit` бросает
`ValidationError` → необработанный `TypeError` → 500 на каждый запрос.
Приложение уже поддерживало это (`apps/backend/src/main.ts`,
`TRUST_PROXY_HOPS` env var) — просто переменная не была выставлена в Render
environment. Добавлена `TRUST_PROXY_HOPS=1` в env backend-сервиса.

### 3. (Исторический дефект) Демо-сид не запускался

В одной из ранних ревизий Docker CMD запускал только `scripts/migrate.ts`
(DDL), но не `scripts/seed.ts` (demo tenant `demo.local`, пользователи,
объекты). Поэтому `/ready` мог отвечать `{"status":"ready"}` при наличии
таблиц, а логин не находил tenant. В исторической ревизии, проверенной
16.09.2026, seed был добавлен в boot chain. Это не означает, что seed должен
выполняться при каждом старте: кандидат CR01 убирает seed из обычного startup.

Исторический boot chain (`infra/Dockerfile`, ревизия на 16.09.2026; не текущий
CR01 startup-контракт):

```dockerfile
CMD ["/bin/sh", "-c", "node --import tsx scripts/migrate.ts && node --import tsx scripts/seed.ts && node --import tsx apps/backend/src/main.ts"]
```

## Конфигурация окружения (исторический snapshot на 16.09.2026)

Backend (`construction-core-mvpconstruction-core-api`):

| Переменная | Значение |
|---|---|
| `DATABASE_URL` | Internal Database URL `construction-core-db` (приватная сеть Frankfurt, не публичный хост) |
| `DB_MODE` | `postgres` |
| `NODE_ENV` | `test` (также зашито в Dockerfile `ENV`) |
| `AUTH_MODE` | `mock` |
| `BIND_HOST` | `0.0.0.0` |
| `PORT` | `10000` (Render не проставляет PORT для Docker-сервисов автоматически — нужно явно) |
| `APP_ORIGIN` | `https://construction-core-web.onrender.com` |
| `MOCK_LOGIN_KEY` | сгенерирован отдельно, тестовый |
| `TOKEN_ENCRYPTION_KEY` | 64 hex символа, сгенерирован отдельно |
| `TRUST_PROXY_HOPS` | `1` |
| `APP_TARGET` | `api` (build ARG) |

Frontend (`construction-core-web`):

| Переменная | Значение |
|---|---|
| `BACKEND_UPSTREAM` | `https://construction-core-mvpconstruction-core.onrender.com` |
| `PORT` | `10000` |
| `APP_TARGET` | `web` (build ARG) |

Health Check Path на обоих сервисах: `/health` (backend) — DB-независимый,
специально выбран вместо `/ready`, чтобы Render не считал деплой неудачным
из-за гонки между стартом контейнера и завершением миграций.

## Сквозная проверка (16.09.2026, через browser pane, не curl)

1. `GET /ready` → `{"status":"ready"}` — миграции применены.
2. `GET /` на `construction-core-web.onrender.com` → реальный SPA
   (`Контур строительства`), не заглушка Render "Application loading".
3. Логин mock-ключом → `POST /api/auth/mock` → `201`, редирект на Dashboard
   директора с реальными сид-данными (10 объектов, 8 подрядчиков, светофоры,
   сигналы отклонений).
4. Открыта карточка объекта (`Поликлиника № 4`) — план/факт/отклонение,
   работы, статусы СК/ИД/СДО подтянуты из БД.
5. Сетевые запросы на этой сессии: `/api/me`, `/api/snapshot`,
   `/api/dictionaries`, `/api/users`, `/api/materials`, `/api/audit` — все
   `200`.

Примечание по методике: прямой `curl` из облачной песочницы на
`*.onrender.com` блокируется organization egress policy агента
(`connect_rejected`) — проверка выполнялась через browser pane, который
идёт через устройство пользователя, а не через sandbox-сеть.

## Восстановление после потери или истечения срока хранения PostgreSQL

**STOP: не выполняйте старую процедуру автоматически.** Приведённый ниже
порядок исторически полагался на то, что Docker CMD сам запускает миграции и
seed. Кандидат CR01 намеренно удаляет эти действия из API startup, а сам
кандидат ещё не принят и не опубликован в LIVE.

До создания новой production-базы или изменения `DATABASE_URL` необходимо:

1. Подтвердить фактический LIVE SHA, состояние резервных копий и возможность
   восстановления.
2. Определить и проверить отдельный контролируемый способ запуска `npm run
   db:migrate` на disposable PostgreSQL. Успешный запуск API не доказывает, что
   схема базы создана или обновлена.
3. Отдельно определить необходимость и безопасный способ подготовки данных;
   не запускать `npm run db:seed` автоматически на production.
4. Подготовить проверяемый порядок восстановления и получить отдельное
   разрешение владельца до любых изменений LIVE.
5. После разрешённого выполнения миграций проверить `/ready` и прикладные
   сценарии согласно утверждённому плану восстановления.

Секреты (`MOCK_LOGIN_KEY`, `TOKEN_ENCRYPTION_KEY`) не являются заменой backup
или процедуре восстановления и не должны включаться в отчёты.