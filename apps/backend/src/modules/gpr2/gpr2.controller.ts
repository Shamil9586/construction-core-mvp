import { Controller, Get, Post, Patch, Put, Param, Body, Query, Req, Inject, HttpCode, Header } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { authenticate } from '../../security';
import { Gpr2Error, CapabilityAssignment, endpointById } from '../../../../../packages/domain/gpr2';
import { Gpr2Hooks, Gpr2HttpException, runGpr2Command } from '../../gpr2-command-guard';
import { runR05Read } from '../../gpr2-r05-read';
import { GPR2_ASSIGNMENTS, GPR2_HOOKS } from './gpr2.tokens';

/**
 * GPR-2 R01 — the guarded /v2 command surface (Technical Design §11.2; acceptance A19 at HTTP level).
 *
 * One method per mounted command of the endpoint register (and, since D1, one GET per mounted R05 read) (packages/domain/gpr2/endpoints.ts) and nothing else: the route, the permission, the
 * Idempotency-Key / expectedVersion / expectedScopeVersion it carries and the lifecycle row it performs are all read from the register, not
 * repeated here — a test holds this class and the register to each other. Every method does the same thing: authenticate, then hand the call to
 * runGpr2Command(), whose fixed order (permission → object scope → nested resource preflight → envelope → replay → execute) is the contract.
 * A command that is applied answers 200 with the CommandResult (a POST would default to 201; the contract and the OpenAPI document say 200).
 *
 * The module is mounted only when GPR2_CONTRACT_ROUTES=enabled (see main.ts). R01 has no behaviour to offer: an authorised, in-scope,
 * well-formed call is answered 501 COMMAND_NOT_ENABLED and writes nothing.
 */
@Controller()
@ApiTags('GPR-2 commands (contract only, feature-gated)')
@ApiBearerAuth()
export class Gpr2ContractController {
    constructor(@Inject(GPR2_HOOKS) private hooks: Gpr2Hooks, @Inject(GPR2_ASSIGNMENTS) private assignments: readonly CapabilityAssignment[]) {}

    private async run(id: string, r: any, params: Record<string, string>, body: unknown) {
        const actor = await authenticate(r);
        try {
            return await runGpr2Command(endpointById(id)!, { actor, params, headers: r.headers ?? {}, body }, this.hooks, this.assignments);
        }
        catch (e) {
            throw e instanceof Gpr2Error ? new Gpr2HttpException(e) : e;
        }
    }

    /**
     * D1 reads: authenticate, then the read service (permission → object scope → query string → one READ ONLY snapshot). Not a command: no Idempotency-Key, no ledger,
     * no write. `no-store` because the answer depends on the caller's CURRENT role and scope and must never be served from a shared or browser cache to anyone else.
     */
    private async read(id: string, r: any, params: Record<string, string>, query: unknown) {
        const actor = await authenticate(r);
        try {
            return await runR05Read(endpointById(id)!, { actor, params, query });
        }
        catch (e) {
            throw e instanceof Gpr2Error ? new Gpr2HttpException(e) : e;
        }
    }

    // R05 reads (D1)
    @Get('v2/objects/:objectId/work-types')
    @Header('Cache-Control', 'no-store')
    workTypesList(@Req() r: any, @Param() p: any, @Query() q: any) { return this.read('work-types.list', r, p, q); }
    @Get('v2/objects/:objectId/area-scopes')
    @Header('Cache-Control', 'no-store')
    areaScopesList(@Req() r: any, @Param() p: any, @Query() q: any) { return this.read('area-scopes.list', r, p, q); }
    @Get('v2/objects/:objectId/finish-systems')
    @Header('Cache-Control', 'no-store')
    finishSystemsList(@Req() r: any, @Param() p: any, @Query() q: any) { return this.read('finish-systems.list', r, p, q); }
    @Get('v2/finish-templates')
    @Header('Cache-Control', 'no-store')
    finishTemplatesList(@Req() r: any, @Param() p: any, @Query() q: any) { return this.read('finish-templates.list', r, p, q); }
    @Get('v2/objects/:objectId/work-type-publication-requests')
    @Header('Cache-Control', 'no-store')
    workTypePublicationRequestsList(@Req() r: any, @Param() p: any, @Query() q: any) { return this.read('work-type-publication-requests.list', r, p, q); }

    // work-type
    @Post('v2/objects/:objectId/work-types')
    @HttpCode(200)
    workTypeCreate(@Req() r: any, @Param() p: any, @Body() b: any) { return this.run('work-type.create', r, p, b); }
    @Post('v2/objects/:objectId/work-types/:id/publication-requests')
    @HttpCode(200)
    workTypePublicationRequest(@Req() r: any, @Param() p: any, @Body() b: any) { return this.run('work-type.publication.request', r, p, b); }
    @Post('v2/work-type-publication-requests/:id/approve')
    @HttpCode(200)
    workTypePublicationApprove(@Req() r: any, @Param() p: any, @Body() b: any) { return this.run('work-type.publication.approve', r, p, b); }
    @Post('v2/work-type-publication-requests/:id/reject')
    @HttpCode(200)
    workTypePublicationReject(@Req() r: any, @Param() p: any, @Body() b: any) { return this.run('work-type.publication.reject', r, p, b); }

    // finish-template (corporate, R05c; proposed routes)
    @Post('v2/finish-templates')
    @HttpCode(200)
    finishTemplateDraft(@Req() r: any, @Param() p: any, @Body() b: any) { return this.run('finish-template.draft', r, p, b); }
    @Post('v2/finish-templates/:id/publish')
    @HttpCode(200)
    finishTemplatePublish(@Req() r: any, @Param() p: any, @Body() b: any) { return this.run('finish-template.publish', r, p, b); }

    // area-scope (R05b; proposed route)
    @Post('v2/objects/:objectId/area-scopes')
    @HttpCode(200)
    areaScopeCreate(@Req() r: any, @Param() p: any, @Body() b: any) { return this.run('area-scope.create', r, p, b); }

    // finish-system
    @Post('v2/objects/:objectId/finish-systems')
    @HttpCode(200)
    finishSystemUpsert(@Req() r: any, @Param() p: any, @Body() b: any) { return this.run('finish-system.upsert', r, p, b); }
    @Post('v2/objects/:objectId/finish-systems/:id/preview')
    @HttpCode(200)
    finishSystemPreview(@Req() r: any, @Param() p: any, @Body() b: any) { return this.run('finish-system.preview', r, p, b); }
    @Post('v2/objects/:objectId/finish-systems/:id/confirm')
    @HttpCode(200)
    finishSystemConfirm(@Req() r: any, @Param() p: any, @Body() b: any) { return this.run('finish-system.confirm', r, p, b); }

    // quantity
    @Post('v2/objects/:objectId/quantity-change-requests')
    @HttpCode(200)
    quantityRequestCreate(@Req() r: any, @Param() p: any, @Body() b: any) { return this.run('quantity.request.create', r, p, b); }
    @Patch('v2/objects/:objectId/quantity-change-requests/:id')
    @HttpCode(200)
    quantityRequestPatch(@Req() r: any, @Param() p: any, @Body() b: any) { return this.run('quantity.request.patch', r, p, b); }
    @Post('v2/objects/:objectId/quantity-change-requests/:id/submit')
    @HttpCode(200)
    quantityRequestSubmit(@Req() r: any, @Param() p: any, @Body() b: any) { return this.run('quantity.request.submit', r, p, b); }
    @Post('v2/objects/:objectId/quantity-change-requests/:id/review-notes')
    @HttpCode(200)
    quantityRequestReviewNote(@Req() r: any, @Param() p: any, @Body() b: any) { return this.run('quantity.request.review-note', r, p, b); }
    @Post('v2/objects/:objectId/quantity-change-requests/:id/approve')
    @HttpCode(200)
    quantityRequestApprove(@Req() r: any, @Param() p: any, @Body() b: any) { return this.run('quantity.request.approve', r, p, b); }
    @Post('v2/objects/:objectId/quantity-change-requests/:id/return')
    @HttpCode(200)
    quantityRequestReturn(@Req() r: any, @Param() p: any, @Body() b: any) { return this.run('quantity.request.return', r, p, b); }

    // calendar
    @Post('v2/objects/:objectId/calendars/versions')
    @HttpCode(200)
    calendarVersionCreate(@Req() r: any, @Param() p: any, @Body() b: any) { return this.run('calendar.version.create', r, p, b); }
    @Patch('v2/objects/:objectId/calendars/versions/:id')
    @HttpCode(200)
    calendarVersionPatch(@Req() r: any, @Param() p: any, @Body() b: any) { return this.run('calendar.version.patch', r, p, b); }

    // schedule
    @Post('v2/objects/:objectId/schedule/revisions')
    @HttpCode(200)
    scheduleRevisionCreate(@Req() r: any, @Param() p: any, @Body() b: any) { return this.run('schedule.revision.create', r, p, b); }
    @Post('v2/objects/:objectId/schedule/revisions/:id/changes/preview')
    @HttpCode(200)
    scheduleChangesPreview(@Req() r: any, @Param() p: any, @Body() b: any) { return this.run('schedule.changes.preview', r, p, b); }
    @Post('v2/objects/:objectId/schedule/revisions/:id/changes/apply')
    @HttpCode(200)
    scheduleChangesApply(@Req() r: any, @Param() p: any, @Body() b: any) { return this.run('schedule.changes.apply', r, p, b); }
    @Post('v2/objects/:objectId/schedule/revisions/:id/backplan-preview')
    @HttpCode(200)
    scheduleBackplanPreview(@Req() r: any, @Param() p: any, @Body() b: any) { return this.run('schedule.backplan.preview', r, p, b); }
    @Post('v2/objects/:objectId/schedule/revisions/:id/submit')
    @HttpCode(200)
    scheduleRevisionSubmit(@Req() r: any, @Param() p: any, @Body() b: any) { return this.run('schedule.revision.submit', r, p, b); }
    @Post('v2/objects/:objectId/schedule/revisions/:id/discard')
    @HttpCode(200)
    scheduleRevisionDiscard(@Req() r: any, @Param() p: any, @Body() b: any) { return this.run('schedule.revision.discard', r, p, b); }
    @Post('v2/objects/:objectId/schedule/revisions/:id/approve')
    @HttpCode(200)
    scheduleRevisionApprove(@Req() r: any, @Param() p: any, @Body() b: any) { return this.run('schedule.revision.approve', r, p, b); }
    @Post('v2/objects/:objectId/schedule/revisions/:id/return')
    @HttpCode(200)
    scheduleRevisionReturn(@Req() r: any, @Param() p: any, @Body() b: any) { return this.run('schedule.revision.return', r, p, b); }

    // finish-change
    @Post('v2/objects/:objectId/finish-changes/record-external-outcome')
    @HttpCode(200)
    finishChangeRecordExternalOutcome(@Req() r: any, @Param() p: any, @Body() b: any) { return this.run('finish-change.record-external-outcome', r, p, b); }
    @Post('v2/objects/:objectId/finish-changes/:id/record-correction')
    @HttpCode(200)
    finishChangeRecordCorrection(@Req() r: any, @Param() p: any, @Body() b: any) { return this.run('finish-change.record-correction', r, p, b); }

    // imports
    @Post('v2/objects/:objectId/imports/boq')
    @HttpCode(200)
    importsBoqUpload(@Req() r: any, @Param() p: any, @Body() b: any) { return this.run('imports.boq.upload', r, p, b); }
    @Post('v2/objects/:objectId/imports/estimate-labor')
    @HttpCode(200)
    importsEstimateLaborUpload(@Req() r: any, @Param() p: any, @Body() b: any) { return this.run('imports.estimate-labor.upload', r, p, b); }
    @Put('v2/objects/:objectId/imports/boq/:id/allocations')
    @HttpCode(200)
    importsBoqAllocations(@Req() r: any, @Param() p: any, @Body() b: any) { return this.run('imports.boq.allocations', r, p, b); }
    @Post('v2/objects/:objectId/imports/boq/:id/commit')
    @HttpCode(200)
    importsBoqCommit(@Req() r: any, @Param() p: any, @Body() b: any) { return this.run('imports.boq.commit', r, p, b); }
    @Post('v2/objects/:objectId/imports/estimate-labor/:id/mapping-proposals')
    @HttpCode(200)
    importsEstimateLaborMappingProposals(@Req() r: any, @Param() p: any, @Body() b: any) { return this.run('imports.estimate-labor.mapping-proposals', r, p, b); }
    @Post('v2/objects/:objectId/imports/estimate-labor/:id/mapping-reviews')
    @HttpCode(200)
    importsEstimateLaborMappingReviews(@Req() r: any, @Param() p: any, @Body() b: any) { return this.run('imports.estimate-labor.mapping-reviews', r, p, b); }
    @Post('v2/objects/:objectId/imports/estimate-labor/:id/commit')
    @HttpCode(200)
    importsEstimateLaborCommit(@Req() r: any, @Param() p: any, @Body() b: any) { return this.run('imports.estimate-labor.commit', r, p, b); }
}
