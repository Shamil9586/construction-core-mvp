import { Module } from '@nestjs/common';
import { InspectionsController } from './inspections.controller';
import { CoreModule } from '../core.module';
@Module({ imports: [CoreModule], controllers: [InspectionsController] })
export class InspectionsModule {}
