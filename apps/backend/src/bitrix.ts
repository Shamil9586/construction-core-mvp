import { BitrixUserProvider, OrganizationProvider, NotificationProvider, TaskProvider, FileStorageProvider } from '../../../packages/domain';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { pool, one, insert, transaction } from './db';
import { encrypt, decrypt, session, sameSecret } from './security';
export class MockBitrixAdapter implements BitrixUserProvider, OrganizationProvider, NotificationProvider, TaskProvider, FileStorageProvider {
    async currentUser(id: string) { return { ID: id, NAME: 'Тестовый пользователь' }; }
    async departments() { return [{ ID: '1', NAME: 'Производство' }]; }
    async notify(_t: string, userId: string, message: string) { return { mock: true, userId, message }; }
    async createTask(_t: string, userId: string, title: string) { return { mock: true, userId, title }; }
    async upload(_t: string, _f: string, name: string) { return { mock: true, name }; }
}
export class RealBitrixAdapter implements BitrixUserProvider, OrganizationProvider, NotificationProvider, TaskProvider, FileStorageProvider {
    constructor(readonly portal = process.env.BITRIX_PORTAL ?? '') { if (!/^[a-z0-9-]+\.bitrix24\.(ru|com|eu|de|kz|by|pl)$/i.test(portal))
        throw new Error('Configure exact cloud portal allowlist'); }
    async call(method: string, token: string, params: any = {}) { const response = await fetch(`https://${this.portal}/rest/${method}.json`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...params, auth: token }), redirect: 'error', signal: AbortSignal.timeout(15000) }); const body: any = await response.json(); if (!response.ok || body.error)
        throw new BadRequestException('Bitrix REST request failed: ' + (body.error ?? response.status)); return body.result; }
    currentUser(token: string) { return this.call('user.current', token); }
    departments(token: string) { return this.call('department.get', token); }
    notify(token: string, userId: string, message: string) { return this.call('im.notify.system.add', token, { USER_ID: userId, MESSAGE: message }); }
    createTask(token: string, userId: string, title: string) { return this.call('tasks.task.add', token, { fields: { TITLE: title, RESPONSIBLE_ID: Number(userId) } }); }
    upload(token: string, folder: string, name: string, base64: string) { return this.call('disk.folder.uploadfile', token, { id: folder, data: { NAME: name }, fileContent: [name, base64] }); }
    async installedCall(tenantId: string, method: string, params: any = {}) { let row = await one(pool, 'SELECT * FROM bitrix_installations WHERE tenant_id=$1', [tenantId]); if (!row || row.portal !== this.portal)
        throw new UnauthorizedException('Installation portal mismatch'); try {
        return await this.call(method, decrypt(row.encryptedAccessToken), params);
    }
    catch (e: any) {
        if (!String(e.message).includes('expired_token'))
            throw e;
        row = await transaction(async (c) => { const current = await one(c, 'SELECT * FROM bitrix_installations WHERE tenant_id=$1 FOR UPDATE', [tenantId]); if (current.version !== row.version)
            return current; const r = await fetch('https://oauth.bitrix.info/oauth/token/', { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', client_id: process.env.BITRIX_CLIENT_ID!, client_secret: process.env.BITRIX_CLIENT_SECRET!, refresh_token: decrypt(current.encryptedRefreshToken) }), redirect: 'error', signal: AbortSignal.timeout(15000) }); const t: any = await r.json(); if (!r.ok || !t.access_token || !t.refresh_token || !Number.isFinite(Number(t.expires_in)) || Number(t.expires_in)<=0 || t.member_id !== current.memberId)
            throw new UnauthorizedException('OAuth refresh failed'); return one(c, 'UPDATE bitrix_installations SET encrypted_access_token=$2,encrypted_refresh_token=$3,expires_at=$4,version=version+1 WHERE id=$1 RETURNING *', [current.id, encrypt(t.access_token), encrypt(t.refresh_token), new Date(Date.now() + Number(t.expires_in) * 1000)]); });
        return this.call(method, decrypt(row.encryptedAccessToken), params);
    } }
}
export async function bitrixLogin(body: any) { if (process.env.AUTH_MODE !== 'bitrix')
    throw new UnauthorizedException('Bitrix mode disabled'); const portal = body.DOMAIN ?? body.auth?.domain; const token = body.AUTH_ID ?? body.auth?.access_token; if (portal !== process.env.BITRIX_PORTAL || !token)
    throw new UnauthorizedException(); const adapter = new RealBitrixAdapter(portal); const current = await adapter.currentUser(token); const user = await one(pool, 'SELECT u.* FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE t.portal=$1 AND u.bitrix_user_id=$2 AND u.is_active=true', [portal, String(current.ID)]); if (!user)
    throw new UnauthorizedException('Пользователь должен быть назначен администратором приложения'); return session(user); }
// Administrative install foundation: only the explicitly provisioned test portal/member/admin.
// Refresh exchange binds submitted credentials to this application's client_id.
export async function installBitrix(body: any) { if (process.env.AUTH_MODE !== 'bitrix')
    throw new UnauthorizedException('Bitrix mode disabled'); const portal = body.DOMAIN ?? body.auth?.domain, refresh = body.REFRESH_ID ?? body.auth?.refresh_token; if (portal !== process.env.BITRIX_PORTAL || !refresh || !process.env.BITRIX_MEMBER_ID || !process.env.BITRIX_ADMIN_USER_ID)
    throw new UnauthorizedException('Portal provisioning required'); const response = await fetch('https://oauth.bitrix.info/oauth/token/', { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', client_id: process.env.BITRIX_CLIENT_ID ?? '', client_secret: process.env.BITRIX_CLIENT_SECRET ?? '', refresh_token: refresh }), redirect: 'error', signal: AbortSignal.timeout(15000) }); const auth: any = await response.json(); if (!response.ok || auth.member_id !== process.env.BITRIX_MEMBER_ID || !auth.access_token || !auth.refresh_token)
    throw new UnauthorizedException('Installation credentials not verified'); const user = await new RealBitrixAdapter(portal).currentUser(auth.access_token); if (String(user.ID) !== process.env.BITRIX_ADMIN_USER_ID)
    throw new UnauthorizedException('Only configured app administrator can install'); return transaction(async (c) => { let tenant = await one(c, 'SELECT * FROM tenants WHERE member_id=$1', [auth.member_id]); if (!tenant)
    tenant = await one(c, 'INSERT INTO tenants(portal,member_id,name) VALUES($1,$2,$3) RETURNING *', [portal, auth.member_id, 'Строительная компания']); if (tenant.portal !== portal)
    throw new UnauthorizedException(); const data = { portal, memberId: auth.member_id, encryptedAccessToken: encrypt(auth.access_token), encryptedRefreshToken: encrypt(auth.refresh_token), expiresAt: new Date(Date.now() + Number(auth.expires_in) * 1000) }; const old = await one(c, 'SELECT * FROM bitrix_installations WHERE tenant_id=$1 FOR UPDATE', [tenant.id]); if (old)
    await c.query('UPDATE bitrix_installations SET encrypted_access_token=$2,encrypted_refresh_token=$3,expires_at=$4,version=version+1 WHERE tenant_id=$1', [tenant.id, data.encryptedAccessToken, data.encryptedRefreshToken, data.expiresAt]);
else
    await insert(c, 'bitrix_installations', tenant.id, data); let u = await one(c, 'SELECT * FROM users WHERE tenant_id=$1 AND bitrix_user_id=$2', [tenant.id, String(user.ID)]); if (!u)
    u = await insert(c, 'users', tenant.id, { bitrixUserId: String(user.ID), name: [user.NAME, user.LAST_NAME].filter(Boolean).join(' '), role: 'ADMIN', email: user.EMAIL }); await c.query('INSERT INTO risk_settings(tenant_id) VALUES($1) ON CONFLICT DO NOTHING', [tenant.id]); return session(u, c); }); }

// Server-to-server ONAPPINSTALL webhook (Bitrix24 calls this URL directly when the
// app is installed — separate from the browser-driven installBitrix()/bitrixLogin()
// handshake above, which the frontend/iframe triggers instead). Perенесено из
// construction-erp, где это появилось как отдельный hardening-фикс: до этого в
// construction-core не было вообще никакого server-to-server webhook-приёмника.
//
// Fail-closed по умолчанию (тот же паттерн, что у остальных Bitrix-маршрутов):
// пока BITRIX_INSTALL_WEBHOOK_ENABLED не 'true', endpoint ничего не пишет в БД
// и отвечает {result:false} — включать только после проверки на тестовом портале
// (REQUIRES BITRIX24 TEST PORTAL VERIFICATION, см. docs/bitrix24-integration.md).
//
// application_token из payload сохраняется зашифрованным как эталон для будущих
// event-хендлеров (verifyApplicationToken ниже) — самих таких хендлеров пока нет,
// это инфраструктура на будущее, как и RealBitrixAdapter уже был готов, но неактивен.
const DOMAIN_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
export async function onAppInstallWebhook(body: any): Promise<{ result: boolean }> {
    if (process.env.BITRIX_INSTALL_WEBHOOK_ENABLED !== 'true') return { result: false };
    const auth = body?.auth ?? body;
    const domain: string | undefined = typeof auth?.domain === 'string' ? auth.domain.trim() : undefined;
    const memberId: string | undefined = typeof auth?.member_id === 'string' ? auth.member_id.trim() : undefined;
    const accessToken: string | undefined = typeof auth?.access_token === 'string' ? auth.access_token : undefined;
    const refreshToken: string | undefined = typeof auth?.refresh_token === 'string' ? auth.refresh_token : undefined;
    const applicationToken: string | undefined = typeof auth?.application_token === 'string' ? auth.application_token : undefined;
    const expiresIn = Number(auth?.expires_in ?? 3600);
    if (!domain || !memberId || !accessToken || !refreshToken || !applicationToken) return { result: false };
    if (!DOMAIN_RE.test(domain) || domain.length > 253) return { result: false };
    if (memberId.length < 8 || memberId.length > 128) return { result: false };
    if (accessToken.length < 10 || accessToken.length > 500 || refreshToken.length < 10 || refreshToken.length > 500) return { result: false };
    if (!Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > 86_400) return { result: false };
    await transaction(async (c) => {
        let tenant = await one(c, 'SELECT * FROM tenants WHERE member_id=$1', [memberId]);
        if (!tenant) tenant = await one(c, 'INSERT INTO tenants(portal,member_id,name) VALUES($1,$2,$3) RETURNING *', [domain, memberId, domain]);
        const data = { encryptedAccessToken: encrypt(accessToken), encryptedRefreshToken: encrypt(refreshToken), encryptedApplicationToken: encrypt(applicationToken), expiresAt: new Date(Date.now() + expiresIn * 1000) };
        const old = await one(c, 'SELECT * FROM bitrix_installations WHERE tenant_id=$1 FOR UPDATE', [tenant.id]);
        if (old) await c.query('UPDATE bitrix_installations SET encrypted_access_token=$2,encrypted_refresh_token=$3,encrypted_application_token=$4,expires_at=$5,version=version+1 WHERE tenant_id=$1', [tenant.id, data.encryptedAccessToken, data.encryptedRefreshToken, data.encryptedApplicationToken, data.expiresAt]);
        else await insert(c, 'bitrix_installations', tenant.id, { portal: domain, memberId, ...data });
    });
    return { result: true };
}

// Сверка application_token из последующих (не самого первого) Bitrix event-вызовов
// с эталоном, сохранённым при ONAPPINSTALL — timing-safe, как и остальные секреты
// в этом файле/security.ts. Пока не вызывается ни одним активным маршрутом (нет
// других event-хендлеров) — готова для их будущего подключения.
export async function verifyApplicationToken(memberId: string | undefined | null, incomingApplicationToken: string | undefined | null): Promise<boolean> {
    if (!memberId || !incomingApplicationToken) return false;
    const tenant = await one(pool, 'SELECT * FROM tenants WHERE member_id=$1', [memberId]);
    if (!tenant) return false;
    const installation = await one(pool, 'SELECT * FROM bitrix_installations WHERE tenant_id=$1', [tenant.id]);
    if (!installation?.encryptedApplicationToken) return false;
    let stored: string;
    try { stored = decrypt(installation.encryptedApplicationToken); } catch { return false; }
    const a = Buffer.from(stored, 'utf8'), b = Buffer.from(incomingApplicationToken, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
}
