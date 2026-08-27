import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  ANALYTICS_EVENT_TYPES,
  BatchTrackAnalyticsEventsDto,
  QueryAnalyticsEventsDto,
  TrackAnalyticsEventDto,
} from './dto/track-analytics-event.dto';

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Ingest a single analytics event after schema validation.
   */
  async trackEvent(
    dto: TrackAnalyticsEventDto,
    meta?: { ipAddress?: string; userAgent?: string; userId?: string },
  ) {
    this.validateEventPayload(dto);

    const event = await this.prisma.analyticsEvent.create({
      data: this.toCreateData(dto, meta),
    });

    this.logger.debug(`Analytics event stored: ${event.eventType} (${event.id})`);
    return event;
  }

  /**
   * Batch-ingest high-frequency analytics events (up to 500 per request).
   */
  async trackEventsBatch(
    dto: BatchTrackAnalyticsEventsDto,
    meta?: { ipAddress?: string; userAgent?: string; userId?: string },
  ) {
    if (!dto.events?.length) {
      throw new BadRequestException('events array must not be empty');
    }

    for (const event of dto.events) {
      this.validateEventPayload(event);
    }

    const result = await this.prisma.analyticsEvent.createMany({
      data: dto.events.map((event) => this.toCreateData(event, meta)),
    });

    this.logger.log(`Analytics batch ingested: ${result.count} events`);
    return {
      ingested: result.count,
      requested: dto.events.length,
    };
  }

  /**
   * Aggregate event volume grouped by event type.
   */
  async getVolumeByEventType(from?: string, to?: string) {
    const where: Prisma.AnalyticsEventWhereInput = {};
    if (from || to) {
      where.occurredAt = {};
      if (from) where.occurredAt.gte = new Date(from);
      if (to) where.occurredAt.lte = new Date(to);
    }

    const grouped = await this.prisma.analyticsEvent.groupBy({
      by: ['eventType'],
      where,
      _count: { _all: true },
    });

    const byEventType = grouped
      .map((row) => ({
        eventType: row.eventType,
        count: row._count._all,
      }))
      .sort((a, b) => b.count - a.count);

    const total = byEventType.reduce((sum, row) => sum + row.count, 0);

    return {
      total,
      byEventType,
    };
  }

  /**
   * Admin-only raw event query with pagination and filters.
   */
  async queryRawEvents(query: QueryAnalyticsEventsDto) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(200, Math.max(1, query.limit ?? 50));
    const skip = (page - 1) * limit;

    const where: Prisma.AnalyticsEventWhereInput = {};
    if (query.eventType) where.eventType = query.eventType;
    if (query.userId) where.userId = query.userId;
    if (query.sessionId) where.sessionId = query.sessionId;
    if (query.from || query.to) {
      where.occurredAt = {};
      if (query.from) where.occurredAt.gte = new Date(query.from);
      if (query.to) where.occurredAt.lte = new Date(query.to);
    }

    const [data, total] = await Promise.all([
      this.prisma.analyticsEvent.findMany({
        where,
        skip,
        take: limit,
        orderBy: { occurredAt: 'desc' },
      }),
      this.prisma.analyticsEvent.count({ where }),
    ]);

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 0,
      },
    };
  }

  /**
   * Validate analytics payload schema beyond class-validator decorators.
   */
  validateEventPayload(dto: TrackAnalyticsEventDto) {
    if (!dto.eventType?.trim()) {
      throw new BadRequestException('eventType is required');
    }

    if (dto.eventType.length > 100) {
      throw new BadRequestException('eventType must be at most 100 characters');
    }

    if (dto.properties !== undefined && dto.properties !== null) {
      if (
        typeof dto.properties !== 'object' ||
        Array.isArray(dto.properties)
      ) {
        throw new BadRequestException('properties must be a plain object');
      }

      let serialized: string;
      try {
        serialized = JSON.stringify(dto.properties);
      } catch {
        throw new BadRequestException('properties must be JSON-serializable');
      }
      if (serialized.length > 16_384) {
        throw new BadRequestException('properties payload is too large');
      }
    }

    // Warn (don't fail) for unknown event types so custom events remain allowed
    if (
      !ANALYTICS_EVENT_TYPES.includes(
        dto.eventType as (typeof ANALYTICS_EVENT_TYPES)[number],
      ) &&
      dto.eventType !== 'custom' &&
      !dto.eventType.startsWith('custom.')
    ) {
      this.logger.debug(`Non-standard analytics eventType: ${dto.eventType}`);
    }
  }

  private toCreateData(
    dto: TrackAnalyticsEventDto,
    meta?: { ipAddress?: string; userAgent?: string; userId?: string },
  ): Prisma.AnalyticsEventCreateManyInput {
    return {
      eventType: dto.eventType.trim(),
      userId: dto.userId ?? meta?.userId ?? null,
      sessionId: dto.sessionId ?? null,
      path: dto.path ?? null,
      properties: (dto.properties as Prisma.InputJsonValue) ?? Prisma.JsonNull,
      userAgent: dto.userAgent ?? meta?.userAgent ?? null,
      ipAddress: meta?.ipAddress ?? null,
      occurredAt: dto.occurredAt ? new Date(dto.occurredAt) : new Date(),
    };
  }
}
