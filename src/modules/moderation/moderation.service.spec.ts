import { Test, TestingModule } from '@nestjs/testing';
import { ModerationService, DEFAULT_UNPUBLISH_THRESHOLD } from './moderation.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CoursesService } from '../courses/courses.service';
import { ReportCategory, ReportTargetType, ReportStatus, CourseStatus } from '@prisma/client';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

/** groupBy({ by: ['reporterId'] }) result: one row per distinct reporter. */
const reporterGroups = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ reporterId: `user-${i + 1}` }));

const mockPrisma = {
  abuseReport: {
    create: jest.fn(),
    groupBy: jest.fn(),
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

const mockCourses = {
  pauseCourse: jest.fn().mockResolvedValue(true),
};

describe('ModerationService', () => {
  let service: ModerationService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ModerationService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: CoursesService, useValue: mockCourses },
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
      mockPrisma.abuseReport.groupBy.mockResolvedValue(reporterGroups(1));

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
      mockPrisma.abuseReport.groupBy.mockResolvedValue(reporterGroups(3));
      mockPrisma.course.findUnique.mockResolvedValue({
        id: 'course-1',
        status: CourseStatus.ACTIVE,
      });
      mockCourses.pauseCourse.mockResolvedValue(true);

      const result = await service.createFlag('user-3', {
        targetType: ReportTargetType.COURSE,
        targetId: 'course-1',
        category: ReportCategory.HARASSMENT,
      });

      expect(result.pendingCount).toBe(3);
      expect(result.autoActionTaken).toBe(true);
      // Issue #232 — pauseCourse also removes from search and purges caches
      expect(mockCourses.pauseCourse).toHaveBeenCalledWith('course-1');
      expect(mockPrisma.course.update).not.toHaveBeenCalled();
    });

    it('does not pause an already-paused course on threshold (issue #232)', async () => {
      mockPrisma.abuseReport.findFirst.mockResolvedValue(null);
      mockPrisma.abuseReport.create.mockResolvedValue({ id: 'flag-4' });
      mockPrisma.abuseReport.groupBy.mockResolvedValue(reporterGroups(3));
      mockPrisma.course.findUnique.mockResolvedValue({
        id: 'course-1',
        status: CourseStatus.PAUSED,
      });

      const result = await service.createFlag('user-4', {
        targetType: ReportTargetType.COURSE,
        targetId: 'course-1',
        category: ReportCategory.SPAM,
      });

      expect(result.autoActionTaken).toBe(false);
      expect(mockCourses.pauseCourse).not.toHaveBeenCalled();
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
      mockPrisma.abuseReport.groupBy.mockResolvedValue(reporterGroups(3));

      await service.createFlag('user-3', {
        targetType: ReportTargetType.COURSE,
        targetId: 'course-1',
        category: ReportCategory.HARASSMENT,
      });

      expect(mockPrisma.abuseReport.groupBy).toHaveBeenCalledWith({
        by: ['reporterId'],
        where: {
          targetType: ReportTargetType.COURSE,
          targetId: 'course-1',
          status: { in: [ReportStatus.PENDING, ReportStatus.UNDER_REVIEW] },
        },
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

    it('restores a PAUSED course to PUBLISHED when all reports are dismissed', async () => {
      mockPrisma.abuseReport.findUnique.mockResolvedValue({
        id: 'flag-1',
        targetType: ReportTargetType.COURSE,
        targetId: 'course-1',
        status: ReportStatus.PENDING,
      });
      mockPrisma.abuseReport.update.mockResolvedValue({
        id: 'flag-1',
        status: ReportStatus.DISMISSED,
        resolvedById: 'admin-1',
      });
      mockPrisma.abuseReport.count.mockResolvedValue(0);
      mockPrisma.course.findUnique.mockResolvedValue({
        id: 'course-1',
        status: CourseStatus.PAUSED,
      });
      mockPrisma.course.update.mockResolvedValue({
        id: 'course-1',
        status: CourseStatus.PUBLISHED,
      });

      await service.resolveFlag('flag-1', 'admin-1', {
        status: ReportStatus.DISMISSED,
      });

      expect(mockPrisma.course.update).toHaveBeenCalledWith({
        where: { id: 'course-1' },
        data: { status: CourseStatus.PUBLISHED },
      });
    });
  });

  describe('createFlag() — enrollment guard', () => {
    it('does not auto-pause a course when reports come from non-enrolled accounts', async () => {
      mockPrisma.abuseReport.findFirst.mockResolvedValue(null);
      mockPrisma.abuseReport.create.mockResolvedValue({
        id: 'flag-3',
        reporterId: 'user-3',
        targetType: ReportTargetType.COURSE,
        targetId: 'course-1',
        category: ReportCategory.SPAM,
        status: ReportStatus.PENDING,
      });
      mockPrisma.abuseReport.groupBy.mockResolvedValue(reporterGroups(3));
      mockPrisma.enrollment.findMany.mockResolvedValue([]);

      const result = await service.createFlag('user-3', {
        targetType: ReportTargetType.COURSE,
        targetId: 'course-1',
        category: ReportCategory.SPAM,
      });

      expect(result.pendingCount).toBe(0);
      expect(result.autoActionTaken).toBe(false);
      expect(mockCourses.pauseCourse).not.toHaveBeenCalled();
    });
  });
});
