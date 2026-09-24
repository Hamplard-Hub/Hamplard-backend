import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { QueueController } from './queue.controller';
import { NOTIFICATION_EMAIL_QUEUE } from './queue.constants';
import { QueueService } from './queue.service';

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const redisUrl = config.get<string>('REDIS_URL');
        const connection = redisUrl
          ? new Redis(redisUrl, { maxRetriesPerRequest: null })
          : {
              host: config.get<string>('REDIS_HOST', 'localhost'),
              port: config.get<number>('REDIS_PORT', 6379),
              password: config.get<string>('REDIS_PASSWORD') || undefined,
              maxRetriesPerRequest: null,
            };

        return {
          connection,
          defaultJobOptions: {
            attempts: config.get<number>('QUEUE_JOB_ATTEMPTS', 5),
            backoff: {
              type: 'exponential',
              delay: config.get<number>('QUEUE_RETRY_DELAY_MS', 5000),
            },
            removeOnComplete: { age: 7 * 24 * 60 * 60, count: 1000 },
            removeOnFail: false,
          },
        };
      },
    }),
    BullModule.registerQueue({ name: NOTIFICATION_EMAIL_QUEUE }),
  ],
  controllers: [QueueController],
  providers: [QueueService],
  exports: [QueueService, BullModule],
})
export class QueueModule {}
