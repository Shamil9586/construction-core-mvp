import { Controller, Get, Post, Param, Body, Req, Inject } from '@nestjs/common';
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
    r: any) { return (await this.read.snapshot(await authenticate(r))).objects; }
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
}
