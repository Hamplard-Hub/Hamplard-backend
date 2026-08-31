import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StellarService } from '../../common/stellar/stellar.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CoursesService } from '../courses/courses.service';
import { EventsService, EVENT_POLLER_CHECKPOINT_KEY } from './events.service';

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
      ],
    }).compile();

    service = module.get(EventsService);
    jest.clearAllMocks();
    mockPrisma.eventPollerCheckpoint.upsert.mockResolvedValue({});
    mockPrisma.eventPollerCheckpoint.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.chainEvent.create.mockResolvedValue({});
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
      mockStellar.getLatestLedger.mockResolvedValue(100);
      await service.onModuleInit();
      jest.clearAllMocks();
      mockPrisma.eventPollerCheckpoint.upsert.mockResolvedValue({});
      mockPrisma.chainEvent.create.mockResolvedValue({});
    });

    it('advances and persists the ledger after processing events', async () => {
      mockStellar.fetchContractEvents.mockResolvedValue([
        { ledger: 105, topic: ['course_registered'], value: 'COURSE-1', txHash: 'a' },
        { ledger: 107, topic: ['course_registered'], value: 'COURSE-2', txHash: 'b' },
      ]);

      await service.pollEvents();

      expect(mockPrisma.eventPollerCheckpoint.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({ lastProcessedLedger: 108 }),
        }),
      );
      const status = await service.getCheckpointStatus();
      expect(status.lastProcessedLedger).toBe(108);
    });

    it('still writes a checkpoint when a poll finds no events', async () => {
      mockStellar.fetchContractEvents.mockResolvedValue([]);

      await service.pollEvents();

      expect(mockPrisma.eventPollerCheckpoint.upsert).toHaveBeenCalledTimes(1);
    });
  });

  describe('pollEvents — checkpoint write failures do not block polling', () => {
    beforeEach(async () => {
      mockPrisma.eventPollerCheckpoint.findUnique.mockResolvedValue(null);
      mockStellar.getLatestLedger.mockResolvedValue(100);
      await service.onModuleInit();
      jest.clearAllMocks();
      mockPrisma.chainEvent.create.mockResolvedValue({});
    });

    it('swallows the write error, records the failure and keeps advancing in memory', async () => {
      mockStellar.fetchContractEvents.mockResolvedValue([
        { ledger: 110, topic: ['course_registered'], value: 'COURSE-1', txHash: 'a' },
      ]);
      mockPrisma.eventPollerCheckpoint.upsert.mockRejectedValue(new Error('db down'));
      mockPrisma.eventPollerCheckpoint.updateMany.mockResolvedValue({ count: 1 });

      await expect(service.pollEvents()).resolves.not.toThrow();

      const status = await service.getCheckpointStatus();
      expect(status.consecutiveWriteFailures).toBe(1);
      expect(status.lastWriteError).toContain('db down');
      expect(status.healthy).toBe(false);
      // in-memory progress is not lost
      expect(status.lastProcessedLedger).toBe(111);
    });

    it('recovers (failure counter resets) once a later write succeeds', async () => {
      mockStellar.fetchContractEvents.mockResolvedValue([]);
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
