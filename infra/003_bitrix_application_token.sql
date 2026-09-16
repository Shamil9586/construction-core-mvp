-- Хранилище application_token из события ONAPPINSTALL (server-to-server webhook
-- Bitrix24, см. apps/backend/src/bitrix.ts: onAppInstallWebhook/verifyApplicationToken).
-- Перенесено из construction-erp (там же появилось как отдельный hardening-фикс) —
-- в construction-core такого server-to-server webhook раньше не было вовсе,
-- был только browser-driven install/launch (installBitrix/bitrixLogin).
-- Nullable: существующие записи, созданные через browser-flow, application_token
-- не получают (он приходит только в ONAPPINSTALL payload).
ALTER TABLE bitrix_installations ADD COLUMN encrypted_application_token text;
