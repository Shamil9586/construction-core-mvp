import { Controller, Get, Post, Patch, Query, Param, Body, Req, Inject, HttpCode } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { authenticate } from '../../security';
import { FinSdo1Service } from '../../fin-sdo-1.service';
const uuid=z.uuid();
const key=z.string().min(8).max(128);
const text=z.string().trim().min(1).max(250);
const period=z.object({year:z.number().int().min(2000).max(2200),quarter:z.number().int().min(1).max(4)});
const money=z.string().regex(/^(?:0|[1-9]\d{0,13})\.\d{2}$/);
const line=z.object({
  coreObjectId:uuid.optional(),
  historicalSubjectId:uuid.optional(),
  partyKind:z.enum(['CORE_CONTRACTOR','HISTORICAL_PARTY','UNALLOCATED']),
  partyId:uuid.optional(),
  contractKind:z.enum(['KNOWN','NOT_SPECIFIED']),
  contractNumber:z.string().trim().min(1).max(150).optional(),
  amountMln:money
}).strict();
const buffer=period.extend({expectedBookVersion:z.number().int().min(0),lines:z.array(line).min(1).max(1000)}).strict();
const bufferPatch=buffer.extend({expectedBufferVersion:z.number().int().min(1)}).strict();
const commit=period.extend({bufferId:uuid,expectedBookVersion:z.number().int().min(0),effectiveOn:z.iso.date(),reason:z.string().trim().min(1).max(300).optional(),idempotencyKey:key}).strict();

@Controller('fin-sdo-1')
@ApiBearerAuth()
@ApiTags('FIN-SDO-1 quarterly planning')
export class FinSdo1Controller {
 constructor(@Inject(FinSdo1Service)private readonly svc:FinSdo1Service){}
 @Get('subjects')
 subjects(@Req() req:any){return authenticate(req).then(a=>this.svc.discover(a));}
 @Get('quarter')
 quarter(@Req() req:any,@Query('year') y:string,@Query('quarter') q:string,@Query('knownAt') knownAt?:string){
  const year=z.coerce.number().int().parse(y),quarter=z.coerce.number().int().parse(q);
  if(knownAt!==undefined)z.iso.datetime({offset:true}).parse(knownAt);
  return authenticate(req).then(a=>this.svc.readBook(a,{year,quarter},knownAt));
 }
 @Post('historical-subjects') @HttpCode(200)
 historical(@Req()req:any,@Body()body:any){
  const b=z.object({name:text,address:z.string().max(500).optional(),customerName:z.string().max(250).optional(),idempotencyKey:key}).strict().parse(body);
  return authenticate(req).then(a=>this.svc.createHistoricalSubject(a,b));
 }
 @Post('historical-parties') @HttpCode(200)
 parties(@Req()req:any,@Body()body:any){
  const b=z.object({name:text,idempotencyKey:key}).strict().parse(body);
  return authenticate(req).then(a=>this.svc.createHistoricalParty(a,b));
 }
 @Post('buffers') @HttpCode(200)
 saveBuffer(@Req()req:any,@Body()body:any){
  const b=buffer.parse(body);
  return authenticate(req).then(a=>this.svc.saveBuffer(a,b));
 }
 @Get('buffers')
 listBuffers(@Req()req:any,@Query('year') y:string,@Query('quarter') q:string){
   const year=z.coerce.number().int().parse(y),quarter=z.coerce.number().int().parse(q);
   return authenticate(req).then(a=>this.svc.listBuffers(a,{year,quarter}));
 }
 @Patch('buffers/:id')
 patchBuffer(@Req()req:any,@Param('id') id:string,@Body()body:any){
   const b=bufferPatch.parse(body);
   return authenticate(req).then(a=>this.svc.updateBuffer(a,uuid.parse(id),b));
 }
 @Get('buffers/:id')
 readBuffer(@Req()req:any,@Param('id') id:string){
  return authenticate(req).then(a=>this.svc.readBuffer(a,uuid.parse(id)));
 }
 @Post('commit') @HttpCode(200)
 commit(@Req()req:any,@Body()body:any){
  const b=commit.parse(body);
  return authenticate(req).then(a=>this.svc.commitBuffer(a,b));
 }
}
