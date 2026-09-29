import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateFlagDto } from './dto/create-flag.dto';
import { ResolveFlagDto } from './dto/resolve-flag.dto';
import { ReportStatus, ReportTargetType, CourseStatus, ReportCategory } from '@prisma/client';

export const DEFAULT_UNPUBLISH_THRESHOLD = 3;

@Injectable()
export class ModerationService {
  private readonly logger = new Logger(ModerationService.name);

  constructor(private readonly prisma: PrismaService) {}

  async createFlag(reporterId: string, dto: CreateFlagDto) {
    if (!Object.values(ReportCategory).includes(dto.category)) {
      throw new BadRequestException(`Invalid flag category: ${dto.category}`);
    }

    const existingFlag = await this.prisma.abuseReport.findFirst({
      where: {
        reporterId,
        targetType: dto.targetType,
        targetId: dto.targetId,
        status: { in: [ReportStatus.PENDING, ReportStatus.UNDER_REVIEW] },
      },
    });

    if (existingFlag) {
      throw new ConflictException(
        'A pending or under-review report already exists for this reporter and target.',
      );
    }

    const report = await this.prisma.abuseReport.create({
      data: {
        reporterId,
        targetType: dto.targetType,
        targetId: dto.targetId,
        category: dto.category,
        description: dto.description,
        status: ReportStatus.PENDING,
      },
    });

    // Check pending flags threshold for automatic unpublish/hide
    const pendingCount = await this.prisma.abuseReport.count({
      where: {
        targetType: dto.targetType,
        targetId: dto.targetId,
        status: { in: [ReportStatus.PENDING, ReportStatus.UNDER_REVIEW] },
      },
      distinct: ['reporterId'],
    });

    let autoActionTaken = false;
    if (pendingCount >= DEFAULT_UNPUBLISH_THRESHOLD) {
      autoActionTaken = await this.handleAutoUnpublish(dto.targetType, dto.targetId);
    }

    return {
      report,
      pendingCount,
      autoActionTaken,
    };
  }

  private async handleAutoUnpublish(targetType: ReportTargetType, targetId: string): Promise<boolean> {
    try {
      if (targetType === ReportTargetType.COURSE) {
        const course = await this.prisma.course.findUnique({ where: { id: targetId } });
        if (course && course.status !== CourseStatus.PAUSED) {
          await this.prisma.course.update({
            where: { id: targetId },
            data: { status: CourseStatus.PAUSED },
          });
          this.logger.warn(`Course ${targetId} automatically paused due to flag threshold reach`);
          return true;
        }
      } else if (targetType === ReportTargetType.COMMENT) {
        const comment = await this.prisma.discussionComment.findUnique({ where: { id: targetId } });
        if (comment && !comment.hidden) {
          await this.prisma.discussionComment.update({
            where: { id: targetId },
            data: { hidden: true },
          });
          this.logger.warn(`Discussion comment ${targetId} automatically hidden due to flag threshold reach`);
          return true;
        }
      }
    } catch (err) {
      this.logger.error(`Failed automatic unpublish for ${targetType} ${targetId}: ${err.message}`);
    }
    return false;
  }

  async resolveFlag(flagId: string, adminId: string, dto: ResolveFlagDto) {
    const flag = await this.prisma.abuseReport.findUnique({ where: { id: flagId } });
    if (!flag) {
      throw new NotFoundException(`Flag report with ID ${flagId} not found`);
    }

    const updated = await this.prisma.abuseReport.update({
      where: { id: flagId },
      data: {
        status: dto.status,
        resolvedById: adminId,
        resolutionNote: dto.resolutionNote,
        resolvedAt: new Date(),
      },
    });

    this.logger.log(`Flag ${flagId} resolved by admin ${adminId} to status ${dto.status}`);
    return updated;
  }

  async getDashboardListing(query: {
    status?: ReportStatus;
    targetType?: ReportTargetType;
    category?: ReportCategory;
    page?: number;
    limit?: number;
  }) {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 10;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (query.status) where.status = query.status;
    if (query.targetType) where.targetType = query.targetType;
    if (query.category) where.category = query.category;

    const [reports, total] = await Promise.all([
      this.prisma.abuseReport.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          reporter: { select: { id: true, name: true, email: true } },
          resolvedBy: { select: { id: true, name: true, email: true } },
        },
      }),
      this.prisma.abuseReport.count({ where }),
    ]);

    return {
      data: reports,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }
}
