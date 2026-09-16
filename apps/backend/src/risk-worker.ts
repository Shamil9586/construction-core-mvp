import { pool, rows, transaction, one } from './db';
import { ReadService } from './read-service';
import { EscalationService } from '../../../packages/domain';
import { audit } from './security';
// Local notifications only. No external messages are sent automatically.
export async function scanRisks() { const admins = await rows(pool, "SELECT DISTINCT ON (tenant_id) * FROM users WHERE role='ADMIN' AND is_active=true ORDER BY tenant_id,id"); for (const a of admins) {
    const snapshot = await new ReadService().snapshot(a);
    await transaction(async (c) => { for (const object of snapshot.objects) {
        const old = await one(c, 'SELECT * FROM objects WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [a.tenantId, object.id]);
        if (old.healthStatus !== object.healthStatus) {
            await c.query('UPDATE objects SET health_status=$3,version=version+1 WHERE tenant_id=$1 AND id=$2', [a.tenantId, object.id, object.healthStatus]);
            await audit(c, a, 'Object', object.id, 'HEALTH', { healthStatus: old.healthStatus }, { healthStatus: object.healthStatus }, 'ObjectHealthChanged');
        }
    } for (const signal of snapshot.dashboard.attentionRequired) {
        const role = new EscalationService().recipient(signal.daysOverdue, snapshot.risk);
        const recipients = await rows(c, 'SELECT id FROM users WHERE tenant_id=$1 AND role=$2 AND is_active=true' + (role === 'PROJECT_MANAGER' ? ' AND id=(SELECT project_manager_id FROM objects WHERE tenant_id=$1 AND id=$3)' : ''), role === 'PROJECT_MANAGER' ? [a.tenantId, role, signal.objectId] : [a.tenantId, role]);
        for (const u of recipients) {
            const key = [signal.entityId, signal.title, signal.severity, role, u.id, new Date().toISOString().slice(0, 10)].join(':');
            await c.query('INSERT INTO notifications(tenant_id,user_id,title,dedupe_key) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [a.tenantId, u.id, signal.title + ': ' + signal.reason, key]);
        }
    } });
} }
