import { Module, OnModuleInit } from '@nestjs/common';
import { AttachmentsController } from './attachments.controller';
import { assertFileStorageConfig } from '../../file-storage/config';
import { hasDiskTransportOverride } from '../../file-storage/file-store';
@Module({ controllers: [AttachmentsController] })
export class AttachmentsModule implements OnModuleInit {
    /** BITRIX-DISK-1: a misspelled / incomplete FILE_STORAGE_PROVIDER stops the process at startup instead of silently storing elsewhere. */
    onModuleInit() { assertFileStorageConfig(process.env, hasDiskTransportOverride()); }
}
