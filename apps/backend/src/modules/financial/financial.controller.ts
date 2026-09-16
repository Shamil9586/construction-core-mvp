import { Controller, Post, Body, Req, Inject } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ProductionService } from '../../service';
import { authenticate } from '../../security';
import * as V from '../../validation';
@Controller()
@ApiTags('Financial')
@ApiBearerAuth()
export class FinancialController {
    constructor(@Inject(ProductionService) private service: ProductionService) {}
    @Post('financial-closings')
    async close(
    @Req()
    r: any,
    @Body()
    b: any) { return this.service.close(await authenticate(r), V.closeDto.parse(b)); }
}
