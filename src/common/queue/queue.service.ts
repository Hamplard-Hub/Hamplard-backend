import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { plainToInstance } from 'class-transformer';
import { IsEmail, IsEnum, IsNotEmpty, IsString, MaxLength, validateSync } from 'class-validator';
import { NotificationType } from '@prisma/client';
import { NOTIFICATION_EMAIL_JOB, NOTIFICATION_EMAIL_QUEUE } from './queue.constants';

export class NotificationEmailJobData {
  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsString()
  @IsNotEmpty()
  notificationId: string;

  @IsEmail()
  to: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  subject: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(10000)
  text: string;

  @IsEnum(NotificationType)
  type: NotificationType;
}

export interface QueueJobStatus {
  id: string;
  queue: string;
  status: string;
  progress: number | object;
  attemptsMade: number;
  result: unknown;
  failedReason?: string;
}

@Injectable()
export class QueueService {
  constructor(
    @InjectQueue(NOTIFICATION_EMAIL_QUEUE)
    private readonly notificationEmailQueue: Queue<NotificationEmailJobData>,
  ) {}

  async enqueueNotificationEmail(payload: unknown) {
    const data = plainToInstance(NotificationEmailJobData, payload);
    const errors = validateSync(data, {
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
    });
    if (errors.length) {
      throw new BadRequestException('Invalid notification email job payload');
    }

    const job = await this.notificationEmailQueue.add(NOTIFICATION_EMAIL_JOB, data);
    return { id: job.id as string, status: await job.getState() };
  }

  async getJobStatus(jobId: string, userId: string): Promise<QueueJobStatus> {
    const job = await this.notificationEmailQueue.getJob(jobId);
    if (!job) {
      throw new NotFoundException('Job not found');
    }

    if (job.data.userId !== userId) {
      throw new NotFoundException('Job not found');
    }

    return {
      id: job.id as string,
      queue: NOTIFICATION_EMAIL_QUEUE,
      status: await job.getState(),
      progress: job.progress as any,
      attemptsMade: job.attemptsMade,
      result: job.returnvalue,
      failedReason: job.failedReason,
    };
  }
}
