# PBX-5A — Bitrix24 notification foundation + object assignment notification

Status: **IMPLEMENTED / READY FOR INDEPENDENT REVIEW** (not closed; live acceptance not run).

## Scope
One trigger, one notification type: a NEW committed `object_function_lead_assignments` row (today `function_code = PTO`,
i.e. a new internal PTO_HEAD becomes the active object functional lead). Created centrally in
`ObjectTeamService.leadChange()` (`apps/backend/src/team-service.ts`), reached by both
`POST /objects/:id/function-team/pto/lead` (`assignObjectLead`) and `POST /function-teams/pto/redistribute`
(`redistribute().leadChanges`). The replaced lead gets nothing. ORG-1 transfers, member add/end, handovers,
`objects.project_manager_id` etc. are not triggers.

## Design
* `infra/018_bitrix_notification_outbox.sql` — `bitrix_notification_outbox`, tenant-scoped composite FKs,
  `UNIQUE(tenant_id,notification_type,source_assignment_id)` (one Core intent per source assignment),
  `UNIQUE(tenant_id,bitrix_tag)`, static partial due index `(next_attempt_at, created_at) WHERE status IN ('PENDING','RETRY_WAIT')`.
* `apps/backend/src/bitrix-notification-outbox.ts` — intent insert (`ON CONFLICT DO NOTHING`, existing row verified), failure
  classification, one-cycle `deliverNextBitrixNotification(transport?)`, polling loop.
* Intent insert is in the assignment transaction (rollback removes both). No Bitrix I/O inside it.
* Message: `Вы назначены начальником ПТО на объекте «{objects.name}».` — the same-tenant object name, no IDs/links (no deep link in 5A).
* Delivery: `RealBitrixAdapter.installedCall(tenantId,'im.notify.system.add',{USER_ID,MESSAGE,TAG})`, scope `im`, backend installed OAuth.
  `TAG = CC5A:<source_assignment_id>`, identical for every attempt. `BitrixRestError` (still a `BadRequestException`) carries
  code / HTTP status / `operating_reset_at`; `expired_token` detection uses the code.
* Recipient re-resolved at delivery by `(tenant_id, user_id)`: inactive → `RECIPIENT_INACTIVE`, bad `bitrix_user_id`
  (`^[1-9][0-9]{0,9}$`) → `RECIPIENT_MAPPING_INVALID`; zero REST calls, `PERMANENT_FAILURE`, no fallback.
* Worker claim: `status IN ('PENDING','RETRY_WAIT') AND next_attempt_at <= now() ORDER BY next_attempt_at, created_at FOR UPDATE SKIP LOCKED LIMIT 1`;
  the row lock is held across the single bounded REST call. Polling starts only with `AUTH_MODE=bitrix` AND
  `BITRIX_NOTIFICATION_DELIVERY_ENABLED=true` (default `false`); idle poll 30 s, 1.5 s between consecutive deliveries.
* Retry: transient = network/timeout, INTERNAL_SERVER_ERROR, ERROR_UNEXPECTED_ANSWER, QUERY_LIMIT_EXCEEDED, OPERATION_TIME_LIMIT
  (plus HTTP 5xx/429), no retry-count cutoff; backoff 30 s·2^n capped at 15 min, QUERY_LIMIT 60 s·2^n capped at 1 h,
  OPERATION_TIME_LIMIT = `operating_reset_at`+1 s when usable (≤1 h) else 10 min. Permanent = WRONG_AUTH_TYPE, USER_ID_EMPTY,
  MESSAGE_EMPTY, INVALID_CREDENTIALS, insufficient_scope, user_access_error, ACCESS_DENIED, OVERLOAD_LIMIT, PORTAL_DELETED,
  expired_token after the refresh path, OAuth refresh/installation failure, `result` not a positive id, unclassified 4xx codes.

## Delivery guarantee (explicit)
Exactly one **Core** intent per source assignment (PostgreSQL uniqueness) and the same deterministic TAG on every attempt,
which gives provider-side replacement / duplicate-state suppression. **Distributed exactly-once delivery between PostgreSQL
and Bitrix is NOT claimed**: if Bitrix accepts a request and the response or the DB commit is lost, the row is retried with the
same TAG and a human may still observe a repeat.

## Decision register (LOCKED)
* PBX5A-D01 Trigger = committed new `object_function_lead_assignments`; current slice PTO.
* PBX5A-D02 Intent and business assignment are one DB transaction; external delivery is not.
* PBX5A-D03 Recipient = same-tenant assignment `lead_user_id` → `users.bitrix_user_id`.
* PBX5A-D04 Invalid/inactive recipient never invalidates the assignment and never falls back.
* PBX5A-D05 Dedicated minimal `bitrix_notification_outbox`.
* PBX5A-D06 PostgreSQL source-assignment uniqueness guarantees exactly one Core intent; every delivery retry uses the same
  deterministic Bitrix TAG for provider-side replacement / duplicate-state suppression. Distributed exactly-once delivery is NOT claimed.
* PBX5A-D07 `im.notify.system.add` / scope `im` / backend installed OAuth.
* PBX5A-D08 Persistent transient retry / permanent failure classification.
* PBX5A-D09 No deep link in 5A.
* PBX5A-D10 No generic notification subsystem; one-notification live acceptance only.
