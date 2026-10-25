import { Controller, Get, Post, Patch, Query, Param, Body, Req, Inject, HttpCode, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
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
/**
 * FIN-SDO-1 has NO release authorization. Only explicitly tested identity
 * operations may enter the restricted FIN pool in protected mode; unconverted
 * legacy financial handlers must fail CLOSED instead of silently falling back
 * to the application's privileged pool.
 */
const protectedSlice=()=>process.env.FIN_SDO_PROTECTED_IDENTITY_COMMANDS==='enabled';
const requireUnprotectedIsolation=()=>{
 if(protectedSlice()||process.env.FIN_SDO_ISOLATED_CONFIRM!=='YES')
   throw new ServiceUnavailableException('FIN_SEC01_PROTECTED_ROUTE_NOT_READY');
 const url=process.env.DATABASE_URL;
 if(!url)throw new ServiceUnavailableException('FIN_SEC01_TEST_DATABASE_REQUIRED');
 let parsed: URL;try{parsed=new URL(url)}catch{throw new ServiceUnavailableException('FIN_SEC01_TEST_DATABASE_INVALID')}
 if(!['localhost','127.0.0.1','::1'].includes(parsed.hostname)||!parsed.pathname.endsWith('_test'))
   throw new ServiceUnavailableException('FIN_SEC01_TEST_DATABASE_REQUIRED');
};
const requestBearer=(req:any):string=>{
 const bearer=req?.headers?.authorization;
 const m=typeof bearer==='string'?/^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(bearer):null;
 if(!m)throw new UnauthorizedException('FIN_BEARER_REQUIRED');
 return m[1];
};
const commit=period.extend({bufferId:uuid,expectedBufferVersion:z.number().int().min(1),expectedBookVersion:z.number().int().min(0),effectiveOn:z.iso.date(),reason:z.string().trim().min(1).max(300).optional(),idempotencyKey:key}).strict();

@Controller('fin-sdo-1')
@ApiBearerAuth()
@ApiTags('FIN-SDO-1 quarterly planning')
export class FinSdo1Controller {
 constructor(@Inject(FinSdo1Service)private readonly svc:FinSdo1Service){}
 @Get('subjects')
 subjects(@Req() req:any){
  if(protectedSlice())return authenticate(req).then(a=>this.svc.discoverProtected(a,requestBearer(req)));
  requireUnprotectedIsolation();return authenticate(req).then(a=>this.svc.discover(a));
 }
 @Get('quarter')
 quarter(@Req() req:any,@Query('year') y:string,@Query('quarter') q:string,@Query('knownAt') knownAt?:string){
  const year=z.coerce.number().int().parse(y),quarter=z.coerce.number().int().parse(q);
  if(knownAt!==undefined)z.iso.datetime({offset:true}).parse(knownAt);
  if(protectedSlice())return authenticate(req).then(a=>this.svc.readBookProtected(a,requestBearer(req),{year,quarter},knownAt));
  requireUnprotectedIsolation();
  return authenticate(req).then(a=>this.svc.readBook(a,{year,quarter},knownAt));
 }
 @Post('historical-subjects') @HttpCode(200)
 historical(@Req()req:any,@Body()body:any){
  const b=z.object({name:text,address:z.string().max(500).optional(),customerName:z.string().max(250).optional(),idempotencyKey:key}).strict().parse(body);
  if(protectedSlice())return authenticate(req).then(a=>this.svc.createHistoricalSubjectProtected(a,requestBearer(req),b));
  requireUnprotectedIsolation();
  return authenticate(req).then(a=>this.svc.createHistoricalSubject(a,b));
 }
 @Post('historical-parties') @HttpCode(200)
 parties(@Req()req:any,@Body()body:any){
  const b=z.object({name:text,idempotencyKey:key}).strict().parse(body);
  if(protectedSlice())return authenticate(req).then(a=>this.svc.createHistoricalPartyProtected(a,requestBearer(req),b));
  requireUnprotectedIsolation();
  return authenticate(req).then(a=>this.svc.createHistoricalParty(a,b));
 }
 @Post('buffers') @HttpCode(200)
 saveBuffer(@Req()req:any,@Body()body:any){
  const b=buffer.parse(body);
  if(protectedSlice())return authenticate(req).then(a=>this.svc.saveBufferProtected(a,requestBearer(req),b));
  requireUnprotectedIsolation();
  return authenticate(req).then(a=>this.svc.saveBuffer(a,b));
 }
 @Get('buffers')
 listBuffers(@Req()req:any,@Query('year') y:string,@Query('quarter') q:string){
   const year=z.coerce.number().int().parse(y),quarter=z.coerce.number().int().parse(q);
   if(protectedSlice())return authenticate(req).then(a=>this.svc.listBuffersProtected(a,requestBearer(req),{year,quarter}));
   requireUnprotectedIsolation();
   return authenticate(req).then(a=>this.svc.listBuffers(a,{year,quarter}));
 }
 @Patch('buffers/:id')
 patchBuffer(@Req()req:any,@Param('id') id:string,@Body()body:any){
   const b=bufferPatch.parse(body);
   if(protectedSlice())return authenticate(req).then(a=>this.svc.updateBufferProtected(a,requestBearer(req),uuid.parse(id),b));
   requireUnprotectedIsolation();
   return authenticate(req).then(a=>this.svc.updateBuffer(a,uuid.parse(id),b));
 }
 @Get('buffers/:id')
 readBuffer(@Req()req:any,@Param('id') id:string){
  if(protectedSlice())return authenticate(req).then(a=>this.svc.readBufferProtected(a,requestBearer(req),uuid.parse(id)));
  requireUnprotectedIsolation();
  return authenticate(req).then(a=>this.svc.readBuffer(a,uuid.parse(id)));
 }
 @Post('commit') @HttpCode(200)
 commit(@Req()req:any,@Body()body:any){
  const b=commit.parse(body);
  if(protectedSlice())return authenticate(req).then(a=>this.svc.commitBufferProtected(a,requestBearer(req),b));
  requireUnprotectedIsolation();
  return authenticate(req).then(a=>this.svc.commitBuffer(a,b));
 }
}
