import { Module } from '@nestjs/common';
import { ObjectsController } from './objects.controller';
import { CoreModule } from '../core.module';
@Module({ imports: [CoreModule], controllers: [ObjectsController] })
export class ObjectsModule {}
