import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Module, Catch, ArgumentsHost, ExceptionFilter, HttpException } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { BitrixModule } from './modules/bitrix/bitrix.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { ObjectsModule } from './modules/objects/objects.module';
import { WorksModule } from './modules/works/works.module';
import { InspectionsModule } from './modules/inspections/inspections.module';
import { ExecutionUnitsModule } from './modules/execution-units/execution-units.module';
import { DocumentationModule } from './modules/documentation/documentation.module';
import { AttachmentsModule } from './modules/attachments/attachments.module';
import { PtoModule } from './modules/pto/pto.module';
import { SdoModule } from './modules/sdo/sdo.module';
import { SdoClosingModule } from './modules/sdo-closing/sdo-closing.module';
import { FinancialModule } from './modules/financial/financial.module';
import { ContractorsModule } from './modules/contractors/contractors.module';
import { DictionariesModule } from './modules/dictionaries/dictionaries.module';
import { UsersModule } from './modules/users/users.module';
import { MaterialsModule } from './modules/materials/materials.module';
import { AuditModule } from './modules/audit/audit.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { ImportsModule } from './modules/imports/imports.module';
@Catch()
class Errors implements ExceptionFilter {
    catch(error: any, host: ArgumentsHost) { const ctx = host.switchToHttp(), res = ctx.getResponse(), req = ctx.getRequest(); const status = error instanceof ZodError ? 400 : error instanceof HttpException ? error.getStatus() : ['23505', '23503', '23514', '22P02'].includes(error.code) ? 409 : 500; const message = error instanceof ZodError ? error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') : status === 500 ? 'Внутренняя ошибка' : error instanceof HttpException ? error.message : 'Конфликт данных или нарушена связь'; if (status === 500)
        console.error(JSON.stringify({ level: 'error', requestId: req.requestId, errorType: error.constructor?.name, code: error.code })); res.status(status).json({ statusCode: status, message, requestId: req.requestId }); }
}
@Module({ imports: [HealthModule, AuthModule, BitrixModule, DashboardModule, ObjectsModule, WorksModule, InspectionsModule, ExecutionUnitsModule, DocumentationModule, AttachmentsModule, PtoModule, SdoModule, SdoClosingModule, FinancialModule, ContractorsModule, DictionariesModule, UsersModule, MaterialsModule, AuditModule, NotificationsModule, ImportsModule] })
class AppModule {
}
/**
 * A window longer than this cannot be expressed as a Node timer: setInterval
 * stores the delay as a signed 32-bit integer, and a larger value overflows to
 * a delay of 1ms. express-rate-limit builds its MemoryStore cleanup interval
 * from windowMs, so an oversized window would silently reset every counter
 * almost immediately — the opposite of what the configured value asks for.
 */
const TIMER_MAX_MS = 2147483647;
/**
 * Rate-limit window and limits are deployment configuration, not business logic.
 * Without the env vars the values below are exactly the previous production
 * defaults (60000ms / 300 global / 30 on /auth). A present but unparsable or
 * out-of-range value aborts startup instead of silently becoming NaN or a 1ms
 * window — express-rate-limit treats a NaN limit as no limit at all, so failing
 * closed is the only safe reading. The timer bound applies to the window only;
 * request counts are not delays and keep the full safe-integer range.
 */
export function positiveIntEnv(name: string, fallback: number, max = Number.MAX_SAFE_INTEGER) { const raw = process.env[name]?.trim(); if (raw === undefined || raw === '')
    return fallback; const value = Number(raw); if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(value) || value > max)
    throw Error(name + ' must be a positive integer' + (max < Number.MAX_SAFE_INTEGER ? ' not greater than ' + max : '')); return value; }
export async function createApp() { if (!['mock', 'bitrix'].includes(process.env.AUTH_MODE ?? ''))
    throw Error('Set AUTH_MODE explicitly'); if (process.env.AUTH_MODE === 'mock' && !process.env.MOCK_LOGIN_KEY)
    throw Error('Set MOCK_LOGIN_KEY'); if (process.env.NODE_ENV === 'production' && process.env.AUTH_MODE === 'mock')
    throw Error('Mock auth prohibited in production'); const rateLimitWindowMs = positiveIntEnv('RATE_LIMIT_WINDOW_MS', 60000, TIMER_MAX_MS), rateLimitMax = positiveIntEnv('RATE_LIMIT_MAX', 300), authRateLimitMax = positiveIntEnv('AUTH_RATE_LIMIT_MAX', 30); const app = await NestFactory.create(AppModule, { bodyParser: false, logger: ['error', 'warn', 'log'] }); if(process.env.TRUST_PROXY_HOPS==='1')app.getHttpAdapter().getInstance().set('trust proxy',1); app.enableShutdownHooks(); app.use(express.json({ limit: '8mb' })); app.use(express.urlencoded({ extended: true, limit: '64kb' })); app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' }, xFrameOptions: false, contentSecurityPolicy: { directives: { frameAncestors: ["'self'", ...(process.env.BITRIX_PORTAL ? [`https://${process.env.BITRIX_PORTAL}`] : [])] } } })); app.enableCors({ origin: process.env.APP_ORIGIN ?? 'http://localhost:5173', allowedHeaders: ['Authorization', 'Content-Type'], methods: ['GET', 'POST'] }); app.use(rateLimit({ windowMs: rateLimitWindowMs, limit: rateLimitMax })); app.use('/auth', rateLimit({ windowMs: rateLimitWindowMs, limit: authRateLimitMax })); app.use((req: any, res: any, next: any) => { req.requestId = randomUUID(); res.setHeader('X-Request-Id', req.requestId); const start = Date.now(); res.on('finish', () => console.log(JSON.stringify({ level: 'info', requestId: req.requestId, method: req.method, path: req.path, status: res.statusCode, durationMs: Date.now() - start }))); next(); }); app.useGlobalFilters(new Errors()); const doc = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('Construction Core API').setVersion('0.1.0').addBearerAuth().build()); SwaggerModule.setup('api-docs', app, doc); return app; }
if (require.main === module)
    createApp().then(app => app.listen(Number(process.env.PORT ?? 3001), process.env.BIND_HOST ?? '0.0.0.0')).catch(e => { console.error(e); process.exit(1); });
