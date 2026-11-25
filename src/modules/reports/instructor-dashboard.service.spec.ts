import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../common/prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { InstructorDashboardController } from './instructor-dashboard.controller';
import { InstructorDashboardService } from './instructor-dashboard.service';
import { InstructorDashboardQueryDto } from './dto/instructor-dashboard-query.dto';

describe('InstructorDashboard (Issue #363)', () => {
  let controller: InstructorDashboardController;
  let service: InstructorDashboardService;

  const mockPrisma = {
    user: { findUnique: jest.fn() },
    course: { findMany: jest.fn() },
    enrollment: { findMany: jest.fn() },
    courseReview: { groupBy: jest.fn() },
    courseModule: { findMany: jest.fn() },
    lesson: { findMany: jest.fn() },
    quizAttempt: { groupBy: jest.fn() },
    exam: { findMany: jest.fn() },
    examAttempt: { groupBy: jest.fn() },
    assignmentSubmission: { findMany: jest.fn() },
  };

  const query = (over: Partial<InstructorDashboardQueryDto> = {}) =>
    Object.assign(new InstructorDashboardQueryDto(), over);

  const instructorUser = {
    id: 'inst-1',
    name: 'Ada Lovelace',
    role: 'INSTRUCTOR',
    stellarAddress: 'GABC123',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [InstructorDashboardController],
      providers: [
        InstructorDashboardService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(InstructorDashboardController);
    service = module.get(InstructorDashboardService);

    jest.clearAllMocks();

    // Setup default mocks
    mockPrisma.user.findUnique.mockResolvedValue(instructorUser);
    mockPrisma.course.findMany.mockResolvedValue([
      { id: 'course-1', name: 'TypeScript 101' },
      { id: 'course-2', name: 'React Fundamentals' },
    ]);
    mockPrisma.enrollment.findMany.mockResolvedValue([]);
    mockPrisma.courseReview.groupBy.mockResolvedValue([]);
    mockPrisma.courseModule.findMany.mockResolvedValue([]);
    mockPrisma.lesson.findMany.mockResolvedValue([]);
    mockPrisma.quizAttempt.groupBy.mockResolvedValue([]);
    mockPrisma.exam.findMany.mockResolvedValue([]);
    mockPrisma.examAttempt.groupBy.mockResolvedValue([]);
    mockPrisma.assignmentSubmission.findMany.mockResolvedValue([]);
  });

  describe('validation', () => {
    it('404s for an unknown instructor', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(service.getDashboard('nope', query())).rejects.toThrow(
        NotFoundException,
      );
    });

    it('400s when the user is not an instructor', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        ...instructorUser,
        role: 'STUDENT',
      });
      await expect(service.getDashboard('inst-1', query())).rejects.toThrow(
        BadRequestException,
      );
    });

    it('400s on invalid from date', async () => {
      await expect(
        service.getDashboard('inst-1', query({ from: 'not-a-date' })),
      ).rejects.toThrow(BadRequestException);
    });

    it('400s on invalid to date', async () => {
      await expect(
        service.getDashboard('inst-1', query({ to: 'not-a-date' })),
      ).rejects.toThrow(BadRequestException);
    });

    it('400s when from > to', async () => {
      await expect(
        service.getDashboard(
          'inst-1',
          query({
            from: '2026-12-31T00:00:00Z',
            to: '2026-01-01T00:00:00Z',
          }),
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('no courses', () => {
    it('returns empty dashboard when instructor has no courses', async () => {
      mockPrisma.course.findMany.mockResolvedValue([]);

      const report = await service.getDashboard('inst-1', query());

      expect(report.courseMetrics).toEqual([]);
      expect(report.summary.totalCourses).toBe(0);
      expect(report.summary.totalEnrollments).toBe(0);
      expect(report.summary.averageCompletionRate).toBe(0);
      expect(report.summary.averageRating).toBe(0);
      expect(report.summary.totalPendingSubmissions).toBe(0);
    });
  });

  describe('per-course metrics', () => {
    it('returns metrics for each course', async () => {
      const courses = [
        { id: 'course-1', title: 'TypeScript 101' },
        { id: 'course-2', title: 'React Fundamentals' },
      ];
      mockPrisma.course.findMany.mockResolvedValue(courses);

      // Enrollments: 2 total in course-1, 1 completed; 3 in course-2, 2 completed
      mockPrisma.enrollment.findMany.mockResolvedValue([
        { courseId: 'course-1', status: 'COMPLETED' },
        { courseId: 'course-1', status: 'ACTIVE' },
        { courseId: 'course-2', status: 'COMPLETED' },
        { courseId: 'course-2', status: 'COMPLETED' },
        { courseId: 'course-2', status: 'ACTIVE' },
      ]);

      // Reviews: course-1 has 1 review with rating 5; course-2 has 2 reviews avg 4
      mockPrisma.courseReview.groupBy.mockResolvedValue([
        {
          courseId: 'course-1',
          _avg: { rating: 5 },
          _count: { _all: 1 },
        },
        {
          courseId: 'course-2',
          _avg: { rating: 4 },
          _count: { _all: 2 },
        },
      ]);

      // No quizzes
      mockPrisma.lesson.findMany.mockResolvedValue([
        { id: 'lesson-1', courseId: 'course-1' },
        { id: 'lesson-2', courseId: 'course-2' },
      ]);
      mockPrisma.quizAttempt.groupBy.mockResolvedValue([]);

      // No exams
      mockPrisma.exam.findMany.mockResolvedValue([]);
      mockPrisma.examAttempt.groupBy.mockResolvedValue([]);

      // Assignments: course-1 has 1 pending; course-2 has 2 approved, 1 rejected
      mockPrisma.assignmentSubmission.findMany.mockResolvedValue([
        {
          status: 'PENDING',
          assignment: { lessonId: 'lesson-1' },
        },
        {
          status: 'APPROVED',
          assignment: { lessonId: 'lesson-2' },
        },
        {
          status: 'APPROVED',
          assignment: { lessonId: 'lesson-2' },
        },
        {
          status: 'REJECTED',
          assignment: { lessonId: 'lesson-2' },
        },
      ]);

      // Lessons: course-1 has lesson-1, course-2 has lesson-2
      mockPrisma.courseModule.findMany.mockResolvedValue([
        { id: 'module-1', courseId: 'course-1' },
        { id: 'module-2', courseId: 'course-2' },
      ]);
      mockPrisma.lesson.findMany.mockResolvedValue([
        { id: 'lesson-1', moduleId: 'module-1' },
        { id: 'lesson-2', moduleId: 'module-2' },
      ]);

      const report = await service.getDashboard('inst-1', query());

      expect(report.courseMetrics.length).toBe(2);

      // Course 1
      expect(report.courseMetrics[0].courseId).toBe('course-1');
      expect(report.courseMetrics[0].courseName).toBe('TypeScript 101');
      expect(report.courseMetrics[0].enrollments.total).toBe(2);
      expect(report.courseMetrics[0].enrollments.completed).toBe(1);
      expect(report.courseMetrics[0].enrollments.completionRate).toBe(0.5);
      expect(report.courseMetrics[0].enrollments.activeCount).toBe(1);
      expect(report.courseMetrics[0].ratings.average).toBe(5);
      expect(report.courseMetrics[0].ratings.totalReviews).toBe(1);
      expect(report.courseMetrics[0].submissions.pending).toBe(1);
      expect(report.courseMetrics[0].submissions.approved).toBe(0);
      expect(report.courseMetrics[0].submissions.rejected).toBe(0);

      // Course 2
      expect(report.courseMetrics[1].courseId).toBe('course-2');
      expect(report.courseMetrics[1].enrollments.total).toBe(3);
      expect(report.courseMetrics[1].enrollments.completed).toBe(2);
      expect(report.courseMetrics[1].enrollments.completionRate).toBeCloseTo(0.6667, 3);
      expect(report.courseMetrics[1].enrollments.activeCount).toBe(1);
      expect(report.courseMetrics[1].ratings.average).toBe(4);
      expect(report.courseMetrics[1].ratings.totalReviews).toBe(2);
      expect(report.courseMetrics[1].submissions.pending).toBe(0);
      expect(report.courseMetrics[1].submissions.approved).toBe(2);
      expect(report.courseMetrics[1].submissions.rejected).toBe(1);
    });

    it('calculates average quiz scores per course', async () => {
      mockPrisma.course.findMany.mockResolvedValue([
        { id: 'course-1', name: 'Course 1' },
      ]);
      mockPrisma.enrollment.findMany.mockResolvedValue([]);
      mockPrisma.courseReview.groupBy.mockResolvedValue([]);
      mockPrisma.courseModule.findMany.mockResolvedValue([
        { id: 'module-1', courseId: 'course-1' },
      ]);
      mockPrisma.lesson.findMany.mockResolvedValue([
        { id: 'lesson-1', moduleId: 'module-1' },
        { id: 'lesson-2', moduleId: 'module-1' },
      ]);

      // Quiz scores: lesson-1 avg 80, lesson-2 avg 90
      mockPrisma.quizAttempt.groupBy.mockResolvedValue([
        { lessonId: 'lesson-1', _avg: { score: 80 } },
        { lessonId: 'lesson-2', _avg: { score: 90 } },
      ]);

      mockPrisma.exam.findMany.mockResolvedValue([]);
      mockPrisma.examAttempt.groupBy.mockResolvedValue([]);
      mockPrisma.assignmentSubmission.findMany.mockResolvedValue([]);

      const report = await service.getDashboard('inst-1', query());

      expect(report.courseMetrics[0].performance.averageQuizScore).toBe(85);
    });

    it('calculates average exam scores per course', async () => {
      mockPrisma.course.findMany.mockResolvedValue([
        { id: 'course-1', name: 'Course 1' },
      ]);
      mockPrisma.enrollment.findMany.mockResolvedValue([]);
      mockPrisma.courseReview.groupBy.mockResolvedValue([]);
      mockPrisma.courseModule.findMany.mockResolvedValue([]);
      mockPrisma.lesson.findMany.mockResolvedValue([]);
      mockPrisma.quizAttempt.groupBy.mockResolvedValue([]);

      mockPrisma.exam.findMany.mockResolvedValue([
        { id: 'exam-1', courseId: 'course-1' },
      ]);

      // Exam scores: exam-1 avg 75
      mockPrisma.examAttempt.groupBy.mockResolvedValue([
        { examId: 'exam-1', _avg: { score: 75 } },
      ]);

      mockPrisma.assignmentSubmission.findMany.mockResolvedValue([]);

      const report = await service.getDashboard('inst-1', query());

      expect(report.courseMetrics[0].performance.averageExamScore).toBe(75);
    });
  });

  describe('summary metrics', () => {
    it('calculates correct summary totals', async () => {
      mockPrisma.course.findMany.mockResolvedValue([
        { id: 'course-1', name: 'Course 1' },
        { id: 'course-2', name: 'Course 2' },
      ]);

      mockPrisma.enrollment.findMany.mockResolvedValue([
        { courseId: 'course-1', status: 'COMPLETED' },
        { courseId: 'course-1', status: 'ACTIVE' },
        { courseId: 'course-2', status: 'COMPLETED' },
        { courseId: 'course-2', status: 'COMPLETED' },
      ]);

      mockPrisma.courseReview.groupBy.mockResolvedValue([
        { courseId: 'course-1', _avg: { rating: 5 }, _count: { _all: 1 } },
        { courseId: 'course-2', _avg: { rating: 3 }, _count: { _all: 1 } },
      ]);

      mockPrisma.lesson.findMany.mockResolvedValue([]);
      mockPrisma.quizAttempt.groupBy.mockResolvedValue([]);
      mockPrisma.exam.findMany.mockResolvedValue([]);
      mockPrisma.examAttempt.groupBy.mockResolvedValue([]);

      mockPrisma.assignmentSubmission.findMany.mockResolvedValue([
        { status: 'PENDING', assignment: { lessonId: 'lesson-1' } },
        { status: 'PENDING', assignment: { lessonId: 'lesson-1' } },
        { status: 'APPROVED', assignment: { lessonId: 'lesson-2' } },
      ]);

      mockPrisma.courseModule.findMany.mockResolvedValue([
        { id: 'module-1', courseId: 'course-1' },
        { id: 'module-2', courseId: 'course-2' },
      ]);
      mockPrisma.lesson.findMany.mockResolvedValue([
        { id: 'lesson-1', moduleId: 'module-1' },
        { id: 'lesson-2', moduleId: 'module-2' },
      ]);

      const report = await service.getDashboard('inst-1', query());

      expect(report.summary.totalCourses).toBe(2);
      expect(report.summary.totalEnrollments).toBe(4);
      expect(report.summary.averageCompletionRate).toBe(0.75);
      expect(report.summary.averageRating).toBe(4);
      expect(report.summary.totalPendingSubmissions).toBe(2);
    });
  });

  describe('date filtering', () => {
    it('filters enrollments by date range when provided', async () => {
      mockPrisma.course.findMany.mockResolvedValue([
        { id: 'course-1', title: 'Course 1' },
      ]);

      const from = '2026-01-01T00:00:00Z';
      const to = '2026-12-31T23:59:59Z';

      await service.getDashboard('inst-1', query({ from, to }));

      // Verify enrollments were queried with date filter
      expect(mockPrisma.enrollment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            enrolledAt: {
              gte: expect.any(Date),
              lte: expect.any(Date),
            },
          }),
        }),
      );
    });
  });

  describe('response structure', () => {
    it('includes instructor info in response', async () => {
      const report = await service.getDashboard('inst-1', query());

      expect(report.instructor).toEqual({
        id: 'inst-1',
        name: 'Ada Lovelace',
      });
    });

    it('includes period info in response', async () => {
      const from = '2026-01-01T00:00:00Z';
      const to = '2026-12-31T23:59:59Z';

      const report = await service.getDashboard('inst-1', query({ from, to }));

      expect(report.period.from).toBeTruthy();
      expect(report.period.to).toBeTruthy();
    });

    it('includes generatedAt timestamp', async () => {
      const before = new Date();
      const report = await service.getDashboard('inst-1', query());
      const after = new Date();

      const generatedAt = new Date(report.generatedAt);
      expect(generatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(generatedAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });
  });

  describe('controller integration', () => {
    it('calls service with correct parameters from controller', async () => {
      const spy = jest.spyOn(service, 'getDashboard');

      await controller.getDashboard('inst-1', query({ from: '2026-01-01T00:00:00Z' }));

      expect(spy).toHaveBeenCalledWith(
        'inst-1',
        expect.objectContaining({ from: '2026-01-01T00:00:00Z' }),
      );
    });
  });

  describe('edge cases', () => {
    it('handles courses with no enrollments', async () => {
      mockPrisma.course.findMany.mockResolvedValue([
        { id: 'course-1', name: 'Empty Course' },
      ]);
      mockPrisma.enrollment.findMany.mockResolvedValue([]);

      const report = await service.getDashboard('inst-1', query());

      expect(report.courseMetrics[0].enrollments.total).toBe(0);
      expect(report.courseMetrics[0].enrollments.completionRate).toBe(0);
    });

    it('handles courses with no reviews', async () => {
      mockPrisma.course.findMany.mockResolvedValue([
        { id: 'course-1', name: 'Course 1' },
      ]);
      mockPrisma.courseReview.groupBy.mockResolvedValue([]);

      const report = await service.getDashboard('inst-1', query());

      expect(report.courseMetrics[0].ratings.average).toBe(0);
      expect(report.courseMetrics[0].ratings.totalReviews).toBe(0);
    });

    it('handles courses with no quizzes', async () => {
      mockPrisma.course.findMany.mockResolvedValue([
        { id: 'course-1', name: 'Course 1' },
      ]);
      mockPrisma.courseModule.findMany.mockResolvedValue([]);
      mockPrisma.lesson.findMany.mockResolvedValue([]);
      mockPrisma.quizAttempt.groupBy.mockResolvedValue([]);

      const report = await service.getDashboard('inst-1', query());

      expect(report.courseMetrics[0].performance.averageQuizScore).toBeNull();
    });

    it('handles courses with no exams', async () => {
      mockPrisma.course.findMany.mockResolvedValue([
        { id: 'course-1', name: 'Course 1' },
      ]);
      mockPrisma.exam.findMany.mockResolvedValue([]);

      const report = await service.getDashboard('inst-1', query());

      expect(report.courseMetrics[0].performance.averageExamScore).toBeNull();
    });

    it('handles courses with no assignments', async () => {
      mockPrisma.course.findMany.mockResolvedValue([
        { id: 'course-1', name: 'Course 1' },
      ]);
      mockPrisma.assignmentSubmission.findMany.mockResolvedValue([]);

      const report = await service.getDashboard('inst-1', query());

      expect(report.courseMetrics[0].submissions).toEqual({
        pending: 0,
        approved: 0,
        rejected: 0,
      });
    });
  });
});
