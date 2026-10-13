import { Controller, Get, Post, Param, Query, Body, Req, Inject } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ScheduleService } from '../../schedule-service';
import { authenticate } from '../../security';
import * as V from '../../validation';
import * as S from '../../schedule-validation';

/**
 * GPR-1 — Production Schedule («График производства работ»).
 *
 * Everything is addressed THROUGH the object (`objects/:objectId/schedule…`), so object identity is part of every URL and a record of
 * another object can never be reached by guessing its id: the service re-checks that each entry / reason belongs to the object in the path.
 * Like the rest of the API, an action on an existing resource is a POST to a verb (`…/edit`, `…/remove`, `…/resolve`).
 * Permission checks happen in the service, before the object is touched.
 */
@Controller()
@ApiTags('Schedule')
@ApiBearerAuth()
export class ScheduleController {
    constructor(@Inject(ScheduleService) private service: ScheduleService) {}

    @Get('objects/:objectId/schedule')
    async schedule(@Req() r: any, @Param('objectId') objectId: string, @Query('asOf') asOf?: string) {
        return this.service.objectSchedule(await authenticate(r), V.uuid.parse(objectId), asOf === undefined ? undefined : S.scheduleAsOf.parse(asOf));
    }

    @Get('works/:workId/schedule')
    async workSchedule(@Req() r: any, @Param('workId') workId: string, @Query('asOf') asOf?: string) {
        return this.service.workSchedule(await authenticate(r), V.uuid.parse(workId), asOf === undefined ? undefined : S.scheduleAsOf.parse(asOf));
    }

    @Post('objects/:objectId/schedule/draft')
    async createDraft(@Req() r: any, @Param('objectId') objectId: string) {
        return this.service.createDraft(await authenticate(r), V.uuid.parse(objectId));
    }

    @Post('objects/:objectId/schedule/draft/entries')
    async addEntry(@Req() r: any, @Param('objectId') objectId: string, @Body() b: any) {
        const a = await authenticate(r);
        return this.service.addEntry(a, V.uuid.parse(objectId), S.scheduleEntryCreateDto.parse(b));
    }

    @Post('objects/:objectId/schedule/draft/entries/:entryId/edit')
    async editEntry(@Req() r: any, @Param('objectId') objectId: string, @Param('entryId') entryId: string, @Body() b: any) {
        const a = await authenticate(r);
        return this.service.editEntry(a, V.uuid.parse(objectId), V.uuid.parse(entryId), S.scheduleEntryEditDto.parse(b));
    }

    @Post('objects/:objectId/schedule/draft/entries/:entryId/remove')
    async removeEntry(@Req() r: any, @Param('objectId') objectId: string, @Param('entryId') entryId: string, @Body() b: any) {
        const a = await authenticate(r);
        return this.service.removeEntry(a, V.uuid.parse(objectId), V.uuid.parse(entryId), S.scheduleVersionOnlyDto.parse(b));
    }

    @Post('objects/:objectId/schedule/draft/discard')
    async discardDraft(@Req() r: any, @Param('objectId') objectId: string, @Body() b: any) {
        const a = await authenticate(r);
        return this.service.discardDraft(a, V.uuid.parse(objectId), S.scheduleVersionOnlyDto.parse(b));
    }

    @Post('objects/:objectId/schedule/draft/approve')
    async approveDraft(@Req() r: any, @Param('objectId') objectId: string, @Body() b: any) {
        const a = await authenticate(r);
        return this.service.approveDraft(a, V.uuid.parse(objectId), S.scheduleApproveDto.parse(b));
    }

    @Post('objects/:objectId/schedule/delay-reasons')
    async recordDelayReason(@Req() r: any, @Param('objectId') objectId: string, @Body() b: any) {
        const a = await authenticate(r);
        return this.service.recordDelayReason(a, V.uuid.parse(objectId), S.scheduleDelayReasonDto.parse(b));
    }

    @Post('objects/:objectId/schedule/delay-reasons/:reasonId/resolve')
    async resolveDelayReason(@Req() r: any, @Param('objectId') objectId: string, @Param('reasonId') reasonId: string, @Body() b: any) {
        const a = await authenticate(r);
        return this.service.resolveDelayReason(a, V.uuid.parse(objectId), V.uuid.parse(reasonId), S.scheduleDelayResolveDto.parse(b));
    }

    @Post('schedule/delay-categories')
    async saveDelayCategory(@Req() r: any, @Body() b: any) {
        return this.service.saveDelayCategory(await authenticate(r), S.scheduleDelayCategoryDto.parse(b));
    }
}
