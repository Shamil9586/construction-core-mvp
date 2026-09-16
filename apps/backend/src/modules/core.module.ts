import { Module } from '@nestjs/common';
import { ProductionService } from '../service';
import { ReadService } from '../read-service';
// Общий модуль: ProductionService/ReadService не имеют собственных зависимостей
// (обращаются к БД через module-level singleton pool из db.ts), поэтому один
// набор providers, переиспользуемый через imports+exports во всех доменных
// модулях — без дублирования регистрации в каждом из них.
@Module({ providers: [ProductionService, ReadService], exports: [ProductionService, ReadService] })
export class CoreModule {}
