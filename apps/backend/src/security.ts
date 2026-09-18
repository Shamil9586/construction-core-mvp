import { ForbiddenException, UnauthorizedException, ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import { pool, one, insert } from './db';
import { hasPermission, Permission, Role } from '../../../packages/domain';
export type Actor = {
    id: string;
    tenantId: string;
    role: Role;
    name: string;
    contractorId?: string;
};
export const hash = (v: string) => createHash('sha256').update(v).digest('hex');
export function requirePermission(a: Actor, p: Permission) { if (!hasPermission(a.role, p))
    throw new ForbiddenException('Недостаточно прав: ' + p); }
export function checkVersion(row: any, version: number) { if (row.version !== version)
    throw new ConflictException('Данные изменены другим пользователем. Обновите страницу.'); }
export async function authenticate(req: any): Promise<Actor> { const token = req.headers.authorization?.replace(/^Bearer /, ''); if (!token)
    throw new UnauthorizedException('Требуется вход'); const u = await one(pool, 'SELECT u.* FROM sessions s JOIN users u ON (u.tenant_id=s.tenant_id AND u.id=s.user_id) WHERE s.token_hash=$1 AND s.expires_at>now() AND u.is_active=true', [hash(token)]); if (!u)
    throw new UnauthorizedException('Сессия истекла'); return u; }
export async function session(user: any, c: any = pool) { const token = randomBytes(32).toString('base64url'); await insert(c, 'sessions', user.tenantId, { userId: user.id, tokenHash: hash(token), expiresAt: new Date(Date.now() + 3600000) }); return { token, user: { id: user.id, name: user.name, role: user.role, tenantId: user.tenantId } }; }
export function sameSecret(a: string, b: string) { return !!a && !!b && timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b))); }
export function encrypt(value: string) { const key = process.env.TOKEN_ENCRYPTION_KEY; if (!key || !/^[a-f0-9]{64}$/i.test(key))
    throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes hex'); const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv), data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), data.toString('hex')].join('.'); }
export function decrypt(value: string) { const [iv, tag, data] = value.split('.'); const cipher = createDecipheriv('aes-256-gcm', Buffer.from(process.env.TOKEN_ENCRYPTION_KEY!, 'hex'), Buffer.from(iv, 'hex')); cipher.setAuthTag(Buffer.from(tag, 'hex')); return Buffer.concat([cipher.update(Buffer.from(data, 'hex')), cipher.final()]).toString(); }
export async function scoped(c: any, table: string, id: string, a: Actor, lock = false) { if (!/^[a-z_]+$/.test(table))
    throw Error('table'); const row = await one(c, `SELECT * FROM ${table} WHERE tenant_id=$1 AND id=$2 ${lock ? 'FOR UPDATE' : ''}`, [a.tenantId, id]); if (!row)
    throw new NotFoundException('Запись не найдена'); return row; }
export async function objectAccess(c: any, a: Actor, objectId: string, write = false) { const o = await scoped(c, 'objects', objectId, a); if (a.role === 'PROJECT_MANAGER' && o.projectManagerId !== a.id)
    throw new ForbiddenException('Объект закреплён за другим РП'); if (a.role === 'CONTRACTOR_VIEWER' && (!a.contractorId || !(await one(c, 'SELECT id FROM object_contractors WHERE tenant_id=$1 AND object_id=$2 AND contractor_id=$3 AND removed_at IS NULL', [a.tenantId, objectId, a.contractorId]))))
    throw new ForbiddenException('Нет доступа к объекту'); return o; }
export async function audit(c: any, a: Actor, entityType: string, entityId: string, action: string, oldValue: any, newValue: any, eventType?: string) { await insert(c, 'audit_logs', a.tenantId, { userId: a.id, entityType, entityId, action, oldValue: oldValue ? JSON.stringify(oldValue) : null, newValue: JSON.stringify(newValue) }); if (eventType) {
    const event = await insert(c, 'domain_events', a.tenantId, { eventType, entityId, payload: JSON.stringify({ actorId: a.id, entityType, entityId }) });
    const users = (await c.query("SELECT id FROM users WHERE tenant_id=$1 AND is_active=true AND role IN ('PTO','TECHNICAL_DIRECTOR','GENERAL_DIRECTOR','CONSTRUCTION_CONTROL','SDO','PROJECT_MANAGER')", [a.tenantId])).rows;
    for (const user of users)
        await c.query('INSERT INTO notifications(tenant_id,user_id,event_id,title,dedupe_key) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [a.tenantId, user.id, event.id, eventType, `${event.id}:${user.id}`]);
} }
export function ensure(allowed: boolean, message: string) { if (!allowed)
    throw new BadRequestException(message); }
