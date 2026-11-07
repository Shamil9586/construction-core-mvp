import { Controller, Post, Get, Param, Body, Req, Inject, Header } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { pool, rows } from '../../db';
import { ProductionService } from '../../service';
import { ReadService } from '../../read-service';
import { authenticate, scoped, objectAccess, workAccess, requirePermission, ensure } from '../../security';
import { Permission as P } from '../../../../../packages/domain';
import * as V from '../../validation';
import { readWorkQuantity } from '../../gpr2-r06a-quantity';
import { hash } from '../../security';
import { replaceWorkAllocation } from '../../gpr2-r06b-allocation';
import { readZonalRelease, configureZonalRelease } from '../../gpr2-r08-release';
@Controller()
@ApiTags('Works')
@ApiBearerAuth()
export class WorksController {
    constructor(@Inject(ProductionService) private service: ProductionService, @Inject(ReadService) private read: ReadService) {}
    @Get('objects/:objectId/works/:workId/execution-units/:unitId/release')
    @Header('Cache-Control', 'no-store')
    release(@Req() r: any, @Param('objectId') objectId: string, @Param('workId') workId: string,
        @Param('unitId') unitId: string) {
        return authenticate(r).then(a=>readZonalRelease(pool,a,V.uuid.parse(objectId),V.uuid.parse(workId),V.uuid.parse(unitId)));
    }
    @Post('objects/:objectId/r08-release-setup')
    async releaseSetup(@Req() r:any,@Param('objectId') objectId:string,@Body() b:any) {
        const body=z.object({workId:V.uuid,executionUnitId:V.uuid,areaScopeId:V.uuid,
            basis:z.string().trim().min(1).max(1000),policy:z.enum(['REQUIRED','NOT_REQUIRED']),
            requirements:z.array(z.object({sourceWorkId:V.uuid,sourceExecutionUnitId:V.uuid,
                sourceAreaScopeId:V.uuid,requiresInternalSc:z.boolean(),cureSeconds:z.number().int().min(0).max(315360000)}).strict()).max(100)}).strict().parse(b);
        return configureZonalRelease(await authenticate(r),V.uuid.parse(objectId),body,
            hash(String(r.headers.authorization).replace(/^Bearer /,'')));
    }
    @Get('objects/:objectId/works/:workId/quantity')
    @Header('Cache-Control', 'no-store')
    async quantity(@Req() r: any, @Param('objectId') objectId: string, @Param('workId') workId: string) {
        return readWorkQuantity(await authenticate(r), objectId, workId);
    }
    @Post('objects/:objectId/works/:workId/allocations')
    async allocate(@Req() r: any, @Param('objectId') objectId: string, @Param('workId') workId: string, @Body() b: any) {
        return replaceWorkAllocation(await authenticate(r), V.uuid.parse(objectId), V.uuid.parse(workId),
            V.workAllocationDto.parse(b) as any, hash(String(r.headers.authorization).replace(/^Bearer /, '')));
    }
    @Post('works')
    async createWork(
    @Req()
    r: any,
    @Body()
    b: any) { return this.service.createWork(await authenticate(r), V.workDto.parse(b)); }
    @Post('works/:id/complete-planning')
    async completePlanning(@Req() r: any, @Param('id') id: string, @Body() b: any) { return this.service.completeWorkPlanning(await authenticate(r), V.uuid.parse(id), V.completeWorkPlanningDto.parse(b)); }
    @Get('works/:id')
    async work(
    @Req()
    r: any,
    @Param('id')
    id: string) { const a = await authenticate(r); const w = await scoped(pool, 'works', V.uuid.parse(id), a); await workAccess(pool, a, w); ensure(a.role !== 'CONTRACTOR_VIEWER' || a.contractorId === w.contractorId, 'Работа другого подрядчика'); return (await this.read.snapshot(a)).works.find(w => w.id === id); }
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
    id: string) { const a = await authenticate(r), w = await scoped(pool, 'works', V.uuid.parse(id), a); await workAccess(pool, a, w); requirePermission(a, P.WORK_VIEW); ensure(a.role !== 'CONTRACTOR_VIEWER' || a.contractorId === w.contractorId, 'Работа другого подрядчика'); return rows(pool, 'SELECT * FROM work_progress WHERE tenant_id=$1 AND object_work_id=$2 ORDER BY reported_at', [a.tenantId, id]); }
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
