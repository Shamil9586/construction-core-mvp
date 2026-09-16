import { Controller, Get, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { pool, rows } from '../../db';
import { authenticate, ensure } from '../../security';
@Controller()
@ApiTags('Audit')
@ApiBearerAuth()
export class AuditController {
    @Get('audit')
    async auditLog(
    @Req()
    r: any) { const a = await authenticate(r); ensure(['ADMIN', 'GENERAL_DIRECTOR', 'TECHNICAL_DIRECTOR'].includes(a.role), 'Аудит доступен руководителям'); return rows(pool, 'SELECT l.*,u.name AS author FROM audit_logs l JOIN users u ON u.id=l.user_id AND u.tenant_id=l.tenant_id WHERE l.tenant_id=$1 ORDER BY l.created_at DESC LIMIT 500', [a.tenantId]); }
}
