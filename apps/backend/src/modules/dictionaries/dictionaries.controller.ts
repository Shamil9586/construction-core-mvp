import { Controller, Post, Get, Body, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { pool, rows, one, transaction, insert } from '../../db';
import { authenticate, requirePermission, scoped, audit, ensure, checkVersion } from '../../security';
import { Permission as P } from '../../../../../packages/domain';
import * as V from '../../validation';
@Controller()
@ApiTags('Dictionaries')
@ApiBearerAuth()
export class DictionariesController {
    @Get('dictionaries')
    async dictionaries(
    @Req()
    r: any) { const a = await authenticate(r); requirePermission(a, P.WORK_VIEW); return { categories: await rows(pool, 'SELECT * FROM work_categories WHERE tenant_id=$1', [a.tenantId]), workTypes: await rows(pool, 'SELECT * FROM work_types WHERE tenant_id=$1', [a.tenantId]) }; }
    @Post('dictionaries/work-types')
    async addType(
    @Req()
    r: any,
    @Body()
    b: any) { const a = await authenticate(r); requirePermission(a, P.ADMIN_DICTIONARIES); const d = z.object({ categoryId: V.uuid, name: V.text, unit: V.text, requiresInspection: z.boolean(), requiresExecutiveDocs: z.boolean(), requiresMaterials: z.boolean() }).strict().parse(b); await scoped(pool, 'work_categories', d.categoryId, a); return insert(pool, 'work_types', a.tenantId, d); }
    @Post('settings/risk')
    async risk(
    @Req()
    r: any,
    @Body()
    b: any) { const a = await authenticate(r); requirePermission(a, P.ADMIN_DICTIONARIES); const d = z.object({ yellowVariance: z.number().min(-50).max(0), redVariance: z.number().min(-100).max(-1), staleDays: z.number().int().min(1).max(90), ptoDays: z.number().int().min(1).max(90), sdoDays: z.number().int().min(1).max(90), escalateTechnicalDays: z.number().int().min(1).max(90), escalateDirectorDays: z.number().int().min(1).max(180), version: V.version }).strict().parse(b); ensure(d.redVariance < d.yellowVariance && d.escalateDirectorDays > d.escalateTechnicalDays, 'Неверный порядок порогов'); return transaction(async (c) => { const old = await one(c, 'SELECT * FROM risk_settings WHERE tenant_id=$1 FOR UPDATE', [a.tenantId]); checkVersion(old, d.version); const n = await one(c, 'UPDATE risk_settings SET yellow_variance=$2,red_variance=$3,stale_days=$4,pto_days=$5,sdo_days=$6,escalate_technical_days=$7,escalate_director_days=$8,version=version+1 WHERE tenant_id=$1 RETURNING *', [a.tenantId, d.yellowVariance, d.redVariance, d.staleDays, d.ptoDays, d.sdoDays, d.escalateTechnicalDays, d.escalateDirectorDays]); await audit(c, a, 'RiskSettings', n.id, 'UPDATE', old, n); return n; }); }
}
