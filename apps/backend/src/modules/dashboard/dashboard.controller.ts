import { Controller, Get, Req, Inject } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ReadService } from '../../read-service';
import { authenticate, requirePermission } from '../../security';
import { Permission as P } from '../../../../../packages/domain';
@Controller()
@ApiTags('Dashboard')
@ApiBearerAuth()
export class DashboardController {
    constructor(@Inject(ReadService) private read: ReadService) {}
    @Get('snapshot')
    async snapshot(
    @Req()
    r: any) { return this.read.snapshot(await authenticate(r)); }
    @Get('dashboard/executive')
    async dashboard(
    @Req()
    r: any) { const a = await authenticate(r); requirePermission(a, P.FINANCE_VIEW); return (await this.read.snapshot(a)).dashboard; }
}
