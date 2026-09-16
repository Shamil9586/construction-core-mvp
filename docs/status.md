# Текущий статус

Обновлено: 16.09.2026. Этот файл — единственный источник актуального
статуса; исторические промежуточные версии (DigitalOcean/AppDeploy разведка,
Railway readiness) заменены этим документом и остаются доступны в git-истории
при необходимости, а не дублируются здесь.

## Итог

**MVP слит из construction-core + construction-erp, задеплоен на Render TEST
и полностью проверен end-to-end.** Все gates ниже, которые раньше были
NOT VERIFIED, теперь VERIFIED.

| Gate | Статус |
|---|---|
| Локальные тесты (PGlite) | VERIFIED — 24/24 → 28/28 после рефакторинга на NestJS-модули |
| Сборка (TypeScript + Vite) | VERIFIED |
| PostgreSQL (не PGlite) | VERIFIED — реальный managed Postgres на Render |
| Docker build/runtime | VERIFIED — оба stage (`api`, `web`) собираются и работают на Render |
| HTTPS test-сервер | VERIFIED — https://construction-core-web.onrender.com |
| Browser E2E (Playwright) | VERIFIED — `director.spec.ts` + `workflow.spec.ts`, `2 passed` |
| Сквозная проверка в браузере (login → dashboard → карточка объекта) | VERIFIED, см. `deployment-render.md` |
| Bitrix24 test portal | NOT VERIFIED — намеренно отложено, остаётся на `MockBitrixAdapter`; требует отдельного разрешения пользователя перед подключением реального/тестового портала |
| Production | Не разворачивался и не разрешён этой задачей |

Детали деплоя, платформенные баги и их фиксы, живые URL и env-конфигурация:
[`deployment-render.md`](deployment-render.md). Инструкции для отдельного
self-hosted Docker Compose трека (не то, что реально исполнено в этой
итерации, но остаётся валидной альтернативой): [`deployment.md`](deployment.md)
и [`test-deployment-runbook.md`](test-deployment-runbook.md).

## Что изменилось в продукте в этой итерации

Главный экран и раздел подрядчиков используют `ContractorPanel`: группы по
подрядчикам, проблемные — первыми, раскрываемые объекты, адрес/УКО, фильтры
подрядчика/статуса/светофора/типа плана, поиск и режим «только отстающие».
Светофор объекта приходит с backend, не выставляется вручную. Тип плана
берётся из `monthlyPlans` за текущий месяц.

В объект добавлен `WorkChain`: по каждой работе видны план/факт/отклонение,
дни, ответственный, СК, замечания/блокировки, ИД, СДО, переданная/
рассчитанная/закрытая суммы. Из construction-erp перенесены 11-вкладочная
карточка объекта и диаграмма Ганта; `ContractorPanel` сохранён как стартовый
экран.

`apps/backend/src/controller.ts` разбит на доменные NestJS-модули
(auth, bitrix, dashboard, objects, works, inspections, attachments, pto,
sdo, financial, contractors, dictionaries, users, materials, audit,
notifications, imports).

## Архитектурные решения (зафиксированы, не пересматривать без явного запроса)

- БД: raw `pg` + SQL-миграции + PGlite для dev/test. Prisma не вводится.
- Bitrix24: `MockBitrixAdapter`. Реальный/тестовый портал — только с
  отдельного разрешения пользователя.
- Деплой: **Render** (сменён с Railway в этой итерации — free plan
  Railway отказал в создании проекта, аккаунт уже занят параллельным
  эффортом; приложение не привязано к конкретной платформе, см.
  `deployment-render.md`).

## Известные ограничения

Bitrix24 real/test portal integration не проверена — остаётся на моках.
Render free-tier Postgres истекает через 30 дней после создания (детали и
процедура восстановления — `deployment-render.md`). Известный, но не
исправленный в этой итерации баг: `Admin()` в `main.tsx` структурно
подвержен той же уязвимости потери локального state при ре-рендере `App`,
что была исправлена в `Materials` (см. историю коммитов шага 6); текущие
E2E-тесты этого не покрывают.
