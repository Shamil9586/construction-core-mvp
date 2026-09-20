# Bitrix24 integration foundation

Проверка официальной документации: 20.09.2026. Реальный портал не подключался.

## Способ встраивания

Серверное локальное приложение с UI. Bitrix открывает HTTPS handler во frame: `DOMAIN` учитывается из query string, а OAuth/authorization поля (`AUTH_ID`, `REFRESH_ID`, `APPLICATION_TOKEN`, `member_id`) — из POST body. Основной экран приложения появляется через штатный интерфейс приложения, без CRM-сущностей.

- Handler: `https://APP_HOST/api/auth/bitrix/launch`.
- Initial installation path: `https://APP_HOST/api/auth/bitrix/install`.
- Встроенный мастер, без режима API only. Реализован вызов `BX24.installFinish()` после сохранения токенов.
- В `.env`: точные BITRIX_PORTAL, BITRIX_CLIENT_ID, BITRIX_CLIENT_SECRET, BITRIX_ADMIN_USER_ID, TOKEN_ENCRYPTION_KEY (32 случайных байта в hex), AUTH_MODE=bitrix. `BITRIX_MEMBER_ID` — optional security pin: его можно оставить пустым для первой полностью проверенной wizard-installation, после которой portal + member_id фиксируются в БД.
- APP_ORIGIN — HTTPS origin приложения; BITRIX_FRAME_ORIGIN — HTTPS origin тестового портала.

Установка обменивает refresh_token через фиксированный официальный OAuth endpoint, требует совпадения incoming `member_id` с OAuth `member_id`, проверяет заранее заданного администратора, фиксирует portal + member_id и шифрует access/refresh/application token AES-256-GCM. Повторная установка не может незаметно заменить уже сохранённый `APPLICATION_TOKEN`; legacy-запись с NULL может заполнить его один раз только после полной OAuth/admin verification. Обновление токенов блокирует строку installation и сохраняет новую пару. Refresh выполняется после expired_token, а не перед каждым запросом. Пользователь входа проверяется через user.current и должен быть назначен в собственной users-таблице. На frontend попадает только короткая opaque app session.

## Preflight hardening перед первым реальным порталом

Browser-driven install/launch теперь проверяет `member_id` + `APPLICATION_TOKEN` до выдачи Construction Core session. Launch сначала сверяет portal/member/installation и timing-safe reference token, и только после этого вызывает `user.current`. Это защищает публичный handler независимо от дополнительной проверки HTTP Origin.

`DOMAIN` для wizard handlers берётся из query string с fallback на прежний body-format; остальные auth-поля остаются в POST body. Это соответствует simplified OAuth flow server-side local application with UI.

`BITRIX_INSTALL_WEBHOOK_ENABLED` остаётся `false`: server-to-server ONAPPINSTALL и event handlers не включаются этим проходом.

## Реально вызываемые методы

| Метод | Scope | Где |
|---|---|---|
| user.current | user / user_brief / user_basic | Вход и проверка администратора установки |
| user.get | user | Проверка Bitrix ID при назначении пользователя |
| department.get | department | OrganizationProvider, ручное подключение/синхронизация ещё требуется |
| im.notify.system.add | im | NotificationProvider; автоматическая отправка выключена |
| tasks.task.add | task | TaskProvider; автоматическое создание задач выключено |
| disk.folder.uploadfile | disk | FileStorageProvider; UI MVP хранит вложения локально в БД |
| OAuth token endpoint | client_id/client_secret | Установка и refresh |

Минимум для начального входа — scope пользователя. department, im, task, disk требуются только при включении соответствующих providers. Учитываются также права сотрудника на объекты Bitrix, одного scope недостаточно.

## Placements / events / webhooks

`placement.bind` проверен по документации (scope placement плюс права точки встраивания, администратор). MVP не регистрирует дополнительный placement: штатной страницы приложения достаточно. Не заявляется несуществующая универсальная точка левого меню.

`event.bind` проверен: работает в контексте app OAuth; обработчик должен быть доступен снаружи, события идут после завершения установки. В MVP не регистрируются внешние события. ONAPPINSTALL относится к варианту callback, текущий установщик использует UI wizard. Подписки пользователя/увольнения, проверка application_token событий, retry/inbox и uninstall cleanup — следующий этап, не реализованная интеграция.

Входящие webhooks пригодны для ограниченной серверной интеграции, но не заменяют OAuth авторизацию каждого сотрудника. Встроенный production-core не использует webhook-секрет во frontend.

## Cloud limitations

Доступность локальных приложений и REST зависит от тарифа/настроек портала; проверяется администратором тестового портала. Локальное приложение устанавливается на один портал; multi-tenant модель позволяет отдельные установки. Лимиты REST требуют очереди, pagination, backoff и batch для массовой синхронизации; массовая синхронизация пока не включена. У HTTP adapter есть timeout и отказ от redirects, автоматический retry для writes не включён из-за риска дублей.

On-premise может использовать собственные домены и иной OAuth endpoint. Текущий adapter допускает только проверенные cloud-домены Bitrix24, настраиваемый on-premise endpoint не поддержан. До расширения allowlist необходимо отдельно решить SSRF и подтверждение endpoint.

## Проверка на тестовом портале

1. Развернуть подготовленный стек с настоящим PostgreSQL и валидным HTTPS.
2. Создать серверное локальное приложение с UI на тестовом портале и прописать оба handler.
3. Задать секреты на сервере и перезапустить API. `BITRIX_MEMBER_ID` можно оставить пустым для первого verified bootstrap либо заранее задать как дополнительный pin.
4. Пройти install, проверить encrypted storage, завершение мастера и повторный запуск.
5. Проверить реальный Origin и поля POST. Некоторые конфигурации портала могут потребовать корректировки bootstrap-парсинга; не отключать проверки без замены проверенной защитой.
6. Проверить роли двух сотрудников, refresh/rotation, разные tenants, CSP в iframe и sessionStorage. Назначить пользователей в разделе администратора.
7. По отдельности включать users/departments, Disk, уведомления и задачи в тестовом портале. Проверить ошибки scopes и rate limits.

Статус: REQUIRES BITRIX24 TEST PORTAL VERIFICATION. Названия RealBitrixAdapter не означают проверку против живого портала.

## Официальные источники

- [Локальные приложения](https://apidocs.bitrix24.com/local-integrations/local-apps.html)
- [Мастер установки](https://apidocs.bitrix24.com/settings/app-installation/local-apps/installation-master.html)
- [Callback установки](https://apidocs.bitrix24.com/settings/app-installation/local-apps/installation-callback.html)
- [OAuth auto renewal](https://apidocs.bitrix24.com/settings/oauth/auto-renewal.html)
- [user.current](https://apidocs.bitrix24.com/api-reference/user/user-current.html)
- [Структура компании и scopes](https://apidocs.bitrix24.com/api-reference/departments/index.html)
- [Уведомление](https://apidocs.bitrix24.com/api-reference/chats/notifications/im-notify-system-add.html)
- [Создание задачи](https://apidocs.bitrix24.com/api-reference/tasks/tasks-task-add.html)
- [Загрузка файла и задача](https://apidocs.bitrix24.com/tutorials/tasks/how-to-create-task-with-file.html)
- [placement.bind](https://apidocs.bitrix24.com/api-reference/widgets/placement-bind.html)
- [event.bind](https://apidocs.bitrix24.com/api-reference/events/event-bind.html)
- [Настройки и ограничения REST](https://apidocs.bitrix24.com/settings/index.html)

## Acceptance matrix — 15.09.2026

«Mock verified» ниже означает исполненные локальные тесты с подменённым HTTP transport, а не успешный вызов на портале. Проверены user.current, OAuth renewal, department.get, tasks.task.add, placement.bind и документированные методы Disk/im по официальным страницам; дополнительные ссылки: [department.get](https://apidocs.bitrix24.com/api-reference/departments/department-get.html), [user.get](https://apidocs.bitrix24.com/api-reference/user/user-get.html), [disk.folder.uploadfile](https://apidocs.bitrix24.com/api-reference/disk/folder/disk-folder-upload-file.html).

| FUNCTION | BITRIX API METHOD | SCOPE/PERMISSION | IMPLEMENTED | MOCK VERIFIED | REAL PORTAL VERIFIED |
|---|---|---|---|---|---|
| Installation | OAuth token + user.current + BX24.installFinish | client credentials, user; настроенный admin ID | Server flow + HTML wizard; member/application-token binding | Simulated service + HTTP query/body contract | No |
| Current user / launch | user.current | user / user_brief / user_basic | Yes; guarded by portal/member/application-token | Yes, simulated transport + negative token/member cases | No |
| Users | user.get | user; доступ сотрудника | Проверка ID при назначении, не массовая синхронизация | Dedicated user.get contract not covered | No |
| Token refresh | oauth.bitrix.info/oauth/token/ | client_id/client_secret + refresh_token | AES-GCM, row lock, rotation | Yes, expired_token + storage + portal mismatch | No |
| Departments | department.get | department | Provider, без sync в UI | Yes, method contract | No |
| Placement | placement.bind | placement, administrator | Не вызывается; штатная страница app | N/A | No |
| Disk | disk.folder.uploadfile | disk, права на папку | Provider, UI хранит файл в БД | Yes, payload contract | No |
| Notifications | im.notify.system.add | im | Provider, delivery выключена | Yes, payload contract | No |
| Tasks | tasks.task.add | task, права пользователя | Provider, auto-creation выключено | Yes, payload contract | No |
| Events/webhooks | event.bind | app context + scope события | Не подключены | N/A | No |

Исправлено: refresh сверяет member_id с installation, adapter не может использовать installation другого portal; wizard install/launch дополнительно привязаны к portal + member_id + encrypted APPLICATION_TOKEN, а `DOMAIN` читается из фактического query-string handler request. Серверная схема рассчитана на cloud allowlist. Ограничения тарифа, фактические scopes, права папки/пользователя и REST quotas требуют тестового портала. Статус интеграционного foundation: IMPLEMENTED / REQUIRES TEST PORTAL VERIFICATION.
