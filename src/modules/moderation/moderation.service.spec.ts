import { Test, TestingModule } from '@nestjs/testing';
import { ModerationService, DEFAULT_UNPUBLISH_THRESHOLD } from './moderation.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ReportCategory, ReportTargetType, ReportStatus, CourseStatus } from '@prisma/client';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

const mockPrisma = {
  abuseReport: {
    create: jest.fn(),
    count: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    findMany: jest.fn(),
  },
  course: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  discussionComment: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
};

describe('ModerationService', () => {
  let service: ModerationService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ModerationService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<ModerationService>(ModerationService);
    jest.clearAllMocks();
  });

  describe('createFlag()', () => {
    it('creates flag report successfully without auto unpublish if threshold not reached', async () => {
      mockPrisma.abuseReport.create.mockResolvedValue({
        id: 'flag-1',
        reporterId: 'user-1',
        targetType: ReportTargetType.COURSE,
        targetId: 'course-1',
        category: ReportCategory.SPAM,
        status: ReportStatus.PENDING,
      });
      mockPrisma.abuseReport.count.mockResolvedValue(1);

      const result = await service.createFlag('user-1', {
        targetType: ReportTargetType.COURSE,
        targetId: 'course-1',
        category: ReportCategory.SPAM,
      });

      expect(result.report.id).toBe('flag-1');
      expect(result.pendingCount).toBe(1);
      expect(result.autoActionTaken).toBe(false);
    });

    it('triggers automatic unpublish when flag threshold is reached for a course', async () => {
      mockPrisma.abuseReport.create.mockResolvedValue({
        id: 'flag-3',
        reporterId: 'user-3',
        targetType: ReportTargetType.COURSE,
        targetId: 'course-1',
        category: ReportCategory.HARASSMENT,
        status: ReportStatus.PENDING,
      });
      mockPrisma.abuseReport.count.mockResolvedValue(3);
      mockPrisma.course.findUnique.mockResolvedValue({
        id: 'course-1',
        status: CourseStatus.ACTIVE,
      });
      mockPrisma.course.update.mockResolvedValue({
        id: 'course-1',
        status: CourseStatus.PAUSED,
      });

      const result = await service.createFlag('user-3', {
        targetType: ReportTargetType.COURSE,
        targetId: 'course-1',
        category: ReportCategory.HARASSMENT,
      });

      expect(result.pendingCount).toBe(3);
      expect(result.autoActionTaken).toBe(true);
      expect(mockPrisma.course.update).toHaveBeenCalledWith({
        where: { id: 'course-1' },
        data: { status: CourseStatus.PAUSED },
      });
    });

    it('rejects duplicate pending flags from the same reporter for the same target', async () => {
      mockPrisma.abuseReport.findFirst.mockResolvedValue({
        id: 'existing-flag',
        reporterId: 'user-1',
        targetType: ReportTargetType.COURSE,
        targetId: 'course-1',
        status: ReportStatus.PENDING,
      });

      await expect(
        service.createFlag('user-1', {
          targetType: ReportTargetType.COURSE,
          targetId: 'course-1',
          category: ReportCategory.SPAM,
        }),
      ).rejects.toThrow(ConflictException);

      expect(mockPrisma.abuseReport.create).not.toHaveBeenCalled();
    });

    it('only counts distinct reporters toward the auto-unpublish threshold', async () => {
      mockPrisma.abuseReport.findFirst.mockResolvedValue(null);
      mockPrisma.abuseReport.create.mockResolvedValue({
        id: 'flag-3',
        reporterId: 'user-3',
        targetType: ReportTargetType.COURSE,
        targetId: 'course-1',
        category: ReportCategory.HARASSMENT,
        status: ReportStatus.PENDING,
      });
      mockPrisma.abuseReport.count.mockResolvedValue(3);

      await service.createFlag('user-3', {
        targetType: ReportTargetType.COURSE,
        targetId: 'course-1',
        category: ReportCategory.HARASSMENT,
      });

      expect(mockPrisma.abuseReport.count).toHaveBeenCalledWith({
        where: {
          targetType: ReportTargetType.COURSE,
          targetId: 'course-1',
          status: { in: [ReportStatus.PENDING, ReportStatus.UNDER_REVIEW] },
        },
        distinct: ['reporterId'],
      });
    });

    it('throws BadRequestException for invalid category', async () => {
      await expect(
        service.createFlag('user-1', {
          targetType: ReportTargetType.COURSE,
          targetId: 'course-1',
          category: 'INVALID_CATEGORY' as any,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('resolveFlag()', () => {
    it('resolves flag and sets admin notes', async () => {
      mockPrisma.abuseReport.findUnique.mockResolvedValue({
        id: 'flag-1',
        status: ReportStatus.PENDING,
      });
      mockPrisma.abuseReport.update.mockResolvedValue({
        id: 'flag-1',
        status: ReportStatus.RESOLVED,
        resolvedById: 'admin-1',
        resolutionNote: 'Content reviewed and action taken',
      });

      const result = await service.resolveFlag('flag-1', 'admin-1', {
        status: ReportStatus.RESOLVED,
        resolutionNote: 'Content reviewed and action taken',
      });

      expect(result.status).toBe(ReportStatus.RESOLVED);
      expect(result.resolvedById).toBe('admin-1');
    });

    it('throws NotFoundException if flag does not exist', async () => {
      mockPrisma.abuseReport.findUnique.mockResolvedValue(null);

      await expect(
        service.resolveFlag('non-existent', 'admin-1', {
          status: ReportStatus.DISMISSED,
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
