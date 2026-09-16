import { Module } from '@nestjs/common';
import { ContractorsController } from './contractors.controller';
import { CoreModule } from '../core.module';
@Module({ imports: [CoreModule], controllers: [ContractorsController] })
export class ContractorsModule {}
