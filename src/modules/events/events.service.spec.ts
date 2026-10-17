import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StellarService } from '../../common/stellar/stellar.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CoursesService } from '../courses/courses.service';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import {
  EventsService,
  EVENT_POLLER_CHECKPOINT_KEY,
  EVENT_POLLER_INTERVAL_NAME,
} from './events.service';

/**
 * SchedulerRegistry stand-in that records registered intervals and clears
 * them immediately so no real timers outlive a test.
 */
const buildMockScheduler = () => {
  const intervals = new Map<string, NodeJS.Timeout>();
  return {
    intervals,
    doesExist: jest.fn((_type: string, name: string) => intervals.has(name)),
    addInterval: jest.fn((name: string, id: NodeJS.Timeout) => {
      clearInterval(id);
      intervals.set(name, id);
    }),
    deleteInterval: jest.fn((name: string) => intervals.delete(name)),
  };
};

describe('EventsService — ledger checkpoint (Issue #80)', () => {
  let service: EventsService;

  const mockPrisma = {
    eventPollerCheckpoint: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      updateMany: jest.fn(),
    },
    chainEvent: {
      create: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
  };

  const mockStellar = {
    getLatestLedger: jest.fn(),
    fetchContractEvents: jest.fn(),
  };

  const mockNotifications = { notifyUser: jest.fn() };
  const mockCourses = {};

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: StellarService, useValue: mockStellar },
        { provide: NotificationsService, useValue: mockNotifications },
        { provide: CoursesService, useValue: mockCourses },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: SchedulerRegistry, useValue: buildMockScheduler() },
      ],
    }).compile();

    service = module.get(EventsService);
    jest.clearAllMocks();
    mockPrisma.eventPollerCheckpoint.upsert.mockResolvedValue({});
    mockPrisma.eventPollerCheckpoint.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.chainEvent.create.mockResolvedValue({});
    mockPrisma.chainEvent.upsert.mockResolvedValue({});
    mockPrisma.chainEvent.update.mockResolvedValue({});
    mockPrisma.chainEvent.updateMany.mockResolvedValue({ count: 1 });
  });

  describe('onModuleInit — resume from checkpoint', () => {
    it('resumes from the persisted ledger instead of the chain tip', async () => {
      mockPrisma.eventPollerCheckpoint.findUnique.mockResolvedValue({
        key: EVENT_POLLER_CHECKPOINT_KEY,
        lastProcessedLedger: 4242,
      });
      mockStellar.getLatestLedger.mockResolvedValue(9999);

      await service.onModuleInit();

      const status = await service.getCheckpointStatus();
      expect(status.lastProcessedLedger).toBe(4242);
      expect(status.resumedFromCheckpoint).toBe(true);
    });

    it('cold-starts near the chain tip and writes an initial checkpoint when none exists', async () => {
      mockPrisma.eventPollerCheckpoint.findUnique.mockResolvedValue(null);
      mockStellar.getLatestLedger.mockResolvedValue(1000);

      await service.onModuleInit();

      const status = await service.getCheckpointStatus();
      expect(status.lastProcessedLedger).toBe(990); // 1000 - COLD_START_LOOKBACK
      expect(status.resumedFromCheckpoint).toBe(false);
      expect(mockPrisma.eventPollerCheckpoint.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { key: EVENT_POLLER_CHECKPOINT_KEY },
        }),
      );
    });

    it('ignores a checkpoint that points past the chain tip (stale / wrong network)', async () => {
      mockPrisma.eventPollerCheckpoint.findUnique.mockResolvedValue({
        key: EVENT_POLLER_CHECKPOINT_KEY,
        lastProcessedLedger: 50_000,
      });
      mockStellar.getLatestLedger.mockResolvedValue(1000);

      await service.onModuleInit();

      const status = await service.getCheckpointStatus();
      expect(status.lastProcessedLedger).toBe(990);
      expect(status.resumedFromCheckpoint).toBe(false);
    });
  });

  describe('pollEvents — checkpoint writes after each poll', () => {
    beforeEach(async () => {
      mockPrisma.eventPollerCheckpoint.findUnique.mockResolvedValue(null);
      mockStellar.getLatestLedger.mockResolvedValue(108);
      await service.onModuleInit();
      jest.clearAllMocks();
      mockPrisma.eventPollerCheckpoint.upsert.mockResolvedValue({});
      mockPrisma.chainEvent.create.mockResolvedValue({});
      mockPrisma.chainEvent.upsert.mockResolvedValue({});
      mockPrisma.chainEvent.update.mockResolvedValue({});
      mockPrisma.chainEvent.updateMany.mockResolvedValue({ count: 1 });
    });

    it('advances and persists the ledger after processing events', async () => {
      mockStellar.fetchContractEvents.mockResolvedValue({
        latestLedger: 108,
        events: [
          { ledger: 105, pagingToken: 'a', topic: ['course_registered'], value: 'COURSE-1', txHash: 'a' },
          { ledger: 107, pagingToken: 'b', topic: ['course_registered'], value: 'COURSE-2', txHash: 'b' },
        ],
      });

      await service.pollEvents();

      expect(mockPrisma.eventPollerCheckpoint.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({ lastProcessedLedger: 109, lastProcessedCursor: null }),
        }),
      );
      const status = await service.getCheckpointStatus();
      expect(status.lastProcessedLedger).toBe(109);
    });

    it('still writes a checkpoint when a poll finds no events', async () => {
      mockStellar.fetchContractEvents.mockResolvedValue({ latestLedger: 108, events: [] });

      await service.pollEvents();

      expect(mockPrisma.eventPollerCheckpoint.upsert).toHaveBeenCalledTimes(1);
    });
  });

  describe('pollEvents — cursor pagination (Issue #227)', () => {
    const events = Array.from({ length: 101 }, (_, i) => ({
      id: `event-${i}`,
      ledger: 500,
      pagingToken: `token-${i}`,
      topic: ['course_registered'],
      value: `COURSE-${i}`,
      txHash: `tx-${i}`,
    }));

    beforeEach(async () => {
      mockPrisma.eventPollerCheckpoint.findUnique.mockResolvedValue(null);
      mockStellar.getLatestLedger.mockResolvedValue(500);
      await service.onModuleInit();
      jest.clearAllMocks();
      mockPrisma.eventPollerCheckpoint.upsert.mockResolvedValue({});
      mockPrisma.chainEvent.create.mockResolvedValue({});
      mockStellar.getLatestLedger.mockResolvedValue(500);
    });

    it('processes all 101 events in one ledger across two pages', async () => {
      mockStellar.fetchContractEvents
        .mockResolvedValueOnce({ latestLedger: 500, events: events.slice(0, 100) })
        .mockResolvedValueOnce({ latestLedger: 500, events: events.slice(100) });

      await service.pollEvents();

      expect(mockPrisma.chainEvent.create).toHaveBeenCalledTimes(101);
      expect(mockStellar.fetchContractEvents).toHaveBeenNthCalledWith(1, 490, undefined);
      expect(mockStellar.fetchContractEvents).toHaveBeenNthCalledWith(2, 501, 'token-99');
      expect(mockPrisma.eventPollerCheckpoint.upsert).toHaveBeenLastCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({ lastProcessedLedger: 501, lastProcessedCursor: null }),
        }),
      );
    });

    it('resumes after the last processed event when the next page fails and the service restarts', async () => {
      let checkpoint: any = null;
      mockPrisma.eventPollerCheckpoint.upsert.mockImplementation(async ({ create, update }) => {
        checkpoint = { ...create, ...update };
        return checkpoint;
      });
      mockStellar.fetchContractEvents
        .mockResolvedValueOnce({ latestLedger: 500, events: events.slice(0, 100) })
        .mockRejectedValueOnce(new Error('RPC unavailable'));

      await service.pollEvents();
      expect(checkpoint.lastProcessedCursor).toBe('token-99');
      expect(mockPrisma.chainEvent.create).toHaveBeenCalledTimes(100);

      mockPrisma.eventPollerCheckpoint.findUnique.mockResolvedValue(checkpoint);
      const restarted = new EventsService(
        mockPrisma as any,
        mockStellar as any,
        mockNotifications as any,
        mockCourses as any,
      );
      await restarted.onModuleInit();
      mockStellar.fetchContractEvents.mockReset().mockResolvedValue({
        latestLedger: 500,
        events: events.slice(100),
      });

      await restarted.pollEvents();

      expect(mockStellar.fetchContractEvents).toHaveBeenCalledWith(501, 'token-99');
      expect(mockPrisma.chainEvent.create).toHaveBeenCalledTimes(101);
      expect(checkpoint.lastProcessedCursor).toBeNull();
    });
  });

  describe('pollEvents — checkpoint write failures do not block polling', () => {
    beforeEach(async () => {
      mockPrisma.eventPollerCheckpoint.findUnique.mockResolvedValue(null);
      mockStellar.getLatestLedger.mockResolvedValue(110);
      await service.onModuleInit();
      jest.clearAllMocks();
      mockPrisma.chainEvent.create.mockResolvedValue({});
      mockPrisma.chainEvent.upsert.mockResolvedValue({});
      mockPrisma.chainEvent.update.mockResolvedValue({});
      mockPrisma.chainEvent.updateMany.mockResolvedValue({ count: 1 });
    });

    it('swallows the write error, records the failure and keeps advancing in memory', async () => {
      mockStellar.fetchContractEvents.mockResolvedValue({
        latestLedger: 110,
        events: [{ ledger: 110, pagingToken: 'a', topic: ['course_registered'], value: 'COURSE-1', txHash: 'a' }],
      });
      mockPrisma.eventPollerCheckpoint.upsert.mockRejectedValue(new Error('db down'));
      mockPrisma.eventPollerCheckpoint.updateMany.mockResolvedValue({ count: 1 });

      await expect(service.pollEvents()).resolves.not.toThrow();

      const status = await service.getCheckpointStatus();
      expect(status.consecutiveWriteFailures).toBe(2);
      expect(status.lastWriteError).toContain('db down');
      expect(status.healthy).toBe(false);
      // in-memory progress is not lost
      expect(status.lastProcessedLedger).toBe(111);
    });

    it('recovers (failure counter resets) once a later write succeeds', async () => {
      mockStellar.fetchContractEvents.mockResolvedValue({ latestLedger: 110, events: [] });
      mockPrisma.eventPollerCheckpoint.upsert
        .mockRejectedValueOnce(new Error('transient'))
        .mockResolvedValueOnce({});
      mockPrisma.eventPollerCheckpoint.updateMany.mockResolvedValue({ count: 1 });

      await service.pollEvents();
      expect((await service.getCheckpointStatus()).consecutiveWriteFailures).toBe(1);

      await service.pollEvents();
      const status = await service.getCheckpointStatus();
      expect(status.consecutiveWriteFailures).toBe(0);
      expect(status.healthy).toBe(true);
    });
  });

  describe('pollEvents — idempotent ingestion', () => {
    beforeEach(async () => {
      mockPrisma.eventPollerCheckpoint.findUnique.mockResolvedValue(null);
      mockStellar.getLatestLedger.mockResolvedValue(100);
      await service.onModuleInit();
      jest.clearAllMocks();
      mockPrisma.eventPollerCheckpoint.upsert.mockResolvedValue({});
      mockPrisma.chainEvent.upsert.mockResolvedValue({});
      mockPrisma.chainEvent.update.mockResolvedValue({});
      mockPrisma.chainEvent.updateMany.mockResolvedValue({ count: 1 });
    });

    it('upserts events by unique event id instead of always inserting', async () => {
      mockStellar.fetchContractEvents.mockResolvedValue([
        { ledger: 105, topic: ['course_registered'], value: 'COURSE-1', txHash: 'a', id: 'evt-1' },
      ]);

      await service.pollEvents();

      expect(mockPrisma.chainEvent.create).not.toHaveBeenCalled();
      expect(mockPrisma.chainEvent.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { eventId: 'evt-1' },
        }),
      );
    });

    it('marks processed after a handler succeeds', async () => {
      mockStellar.fetchContractEvents.mockResolvedValue([
        { ledger: 105, topic: ['course_registered'], value: 'COURSE-1', txHash: 'a', id: 'evt-1' },
      ]);

      await service.pollEvents();

      expect(mockPrisma.chainEvent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { eventId: 'evt-1' },
          data: expect.objectContaining({ processed: true }),
        }),
      );
    });

    it('records handler errors without marking the event processed', async () => {
      mockStellar.fetchContractEvents.mockResolvedValue([
        { ledger: 105, topic: ['course_registered'], value: 'COURSE-1', txHash: 'a', id: 'evt-1' },
      ]);
      mockPrisma.chainEvent.update.mockRejectedValueOnce(new Error('handler failed'));

      await expect(service.pollEvents()).resolves.not.toThrow();
    });
  });

  describe('getCheckpointStatus', () => {
    it('reports the persisted ledger from the database', async () => {
      mockPrisma.eventPollerCheckpoint.findUnique.mockResolvedValue({
        key: EVENT_POLLER_CHECKPOINT_KEY,
        lastProcessedLedger: 777,
        lastPolledAt: new Date('2026-08-27T00:00:00Z'),
      });

      const status = await service.getCheckpointStatus();
      expect(status.persistedLedger).toBe(777);
      expect(status.key).toBe(EVENT_POLLER_CHECKPOINT_KEY);
    });
  });
});

describe('EventsService — poller scheduling & re-entrancy (Issue #229)', () => {
  let service: EventsService;
  let scheduler: ReturnType<typeof buildMockScheduler>;
  const config = { get: jest.fn() };

  const mockPrisma = {
    eventPollerCheckpoint: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    chainEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  const mockStellar = {
    getLatestLedger: jest.fn().mockResolvedValue(100),
    fetchContractEvents: jest.fn(),
  };

  beforeEach(async () => {
    scheduler = buildMockScheduler();
    config.get.mockReset();
    mockStellar.fetchContractEvents.mockReset();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: StellarService, useValue: mockStellar },
        { provide: NotificationsService, useValue: { notifyUser: jest.fn() } },
        { provide: CoursesService, useValue: {} },
        { provide: ConfigService, useValue: config },
        { provide: SchedulerRegistry, useValue: scheduler },
      ],
    }).compile();

    service = module.get(EventsService);
  });

  it('registers the poll interval with SchedulerRegistry using EVENT_POLLING_INTERVAL_MS', async () => {
    config.get.mockImplementation((key: string) =>
      key === 'EVENT_POLLING_INTERVAL_MS' ? '12000' : undefined,
    );
    const setIntervalSpy = jest.spyOn(global, 'setInterval');

    await service.onModuleInit();

    expect(service.getPollingIntervalMs()).toBe(12000);
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 12000);
    expect(scheduler.addInterval).toHaveBeenCalledWith(
      EVENT_POLLER_INTERVAL_NAME,
      expect.anything(),
    );
    setIntervalSpy.mockRestore();
  });

  it('defaults to 5000 ms when EVENT_POLLING_INTERVAL_MS is unset or invalid', () => {
    config.get.mockReturnValue(undefined);
    expect(service.getPollingIntervalMs()).toBe(5000);

    config.get.mockReturnValue('not-a-number');
    expect(service.getPollingIntervalMs()).toBe(5000);

    config.get.mockReturnValue('0');
    expect(service.getPollingIntervalMs()).toBe(5000);
  });

  it('removes the interval on module destroy', async () => {
    await service.onModuleInit();
    service.onModuleDestroy();
    expect(scheduler.deleteInterval).toHaveBeenCalledWith(EVENT_POLLER_INTERVAL_NAME);
  });

  it('skips overlapping ticks while a slow poll is still running', async () => {
    let releaseFetch!: (events: any[]) => void;
    mockStellar.fetchContractEvents.mockImplementation(
      () => new Promise((resolve) => { releaseFetch = resolve; }),
    );

    const slowPoll = service.pollEvents();
    // Two more ticks fire while the first RPC call is still pending.
    await service.pollEvents();
    await service.pollEvents();

    expect(mockStellar.fetchContractEvents).toHaveBeenCalledTimes(1);

    releaseFetch([]);
    await slowPoll;

    // Once the slow poll finishes the next tick runs normally.
    mockStellar.fetchContractEvents.mockResolvedValue([]);
    await service.pollEvents();
    expect(mockStellar.fetchContractEvents).toHaveBeenCalledTimes(2);
  });

  it('releases the lock even when the RPC fetch fails', async () => {
    mockStellar.fetchContractEvents
      .mockRejectedValueOnce(new Error('rpc timeout'))
      .mockResolvedValueOnce([]);

    await service.pollEvents();
    await service.pollEvents();

    expect(mockStellar.fetchContractEvents).toHaveBeenCalledTimes(2);
  });

  it('releases the lock even when event processing throws', async () => {
    mockStellar.fetchContractEvents
      .mockResolvedValueOnce([{ ledger: 101, topic: ['course_paused'], value: 'C-1' }])
      .mockResolvedValueOnce([]);
    (mockPrisma as any).course = {
      updateMany: jest.fn().mockRejectedValue(new Error('db write failed')),
    };

    await service.pollEvents();
    await service.pollEvents();

    expect(mockStellar.fetchContractEvents).toHaveBeenCalledTimes(2);
  });
});
