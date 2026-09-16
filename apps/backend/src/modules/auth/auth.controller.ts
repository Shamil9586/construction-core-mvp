import { Controller, Post, Get, Body, Req, Res, UnauthorizedException } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { pool } from '../../db';
import { authenticate, session, sameSecret, hash } from '../../security';
import { roles } from '../../../../../packages/domain';
import { one } from '../../db';
import { bitrixLogin, installBitrix, MockBitrixAdapter } from '../../bitrix';
import { ensure } from '../../security';
@Controller()
@ApiTags('Auth')
@ApiBearerAuth()
export class AuthController {
    @Post('auth/mock')
    async mock(
    @Body()
    body: any) { if (process.env.AUTH_MODE !== 'mock' || !sameSecret(body.key, process.env.MOCK_LOGIN_KEY ?? ''))
        throw new UnauthorizedException('Неверный тестовый ключ'); const role = z.enum(roles).parse(body.role); const tenant = await one(pool, "SELECT id FROM tenants WHERE portal='demo.local'"); const user = await one(pool, 'SELECT * FROM users WHERE tenant_id=$1 AND role=$2 AND is_active=true ORDER BY bitrix_user_id LIMIT 1', [tenant.id, role]); await new MockBitrixAdapter().currentUser(user.bitrixUserId); return session(user); }
    @Post('auth/bitrix')
    login(
    @Body()
    body: any) { return bitrixLogin(body); }
    @Post('auth/bitrix/install')
    async install(
    @Req()
    r: any,
    @Body()
    b: any,
    @Res()
    res: any) { ensure(r.headers.origin === `https://${process.env.BITRIX_PORTAL}`, 'Invalid portal origin'); const result = await installBitrix(b); this.launchHtml(res, result, true); }
    @Post('auth/bitrix/launch')
    async launch(
    @Req()
    r: any,
    @Body()
    b: any,
    @Res()
    res: any) { ensure(r.headers.origin === `https://${process.env.BITRIX_PORTAL}`, 'Invalid portal origin'); const result = await bitrixLogin(b); this.launchHtml(res, result, false); }
    private launchHtml(res: any, result: any, install: boolean) { const nonce = require('node:crypto').randomBytes(18).toString('base64'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}' https://api.bitrix24.com; frame-ancestors https://${process.env.BITRIX_PORTAL}; base-uri 'none'`); res.type('html').send(`<!doctype html><html lang="ru"><meta charset="utf-8"><title>Вход в приложение</title><body><p>Открываем производственную систему…</p>${install ? '<script src="https://api.bitrix24.com/api/v1/"></script>' : ''}<script nonce="${nonce}">sessionStorage.setItem('session',${JSON.stringify(result.token)});${install ? "BX24.init(function(){BX24.installFinish();location.replace('/')});" : "location.replace('/');"}</script></body></html>`); }
    @Post('auth/logout') async logout(@Req() r:any){const a=await authenticate(r);await pool.query('DELETE FROM sessions WHERE tenant_id=$1 AND token_hash=$2',[a.tenantId,hash(r.headers.authorization.replace(/^Bearer /,''))]);return {loggedOut:true};}
    @Get('me')
    me(
    @Req()
    r: any) { return authenticate(r); }
}
