import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { CronMonitorModule } from '../cron-monitor/cron-monitor.module';
import { AuthCleanupService } from './auth-cleanup.service';

@Module({
  imports: [ConfigModule, PrismaModule, CronMonitorModule],
  providers: [AuthCleanupService],
})
export class AuthCleanupModule {}
