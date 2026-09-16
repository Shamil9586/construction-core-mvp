import { Controller, Post, Get, Param, Body, Req, Inject } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { pool, rows } from '../../db';
import { ProductionService } from '../../service';
import { ReadService } from '../../read-service';
import { authenticate, scoped, objectAccess, requirePermission, ensure } from '../../security';
import { Permission as P } from '../../../../../packages/domain';
import * as V from '../../validation';
@Controller()
@ApiTags('Works')
@ApiBearerAuth()
export class WorksController {
    constructor(@Inject(ProductionService) private service: ProductionService, @Inject(ReadService) private read: ReadService) {}
    @Post('works')
    async createWork(
    @Req()
    r: any,
    @Body()
    b: any) { return this.service.createWork(await authenticate(r), V.workDto.parse(b)); }
    @Get('works/:id')
    async work(
    @Req()
    r: any,
    @Param('id')
    id: string) { const a = await authenticate(r); const w = await scoped(pool, 'works', V.uuid.parse(id), a); await objectAccess(pool, a, w.objectId); ensure(a.role !== 'CONTRACTOR_VIEWER' || a.contractorId === w.contractorId, 'Работа другого подрядчика'); return (await this.read.snapshot(a)).works.find(w => w.id === id); }
    @Get('works/:id/transition')
    async transition(
    @Req()
    r: any,
    @Param('id')
    id: string) { return this.service.transition(pool, await authenticate(r), V.uuid.parse(id)); }
    @Post('work-dependencies')
    async dependency(
    @Req()
    r: any,
    @Body()
    b: any) { return this.service.dependency(await authenticate(r), z.object({ predecessorWorkId: V.uuid, successorWorkId: V.uuid, requiresAcceptance: z.boolean(), requiresDocument: z.boolean().optional() }).strict().parse(b)); }
    @Post('works/:id/progress')
    async progress(
    @Req()
    r: any,
    @Param('id')
    id: string,
    @Body()
    b: any) { return this.service.progress(await authenticate(r), V.uuid.parse(id), V.progressDto.parse(b)); }
    @Get('works/:id/progress')
    async history(
    @Req()
    r: any,
    @Param('id')
    id: string) { const a = await authenticate(r), w = await scoped(pool, 'works', V.uuid.parse(id), a); await objectAccess(pool, a, w.objectId); requirePermission(a, P.WORK_VIEW); ensure(a.role !== 'CONTRACTOR_VIEWER' || a.contractorId === w.contractorId, 'Работа другого подрядчика'); return rows(pool, 'SELECT * FROM work_progress WHERE tenant_id=$1 AND object_work_id=$2 ORDER BY reported_at', [a.tenantId, id]); }
    @Post('works/:id/start')
    async start(
    @Req()
    r: any,
    @Param('id')
    id: string,
    @Body()
    b: any) { return this.service.start(await authenticate(r), V.uuid.parse(id), V.version.parse(b.version)); }
    @Post('works/:id/inspection-request')
    async inspection(
    @Req()
    r: any,
    @Param('id')
    id: string,
    @Body()
    b: any) { return this.service.requestInspection(await authenticate(r), V.uuid.parse(id), V.version.parse(b.version)); }
}
