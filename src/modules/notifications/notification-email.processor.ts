import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { NOTIFICATION_EMAIL_QUEUE } from '../../common/queue/queue.constants';
import { NotificationEmailJobData } from '../../common/queue/queue.service';
import { NotificationsService } from './notifications.service';

@Processor(NOTIFICATION_EMAIL_QUEUE)
export class NotificationEmailProcessor extends WorkerHost {
  constructor(private readonly notificationsService: NotificationsService) {
    super();
  }

  async process(job: Job<NotificationEmailJobData>) {
    await this.notificationsService.processEmailJob(job.data);
    return { sent: true };
  }
}
