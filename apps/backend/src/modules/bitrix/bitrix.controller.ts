import { Controller, Post, Get, Body, Req, BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { onAppInstallWebhook, RealBitrixAdapter } from '../../bitrix';
import { authenticate, requirePermission } from '../../security';
import { Permission as P } from '../../../../../packages/domain';
// Bitrix24 user.get отдаёт ровно 50 записей на страницу и сдвигается параметром start.
// Ответ обрезается верхней границей запросов, чтобы портал с аномально большим
// штатом (или портал, игнорирующий start) не превратил чтение в бесконечный цикл.
const DIRECTORY_PAGE_SIZE = 50;
const DIRECTORY_MAX_REQUESTS = 40;
const trimmed = (value: any) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
// Allowlist, а не blacklist: в ответ попадают только поля, разрешённые скоупом
// user_brief и нужные Core. Почта, телефоны, адреса, служебные UF_* и любая
// метаинформация Bitrix отбрасываются здесь, а не на фронтенде.
function sanitizeEmployee(raw: any) {
    const employee: Record<string, unknown> = {
        ID: String(raw.ID),
        NAME: trimmed(raw.NAME) ?? null,
        LAST_NAME: trimmed(raw.LAST_NAME) ?? null,
        ACTIVE: raw.ACTIVE === true || raw.ACTIVE === 'Y' || raw.ACTIVE === 1 || raw.ACTIVE === '1',
        WORK_POSITION: trimmed(raw.WORK_POSITION) ?? null,
        UF_DEPARTMENT: Array.isArray(raw.UF_DEPARTMENT) ? raw.UF_DEPARTMENT.map(Number).filter(Number.isFinite) : []
    };
    const secondName = trimmed(raw.SECOND_NAME);
    if (secondName) employee.SECOND_NAME = secondName;
    return employee;
}
// Server-to-server ONAPPINSTALL webhook (не browser-flow из auth-модуля) — fail-closed
// за BITRIX_INSTALL_WEBHOOK_ENABLED, см. bitrix.ts.
@Controller()
@ApiTags('Bitrix')
@ApiBearerAuth()
export class BitrixController {
    @Post('bitrix/onappinstall') onAppInstall(@Body() body: any) { return onAppInstallWebhook(body); }
    // Первый шаг интеграции со штатным расписанием портала: только чтение.
    // Ничего не пишется в Core (ни пользователей, ни ролей, ни синхронизации) —
    // это витрина сотрудников установленного портала, привязанная исключительно
    // к tenantId аутентифицированного Actor. Токен портала не покидает
    // RealBitrixAdapter: installedCall сам расшифровывает его и сам же
    // обрабатывает expired_token/refresh.
    @Get('bitrix/directory/users')
    async directoryUsers(
    @Req()
    r: any) {
        const a = await authenticate(r);
        if (process.env.AUTH_MODE !== 'bitrix')
            throw new UnauthorizedException('Bitrix mode disabled');
        // Первый интеграционный шлюз намеренно уже, чем ADMIN_USERS по матрице прав:
        // читать штат портала может только роль ADMIN.
        requirePermission(a, P.ADMIN_USERS);
        if (a.role !== 'ADMIN')
            throw new ForbiddenException('Недостаточно прав: ADMIN');
        // Запрос не имеет ни одного легального параметра: tenantId, portal, member_id
        // и токены берутся только из сессии, поэтому любой query отвергается целиком.
        z.object({}).strict().parse({ ...(r.query ?? {}) });
        const adapter = new RealBitrixAdapter();
        const seen = new Set<string>();
        const users: Record<string, unknown>[] = [];
        let truncated = false;
        for (let request = 0;; request++) {
            if (request >= DIRECTORY_MAX_REQUESTS) { truncated = true; break; }
            const page = await adapter.installedCall(a.tenantId, 'user.get', { start: request * DIRECTORY_PAGE_SIZE });
            if (!Array.isArray(page))
                throw new BadRequestException('Bitrix вернул неожиданный ответ user.get');
            const known = seen.size;
            for (const raw of page) {
                if (raw?.ID === undefined || raw?.ID === null) continue;
                const employee = sanitizeEmployee(raw);
                if (seen.has(employee.ID as string)) continue;
                seen.add(employee.ID as string);
                users.push(employee);
            }
            // Bitrix сигнализирует об окончании неполной страницей; повтор тех же ID
            // означает портал, игнорирующий start, и тоже обязан останавливать цикл.
            if (page.length < DIRECTORY_PAGE_SIZE || seen.size === known) break;
        }
        return { users, count: users.length, truncated };
    }
}
