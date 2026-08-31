import { Test, TestingModule } from '@nestjs/testing';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EventsService } from '../events/events.service';
import type { CheckpointStatus } from '../events/events.service';

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
    persistedLedger: 5123,
    lastPolledAt: new Date('2026-08-27T12:00:00Z'),
    resumedFromCheckpoint: true,
    consecutiveWriteFailures: 0,
    lastWriteError: null,
    healthy: true,
  };

  const mockEvents = { getCheckpointStatus: jest.fn() };
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
      ],
    }).compile();

    controller = module.get(HealthController);
    jest.clearAllMocks();
    mockPrisma.$runCommandRaw.mockRejectedValue(new Error('Use the mongodb provider'));
    mockPrisma.$queryRawUnsafe.mockResolvedValue([{ result: 1 }]);
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
});
