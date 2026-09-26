# Текущий статус

Обновлено: 19.09.2026. Этот файл — единственный источник актуального
статуса; исторические промежуточные версии заменены этим документом и
остаются доступны в git-истории при необходимости, а не дублируются здесь.

## Итог

**Core 2.1 Final Post-Review Correction Pass завершён.**

* branch: `feature/core-2.1`
* последний substantive (non-docs) commit: `9dd53eb`; после него следуют
  только docs-only коммиты этого файла — точный текущий HEAD см. `git log`
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
| Core 2.1 targeted browser specs (`contractors.spec.ts`, изолированный прогон) | PASS — 2/2 |
| Полный Playwright suite (`contractors.spec.ts` + `director.spec.ts` + `workflow.spec.ts`) | **FAIL** |

### Browser test stability: unresolved, separate gate

**Core 2.1 targeted browser specs: PASS 2/2. Full Playwright suite: FAIL.**

Intermittent browser-test instability was observed with more than one
failure signature, including workflow/navigation and login/mock-auth
related symptoms. Current evidence does not establish a deterministic
Core 2.1 production regression, but it also does not prove that every
observed failure signature is baseline-equivalent. Browser stability
remains a separate unresolved test-stability gate, not declared PASS or
attributed with certainty to any single cause.

Observed datapoints from this session (local embedded PostgreSQL, one
worker, sequential runs — not an exhaustive or statistically-sized sample):

* Full suite on `feature/core-2.1` (run 1): `workflow.spec.ts:6` FAIL —
  180000ms timeout, stuck on a tab click (`workflow.spec.ts:23`,
  «ПТО / документы») shortly after a `page.goto(objectUrl)` that follows
  materials binding.
* `workflow.spec.ts` alone (baseline, `core-2.1-before-implementation` /
  `9a2e39c`, separate worktree + fresh DB): both tests in the file PASS,
  ~16–22s total.
* `workflow.spec.ts` alone on `feature/core-2.1`: the main test
  (`workflow.spec.ts:6`) PASS (~16.7s), but the file's second test
  (`Admin: импорт Excel переживает перерендер App`) FAIL — a different
  symptom (login heading not visible after clicking «Войти», 15000ms
  timeout) at a different line, unrelated to the run-1 failure above.
* Full suite on `feature/core-2.1` (run 2, fresh DB): `workflow.spec.ts:6`
  FAIL again, same line/signature as run 1.

None of the failure lines above fall inside any file touched by the
Core 2.1 corrective commits (`objects.controller.ts`, `service.ts`,
`validation.ts`, `main.tsx`) — login, materials binding, the PTO tab, and
the Admin Excel-import flow are all outside this pass's diff. That is
suggestive, not conclusive: the sample size is small (2 full-suite runs,
2 isolated runs) and the failure signature was not identical between
observations, so equivalence to any previously-described baseline
failure is not established either.

**Not declared full Playwright PASS.** `workflow.spec.ts` was not modified
in this pass (out of scope). This needs a dedicated test-stability
investigation with a larger sample and profiling — in particular why
sequential-run behavior differs from isolated runs, and whether the two
distinct failure signatures observed share a root cause.

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
