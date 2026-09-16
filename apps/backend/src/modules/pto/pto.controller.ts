import { Controller, Post, Get, Param, Body, Req, Inject } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { pool } from '../../db';
import { ProductionService } from '../../service';
import { ReadService } from '../../read-service';
import { authenticate, requirePermission } from '../../security';
import { Permission as P } from '../../../../../packages/domain';
import * as V from '../../validation';
@Controller()
@ApiTags('PTO')
@ApiBearerAuth()
export class PtoController {
    constructor(@Inject(ProductionService) private service: ProductionService, @Inject(ReadService) private read: ReadService) {}
    @Post('executive-packages')
    async package(
    @Req()
    r: any,
    @Body()
    b: any) { return this.service.createPackage(await authenticate(r), V.uuid.parse(b.objectWorkId)); }
    @Get('executive-packages')
    async packages(
    @Req()
    r: any) { const a = await authenticate(r); requirePermission(a, P.PTO_VIEW); return (await this.read.snapshot(a)).packages; }
    @Post('executive-documents')
    async document(
    @Req()
    r: any,
    @Body()
    b: any) { return this.service.createDocument(await authenticate(r), z.object({ packageId: V.uuid, type: z.enum(['AOSR', 'EXECUTIVE_SCHEME', 'CERTIFICATE', 'PASSPORT', 'LAB_REPORT', 'OTHER']), number: V.text, documentDate: V.date, fileId: V.uuid.optional() }).strict().parse(b)); }
    @Post('executive-documents/:id/approve')
    async approve(
    @Req()
    r: any,
    @Param('id')
    id: string,
    @Body()
    b: any) { return this.service.approveDocument(await authenticate(r), V.uuid.parse(id), V.version.parse(b.version)); }
    @Get('executive-packages/:id/validation')
    async validation(
    @Req()
    r: any,
    @Param('id')
    id: string) { const a = await authenticate(r); requirePermission(a, P.PTO_VIEW); return this.service.packageValidation(pool, a, V.uuid.parse(id)); }
    @Post('executive-packages/:id/ready')
    async packageReady(
    @Req()
    r: any,
    @Param('id')
    id: string,
    @Body()
    b: any) { return this.service.packageAction(await authenticate(r), V.uuid.parse(id), V.version.parse(b.version), 'ready'); }
    @Post('executive-packages/:id/transfer-sdo')
    async transfer(
    @Req()
    r: any,
    @Param('id')
    id: string,
    @Body()
    b: any) { return this.service.packageAction(await authenticate(r), V.uuid.parse(id), V.version.parse(b.version), 'transfer-sdo'); }
}
