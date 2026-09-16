import { Controller, Get, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { pool, rows } from '../../db';
import { authenticate } from '../../security';
@Controller()
@ApiTags('Notifications')
@ApiBearerAuth()
export class NotificationsController {
    @Get('notifications')
    async notifications(
    @Req()
    r: any) { const a = await authenticate(r); return rows(pool, 'SELECT * FROM notifications WHERE tenant_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 100', [a.tenantId, a.id]); }
}
