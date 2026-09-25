import { Controller, Post, Body, Param, Req, Inject } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ProductionService } from '../../service';
import { authenticate } from '../../security';
import * as V from '../../validation';

/**
 * F8.1 Production Execution + Construction Control Foundation.
 *
 * Creation posts flat with the parent id in the body (execution-units,
 * objectWorkId in the body) — the same shape POST works already uses for
 * objectId. An action on an existing resource nests under that resource's
 * own id (works/:id/progress, works/:id/inspection-request) — portions/:id/fact
 * and portions/:id/inspection-request follow that exactly.
 *
 * Accepting/rejecting either inspection type, and raising an issue against
 * either, are NOT new routes here: inspectionAction() and addIssue() are
 * unchanged (F8.1 decision 5 — one workflow, not two) and already work for a
 * portion-scoped or Customer SC inspection through the existing
 * InspectionsController routes (inspections/:id/accept, /reject, /issues).
 */
@Controller()
@ApiTags('ExecutionUnits')
@ApiBearerAuth()
export class ExecutionUnitsController {
    constructor(@Inject(ProductionService) private service: ProductionService) {}

    @Post('execution-units')
    async createExecutionUnit(@Req() r: any, @Body() b: any) {
        return this.service.createExecutionUnit(await authenticate(r), V.executionUnitDto.parse(b));
    }

    @Post('execution-units/:id/layers')
    async addLayer(@Req() r: any, @Param('id') id: string, @Body() b: any) {
        return this.service.addExecutionUnitLayer(await authenticate(r), V.uuid.parse(id), V.executionUnitLayerDto.parse(b));
    }

    @Post('execution-units/:id/portions')
    async createPortion(@Req() r: any, @Param('id') id: string, @Body() b: any) {
        return this.service.createQuantityPortion(await authenticate(r), V.uuid.parse(id), V.quantityPortionDto.parse(b));
    }

    @Post('portions/:id/fact')
    async recordFact(@Req() r: any, @Param('id') id: string, @Body() b: any) {
        return this.service.recordPortionFact(await authenticate(r), V.uuid.parse(id), V.portionFactDto.parse(b));
    }

    @Post('portions/:id/inspection-request')
    async requestInspection(@Req() r: any, @Param('id') id: string, @Body() b: any) {
        const d = V.portionInspectionRequestDto.parse(b);
        return this.service.requestPortionInspection(await authenticate(r), V.uuid.parse(id), d.version, d.inspectionType);
    }
}
