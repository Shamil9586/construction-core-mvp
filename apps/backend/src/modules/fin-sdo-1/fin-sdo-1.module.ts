import { Module } from '@nestjs/common';
import { FinSdo1Controller } from './fin-sdo-1.controller';
import { FinSdo1Service } from '../../fin-sdo-1.service';
@Module({controllers:[FinSdo1Controller],providers:[FinSdo1Service]})
export class FinSdo1Module {}
