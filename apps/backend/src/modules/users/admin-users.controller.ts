import { Controller, Get, Post, Patch, Body, Req, Param, ConflictException, NotFoundException } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { pool, rows, one, transaction } from '../../db';
import { authenticate, requirePermission, audit, ensure, Actor } from '../../security';
import { Permission as P, INTERNAL_ASSIGNABLE_ROLES } from '../../../../../packages/domain';
import * as V from '../../validation';
import { RealBitrixAdapter } from '../../bitrix';

// PBX-2 — Core user & access administration. Core alone decides who is a Core
// user, which role they hold and whether access is active; Bitrix is consulted
// only to confirm an employee exists and to read their display name. Nothing
// here reads WORK_POSITION, departments or ACTIVE to pick or change a role.

// Explicit column list: session hashes, contractor scope and anything else on
// the row never reach the admin UI.
const ADMIN_USER_COLUMNS = 'id,name,role,bitrix_user_id,email,is_active,created_at,updated_at,version';

const roleSchema = z.enum(INTERNAL_ASSIGNABLE_ROLES);

async function adminActor(r: any): Promise<Actor> {
    const a = await authenticate(r);
    requirePermission(a, P.ADMIN_USERS);
    return a;
}

function bitrixDisplayName(employee: any, fallbackId: string) {
    const name = [employee.LAST_NAME, employee.NAME, employee.SECOND_NAME]
        .filter((part: any) => typeof part === 'string' && part.trim())
        .map((part: string) => part.trim())
        .join(' ');
    return (name || `Сотрудник Bitrix ${fallbackId}`).slice(0, 500);
}

async function assertNotAssigned(c: any, tenantId: string, bitrixUserId: string) {
    const existing = await one(c, 'SELECT is_active FROM users WHERE tenant_id=$1 AND bitrix_user_id=$2', [tenantId, bitrixUserId]);
    if (existing)
        throw new ConflictException(existing.isActive ? 'Сотрудник уже добавлен в Core' : 'Сотрудник уже добавлен в Core, доступ отключён. Включите доступ.');
}

// email is the Core-held address (users.email, may be null) — shown only on this ADMIN-only screen and used for registry search.
// The Bitrix directory is never asked for EMAIL (accepted PBX-1 data-minimisation contract).
const view = (u: any) => ({ id: u.id, name: u.name, role: u.role, bitrixUserId: u.bitrixUserId, email: u.email ?? null, isActive: u.isActive, createdAt: u.createdAt, updatedAt: u.updatedAt, version: u.version });

// Serialises every access mutation inside one tenant. FOR NO KEY UPDATE on the
// tenant row is exclusive against itself (a second administrator mutation
// waits for the first to COMMIT/ROLLBACK and then sees its result) but does
// not block ordinary FK inserts that only take FOR KEY SHARE on the tenant.
async function lockTenantAccess(c: any, tenantId: string) {
    await c.query('SELECT id FROM tenants WHERE id=$1 FOR NO KEY UPDATE', [tenantId]);
}

@Controller()
@ApiTags('Admin users')
@ApiBearerAuth()
export class AdminUsersController {
    @Get('admin/users')
    async list(@Req() r: any) {
        const a = await adminActor(r);
        const users = await rows(pool, `SELECT ${ADMIN_USER_COLUMNS} FROM users WHERE tenant_id=$1 ORDER BY is_active DESC, name, id`, [a.tenantId]);
        return { users: users.map(view) };
    }

    @Post('admin/users')
    async add(@Req() r: any, @Body() b: any) {
        const a = await adminActor(r);
        const bitrixMode = process.env.AUTH_MODE === 'bitrix';
        const base = { bitrixUserId: z.string().regex(/^\d+$/), role: roleSchema };
        // In bitrix mode the name comes from the portal, never from the client.
        const d: any = (bitrixMode ? z.object(base).strict() : z.object({ ...base, name: V.text }).strict()).parse(b);
        let name: string = d.name;
        // Checked before any Bitrix round-trip so a known employee is reported as
        // already added; re-checked under the tenant lock below for races.
        await assertNotAssigned(pool, a.tenantId, d.bitrixUserId);
        if (bitrixMode) {
            const found = await new RealBitrixAdapter().installedCall(a.tenantId, 'user.get', { filter: { ID: d.bitrixUserId } });
            const employee = Array.isArray(found) ? found.find((x: any) => String(x.ID) === d.bitrixUserId) : undefined;
            ensure(!!employee, 'Пользователь Bitrix не найден');
            name = bitrixDisplayName(employee, d.bitrixUserId);
        }
        return transaction(async (c) => {
            await lockTenantAccess(c, a.tenantId);
            await assertNotAssigned(c, a.tenantId, d.bitrixUserId);
            const u = await one(c, `INSERT INTO users(tenant_id,bitrix_user_id,name,role) VALUES($1,$2,$3,$4) RETURNING ${ADMIN_USER_COLUMNS}`, [a.tenantId, d.bitrixUserId, name, d.role]);
            await audit(c, a, 'User', u.id, 'CREATE', null, { role: u.role, isActive: true, bitrixUserId: d.bitrixUserId });
            return view(u);
        });
    }

    @Patch('admin/users/:id')
    async update(@Req() r: any, @Param('id') id: string, @Body() b: any) {
        const a = await adminActor(r);
        const targetId = V.uuid.parse(id);
        const d = z.object({ role: roleSchema.optional(), isActive: z.boolean().optional() }).strict()
            .refine(x => x.role !== undefined || x.isActive !== undefined, 'Нужно изменить роль или статус доступа').parse(b);
        return transaction(async (c) => {
            await lockTenantAccess(c, a.tenantId);
            const before = await one(c, 'SELECT * FROM users WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [a.tenantId, targetId]);
            if (!before)
                throw new NotFoundException('Запись не найдена');
            // External participants are outside the internal Core contour: readable, not administrable here.
            ensure(before.role !== 'CONTRACTOR_VIEWER', 'Внешние участники не управляются в разделе «Пользователи и доступ»');
            const role: string = d.role ?? before.role;
            const isActive: boolean = d.isActive ?? before.isActive;
            const roleChanged = role !== before.role, activeChanged = isActive !== before.isActive;
            if (!roleChanged && !activeChanged)
                return view(before);
            // Last-administrator invariant, checked under the tenant lock so two
            // concurrent requests cannot each see "the other admin remains".
            if (before.role === 'ADMIN' && before.isActive && (!isActive || role !== 'ADMIN')) {
                const others = await one(c, "SELECT count(*)::int AS n FROM users WHERE tenant_id=$1 AND role='ADMIN' AND is_active=true AND id<>$2", [a.tenantId, targetId]);
                if (others.n === 0)
                    throw new ConflictException('Нельзя оставить организацию без активного администратора');
            }
            const u = await one(c, `UPDATE users SET role=$3,is_active=$4,updated_at=now(),version=version+1 WHERE tenant_id=$1 AND id=$2 RETURNING ${ADMIN_USER_COLUMNS}`, [a.tenantId, targetId, role, isActive]);
            if (roleChanged)
                await audit(c, a, 'User', targetId, 'ROLE_CHANGE', { role: before.role, isActive: before.isActive }, { role, isActive });
            if (activeChanged) {
                // A token issued before deactivation must not come back to life on
                // reactivation: the sessions are removed, a fresh Bitrix launch is needed.
                if (!isActive)
                    await c.query('DELETE FROM sessions WHERE tenant_id=$1 AND user_id=$2', [a.tenantId, targetId]);
                await audit(c, a, 'User', targetId, isActive ? 'REACTIVATE' : 'DEACTIVATE', { role: before.role, isActive: before.isActive }, { role, isActive });
            }
            return view(u);
        });
    }
}
