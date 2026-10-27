import { Test, TestingModule } from '@nestjs/testing';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EventsService } from '../events/events.service';
import type { CheckpointStatus } from '../events/events.service';
import { VirusScanService } from '../uploads/virus-scan.service';

/**
 * Exercises the real health routes end-to-end: the controller is resolved from
 * a Nest module with the real TerminusModule wired in, so `check()` runs the
 * actual HealthCheckService aggregation and `checkpoint()` runs the real
 * handler that GET /health/checkpoint is bound to.
 */
describe('HealthController (Issue #80 — checkpoint via health endpoint)', () => {
  let controller: HealthController;

  const healthyStatus: CheckpointStatus = {
    key: 'stellar-event-poller',
    lastProcessedLedger: 5123,
    lastProcessedCursor: null,
    persistedLedger: 5123,
    persistedCursor: null,
    lastPolledAt: new Date('2026-08-27T12:00:00Z'),
    resumedFromCheckpoint: true,
    consecutiveWriteFailures: 0,
    lastWriteError: null,
    healthy: true,
  };

  const mockEvents = { getCheckpointStatus: jest.fn() };
  const mockVirusScan = {
    getScannerStatus: jest.fn().mockReturnValue({ enabled: true, available: true }),
  };
  // PrismaHealthIndicator.pingDb tries $runCommandRaw first, then falls back to
  // $queryRawUnsafe('SELECT 1') for SQL providers.
  const mockPrisma = {
    $runCommandRaw: jest
      .fn()
      .mockRejectedValue(new Error('Use the mongodb provider')),
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ result: 1 }]),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [TerminusModule],
      controllers: [HealthController],
      providers: [
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EventsService, useValue: mockEvents },
        { provide: VirusScanService, useValue: mockVirusScan },
      ],
    }).compile();

    controller = module.get(HealthController);
    jest.clearAllMocks();
    mockPrisma.$runCommandRaw.mockRejectedValue(new Error('Use the mongodb provider'));
    mockPrisma.$queryRawUnsafe.mockResolvedValue([{ result: 1 }]);
    mockVirusScan.getScannerStatus.mockReturnValue({ enabled: true, available: true });
  });

  it('GET /health/checkpoint returns the current ledger checkpoint payload', async () => {
    mockEvents.getCheckpointStatus.mockResolvedValue(healthyStatus);

    const result = await controller.checkpoint();

    expect(result).toEqual(healthyStatus);
    expect(mockEvents.getCheckpointStatus).toHaveBeenCalledTimes(1);
  });

  it('GET /health includes the event poller checkpoint indicator and stays 200 (ok)', async () => {
    mockEvents.getCheckpointStatus.mockResolvedValue(healthyStatus);

    const result = await controller.check();

    expect(result.status).toBe('ok');
    expect(result.info?.event_poller_checkpoint).toEqual(
      expect.objectContaining({
        status: 'up',
        checkpointHealthy: true,
        lastProcessedLedger: 5123,
        persistedLedger: 5123,
      }),
    );
    expect(result.info?.virus_scanner).toEqual({
      status: 'up',
      enabled: true,
      available: true,
    });
  });

  it('GET /health reports an enabled but unavailable virus scanner as unhealthy', async () => {
    mockEvents.getCheckpointStatus.mockResolvedValue(healthyStatus);
    mockVirusScan.getScannerStatus.mockReturnValue({ enabled: true, available: false });

    let result: any;
    try {
      result = await controller.check();
    } catch (err: any) {
      result = typeof err.getResponse === 'function' ? err.getResponse() : err;
    }

    expect(result.status).toBe('error');
    expect(result.error?.virus_scanner).toEqual({
      status: 'down',
      enabled: true,
      available: false,
    });
  });

  it('GET /health surfaces a degraded checkpoint without failing the overall check', async () => {
    mockEvents.getCheckpointStatus.mockResolvedValue({
      ...healthyStatus,
      consecutiveWriteFailures: 3,
      lastWriteError: 'connection reset',
      healthy: false,
    });

    const result = await controller.check();

    expect(result.status).toBe('ok');
    expect(result.info?.event_poller_checkpoint).toEqual(
      expect.objectContaining({
        status: 'up',
        checkpointHealthy: false,
        consecutiveWriteFailures: 3,
        lastWriteError: 'connection reset',
      }),
    );
  });

  it("GET /health/live checks only the process and stays ok even when DB and virus scanner fail (#500)", async () => {
    mockPrisma.$queryRawUnsafe.mockRejectedValue(new Error("DB connection timeout"));
    mockVirusScan.getScannerStatus.mockReturnValue({ enabled: true, available: false });

    const result = await controller.live();

    expect(result.status).toBe("ok");
    expect(result.info?.process).toEqual(
      expect.objectContaining({
        status: "up",
      }),
    );
    expect(mockEvents.getCheckpointStatus).not.toHaveBeenCalled();
  });

  it("GET /health/ready checks database, Redis, checkpoint, and virus scanner (#500)", async () => {
    mockEvents.getCheckpointStatus.mockResolvedValue(healthyStatus);

    const result = await controller.ready();

    expect(result.status).toBe("ok");
    expect(result.info?.database).toEqual({ status: "up" });
    expect(result.info?.redis).toEqual({ status: "up", configured: false });
    expect(result.info?.virus_scanner).toEqual({
      status: "up",
      enabled: true,
      available: true,
    });
  });
});
