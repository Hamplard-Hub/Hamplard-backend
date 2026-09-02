import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { CronMonitorService } from './cron-monitor.service';

/**
 * CronMonitorScheduler
 *
 * Houses the housekeeping cron jobs for the cron monitor itself:
 *  - Every 15 minutes: mark zombie RUNNING runs as FAILED
 *  - Daily at midnight: purge old run history (configurable retention)
 */
@Injectable()
export class CronMonitorScheduler {
  private readonly logger = new Logger(CronMonitorScheduler.name);

  constructor(
    private readonly cronMonitor: CronMonitorService,
    private readonly config: ConfigService,
  ) {}

  @Cron('0 */15 * * * *', { name: 'cron-monitor-stale-cleanup' })
  async cleanupStaleRuns() {
    const thresholdMinutes = this.config.get<number>(
      'CRON_STALE_THRESHOLD_MINUTES',
      30,
    );
    const result = await this.cronMonitor.markStaleRunsFailed(thresholdMinutes);
    if (result.marked > 0) {
      this.logger.warn(`Cleaned up ${result.marked} stale cron run(s)`);
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT, { name: 'cron-monitor-purge' })
  async purgeHistory() {
    const retentionDays = this.config.get<number>(
      'CRON_RUN_RETENTION_DAYS',
      90,
    );
    await this.cronMonitor.run('cron-monitor-purge', async () => {
      const result = await this.cronMonitor.purgeOldRuns(retentionDays);
      this.logger.log(`Purged ${result.deleted} old cron run records`);
      return result;
    });
  }
}
