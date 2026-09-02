import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../common/prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { EngagementReportController } from './engagement-report.controller';
import { EngagementReportService } from './engagement-report.service';
import {
  EngagementReportQueryDto,
  EngagementScope,
} from './dto/engagement-report-query.dto';

const DAY = 24 * 60 * 60 * 1000;

describe('EngagementReport (Issue #64)', () => {
  let controller: EngagementReportController;
  let service: EngagementReportService;

  const mockPrisma = {
    user: { findUnique: jest.fn() },
    course: { findUnique: jest.fn() },
    enrollment: { findMany: jest.fn() },
    lessonProgress: {
      aggregate: jest.fn(),
      count: jest.fn(),
      groupBy: jest.fn(),
    },
    userPoints: { findMany: jest.fn() },
  };

  const query = (over: Partial<EngagementReportQueryDto> = {}) =>
    Object.assign(new EngagementReportQueryDto(), over);

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [EngagementReportController],
      providers: [
        EngagementReportService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    })
      // strip auth guards — this suite exercises the report logic, not authN
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(EngagementReportController);
    service = module.get(EngagementReportService);

    jest.clearAllMocks();
    mockPrisma.lessonProgress.aggregate.mockResolvedValue({
      _sum: { watchedSecs: 0 },
      _count: { _all: 0 },
    });
    mockPrisma.lessonProgress.count.mockResolvedValue(0);
    mockPrisma.lessonProgress.groupBy.mockResolvedValue([]);
    mockPrisma.userPoints.findMany.mockResolvedValue([]);
    mockPrisma.enrollment.findMany.mockResolvedValue([]);
  });

  describe('scope validation', () => {
    it('rejects STUDENT scope without a studentId', async () => {
      await expect(
        service.getReport(query({ scope: EngagementScope.STUDENT })),
      ).rejects.toThrow(BadRequestException);
    });

    it('404s when the requested student does not exist', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(
        service.getReport(
          query({ scope: EngagementScope.STUDENT, studentId: 'nope' }),
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects COURSE scope without a courseId', async () => {
      await expect(
        service.getReport(query({ scope: EngagementScope.COURSE })),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects an inverted reporting period', async () => {
      await expect(
        service.getReport(
          query({
            scope: EngagementScope.PLATFORM,
            from: '2026-08-01T00:00:00.000Z',
            to: '2026-07-01T00:00:00.000Z',
          }),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('scopes the enrollment query to the course for a cohort report', async () => {
      mockPrisma.course.findUnique.mockResolvedValue({ id: 'course-1' });

      await service.getReport(
        query({ scope: EngagementScope.COURSE, courseId: 'course-1' }),
      );

      expect(mockPrisma.enrollment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ courseId: 'course-1' }),
        }),
      );
    });
  });

  describe('watch time & completion aggregates', () => {
    it('summarises watch time, lesson and course completion for a cohort', async () => {
      mockPrisma.course.findUnique.mockResolvedValue({ id: 'course-1' });
      mockPrisma.enrollment.findMany.mockResolvedValue([
        {
          id: 'enr-1',
          studentId: 'stu-1',
          status: 'COMPLETED',
          progressPercent: 100,
          updatedAt: new Date(),
          enrolledAt: new Date(),
        },
        {
          id: 'enr-2',
          studentId: 'stu-2',
          status: 'ACTIVE',
          progressPercent: 40,
          updatedAt: new Date(),
          enrolledAt: new Date(),
        },
      ]);
      mockPrisma.lessonProgress.aggregate.mockResolvedValue({
        _sum: { watchedSecs: 7200 },
        _count: { _all: 10 },
      });
      mockPrisma.lessonProgress.count.mockResolvedValue(6);
      mockPrisma.lessonProgress.groupBy.mockResolvedValue([
        { enrollmentId: 'enr-1', _max: { updatedAt: new Date() } },
        { enrollmentId: 'enr-2', _max: { updatedAt: new Date() } },
      ]);
      mockPrisma.userPoints.findMany.mockResolvedValue([
        { userId: 'stu-1', currentStreak: 5, longestStreak: 12 },
        { userId: 'stu-2', currentStreak: 1, longestStreak: 3 },
      ]);

      const report = await controller.getReport(
        query({ scope: EngagementScope.COURSE, courseId: 'course-1' }),
      );

      expect(report.summary.students).toBe(2);
      expect(report.summary.enrollments).toBe(2);
      expect(report.summary.completedEnrollments).toBe(1);
      expect(report.summary.courseCompletionRate).toBe(0.5);
      expect(report.summary.avgProgressPercent).toBe(70);
      expect(report.summary.watchTime.totalSeconds).toBe(7200);
      expect(report.summary.watchTime.totalHours).toBe(2);
      expect(report.summary.watchTime.avgSecondsPerStudent).toBe(3600);
      expect(report.summary.lessons).toEqual({
        started: 10,
        completed: 6,
        completionRate: 0.6,
      });
      expect(report.summary.streaks).toEqual({
        avgCurrentStreak: 3,
        longestStreak: 12,
      });
    });
  });

  describe('inactivity threshold flagging', () => {
    it('flags students whose last lesson activity is older than the threshold', async () => {
      const stale = new Date(Date.now() - 40 * DAY);
      const fresh = new Date(Date.now() - 2 * DAY);
      mockPrisma.course.findUnique.mockResolvedValue({ id: 'course-1' });
      mockPrisma.enrollment.findMany.mockResolvedValue([
        {
          id: 'enr-active',
          studentId: 'stu-active',
          status: 'ACTIVE',
          progressPercent: 50,
          updatedAt: stale,
          enrolledAt: stale,
        },
        {
          id: 'enr-stale',
          studentId: 'stu-stale',
          status: 'ACTIVE',
          progressPercent: 10,
          updatedAt: stale,
          enrolledAt: stale,
        },
      ]);
      mockPrisma.lessonProgress.groupBy.mockResolvedValue([
        { enrollmentId: 'enr-active', _max: { updatedAt: fresh } },
        { enrollmentId: 'enr-stale', _max: { updatedAt: stale } },
      ]);

      const report = await service.getReport(
        query({
          scope: EngagementScope.COURSE,
          courseId: 'course-1',
          inactiveDays: 14,
        }),
      );

      expect(report.summary.inactivity.thresholdDays).toBe(14);
      expect(report.summary.inactivity.inactiveStudents).toBe(1);
      expect(report.summary.inactivity.studentIds).toEqual(['stu-stale']);
      expect(report.summary.inactivity.inactiveRate).toBe(0.5);
    });
  });

  describe('empty platform report', () => {
    it('returns a well-formed zeroed payload when there is no data', async () => {
      const report = await service.getReport(
        query({ scope: EngagementScope.PLATFORM }),
      );

      expect(report.scope).toBe(EngagementScope.PLATFORM);
      expect(report.summary.students).toBe(0);
      expect(report.summary.lessons.completionRate).toBe(0);
      expect(report.summary.inactivity.inactiveStudents).toBe(0);
      expect(mockPrisma.lessonProgress.groupBy).not.toHaveBeenCalled();
    });
  });
});
