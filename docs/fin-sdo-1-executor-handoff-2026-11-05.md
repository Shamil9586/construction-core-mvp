# FIN-SDO-1 — EXECUTOR HANDOFF

**Дата:** 2026-11-05 · **Роль:** исполнитель (Backend/Frontend/PostgreSQL/Security), не reviewer.
**Статус:** `IMPLEMENTED — PENDING INDEPENDENT REVIEW`. FIN-SDO-1 в целом **NOT ACCEPTED**. Это не verdict, не разрешение на merge/LIVE.
**Метки в таблицах:** `PASS (exec)` — проверка реально выполнена исполнителем на указанном кандидате; независимой приёмкой **не является**.

## A. Исходное состояние

| Репозиторий | Что прочитано | Идентичность |
|---|---|---|
| product `construction-core-mvp` | ветки, код, workflow, профили | main `fc98aae5f751aba1a091b4aaf57b9aafe41bef44` (обновлён через GitHub, = ориентир задания); F02 `1d89ecd342e77d1fe9f13bc9bacdc49b41526ead` (tree `27c46dafb99c223fc459f366018dadd73840e7c7`), feature `09fad48e…`, CI-only `4c97a210…` — **HEAD не сдвинулись** |
| docs `construction-core-project-docs` | `CHATGPT_PROJECT_INSTRUCTIONS`, `PROJECT_PROTOCOL`, `WORKSTREAM_REGISTRY`, `DECISION_REGISTER`, `ACCEPTANCE_PROTOCOL` целиком; `SOURCE_REGISTER` — выборочно (FIN/миграции); решения координатора FIN/R05/R06b/R07/R08; отчёт и независимый review FIN×R05 | main `48395c8200d75618bda86725c3c21f42b74b57dc`; blob'ы: INSTRUCTIONS `db4aa265…`, PROTOCOL `6fe04021…`, REGISTRY `a979ff48…`, DECISION_REGISTER `17dd10e7…`, SOURCE_REGISTER `4b6711a1…`, ACCEPTANCE `18fe3d60…` |
| evidence `construction-core-acceptance-evidence` | решения DEC-01…07 (`c45ea954…`), критерии FIN1-01…27 из архитектуры v0.9 (`b847027e…`, прочитаны **выборочно**, таблица критериев), архив F02 | main `f670452ff3d85e1240ee96c5016b09e0a29b3548`; pinned `dde03c36…` доступен; ZIP F02 sha256 `d5c7a23f…77148` — **совпал** с независимым review |

**Не прочитано полностью (честно):** FIN-SDO-0 acceptance report (`b1d1d995…`), полный текст архитектуры v0.9, содержимое ZIP F02 (проверен только digest). Для текущего scope не требовалось.
**Доступ:** чтение всех трёх — подтверждено реальным чтением файлов. Репозитории docs/evidence подключены через `add_repo` (read). Запись в них не использовалась.
**Принятые решения:** DEC-01…07 без изменений; **номер FIN-миграции не назначен** (нет записи после 2026-11-05: 038→R07, 039→R08 условно, FIN — `UNNUMBERED`).
**Ранее подтверждено независимо:** SEC-01-F02 PASS — только candidate `1d89ecd`, run 41463191837. Не повторялось.

## B. Реализация

**Было готово (F02):** обнаружение CORE, HISTORICAL subject/party, буфер ввода, commit с CAS/idempotency/ledger, чтения, 12 таблиц `fin_*`, SECURITY DEFINER-слой под ограниченным FIN-логином, UI `/sdo/plan` (флаг `VITE_FIN_SDO_1`), роуты за флагом `FIN_SDO_1_ROUTES`.

**Сделано в этой сессии (локальный коммит `3be8259…`, merge F02 → main):**
1. **Слияние F02 с актуальным main.** Единственный текстовый конфликт — `tests/helpers/gpr2-writer-scan.ts`; разрешён сохранением обоих вызовов `runCommandTx` и `runFinSdoCommandTx` (как предлагал отчёт 2026-11-03; теперь подтверждено на `fc98aae`, а не на R05-baseline). Остальные общие файлы (`writer-registry.ts`, `AppRoutes.tsx`, `routePaths.ts`) сливаются автоматически.
2. **Найден и исправлен семантический конфликт, невидимый для source-level анализа.** F02 добавлял `FIN_SDO_PLAN_READ/WRITE` в легаси-enum `Permission`. Это (а) молча расширяло `ADMIN: Object.values(Permission)` и (б) ломало закрепление легаси-прав R01 (`tests/gpr2-r01-permissions.test.ts`, 2 теста). Исправление: права убраны из enum; сервис использует уже существовавшие явные `canReadFinPlan/canWriteFinPlan` (ADMIN указан поимённо, DEC-01). Эффект: `packages/domain/index.ts` **байт-в-байт равен main** (blob `68e804a3…`). SQL-проверка ролей не менялась.
3. Новый `tests/fin-sdo-1-access-matrix.test.ts` (4 теста): таблица ролей из DEC-01, написанная вручную; отсутствие наследования от `SDO_VIEW/FINANCE_VIEW`; отсутствие `FIN_SDO_*` в легаси-enum; **паритет списков ролей TS ↔ SQL**.

**Не вводилось:** FIN-2/3 (аудит схемы/кода/UI: ни одного термина AGREED/override/D03/O01/xlsx; 12 таблиц `fin_*`, 9 эндпоинтов, записей в производственные таблицы нет). Нумерованного SQL нет; `schema-UNNUMBERED.sql` blob `2c5e24e5…` **неизменён**.

### Матрица FIN1-01…27

| Критерий | Статус | Основание |
|---|---|---|
| 01, 02, 03 | PASS (exec) | service-verify: CORE ACTIVE/COMPLETED/ARCHIVED, Early Work с NULL, нет F8.3-кейса |
| 04 | PASS (exec) | service + protected |
| 05 | **NOT VERIFIED** (пробел) | UNALLOCATED/NOT_SPECIFIED используются как фикстуры, **отдельного утверждения о non-null ключах/«не выдумывать подрядчика» нет** |
| 06–13 | PASS (exec) | service/protected/http/money; 13 — на protected-пути |
| 14, 15 | PASS (exec) | гонки на обоих путях (service и restricted LOGIN) |
| 16, 17 | PASS (exec) | replay; auth-before-replay, mismatch 409 |
| 18, 19 | PASS (exec) | http + protected + access-matrix (все 11 ролей + неизвестные) |
| 20, 21, 22 | PASS (exec) | service/protected/http |
| 23 | **PARTIAL** | единственное соединение `tx.c`, FIN-коннектор выбирается до BEGIN — PASS (exec); согласованность snapshot при конкурентной записи во время чтения напрямую не утверждается |
| 24 | PASS (exec) | writer-registry/scanner тесты + protected |
| 25 | **BLOCKED** | номер миграции не выделен координатором; применимость FIN-SQL после 029–037 — см. D |
| 26 | PASS (exec) | аудит выше + browser B11 + protected |
| 27 | PASS (exec) | protected + access-matrix |

**Осталось по коду FIN-1:** закрыть пробелы FIN1-05 и FIN1-23 (по одному целевому утверждению в нативном скрипте) — не сделано, нужны только тесты, не продуктовый код.

## C. Безопасность

**Сохранено:** роли DEC-01 (SDO/SDO_HEAD write; GD/Deputy read; ADMIN tenant; остальные deny, неизвестные deny); tenant isolation; ограниченный FIN-логин без прямого DML; SECURITY DEFINER с зафиксированным `search_path`; CAS/idempotency/ledger; неизменяемые original/history; точные суммы (bigint-копейки, строки, без float); fail-closed 500 без утечки деталей; FIN-роуты и UI выключены по умолчанию.
**Выполнено (exec):** 5 нативных FIN-скриптов (ниже), FIN unit-тесты (+16 тестов к main в полном прогоне), 14 Chromium-сценариев (перехваченный API — **не** доказательство RBAC/PG).
**Отсутствует:** независимая проверка интегрированного кандидата; prod-роли/provisioning FIN-логина (не авторизовано); независимый запуск негативных проб reviewer'а на новом SHA.

## D. Интеграция

- **Совместимость с GPR (main `fc98aae`, миграции 001–037):** FIN-SQL применяется после 001–037 без ошибок; 5 нативных скриптов PASS. Конфликты: 1 текстовый (разрешён), 1 семантический (исправлен, п. B2).
- **Миграции:** FIN остаётся `UNNUMBERED`. 035–037 заняты GPR, 038→R07, 039→R08 (условно). Номер выделяет только координатор после свежей инвентаризации.
- **Регресс общего backend (дифференциальный, `npm test`, среда как CR01: PG 16.15 на 5432, `construction_test`, `NODE_ENV=test`):**
  merged `3be8259`: 1329 тестов / 1231 pass / 97 fail; чистый main `fc98aae`: 1313 / 1214 / 98 fail.
  **Падений, возникших только в merged, нет** (97 ⊂ 98); +16 новых проходящих теста. Разница в 1 тест (`D1 reads on native PostgreSQL…` падает только на main) — нестабильность, причина не исследовалась.
- **Находка вне scope FIN (для координатора GPR):** чистый `main` падает на 98 тестах. Доминирующая причина — триггер `r06b_planned_cap_guard` (037) отвергает вставки `work_execution_units` в фикстурах легаси-наборов (id-auto-1/2, pto-package, bitrix-disk-1; 77× HTTP 409 + 8× `R06B: Work planned WEU cap exceeded`), плюс 3× `work_quantity_origins does not exist`. CR01-полный регресс в CI последний раз запускался 2026-10-17; свежего зелёного `npm test` на main нет. **Не исправлялось** (запрет менять GPR ради FIN).
- **CI для независимой проверки:** F02-workflow жёстко привязан к SHA F02 и родителю `946fa30…` и применяет только 001–028 — для нового кандидата непригоден. Универсальный `gpr2-acceptance.yml` для FIN «как есть» не подходит: regex стадий `R\d\d[a-z]?|GPR2-*`, окружение зачищает `DATABASE_URL`, а FIN-скрипты требуют `DATABASE_URL` + `FIN_SDO_ISOLATED_CONFIRM`. Нужен новый reviewed CI-only вариант (профиль/workflow + обёртки скриптов) и отдельное разрешение на dispatch. **Это ограничение полномочий, не отсутствие инфраструктуры** (PG16, Node 22, Chromium в CI есть).
- **Список проверок для интеграционного кандидата:** `tsc`, `build`, FIN unit (4 файла + access-matrix), writer-registry/scanner, R01 permissions, R03a/b/d, 5 нативных FIN-скриптов на цепочке 001–037+FIN, FIN Playwright (14), независимые негативные пробы.

## E. Доказательства (локальные, исполнитель; кандидат `3be8259ef5d4f69f353c8f5045d52d9c14576918`, tree `4ea177c11f5b58bb1e99fafd2700779bbf347e85`)

| Проверка | Результат | Exit |
|---|---|---|
| `tsc --noEmit` | PASS (exec) | 0 |
| `npm run build` | PASS (exec) | 0 |
| FIN unit + R01 permissions + R03b registry (34 теста) | 34/34 PASS (exec) | 0 |
| миграции 001–037 на одноразовой PG 16.15 (loopback, `*_test`) | PASS (exec) | 0 |
| native pg / service / http / protected / sec01-f01 | 28 / 22 / 11 / 58 / 73 `PASS`-строк | 0 / 0 / 0 / 0 / 0 |
| Playwright FIN (Chromium) | 14/14 (exec, intercepted API) | 0 |
| полный `npm test` merged vs main | см. D | 1 / 1 (оба красные из-за унаследованных падений main) |

Сырые логи и коды возврата (временный scratchpad сессии; **не опубликованы** — evidence-репозиторий не записывался):
- `…/scratchpad/evidence2/` — миграции + 5 нативных скриптов; SHA256SUMS sha256 `e3663bea7d490e2ad25b3ef272289c7e023424b8022e58c5b282357a0f189b52` (там же устаревший прогон регресса на порту 54329 без E2E-окружения — **не использовать**).
- `…/scratchpad/evidence3/` — авторитетный дифференциальный регресс; SHA256SUMS sha256 `405f0e13a8f1d7d58eef5db5e4e1ff2585761ada4a7160b3c058ea7271f7c4a9`.
- Первый прогон (до падения локального кластера в 15:58 из-за смены прав каталога) отброшен как недействительный; нативные FIN-скрипты выполнены заново на стабильном кластере.
- GitHub run IDs: **нет** (dispatch не выполнялся).

## F. GitHub

- Репозиторий: `Shamil9586/construction-core-mvp`; ветка сессии `claude/charming-gates-x5n4i9`.
- Локальный кодовый коммит (кандидат, на нём получены все evidence): `3be8259ef5d4f69f353c8f5045d52d9c14576918`; поверх него отдельный docs-only коммит с этим файлом (код не менялся, tree кода идентичен), tree `4ea177c11f5b58bb1e99fafd2700779bbf347e85`, parents `fc98aae5…` + `1d89ecd3…`.
- Blob'ы изменений относительно F02: `tests/helpers/gpr2-writer-scan.ts` `de671e76…`; `packages/domain/index.ts` `68e804a3…` (= main); `packages/domain/fin-sdo-1/index.ts` `c7b5fd6a…`; `apps/backend/src/fin-sdo-1.service.ts` `3e45ba2d…`; `tests/fin-sdo-1-access-matrix.test.ts` `5c08df1e…`.
- **Опубликовано:** push ветки `claude/charming-gates-x5n4i9` выполнен с разрешения владельца (только эта ветка). Readback из GitHub: код-кандидат `3be8259…` существует; blob `tests/fin-sdo-1-access-matrix.test.ts` `5c08df1e…` совпал с локальным. HEAD ветки на момент readback — `e2bd18fc…` (docs-only); этот документ, правленный после push, лежит в следующем docs-only коммите, **код-кандидат `3be8259`/tree `4ea177c1…` не менялся**. Reviewer должен фиксировать SHA кандидата `3be8259…` и сверять `git diff 3be8259 HEAD` = только этот файл.
- PR: **не создан** (не запрашивался). Actions: **не запускались**. Ссылка: https://github.com/Shamil9586/construction-core-mvp/tree/claude/charming-gates-x5n4i9

## G. Решение, необходимое от владельца/координатора

1. ~~Push ветки~~ — **выполнен** (см. F). Для создания PR / передачи reviewer'у разрешение на PR отдельно не запрашивалось и не использовалось.
2. **Номер FIN-миграции** (координатор, после свежей инвентаризации main/веток; 035–039 недоступны).
3. **CI-only PR + одна dispatch-сессия** для FIN-кандидата (новый reviewed профиль/workflow на цепочке 001–037+FIN). Только после п. 1 и по точному SHA.
4. **Информационно, не FIN:** красный полный регресс `main` из-за R06b-триггера и фикстур легаси-тестов — решение за владельцем GPR.
