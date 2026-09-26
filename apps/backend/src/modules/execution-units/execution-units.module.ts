import { Module } from '@nestjs/common';
import { ExecutionUnitsController } from './execution-units.controller';
import { CoreModule } from '../core.module';
@Module({ imports: [CoreModule], controllers: [ExecutionUnitsController] })
export class ExecutionUnitsModule {}
