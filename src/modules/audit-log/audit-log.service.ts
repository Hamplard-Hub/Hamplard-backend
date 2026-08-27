import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateAuditLogDto } from './dto/create-audit-log.dto';
import { QueryAuditLogDto } from './dto/query-audit-log.dto';

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  async createEntry(actorId: string, dto: CreateAuditLogDto) {
    return this.prisma.adminAuditLog.create({
      data: {
        actorId,
        action: dto.action,
        targetType: dto.targetType,
        targetId: dto.targetId,
        metadata: dto.metadata ?? null,
        ipAddress: dto.ipAddress,
      },
    });
  }

  async findAll(query: QueryAuditLogDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (query.actorId) where.actorId = query.actorId;
    if (query.action) where.action = query.action;
    if (query.targetType) where.targetType = query.targetType;
    if (query.targetId) where.targetId = query.targetId;

    if (query.from || query.to) {
      where.createdAt = {};
      if (query.from) where.createdAt.gte = new Date(query.from);
      if (query.to) where.createdAt.lte = new Date(query.to);
    }

    const [data, total] = await Promise.all([
      this.prisma.adminAuditLog.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          actor: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
      }),
      this.prisma.adminAuditLog.count({ where }),
    ]);

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async purgeOldEntries() {
    const retentionDays = this.configService.get<number>('AUDIT_LOG_RETENTION_DAYS', 90);
    const purgeDate = new Date();
    purgeDate.setDate(purgeDate.getDate() - retentionDays);

    try {
      const result = await this.prisma.adminAuditLog.deleteMany({
        where: {
          createdAt: {
            lt: purgeDate,
          },
        },
      });
      this.logger.log(`Purged ${result.count} old audit log entries (older than ${retentionDays} days)`);
    } catch (error) {
      this.logger.error('Failed to purge old audit log entries', error);
    }
  }
}
