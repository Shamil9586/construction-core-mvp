import { Controller, Post, Get, Body, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { pool, rows, transaction, insert } from '../../db';
import { authenticate, requirePermission, scoped, audit, ensure } from '../../security';
import { Permission as P, roles } from '../../../../../packages/domain';
import * as V from '../../validation';
import { RealBitrixAdapter } from '../../bitrix';
@Controller()
@ApiTags('Users')
@ApiBearerAuth()
export class UsersController {
    @Get('users')
    async users(
    @Req()
    r: any) { const a = await authenticate(r); requirePermission(a, P.OBJECT_VIEW); return rows(pool, 'SELECT id,name,role,bitrix_user_id FROM users WHERE tenant_id=$1 AND is_active=true', [a.tenantId]); }
    @Post('users')
    async addUser(
    @Req()
    r: any,
    @Body()
    b: any) { const a = await authenticate(r); requirePermission(a, P.ADMIN_USERS); const d = z.object({ bitrixUserId: z.string().regex(/^\d+$/), name: V.text, role: z.enum(roles), contractorId: V.uuid.optional() }).strict().parse(b); if (process.env.AUTH_MODE === 'bitrix') {
        const found = await new RealBitrixAdapter().installedCall(a.tenantId, 'user.get', { filter: { ID: d.bitrixUserId } });
        ensure(Array.isArray(found) && found.some(x => String(x.ID) === d.bitrixUserId), 'Пользователь Bitrix не найден');
    } return transaction(async (c) => { if (d.contractorId)
        await scoped(c, 'contractors', d.contractorId, a); ensure(d.role !== 'CONTRACTOR_VIEWER' || !!d.contractorId, 'Укажите организацию подрядчика'); const u = await insert(c, 'users', a.tenantId, d); await audit(c, a, 'User', u.id, 'CREATE', null, { role: u.role, bitrixUserId: u.bitrixUserId }); return { id: u.id, name: u.name, role: u.role }; }); }
}
