import { Module } from '@nestjs/common';
import { ImportsController } from './imports.controller';
@Module({ controllers: [ImportsController] })
export class ImportsModule {}
