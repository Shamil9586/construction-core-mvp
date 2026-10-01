import { Controller, Get, Post, Param, Body, Req, Query, Inject } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { OrgStructureService } from '../../org-structure-service';
import { ORG_FUNCTION_CODES, type OrgFunctionCode } from '../../team-service';
import { authenticate } from '../../security';
import * as V from '../../validation';

// ORG-1: every body is .strict() — tenantId/assignedBy/functionCode can never come from the client
// (tenant + actor from the session, function from the route).
const fnCode = z.enum(ORG_FUNCTION_CODES as [OrgFunctionCode, ...OrgFunctionCode[]]);
const assignDto = z.object({ memberUserId: V.uuid, managerUserId: V.uuid }).strict();
const transferDto = z.object({ memberUserId: V.uuid, managerUserId: V.uuid, reason: V.text, expectedAssignmentId: V.uuid, expectedVersion: V.version }).strict();
const endDto = z.object({ memberUserId: V.uuid, reason: V.text, expectedAssignmentId: V.uuid, expectedVersion: V.version }).strict();
const historyQuery = z.object({ functionCode: fnCode.optional(), memberUserId: V.uuid.optional() }).strict();

@Controller()
@ApiTags('Org structure')
@ApiBearerAuth()
export class OrgStructureController {
    constructor(@Inject(OrgStructureService) private service: OrgStructureService) {}
    @Get('org-structure')
    async overview(@Req() r: any) { return this.service.overview(await authenticate(r)); }
    @Get('org-structure/history')
    async history(@Req() r: any, @Query() q: any) { return this.service.history(await authenticate(r), historyQuery.parse(q ?? {})); }
    @Post('org-structure/:fn/assign')
    async assign(@Req() r: any, @Param('fn') fn: string, @Body() b: any) { return this.service.assign(await authenticate(r), fnCode.parse(fn), assignDto.parse(b)); }
    @Post('org-structure/:fn/transfer')
    async transfer(@Req() r: any, @Param('fn') fn: string, @Body() b: any) { return this.service.transfer(await authenticate(r), fnCode.parse(fn), transferDto.parse(b)); }
    @Post('org-structure/:fn/end')
    async end(@Req() r: any, @Param('fn') fn: string, @Body() b: any) { return this.service.end(await authenticate(r), fnCode.parse(fn), endDto.parse(b)); }
}
