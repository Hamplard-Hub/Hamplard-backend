// notifications.module.ts
import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { QueueModule } from '../../common/queue/queue.module';
import { NotificationEmailProcessor } from './notification-email.processor';

@Module({
  imports: [QueueModule],
  providers: [NotificationsService, NotificationEmailProcessor],
  controllers: [NotificationsController],
  exports: [NotificationsService],
})
export class NotificationsModule {}
