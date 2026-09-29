// reports.service.ts
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateReportDto } from './dto/create-report.dto';
import { UpdateReportStatusDto } from './dto/update-report-status.dto';
import { ReportTargetType, ReportStatus } from '@prisma/client';

const OPEN_STATUSES: ReportStatus[] = [ReportStatus.PENDING, ReportStatus.UNDER_REVIEW];

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(reporterId: string, dto: CreateReportDto) {
    const reporter = await this.prisma.user.findUnique({ where: { id: reporterId } });
    if (!reporter) throw new NotFoundException('Reporter account not found');

    if (dto.targetType === ReportTargetType.PROFILE && dto.targetId === reporterId) {
      throw new BadRequestException('You cannot report your own profile');
    }

    await this.assertTargetExists(dto.targetType, dto.targetId);

    const existingOpenReport = await this.prisma.abuseReport.findFirst({
      where: {
        reporterId,
        targetType: dto.targetType,
        targetId: dto.targetId,
        status: { in: OPEN_STATUSES },
      },
    });
    if (existingOpenReport) {
      throw new ConflictException('You already have an open report for this target');
    }

    return this.prisma.abuseReport.create({
      data: {
        reporterId,
        targetType: dto.targetType,
        targetId: dto.targetId,
        category: dto.category,
        severity: dto.severity,
        description: dto.description,
      },
    });
  }

  async findMine(reporterId: string, status?: ReportStatus, page = 1, limit = 20) {
    const where: any = { reporterId };
    if (status) where.status = status;

    const [data, total] = await this.prisma.$transaction([
      this.prisma.abuseReport.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.abuseReport.count({ where }),
    ]);

    return { data, meta: { total, page, limit } };
  }

  async findOneForReporter(id: string, reporterId: string) {
    const report = await this.prisma.abuseReport.findUnique({ where: { id } });
    if (!report || report.reporterId !== reporterId) {
      throw new NotFoundException('Report not found');
    }
    return report;
  }

  async getCountForTarget(targetType: ReportTargetType, targetId: string) {
    const total = await this.prisma.abuseReport.count({ where: { targetType, targetId } });
    const open = await this.prisma.abuseReport.count({
      where: { targetType, targetId, status: { in: OPEN_STATUSES } },
    });
    return { targetType, targetId, total, open };
  }

  async adminFindAll(
    filters: {
      status?: ReportStatus;
      targetType?: ReportTargetType;
      category?: string;
      severity?: string;
    },
    page = 1,
    limit = 20,
  ) {
    const where: any = {};
    if (filters.status) where.status = filters.status;
    if (filters.targetType) where.targetType = filters.targetType;
    if (filters.category) where.category = filters.category;
    if (filters.severity) where.severity = filters.severity;

    const [data, total] = await this.prisma.$transaction([
      this.prisma.abuseReport.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: { reporter: { select: { id: true, name: true, email: true } } },
      }),
      this.prisma.abuseReport.count({ where }),
    ]);

    return { data, meta: { total, page, limit } };
  }

  async adminFindOne(id: string) {
    const report = await this.prisma.abuseReport.findUnique({
      where: { id },
      include: { reporter: { select: { id: true, name: true, email: true } } },
    });
    if (!report) throw new NotFoundException('Report not found');
    return report;
  }

  async adminUpdateStatus(id: string, adminId: string, dto: UpdateReportStatusDto) {
    if (dto.status === ReportStatus.PENDING) {
      throw new BadRequestException('Cannot set a report back to PENDING');
    }

    const report = await this.prisma.abuseReport.findUnique({ where: { id } });
    if (!report) throw new NotFoundException('Report not found');

    const isResolving = dto.status === ReportStatus.RESOLVED || dto.status === ReportStatus.DISMISSED;

    return this.prisma.abuseReport.update({
      where: { id },
      data: {
        status: dto.status,
        resolutionNote: dto.resolutionNote,
        resolvedById: isResolving ? adminId : null,
        resolvedAt: isResolving ? new Date() : null,
      },
    });
  }

  async adminTopReportedTargets(limit = 10) {
    const grouped = await (this.prisma.abuseReport as any).groupBy({
      by: ['targetType', 'targetId'],
      _count: { _all: true },
      orderBy: { _count: { _all: 'desc' } },
      take: limit,
    });

    return grouped.map((g) => ({
      targetType: g.targetType,
      targetId: g.targetId,
      reportCount: g._count._all,
    }));
  }

  private async assertTargetExists(targetType: ReportTargetType, targetId: string) {
    switch (targetType) {
      case ReportTargetType.COURSE: {
        const course = await this.prisma.course.findUnique({ where: { id: targetId } });
        if (!course) throw new NotFoundException('Reported course not found');
        return;
      }
      case ReportTargetType.PROFILE: {
        const user = await this.prisma.user.findUnique({ where: { id: targetId } });
        if (!user) throw new NotFoundException('Reported profile not found');
        return;
      }
      case ReportTargetType.COMMENT: {
        const comment = await this.prisma.discussionComment.findUnique({ where: { id: targetId } });
        if (!comment) throw new NotFoundException('Reported comment not found');
        return;
      }
    }
  }
}
