import { Controller, Post, Get, Param, Body, Req, Inject } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ProductionService } from '../../service';
import { ReadService } from '../../read-service';
import { authenticate, requirePermission } from '../../security';
import { Permission as P } from '../../../../../packages/domain';
import * as V from '../../validation';
@Controller()
@ApiTags('SDO')
@ApiBearerAuth()
export class SdoController {
    constructor(@Inject(ProductionService) private service: ProductionService, @Inject(ReadService) private read: ReadService) {}
    @Get('sdo')
    async sdo(
    @Req()
    r: any) { const a = await authenticate(r); requirePermission(a, P.SDO_VIEW); return (await this.read.snapshot(a)).sdo; }
    @Post('sdo/:id/calculate')
    async calculate(
    @Req()
    r: any,
    @Param('id')
    id: string,
    @Body()
    b: any) { return this.service.calculateSdo(await authenticate(r), V.uuid.parse(id), z.object({ version: V.version, calculatedValue: V.money }).strict().parse(b)); }
}
