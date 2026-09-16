import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { CoreModule } from '../core.module';
@Module({ imports: [CoreModule], controllers: [DashboardController] })
export class DashboardModule {}
