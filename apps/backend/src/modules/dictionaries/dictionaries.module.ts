import { Module } from '@nestjs/common';
import { DictionariesController } from './dictionaries.controller';
@Module({ controllers: [DictionariesController] })
export class DictionariesModule {}
