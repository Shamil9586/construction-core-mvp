import { Module, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { bitrixNotificationWorkerEnabled, startBitrixNotificationWorker } from '../../bitrix-notification-outbox';
@Module({ controllers: [NotificationsController] })
export class NotificationsModule implements OnApplicationBootstrap, OnModuleDestroy {
    private worker?: { stop(): void };
    // PBX-5A: polling starts only with AUTH_MODE=bitrix AND BITRIX_NOTIFICATION_DELIVERY_ENABLED=true.
    onApplicationBootstrap() { if (bitrixNotificationWorkerEnabled())
        this.worker = startBitrixNotificationWorker(); }
    onModuleDestroy() { this.worker?.stop(); }
}
