import { Controller, Post, Get, Param, Body, Req, Inject } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ProductionService } from '../../service';
import { ReadService } from '../../read-service';
import { authenticate, requirePermission } from '../../security';
import { Permission as P } from '../../../../../packages/domain';
import * as V from '../../validation';

/**
 * F8.3 SDO / Closing. New, additive controller — the SDO Case model here
 * hangs off documentation_packages/quantity_portions and never touches the
 * legacy executive-packages/sdo_cases/financial_closings pipeline
 * (sdo.controller.ts/pto.controller.ts, both untouched by this file). See
 * infra/008_sdo_closing.sql for why the two do not share a table.
 *
 * `sdo-closing-cases` (GET) reuses the existing SDO_VIEW permission — it
 * already grants exactly the intended read audience (every internal role
 * except CONTRACTOR_VIEWER, which SDO_VIEW has never included). Every
 * mutation below requires SDO_CASE_MANAGE (SDO/ADMIN only) — PTO's own
 * side of F8.3 (customer-acceptance registration, handoff) lives in
 * documentation.controller.ts instead, gated by DOCUMENTATION_MANAGE.
 */
@Controller()
@ApiTags('SdoClosing')
@ApiBearerAuth()
export class SdoClosingController {
    constructor(@Inject(ProductionService) private service: ProductionService, @Inject(ReadService) private read: ReadService) {}

    @Get('sdo-closing-cases')
    async cases(@Req() r: any) {
        const a = await authenticate(r);
        requirePermission(a, P.SDO_VIEW);
        return (await this.read.snapshot(a)).sdoClosingCases ?? [];
    }

    @Post('sdo-closing-cases/:id/return-to-pto')
    async returnToPto(@Req() r: any, @Param('id') id: string, @Body() b: any) {
        const d = V.sdoReturnToPtoDto.parse(b);
        return this.service.returnSdoCaseToPto(await authenticate(r), V.uuid.parse(id), d);
    }

    @Post('sdo-closing-cases/:id/responsible')
    async assignResponsible(@Req() r: any, @Param('id') id: string, @Body() b: any) {
        const d = V.sdoResponsibleDto.parse(b);
        return this.service.assignSdoResponsible(await authenticate(r), V.uuid.parse(id), d);
    }

    @Post('sdo-closing-cases/:id/status')
    async changeStatus(@Req() r: any, @Param('id') id: string, @Body() b: any) {
        const d = V.sdoClosingStatusDto.parse(b);
        return this.service.changeSdoClosingStatus(await authenticate(r), V.uuid.parse(id), d);
    }

    @Post('sdo-closing-cases/:id/amount')
    async setAmount(@Req() r: any, @Param('id') id: string, @Body() b: any) {
        const d = V.sdoClosingAmountDto.parse(b);
        return this.service.setSdoClosingAmount(await authenticate(r), V.uuid.parse(id), d);
    }

    @Post('sdo-closing-cases/:id/allocations')
    async addAllocation(@Req() r: any, @Param('id') id: string, @Body() b: any) {
        const d = V.sdoClosingAllocationDto.parse(b);
        return this.service.addSdoClosingPortionAllocation(await authenticate(r), V.uuid.parse(id), d);
    }
}
