import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CronMonitorService } from './cron-monitor.service';
import { CronMonitorController } from './cron-monitor.controller';
import { CronMonitorScheduler } from './cron-monitor.scheduler';

@Module({
  imports: [ConfigModule],
  controllers: [CronMonitorController],
  providers: [CronMonitorService, CronMonitorScheduler],
  exports: [CronMonitorService], // export so any cron service can call .start() / .run()
})
export class CronMonitorModule {}
