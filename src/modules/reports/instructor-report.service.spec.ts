import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../common/prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { InstructorReportController } from './instructor-report.controller';
import { InstructorReportService } from './instructor-report.service';
import { InstructorReportQueryDto } from './dto/instructor-report-query.dto';

describe('InstructorReport (Issue #65)', () => {
  let controller: InstructorReportController;
  let service: InstructorReportService;

  const mockPrisma = {
    user: { findUnique: jest.fn(), count: jest.fn() },
    course: { findMany: jest.fn() },
    enrollment: { findMany: jest.fn(), aggregate: jest.fn(), count: jest.fn() },
    courseReview: { aggregate: jest.fn() },
  };

  const query = (over: Partial<InstructorReportQueryDto> = {}) =>
    Object.assign(new InstructorReportQueryDto(), over);

  const instructorUser = {
    id: 'inst-1',
    name: 'Ada',
    role: 'INSTRUCTOR',
    stellarAddress: 'GABC',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [InstructorReportController],
      providers: [
        InstructorReportService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(InstructorReportController);
    service = module.get(InstructorReportService);

    jest.clearAllMocks();
    // sensible platform-average defaults
    mockPrisma.user.count.mockResolvedValue(4);
    mockPrisma.enrollment.aggregate.mockResolvedValue({
      _sum: { amountPaid: 4000 },
      _count: { _all: 80 },
    });
    mockPrisma.enrollment.count.mockResolvedValue(40);
    mockPrisma.courseReview.aggregate.mockResolvedValue({
      _avg: { rating: 4 },
      _count: { _all: 20 },
    });
    mockPrisma.course.findMany.mockResolvedValue([]);
    mockPrisma.enrollment.findMany.mockResolvedValue([]);
  });

  describe('validation', () => {
    it('404s for an unknown instructor', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(service.getReport('nope', query())).rejects.toThrow(
        NotFoundException,
      );
    });

    it('400s when the user is not an instructor', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        ...instructorUser,
        role: 'STUDENT',
      });
      await expect(service.getReport('inst-1', query())).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects an inverted reporting period', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(instructorUser);
      await expect(
        service.getReport(
          'inst-1',
          query({
            from: '2026-06-01T00:00:00.000Z',
            to: '2026-01-01T00:00:00.000Z',
          }),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('passes the reporting period through to the enrollment query', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(instructorUser);
      mockPrisma.course.findMany.mockResolvedValue([
        { id: 'c1', status: 'ACTIVE', platformFeePercent: 20 },
      ]);
      mockPrisma.courseReview.aggregate.mockResolvedValue({
        _avg: { rating: null },
        _count: { _all: 0 },
      });

      await service.getReport(
        'inst-1',
        query({ from: '2026-01-01T00:00:00.000Z', to: '2026-06-30T00:00:00.000Z' }),
      );

      const call = mockPrisma.enrollment.findMany.mock.calls[0][0];
      expect(call.where.enrolledAt).toEqual({
        gte: new Date('2026-01-01T00:00:00.000Z'),
        lte: new Date('2026-06-30T00:00:00.000Z'),
      });
    });
  });

  describe('rating, revenue & completion aggregates', () => {
    beforeEach(() => {
      mockPrisma.user.findUnique.mockResolvedValue(instructorUser);
      mockPrisma.course.findMany.mockResolvedValue([
        { id: 'c1', status: 'ACTIVE', platformFeePercent: 20 },
        { id: 'c2', status: 'PAUSED', platformFeePercent: 10 },
      ]);
      mockPrisma.enrollment.findMany.mockResolvedValue([
        { courseId: 'c1', status: 'COMPLETED', amountPaid: 100 },
        { courseId: 'c1', status: 'ACTIVE', amountPaid: 100 },
        { courseId: 'c2', status: 'COMPLETED', amountPaid: 50 },
      ]);
      // instructor-scoped review query carries a courseId filter; the
      // platform-average query does not.
      mockPrisma.courseReview.aggregate.mockImplementation((args: any) =>
        Promise.resolve(
          args?.where?.courseId
            ? { _avg: { rating: 4.5 }, _count: { _all: 8 } }
            : { _avg: { rating: 4 }, _count: { _all: 20 } },
        ),
      );
    });

    it('computes per-instructor rating, revenue (with per-course fees) and completion rate', async () => {
      const report = await controller.getReport('inst-1', query());

      expect(report.metrics.courses).toEqual({ total: 2, active: 1 });
      expect(report.metrics.ratings).toEqual({ average: 4.5, totalReviews: 8 });
      expect(report.metrics.students).toEqual({
        enrollments: 3,
        completions: 2,
        completionRate: 0.6667,
      });
      // gross = 250; fees = 100*0.2 + 100*0.2 + 50*0.1 = 45; net = 205
      expect(report.metrics.revenue).toEqual({
        gross: 250,
        platformFees: 45,
        net: 205,
      });
    });

    it('compares the instructor against platform averages', async () => {
      const report = await controller.getReport('inst-1', query());

      // platform: 4 instructors, gross 4000 => 1000/instructor; 80 enrollments => 20/instructor
      expect(report.platformAverages).toEqual(
        expect.objectContaining({
          instructorCount: 4,
          rating: 4,
          completionRate: 0.5,
          grossRevenuePerInstructor: 1000,
          enrollmentsPerInstructor: 20,
        }),
      );

      expect(report.comparison.rating).toEqual(
        expect.objectContaining({
          instructor: 4.5,
          platformAverage: 4,
          delta: 0.5,
          verdict: 'above',
        }),
      );
      expect(report.comparison.grossRevenue).toEqual(
        expect.objectContaining({
          instructor: 250,
          platformAverage: 1000,
          delta: -750,
          verdict: 'below',
        }),
      );
    });
  });

  it('handles an instructor with no courses without dividing by zero', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(instructorUser);
    mockPrisma.course.findMany.mockResolvedValue([]);
    mockPrisma.courseReview.aggregate.mockResolvedValue({
      _avg: { rating: null },
      _count: { _all: 0 },
    });

    const report = await service.getReport('inst-1', query());

    expect(report.metrics.students.completionRate).toBe(0);
    expect(report.metrics.revenue).toEqual({ gross: 0, platformFees: 0, net: 0 });
    expect(report.metrics.ratings.average).toBe(0);
  });
});
