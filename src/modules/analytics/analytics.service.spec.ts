import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AnalyticsService } from './analytics.service';

describe('AnalyticsService', () => {
  let service: AnalyticsService;

  const mockPrisma = {
    analyticsEvent: {
      create: jest.fn(),
      createMany: jest.fn(),
      groupBy: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get(AnalyticsService);
    jest.clearAllMocks();
  });

  describe('trackEvent()', () => {
    it('ingests a valid analytics event', async () => {
      mockPrisma.analyticsEvent.create.mockResolvedValue({
        id: 'evt-1',
        eventType: 'page_view',
        path: '/courses',
      });

      const result = await service.trackEvent(
        { eventType: 'page_view', path: '/courses' },
        { userId: 'user-1', ipAddress: '127.0.0.1' },
      );

      expect(result.id).toBe('evt-1');
      expect(mockPrisma.analyticsEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          eventType: 'page_view',
          path: '/courses',
          userId: 'user-1',
          ipAddress: '127.0.0.1',
        }),
      });
    });

    it('rejects empty eventType', async () => {
      await expect(
        service.trackEvent({ eventType: '   ' } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects non-object properties', async () => {
      await expect(
        service.trackEvent({
          eventType: 'click',
          properties: ['bad'] as any,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('trackEventsBatch()', () => {
    it('batch-ingests high-frequency events', async () => {
      mockPrisma.analyticsEvent.createMany.mockResolvedValue({ count: 3 });

      const result = await service.trackEventsBatch({
        events: [
          { eventType: 'click', path: '/a' },
          { eventType: 'click', path: '/b' },
          { eventType: 'page_view', path: '/c' },
        ],
      });

      expect(result).toEqual({ ingested: 3, requested: 3 });
      expect(mockPrisma.analyticsEvent.createMany).toHaveBeenCalledTimes(1);
    });

    it('rejects empty batches', async () => {
      await expect(
        service.trackEventsBatch({ events: [] }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('getVolumeByEventType()', () => {
    it('returns volume metrics per event type', async () => {
      mockPrisma.analyticsEvent.groupBy.mockResolvedValue([
        { eventType: 'page_view', _count: { _all: 10 } },
        { eventType: 'click', _count: { _all: 4 } },
      ]);

      const result = await service.getVolumeByEventType();
      expect(result.total).toBe(14);
      expect(result.byEventType).toEqual([
        { eventType: 'page_view', count: 10 },
        { eventType: 'click', count: 4 },
      ]);
    });
  });

  describe('queryRawEvents()', () => {
    it('returns paginated raw events for admins', async () => {
      mockPrisma.analyticsEvent.findMany.mockResolvedValue([
        { id: 'evt-1', eventType: 'page_view' },
      ]);
      mockPrisma.analyticsEvent.count.mockResolvedValue(1);

      const result = await service.queryRawEvents({
        eventType: 'page_view',
        page: 1,
        limit: 10,
      });

      expect(result.data).toHaveLength(1);
      expect(result.meta).toEqual({
        total: 1,
        page: 1,
        limit: 10,
        totalPages: 1,
      });
    });
  });

  describe('validateEventPayload()', () => {
    it('allows known and custom event types', () => {
      expect(() =>
        service.validateEventPayload({ eventType: 'page_view' }),
      ).not.toThrow();
      expect(() =>
        service.validateEventPayload({ eventType: 'custom.widget_open' }),
      ).not.toThrow();
    });

    it('rejects oversized properties payloads', () => {
      const huge = { blob: 'x'.repeat(20_000) };
      expect(() =>
        service.validateEventPayload({
          eventType: 'click',
          properties: huge,
        }),
      ).toThrow(BadRequestException);
    });
  });
});
