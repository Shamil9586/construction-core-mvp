# GPR-2 — постоянный контур независимой технической приёмки

> Этот R04-специфичный workflow **заморожен** как эталон принятого запуска 39788979618. Универсальный контур для R05+ — `.github/workflows/gpr2-acceptance.yml`, см. [`gpr2-ci-foundation.md`](gpr2-ci-foundation.md).

Статус: **DRAFT / НЕ АКТИВИРОВАНО**. Размещено на подготовительной ветке; никакого запуска, merge или deploy не производилось.

## Зачем отдельный workflow, если уже есть .github/workflows/claude.yml?

`claude.yml` — отдельный **AI automation** путь для комментариев `@claude`, работающий с Claude OAuth и правами GitHub на запись. Его M1-A acceptance ещё не завершён. Не изменять и не объединять с тестовым CI до самостоятельной приёмки безопасности.

`.github/workflows/gpr2-independent-acceptance.yml` — ручной **non-AI** контроль native PostgreSQL и браузера. Без Claude, без OAuth-токенов, без MCP, без GitHub write permissions, без Render/Bitrix24/LIVE. Это не альтернативный продукт и не второй репозиторий.

## Предусловия запуска (отдельные решения владельца)

1. Прочитать и независимо проверить этот draft PR, убедиться в отсутствии побочного влияния на `main` и PR №4.
2. Отдельно разрешить merge только workflow и helper-файлов на `main`. Для `workflow_dispatch` определение должно находиться на default branch. **Само размещение на draft-ветке не даёт возможности завершить тест.**
3. Отдельно разрешить публикацию локального кандидата R04 на **test/review** ветку без merge и deploy. Исходный exact commit `b882fd0a35fe93d5f85d6be1ccd7dfdc6982f67d` сейчас представлен лишь в Git bundle, поэтому его нужно перенести через `git fetch <bundle>` + отдельный `git push` из авторизованного локального checkout. SHA/parent/tree обязаны сохраниться.
4. Ручной запуск: Actions → **GPR-2 Independent Acceptance (PostgreSQL + Chromium)** → Run workflow; branch **main**; exact SHA; confirmation `APPROVE_R04_TEST_ONLY`.
5. Сохранить artifact `gpr2-r04-independent-runtime-evidence` и передать **другому** независимому reviewer для итогового вердикта.

## Защита

- Проверяется Git SHA `b882fd0...`, tree `2f5d364...` и цепочка `main 92fcf6d → R04 e7ddcf6 → CP01 169ae90 → CP02 b882fd0`.
- Runner: ubuntu-24.04, Node 22.22.0, `npm ci`, Playwright Chromium из lockfile.
- PostgreSQL 16: новый runner-owned cluster `gpr2-p1-isolated` на 127.0.0.1:54329; ни один тест не принимает LIVE host. Native helper проверяет marker/address перед CREATE/DROP БД.
- `permissions: contents: read`, `persist-credentials: false`, нет production secrets.
- Native: GPR-2 R02/R03/R04, migration upgrade, race/locks, guards.
- Browser: GPR-1 suite, 1440 и 390 px, контроль 22/22 без ложной зелёной приёмки.
- Логи и exit codes сохраняются при отказе. Cleanup PostgreSQL — всегда.
- Финальный PASS CI означает только выполненные технические gates. Не равен независимому `ACCEPTED`, не запускает merge/deploy.

## На будущие этапы

Для R05+ менять точную allowlist SHA, тесты и критерии через отдельный проверяемый PR; общие helper для PostgreSQL/Chromium переиспользовать.

Если GitHub Actions недоступны или что-то заблокировано — фиксировать BLOCKED; **не** отключать guards и не запускать на LIVE.
