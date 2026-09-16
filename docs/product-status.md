# Product-first iteration — фактический результат

## Сохранено

Существующие NestJS/React, PostgreSQL target/pg, SQL migrations, domain policies, роли и Bitrix adapters. 10 демо-объектов, 8 подрядчиков, 60 работ с нормальными и проблемными сценариями. Сквозные HTTP операции до финансового закрытия существовали до этой итерации.

## Изменено

Главный экран и раздел подрядчиков используют ContractorPanel: группы по подрядчикам, проблемные первыми, раскрываемые объекты, адрес/УКО, фильтры подрядчика/статуса/светофора/типа плана, поиск и только отстающие. План/факт и закрытие объекта явно подписаны как показатели всего объекта; СК/ИД/СДО показываются по работам подрядчика в группе. Светофор объекта приходит с backend; не выставляется вручную. Тип плана берётся из monthlyPlans за текущий месяц, без выдуманного значения при отсутствии данных.

В объект добавлен WorkChain: по каждой работе видны план/факт/отклонение, дни, ответственный, СК, замечания/блокировки, ИД, СДО, переданная/рассчитанная/закрытая суммы. Если причина отставания неизвестна, UI просит уточнить её у РП, не выдумывает производственную причину. Существующие вкладки и формы для изменения факта/СК/ПТО/СДО сохранены.

GitHub hygiene и Railway runtime изменения предыдущего незавершённого шага сохранены: ignore-файлы, env example, runtime PORT, 0.0.0.0, DATABASE_URL precedence, configurable Caddy upstream, APP_TARGET выбора существующего Docker stage.

## Проверки

- npm run build: PASS (TypeScript/Vite). Предупреждение большого JS bundle остаётся.
- npm test: 24 tests PASS, 0 fail. PGlite, включая HTTP E2E; это не PostgreSQL deployment proof.
- python scripts/repository-audit.py: PASS, no pattern findings. Нет исходной git history. Fixture secrets синтетические; реальные credentials не обнаружены. Scan эвристический, не абсолютная гарантия.
- npm run test:browser -- --list: 2 сценария найдены. Новый director.spec.ts покрывает обзор директора; существующий workflow.spec.ts сохраняет изменение данных по всему циклу. Оба browser-сценария НЕ исполнялись в этой итерации.

## Доступность

Railway подключён. Read-only проверены list_projects, list_services и get_service_config. Найден construction-erp-mvp-test с backend из Shamil9586/construction-erp-mvp (master), Prisma/workspace-командами. Это другая реализация, не текущее содержимое construction-core. Никаких изменений её сервисов/БД не выполнялось.

Для текущего core нет подтверждённого GitHub remote; доступный create_deployment требует GitHub repo. GitHub plugin сообщил installed=false; gh CLI отсутствует. Новый платный ресурс без источника кода не создавался. Source package подготовлен; deployment URL отсутствует. DigitalOcean/Render и Bitrix не использовались.

| Gate | Статус |
|---|---|
| PRODUCT PROTOTYPE VERIFIED | Частично: интерфейс собран, API workflow проходит; визуальная/пользовательская проверка не выполнена |
| DEPLOYED MVP VERIFIED | NOT VERIFIED |
| DATA PERSISTENCE VERIFIED | NOT VERIFIED для native PostgreSQL; PGlite проверен |
| BROWSER E2E VERIFIED | NOT VERIFIED |
| BITRIX24 INTEGRATION VERIFIED | Отложено |

Следующее единственное внешнее действие: разместить подготовленные текущие исходники в private GitHub repo и указать owner/name именно для construction-core-mvp либо дать подключённый GitHub доступ для этого. После этого Railway принимает существующий Dockerfile без переписывания продукта. Не использовать ссылку другой реализации в качестве результата этого проекта.
