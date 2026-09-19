# Текущий статус

Обновлено: 19.09.2026. Этот файл — единственный источник актуального
статуса; исторические промежуточные версии заменены этим документом и
остаются доступны в git-истории при необходимости, а не дублируются здесь.

## Итог

**Core 2.1 Final Post-Review Correction Pass завершён.**

* branch: `feature/core-2.1`
* HEAD: `9dd53eb`
* baseline checkpoint (review snapshot до этого прохода): `62bf5e2`
* `main` не изменён, Core 2.1 в `main` не смёржен
* baseline tag `core-2.1-before-implementation` не изменён
* локальные safety-указатели: `safety/core-2.1-before-claude-limit`,
  `safety/core-2.1-post-review-62bf5e2` (обе — только локальные ветки-метки,
  не запушены)

Этот проход исправил business-integrity/concurrency findings независимого
Work review поверх уже пройденного (отдельно) READ-ONLY security-guidance
review commit `62bf5e2`. Security-guidance review не нашёл tenant-isolation
bypass, IDOR, SQL injection или обхода projectManagerId authorization ни на
`main...62bf5e2`, ни на корректирующем diff `62bf5e2...HEAD`.

## Gates этого прохода

| Gate | Статус |
|---|---|
| F1 — remove-contractor адресует конкретный экземпляр relation | PASS |
| F2 — progress() не реактивирует работу снятого подрядчика | PASS |
| F3 — concurrency-тест: корректные HTTP-статусы гонки | PASS |
| F4 — object history показывает ASSIGN/REMOVE подрядчика | PASS |
| F6 — `startDate` восстановлен в partial Object Edit whitelist | PASS |
| F7 — regression-покрытие реальным cross-tenant сценарием | PASS |
| Security-guidance re-review (`62bf5e2...HEAD`, read-only) | PASS — 1 finding (auth-before-validation ordering, низкая severity, без реальной эксплуатации), исправлено коммитом `485264c` |
| `npm test` (PGlite) | PASS — 33/33 |
| `npm run build` (tsc + Vite) | PASS |
| Runtime smoke (`scripts/runtime-smoke.ts`) | PASS |
| PGlite: fresh migrate | PASS |
| PGlite: repeat migrate (idempotency) | PASS |
| PostgreSQL (реальный, локальный embedded instance, не PGlite): fresh + repeat migrate | PASS |
| Core 2.1 contractor tests на реальном PostgreSQL | PASS |
| `createWork ↔ removeContractor` concurrency на реальном PostgreSQL | PASS |
| `progress ↔ removeContractor` reactivation concurrency на реальном PostgreSQL | PASS |
| Core 2.1 browser specs (`contractors.spec.ts`, изолированный прогон) | PASS — 2/2 |
| Полный Playwright suite (`contractors.spec.ts` + `director.spec.ts` + `workflow.spec.ts`) | **FAIL** — см. ниже |

### Известная проблема: `tests/browser/workflow.spec.ts:6`

Этот тест падает по таймауту (180000ms) **только** при прогоне в составе
полного suite (после `contractors.spec.ts` и `director.spec.ts` в одном
worker), и **не падает** при изолированном прогоне — в изоляции он проходит
за 16–17 секунд как на `feature/core-2.1` (HEAD этого прохода), так и на
baseline (`core-2.1-before-implementation`, commit `9a2e39c`, отдельный
git worktree, отдельная свежая PostgreSQL база). Padение дважды
воспроизведено на одной и той же строке (`workflow.spec.ts:23`, клик по
табу «ПТО / документы» сразу после `page.goto(objectUrl)`, следующего за
привязкой материала), что указывает на деградацию состояния/ресурсов при
последовательном прогоне нескольких browser-тестов в одном worker (Vite
dev-сервер, соединения с БД, накопленные тестовые данные), а не на
логическую ошибку в production-коде: ни один из файлов, затронутых
Core 2.1 corrective commits (`objects.controller.ts`, `service.ts`,
`validation.ts`, `main.tsx`), не находится на пути логина, привязки
материалов или вкладки «ПТО / документы». Отдельно при том же изолированном
прогоне (`workflow.spec.ts` + Excel-import тест, без `contractors.spec.ts`)
наблюдался ещё один, отличный по месту, кратковременный login-related
таймаут — то есть общая картина указывает на нестабильность
тестовой инфраструктуры/окружения при повторных запусках, а не на
детерминированный, воспроизводимый в изоляции баг.

**Не объявляется full Playwright PASS.** Этот файл не менялся и не
чинился в рамках этого прохода (вне scope). Требуется отдельная
test-stability задача с профилированием (в частности — почему повторный
прогон в одном worker после других browser-тестов ведёт себя иначе, чем
изолированный).

## Corrective commits этого прохода (`62bf5e2..HEAD`)

1. `6791214` — F1: remove-contractor адресует relation по её собственному id
2. `2f51b71` — F2: progress() требует активной contractor-relation для
   недоступных вне-COMPLETED статусов
3. `24312a2` — F3: исправлено неверное предположение о HTTP-статусе в
   concurrency-тесте (`@Post` по умолчанию — 201, не 200)
4. `291dbf0` — F4: object history включает ObjectContractor ASSIGN/REMOVE
5. `314e3cc` — F6: `startDate` восстановлен в whitelist partial Object Edit
6. `9dac223` — F7: regression-покрытие реальным cross-tenant сценарием
7. `485264c` — hardening: authenticate() до валидации тела запроса в
   removeContractor (найдено при security-guidance re-review)
8. `607679e` — исправление: object history фильтр не должен `JSON.parse`
   уже распарсенное jsonb-значение (найдено при browser gate)
9. `9dd53eb` — browser-тест: подтверждение `startDate` в Object Edit форме

## Что изменилось в продукте в этом проходе

* `removeContractor` теперь требует `relationId` в теле запроса и
  адресует конкретный экземпляр `object_contractors`, а не только пару
  (object, contractor) — защита от stale-remove после reassign.
* `progress()` (корректировка факта работы) проверяет активную
  contractor-relation через тот же `FOR UPDATE`-lock, что и
  `removeContractor`/`createWork`, прежде чем перевести работу в
  `ACTIVE` — снятый подрядчик не может получить реактивированную работу.
* Object Edit whitelist снова включает `startDate` (ранее одобренное
  решение, не полностью перенесённое в реализацию/документы).
* Object card «История» показывает ASSIGN/REMOVE подрядчика, включая
  снятые (removed) relation, не только текущие активные.

## Архитектурные решения (зафиксированы ранее, не пересматривались в этом проходе)

* БД: raw `pg` + SQL-миграции + PGlite для dev/test. Prisma не вводится.
* Bitrix24: `MockBitrixAdapter`. Реальный/тестовый портал — только с
  отдельного разрешения пользователя; в этом проходе не трогался.
* Прошлые деплой-статусы (Render TEST, HTTPS, живой URL) относятся к
  более ранней итерации Core 2.0/до-Core-2.1-слияния и **не переверялись
  в этом проходе** — при необходимости актуального deployment-статуса
  Core 2.1 требуется отдельная задача (эта сессия деплой не трогала,
  согласно ограничению scope).

## Известные ограничения

* `tests/browser/workflow.spec.ts:6` — см. выше; не исправлялся в этом
  проходе намеренно.
* Bitrix24 real/test portal integration не проверена — остаётся на моках.
* Полный Playwright suite не проходит целиком за один прогон в этой
  локальной среде; см. известную проблему выше.
