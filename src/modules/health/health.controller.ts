import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  HealthIndicatorResult,
  PrismaHealthIndicator,
} from '@nestjs/terminus';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EventsService } from '../events/events.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaHealth: PrismaHealthIndicator,
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
  ) {}

  @Get()
  @HealthCheck()
  @ApiOperation({ summary: 'Check API and database health' })
  check() {
    return this.health.check([
      () => this.prismaHealth.pingCheck('database', this.prisma),
      () => this.eventPollerCheckpointIndicator(),
    ]);
  }

  @Get('checkpoint')
  @ApiOperation({
    summary: 'Current Stellar event-poller ledger checkpoint (crash recovery)',
  })
  checkpoint() {
    return this.events.getCheckpointStatus();
  }

  /**
   * Reports the event-poller checkpoint inside the aggregate health check.
   * Informational only: it always reports `up` (with a `checkpointHealthy`
   * flag and failure details) so a transient checkpoint write failure on the
   * poller never sends a 503 that pulls the whole service out of rotation.
   * Use GET /health/checkpoint for the authoritative checkpoint state.
   */
  private async eventPollerCheckpointIndicator(): Promise<HealthIndicatorResult> {
    const status = await this.events.getCheckpointStatus();
    return {
      event_poller_checkpoint: {
        status: 'up',
        checkpointHealthy: status.healthy,
        lastProcessedLedger: status.lastProcessedLedger,
        persistedLedger: status.persistedLedger,
        lastPolledAt: status.lastPolledAt,
        resumedFromCheckpoint: status.resumedFromCheckpoint,
        consecutiveWriteFailures: status.consecutiveWriteFailures,
        lastWriteError: status.lastWriteError,
      },
    };
  }
}
