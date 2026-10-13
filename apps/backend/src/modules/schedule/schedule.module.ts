import { Module } from '@nestjs/common';
import { ScheduleController } from './schedule.controller';
import { ScheduleService } from '../../schedule-service';

// GPR-1. The schedule service has no collaborators of its own (it reads the shared pool, like ProductionService), so it is provided here
// and CoreModule is untouched.
@Module({ controllers: [ScheduleController], providers: [ScheduleService] })
export class ProductionScheduleModule {}
