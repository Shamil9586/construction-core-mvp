import { Module } from '@nestjs/common';
import { FinancialController } from './financial.controller';
import { CoreModule } from '../core.module';
@Module({ imports: [CoreModule], controllers: [FinancialController] })
export class FinancialModule {}
