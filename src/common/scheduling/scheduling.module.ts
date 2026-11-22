import { Module, OnModuleInit, Logger } from '@nestjs/common';
import { DistributedLockService } from './distributed-lock.service';

/**
 * Scheduling Module (issue #310)
 *
 * Provides distributed locking for @Cron jobs across multiple API instances.
 * Exports DistributedLockService for injection into services that use @Cron decorators.
 *
 * Import this module in AppModule so distributed locks are available globally.
 */
@Module({
  providers: [DistributedLockService],
  exports: [DistributedLockService],
})
export class SchedulingModule implements OnModuleInit {
  private readonly logger = new Logger(SchedulingModule.name);

  constructor(private readonly lockService: DistributedLockService) {}

  async onModuleInit() {
    const healthy = await this.lockService.healthCheck();
    if (!healthy) {
      this.logger.warn(
        'DistributedLockService Redis connection unhealthy. ' +
        'Cron jobs may run on multiple instances.',
      );
    } else {
      this.logger.log('DistributedLockService initialized successfully');
    }
  }
}
