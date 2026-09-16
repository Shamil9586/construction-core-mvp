# Архитектура

См. ADR-0001. HTTP controllers валидируют Zod DTO и передают управление application services. ProductionService открывает транзакцию, проверяет роль и область объекта, блокирует строки, применяет domain policy, сохраняет историю и событие. ReadService рассчитывает актуальные управленческие projections.

Backend является источником истины. Доступ РП ограничен назначенными объектами. CONTRACTOR_VIEWER ограничен связанными объектами и собственными работами, без финансов. Составные внешние ключи `(tenant_id, id)` исключают ссылки между порталами. Tenant берётся из server-side session, а не из DTO.

Сессии: случайный opaque Bearer token, в БД только SHA-256, срок 1 час. Frontend держит app session в sessionStorage. OAuth токены не выходят во frontend. Cookie не используются; ambient-cookie CSRF отсутствует. Bitrix launch проверяет Origin и token через user.current. Установка дополнительно проверяет member_id через OAuth refresh exchange и настроенного администратора.

Транзакции объединяют изменение, AuditLog и DomainEvent. История прогресса, аудит и закрытия неизменяемы триггерами. Контроль version защищает от потери обновления. FinancialClosing дополнительно требует idempotencyKey.

Файлы до 5 МБ хранятся bytea в PostgreSQL для MVP, с проверкой MIME/signature и принудительным attachment-download. Disk adapter подготовлен отдельно. JSONB используется для аудита, событий, metadata и отчёта импорта; основные связи нормализованы.

Risk worker предназначен для отдельного процесса только с PostgreSQL. Он пересчитывает сохранённый health и добавляет дедуплицированные локальные уведомления. Dashboard пересчитывает projection при запросе, не зависит от работы cron.
