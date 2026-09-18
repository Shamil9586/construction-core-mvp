import { Controller, Get, Post, Param, Body, Query, Req, Inject } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { pool } from '../../db';
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
    b: any) { return this.service.removeContractor(await authenticate(r), V.uuid.parse(id), V.uuid.parse(contractorId), V.version.parse(b.version)); }
}
