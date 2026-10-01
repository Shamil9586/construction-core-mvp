-- PBX-5A — Bitrix24 notification outbox (Object Assignment Notification).
--
-- A narrow, additive table. NOT the local `notifications` table and NOT a generic queue:
-- one row = one Core notification intent for one committed object_function_lead_assignments row.
-- The row is inserted in the SAME transaction as the assignment (apps/backend/src/team-service.ts
-- leadChange()); delivery to Bitrix (im.notify.system.add) happens later, outside that transaction.
--
-- Idempotency: UNIQUE(tenant_id,notification_type,source_assignment_id) = exactly one Core intent per
-- source assignment. bitrix_tag is deterministic from the source assignment and is reused by every
-- delivery attempt (provider-side replacement / duplicate-state suppression; NOT distributed
-- exactly-once delivery between PostgreSQL and Bitrix).
CREATE TABLE bitrix_notification_outbox(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    notification_type text NOT NULL CHECK(notification_type IN ('OBJECT_FUNCTION_LEAD_ASSIGNED')),
    source_assignment_id uuid NOT NULL,
    object_id uuid NOT NULL,
    recipient_user_id uuid NOT NULL,
    message text NOT NULL CHECK(length(btrim(message)) > 0),
    bitrix_tag text NOT NULL CHECK(length(btrim(bitrix_tag)) > 0),
    status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','RETRY_WAIT','DELIVERED','PERMANENT_FAILURE')),
    attempt_count int NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    last_attempt_at timestamptz,
    delivered_at timestamptz,
    delivered_bitrix_user_id text,
    bitrix_notification_id bigint,
    last_error_code text,
    last_http_status int,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    version int NOT NULL DEFAULT 1,
    UNIQUE(tenant_id,id),
    UNIQUE(tenant_id,notification_type,source_assignment_id),
    UNIQUE(tenant_id,bitrix_tag),
    FOREIGN KEY(tenant_id,source_assignment_id) REFERENCES object_function_lead_assignments(tenant_id,id),
    FOREIGN KEY(tenant_id,object_id) REFERENCES objects(tenant_id,id),
    FOREIGN KEY(tenant_id,recipient_user_id) REFERENCES users(tenant_id,id)
);
-- Due-row index: the predicate is static; "next_attempt_at <= now()" belongs to the worker query.
CREATE INDEX bitrix_notification_outbox_due_idx ON bitrix_notification_outbox (next_attempt_at, created_at) WHERE status IN ('PENDING', 'RETRY_WAIT');
