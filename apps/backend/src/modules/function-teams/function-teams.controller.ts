import { Controller, Get, Post, Param, Body, Req, Inject } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ObjectTeamService } from '../../team-service';
import { authenticate } from '../../security';
import * as V from '../../validation';

// PBX-3A: PTO object-team foundation. Every body is .strict(): a client can never inject
// tenantId/functionCode/assignedBy/etc. — those are fixed server-side (tenant + PTO from the
// session and route, assigned_by from the authenticated actor).
const reason = V.text.optional();
const orgMemberDto = z.object({ memberUserId: V.uuid, managerUserId: V.uuid, reason, expectedVersion: V.version.optional() }).strict();
const leadDto = z.object({ leadUserId: V.uuid, reason, note: V.text.optional(), expectedVersion: V.version.optional() }).strict();
const memberDto = z.object({ memberUserId: V.uuid }).strict();
const endMemberDto = z.object({ reason, expectedVersion: V.version.optional() }).strict();
const list = <T extends z.ZodTypeAny>(t: T) => z.array(t).max(100).default([]);
const redistributeDto = z.object({
    reason: V.text,
    orgTransfers: list(z.object({ memberUserId: V.uuid, toManagerUserId: V.uuid }).strict()),
    orgEnds: list(z.object({ memberUserId: V.uuid }).strict()),
    leadChanges: list(z.object({ objectId: V.uuid, leadUserId: V.uuid }).strict()),
    memberEnds: list(z.object({ objectId: V.uuid, memberUserId: V.uuid }).strict()),
    memberAdds: list(z.object({ objectId: V.uuid, memberUserId: V.uuid }).strict()),
    handovers: list(z.object({ objectId: V.uuid, outgoingUserId: V.uuid, incomingUserId: V.uuid, note: V.text.optional() }).strict()),
}).strict();
const ackDto = z.object({ version: V.version }).strict();
const adminCompleteDto = z.object({ version: V.version, reason: V.text }).strict();

@Controller()
@ApiTags('Function teams')
@ApiBearerAuth()
export class FunctionTeamsController {
    constructor(@Inject(ObjectTeamService) private service: ObjectTeamService) {}
    @Get('function-teams/pto/overview')
    async overview(@Req() r: any) { return this.service.overview(await authenticate(r)); }
    @Get('function-teams/pto/my-team')
    async myTeam(@Req() r: any) { return this.service.myTeam(await authenticate(r)); }
    @Get('objects/:id/function-team/pto')
    async objectTeam(@Req() r: any, @Param('id') id: string) { return this.service.objectTeam(await authenticate(r), V.uuid.parse(id)); }
    @Post('function-teams/pto/org-members')
    async orgMember(@Req() r: any, @Body() b: any) { return this.service.assignOrgMember(await authenticate(r), orgMemberDto.parse(b)); }
    @Post('objects/:id/function-team/pto/lead')
    async lead(@Req() r: any, @Param('id') id: string, @Body() b: any) { return this.service.assignObjectLead(await authenticate(r), V.uuid.parse(id), leadDto.parse(b)); }
    @Post('objects/:id/function-team/pto/members')
    async addMember(@Req() r: any, @Param('id') id: string, @Body() b: any) { return this.service.addObjectMember(await authenticate(r), V.uuid.parse(id), memberDto.parse(b)); }
    @Post('objects/:id/function-team/pto/members/:memberUserId/end')
    async endMember(@Req() r: any, @Param('id') id: string, @Param('memberUserId') memberUserId: string, @Body() b: any) { return this.service.endObjectMember(await authenticate(r), V.uuid.parse(id), V.uuid.parse(memberUserId), endMemberDto.parse(b ?? {})); }
    @Post('function-teams/pto/redistribute')
    async redistribute(@Req() r: any, @Body() b: any) { return this.service.redistribute(await authenticate(r), redistributeDto.parse(b)); }
    @Get('function-handovers')
    async handovers(@Req() r: any) { return this.service.listHandovers(await authenticate(r)); }
    @Post('function-handovers/:id/acknowledge')
    async acknowledge(@Req() r: any, @Param('id') id: string, @Body() b: any) { return this.service.acknowledgeHandover(await authenticate(r), V.uuid.parse(id), ackDto.parse(b)); }
    @Post('function-handovers/:id/admin-complete')
    async adminComplete(@Req() r: any, @Param('id') id: string, @Body() b: any) { return this.service.adminCompleteHandover(await authenticate(r), V.uuid.parse(id), adminCompleteDto.parse(b)); }
}
