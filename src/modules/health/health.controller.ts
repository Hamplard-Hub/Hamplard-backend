import { Controller, Get, Optional } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  HealthCheckError,
  HealthIndicatorResult,
  PrismaHealthIndicator,
} from '@nestjs/terminus';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CacheService } from '../../common/cache/cache.service';
import { EventsService } from '../events/events.service';
import { VirusScanService } from '../uploads/virus-scan.service';

@ApiTags('health')
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaHealth: PrismaHealthIndicator,
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly virusScan: VirusScanService,
    @Optional() private readonly cache?: CacheService,
  ) {}

  @Get()
  @SkipThrottle()
  @HealthCheck()
  @ApiOperation({ summary: 'Check API and database health' })
  check() {
    return this.health.check([
      () => this.prismaHealth.pingCheck('database', this.prisma),
      () => this.eventPollerCheckpointIndicator(),
      () => this.virusScannerIndicator(),
    ]);
  }

  @Get('live')
  @SkipThrottle()
  @HealthCheck()
  @ApiOperation({
    summary:
      'Kubernetes/load-balancer liveness probe (process only; does not fail on external dependency latency)',
  })
  @ApiResponse({ status: 200, description: 'Process is alive and event loop is responsive' })
  live() {
    return this.health.check([() => this.processLivenessIndicator()]);
  }

  @Get('ready')
  @SkipThrottle()
  @HealthCheck()
  @ApiOperation({
    summary:
      'Kubernetes/load-balancer readiness probe (checks database, Redis cache, and critical dependencies)',
  })
  @ApiResponse({ status: 200, description: 'Service is ready to accept traffic' })
  @ApiResponse({ status: 503, description: 'One or more critical dependencies are unavailable' })
  ready() {
    return this.health.check([
      () => this.prismaHealth.pingCheck('database', this.prisma),
      () => this.redisReadinessIndicator(),
      () => this.eventPollerCheckpointIndicator(),
      () => this.virusScannerIndicator(),
    ]);
  }

  @Get('checkpoint')
  @SkipThrottle()
  @ApiOperation({
    summary: 'Current Stellar event-poller ledger checkpoint (crash recovery)',
  })
  checkpoint() {
    return this.events.getCheckpointStatus();
  }

  private async processLivenessIndicator(): Promise<HealthIndicatorResult> {
    return {
      process: {
        status: 'up',
        uptimeSeconds: Math.floor(process.uptime()),
      },
    };
  }

  private async redisReadinessIndicator(): Promise<HealthIndicatorResult> {
    const redisClient = (this.cache as any)?.redis;
    if (!redisClient || typeof redisClient.ping !== 'function') {
      return {
        redis: {
          status: 'up',
          configured: false,
        },
      };
    }

    try {
      const pong = await redisClient.ping();
      const isUp = pong === 'PONG' || pong === true;
      const result: HealthIndicatorResult = {
        redis: {
          status: isUp ? 'up' : 'down',
          configured: true,
        },
      };
      if (!isUp) {
        throw new HealthCheckError('Redis ping failed', result);
      }
      return result;
    } catch (err) {
      if (err instanceof HealthCheckError) throw err;
      const result: HealthIndicatorResult = {
        redis: {
          status: 'down',
          configured: true,
          message: (err as Error).message,
        },
      };
      throw new HealthCheckError('Redis readiness check failed', result);
    }
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

  private async virusScannerIndicator(): Promise<HealthIndicatorResult> {
    const scanner = this.virusScan.getScannerStatus();
    const result: HealthIndicatorResult = {
      virus_scanner: {
        status: scanner.enabled && !scanner.available ? 'down' : 'up',
        enabled: scanner.enabled,
        available: scanner.available,
      },
    };

    if (scanner.enabled && !scanner.available) {
      throw new HealthCheckError('Virus scanner is unavailable', result);
    }

    return result;
  }
}
