# Текущий приоритет: PRODUCT FIRST

Актуальный результат — docs/product-status.md. Записи ниже сохраняют историю инфраструктурной приёмки; она больше не блокирует работу над интерфейсом.

# Technical acceptance — current status

Текущая итерация: проверка доступности HTTPS test environment, 15.09.2026.
**LOCAL MVP VERIFIED. TEST ENVIRONMENT NOT VERIFIED.**
Исторические локальные доказательства: [acceptance-local-baseline.md](acceptance-local-baseline.md). Они не являются новым прогоном на сервере.

## A. Verified locally

24 теста и HTTP E2E прошли в предыдущей итерации на PGlite. Проверены RBAC, два tenant, optimistic concurrency, Decimal/финансовые ограничения, rollback, повтор операций и AuditLog. Clean-room npm ci/build/tests/migrations×2/seed×2/smoke прошёл. В этой итерации эти тесты не повторялись: код бизнес-логики не изменялся.

## B. Verified with real PostgreSQL

NOT VERIFIED. psql/Docker/Podman не найдены. Результаты PGlite не перенесены в эту категорию. Native root restriction из предыдущей итерации не обходилась.

## C. Verified in Docker

NOT VERIFIED. Docker CLI отсутствует. Compose build/start/restart/volumes gates не выполнены. Проверен только синтаксис нового backup script, его выполнение завершилось exit2 до любых действий с БД.

## D. Verified on HTTPS test server

NOT VERIFIED. Внешний URL не создан. Изучены фактически доступные возможности AppDeploy: backend требует @appdeploy/sdk router, frontend — собственный client/HashRouter; интерфейс не предоставляет запуск существующего Compose стека. Перенос в этот runtime не выполнен, поскольку не доказывает нужные gates и требует изменения реализации.

DigitalOcean подключён. Account API вернул status=warning и сообщение о достижении максимального количества Droplets (droplet_limit=3). List droplets и list sizes вернули HTTP403: feature not available for your account at this time. Создание сервера не выполнялось. Адрес и доступ к существующему test VPS также отсутствуют. Никакие облачные ресурсы не созданы, production не использован.

## E. Verified in browser

NOT VERIFIED. Существующий Playwright workflow написан и обнаружен в предыдущей итерации. Новый HTTPS deployment отсутствует; browser run/screenshots/visual QA в этой итерации не выполнялись.

## F. Verified on Bitrix24 test portal

NOT VERIFIED. Проверка намеренно не начата до PostgreSQL/Docker/browser gates. Сохранены IMPLEMENTED и MOCK VERIFIED для соответствующих adapter contracts; это не live OAuth verification.

## G. Not verified

Native PostgreSQL; Docker build/runtime; HTTPS/CORS/CSP внутри реального ingress; browser workflow и visual QA; clean server deployment; backup/restore; Bitrix installation/iframe/OAuth/refresh/current user/Disk/notifications. Нет оснований выставлять CORE TEST ENVIRONMENT VERIFIED.

## H. Known limitations

AppDeploy не является доступом к VPS/Compose. DigitalOcean подключён, но операции инфраструктуры недоступны из-за ограничения аккаунта (HTTP403). Локальная среда остаётся без Docker. Подготовлен scripts/backup-restore-check.sh: делает pg_dump, восстанавливает в новую отдельную БД, выполняет SQL smoke, сохраняет recovery DB; не меняет DATABASE_URL и не удаляет volumes. Его реальное выполнение требует Docker test server.

## I. Production blockers

Все непройденные test gates; непроверенный restore; live Bitrix auth/iframe/refresh; нагрузочная и production security приёмка. Production запрещён этой задачей.

## Изменения и фактические команды этой итерации

- Добавлен backup/restore script и точная команда в runbook; business-код не изменён.
- status.md приведён к структуре A–I; предыдущие доказательства сохранены отдельно.
- command -v docker / podman / psql: не найдены; command -v ssh: /usr/bin/ssh, но test host отсутствует.
- bash -n scripts/backup-restore-check.sh: exit0, синтаксис корректен.
- bash scripts/backup-restore-check.sh: exit2, Docker отсутствует; tests/acceptance/recovery-attempt.txt.
- Изучены deployment constraints AppDeploy. DigitalOcean подключён; выполнены account_get_information, droplet_list, size_list. Account warning / два HTTP403.

Следующий шаг: устранить ограничение аккаунта DigitalOcean через его панель/поддержку либо предоставить доступ к существующему выделенному test VPS. Подключать плагин повторно не требуется. После появления доступа выполнить неизменённый Compose deployment/runbook и gates; сначала проверить возможности и стоимость создания VPS, затем создавать инфраструктуру согласно доступной авторизации. Bitrix credentials пока не нужны.


## GitHub / Railway package preparation

Current deployment target: Railway TEST. DigitalOcean is no longer a deployment target; its resources were not changed. Render unused. Source preparation only: no GitHub publication, Railway deployment or browser gate in this iteration.

Updated gitignore/dockerignore exclude environments, logs, build output, dependency folders, database files/backups, test reports and workbook-derived report. No Git repository/history existed in the source directory. Candidate files inspected with scripts/repository-audit.py; no detected private keys, provider tokens, JWT credentials or non-placeholder credential URLs. This heuristic scan is not a guarantee against all secret formats. Fixture credentials are deliberately synthetic, limited to isolated tests.

Backend uses runtime PORT and binds 0.0.0.0; DATABASE_URL takes precedence over PGlite selection. Caddy upstream is runtime-configurable, keeps SPA fallback and same-origin /api. Existing api/web Docker stages retained; APP_TARGET build argument selects the final stage for services without a --target option. Container build/runtime remains NOT VERIFIED. Deployment parameters: docs/github-railway-readiness.md.
