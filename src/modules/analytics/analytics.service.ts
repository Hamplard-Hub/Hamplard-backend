import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  async trackEvent(
    dto: any,
    meta?: { ipAddress?: string; userAgent?: string; userId?: string },
  ) {
    const event = await this.prisma.analyticsEvent.create({
      data: {
        eventType: dto.eventType,
        userId: dto.userId ?? meta?.userId ?? null,
        sessionId: dto.sessionId ?? null,
        path: dto.path ?? null,
        properties: dto.properties ?? null,
        userAgent: dto.userAgent ?? meta?.userAgent ?? null,
        ipAddress: meta?.ipAddress ?? null,
        occurredAt: dto.occurredAt ? new Date(dto.occurredAt) : new Date(),
      },
    });
    this.logger.debug(`Analytics event stored: ${event.eventType} (${event.id})`);
    return event;
  }

  async trackEventsBatch(dto: any, meta?: { ipAddress?: string; userAgent?: string; userId?: string }) {
    if (!dto.events?.length) {
      throw new Error('events array must not be empty');
    }
    const result = await this.prisma.analyticsEvent.createMany({
      data: dto.events.map((event: any) => ({
        eventType: event.eventType,
        userId: event.userId ?? meta?.userId ?? null,
        sessionId: event.sessionId ?? null,
        path: event.path ?? null,
        properties: event.properties ?? null,
        userAgent: event.userAgent ?? meta?.userAgent ?? null,
        ipAddress: meta?.ipAddress ?? null,
        occurredAt: event.occurredAt ? new Date(event.occurredAt) : new Date(),
      })),
    });
    this.logger.log(`Analytics batch ingested: ${result.count} events`);
    return { ingested: result.count, requested: dto.events.length };
  }

  async getVolumeByEventType(from?: string, to?: string) {
    const where: any = {};
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
      .map((row) => ({ eventType: row.eventType, count: row._count._all }))
      .sort((a, b) => b.count - a.count);
    const total = byEventType.reduce((sum, row) => sum + row.count, 0);
    return { total, byEventType };
  }

  async queryRawEvents(query: { eventType?: string; userId?: string; sessionId?: string; from?: string; to?: string; page?: number; limit?: number }) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(200, Math.max(1, query.limit ?? 50));
    const skip = (page - 1) * limit;
    const where: any = {};
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
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) || 0 },
    };
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async purgeOldEntries() {
    const retentionDays = this.configService.get<number>('ANALYTICS_RETENTION_DAYS', 180);
    const purgeDate = new Date();
    purgeDate.setDate(purgeDate.getDate() - retentionDays);
    const BATCH_SIZE = 10000;
    let totalDeleted = 0;

    try {
      while (true) {
        const result = await this.prisma.analyticsEvent.deleteMany({
          where: {
            occurredAt: { lt: purgeDate },
          },
          take: BATCH_SIZE,
        });
        totalDeleted += result.count;
        if (result.count < BATCH_SIZE) break;
      }
      this.logger.log(`Purged ${totalDeleted} old analytics events (older than ${retentionDays} days)`);
    } catch (error) {
      this.logger.error('Failed to purge old analytics events', error);
    }
  }
}