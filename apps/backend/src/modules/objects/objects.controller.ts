import { Controller, Get, Post, Param, Body, Query, Req, Inject } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { pool, rows } from '../../db';
import { ProductionService } from '../../service';
import { ReadService } from '../../read-service';
import { authenticate, objectAccess } from '../../security';
import * as V from '../../validation';
@Controller()
@ApiTags('Objects')
@ApiBearerAuth()
export class ObjectsController {
    constructor(@Inject(ProductionService) private service: ProductionService, @Inject(ReadService) private read: ReadService) {}
    @Get('objects')
    async objects(
    @Req()
    r: any,
    @Query('contractorId')
    contractorId?: string) { const a = await authenticate(r); return (await this.read.snapshot(a, contractorId ? { contractorId: V.uuid.parse(contractorId) } : {})).objects; }
    @Get('objects/:id')
    async object(
    @Req()
    r: any,
    @Param('id')
    id: string) { const a = await authenticate(r); await objectAccess(pool, a, V.uuid.parse(id)); const s = await this.read.snapshot(a); return { object: s.objects.find(o => o.id === id), works: s.works.filter(w => w.objectId === id) }; }
    @Post('objects')
    async createObject(
    @Req()
    r: any,
    @Body()
    b: any) { return this.service.createObject(await authenticate(r), V.objectDto.parse(b)); }
    @Get('objects/:id/works')
    async works(
    @Req()
    r: any,
    @Param('id')
    id: string) { const a = await authenticate(r); await objectAccess(pool, a, V.uuid.parse(id)); return (await this.read.snapshot(a)).works.filter(w => w.objectId === id); }
    @Get('objects/:id/contractors')
    async contractors(
    @Req()
    r: any,
    @Param('id')
    id: string) { const a = await authenticate(r); await objectAccess(pool, a, V.uuid.parse(id)); return rows(pool, 'SELECT oc.*,c.name AS contractor_name FROM object_contractors_active oc JOIN contractors c ON c.id=oc.contractor_id AND c.tenant_id=oc.tenant_id WHERE oc.tenant_id=$1 AND oc.object_id=$2 ORDER BY c.name', [a.tenantId, id]); }
    @Post('objects/:id/contractors')
    async assignContractor(
    @Req()
    r: any,
    @Param('id')
    id: string,
    @Body()
    b: any) { return this.service.assignContractor(await authenticate(r), V.uuid.parse(id), V.objectContractorDto.parse(b).contractorId); }
    @Post('objects/:id/contractors/:contractorId/remove')
    async removeContractor(
    @Req()
    r: any,
    @Param('id')
    id: string,
    @Param('contractorId')
    contractorId: string,
    @Body()
    b: any) { const dto = V.removeContractorDto.parse(b); return this.service.removeContractor(await authenticate(r), V.uuid.parse(id), V.uuid.parse(contractorId), dto.relationId, dto.version); }
    @Post('objects/:id/edit')
    async editObject(
    @Req()
    r: any,
    @Param('id')
    id: string,
    @Body()
    b: any) { return this.service.editObject(await authenticate(r), V.uuid.parse(id), V.objectEditDto.parse(b)); }
}
