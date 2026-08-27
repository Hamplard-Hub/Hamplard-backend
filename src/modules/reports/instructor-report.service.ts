import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { InstructorReportQueryDto } from './dto/instructor-report-query.dto';

interface ResolvedPeriod {
  from: Date | null;
  to: Date | null;
}

export interface InstructorPerformanceReport {
  instructor: { id: string; name: string | null; stellarAddress: string | null };
  period: { from: string | null; to: string | null };
  generatedAt: string;
  metrics: {
    courses: { total: number; active: number };
    ratings: { average: number; totalReviews: number };
    students: { enrollments: number; completions: number; completionRate: number };
    revenue: { gross: number; platformFees: number; net: number };
  };
  platformAverages: {
    instructorCount: number;
    rating: number;
    completionRate: number;
    grossRevenuePerInstructor: number;
    enrollmentsPerInstructor: number;
  };
  comparison: {
    rating: ComparisonPoint;
    completionRate: ComparisonPoint;
    grossRevenue: ComparisonPoint;
    enrollments: ComparisonPoint;
  };
}

interface ComparisonPoint {
  instructor: number;
  platformAverage: number;
  delta: number;
  /** Percent difference vs the platform average; null when the average is 0. */
  percentDiff: number | null;
  verdict: 'above' | 'below' | 'on_par';
}

@Injectable()
export class InstructorReportService {
  constructor(private readonly prisma: PrismaService) {}

  async getReport(
    instructorId: string,
    dto: InstructorReportQueryDto,
  ): Promise<InstructorPerformanceReport> {
    const instructor = await this.prisma.user.findUnique({
      where: { id: instructorId },
      select: { id: true, name: true, role: true, stellarAddress: true },
    });
    if (!instructor) throw new NotFoundException('Instructor not found');
    if (instructor.role !== 'INSTRUCTOR') {
      throw new BadRequestException('User is not an instructor');
    }

    const period = this.resolvePeriod(dto);

    const courses = await this.prisma.course.findMany({
      where: { instructorAddress: instructor.stellarAddress ?? '__none__' },
      select: { id: true, status: true, platformFeePercent: true },
    });
    const courseIds = courses.map((c) => c.id);
    const feeByCourse = new Map(
      courses.map((c) => [c.id, c.platformFeePercent] as const),
    );

    const [enrollments, reviewAgg, platform] = await Promise.all([
      this.prisma.enrollment.findMany({
        where: {
          courseId: { in: courseIds },
          ...this.dateFilter('enrolledAt', period),
        },
        select: { courseId: true, status: true, amountPaid: true },
      }),
      this.prisma.courseReview.aggregate({
        where: {
          courseId: { in: courseIds },
          ...this.dateFilter('createdAt', period),
        },
        _avg: { rating: true },
        _count: { _all: true },
      }),
      this.computePlatformAverages(period),
    ]);

    const gross = enrollments.reduce(
      (sum, e) => sum + this.toNumber(e.amountPaid),
      0,
    );
    const platformFees = enrollments.reduce((sum, e) => {
      const feePercent = feeByCourse.get(e.courseId) ?? 0;
      return sum + (this.toNumber(e.amountPaid) * feePercent) / 100;
    }, 0);
    const completions = enrollments.filter((e) => e.status === 'COMPLETED').length;

    const metrics = {
      courses: {
        total: courses.length,
        active: courses.filter((c) => c.status === 'ACTIVE').length,
      },
      ratings: {
        average: this.round(reviewAgg._avg.rating ?? 0),
        totalReviews: reviewAgg._count._all,
      },
      students: {
        enrollments: enrollments.length,
        completions,
        completionRate: this.rate(completions, enrollments.length),
      },
      revenue: {
        gross: this.round(gross),
        platformFees: this.round(platformFees),
        net: this.round(gross - platformFees),
      },
    };

    return {
      instructor: {
        id: instructor.id,
        name: instructor.name,
        stellarAddress: instructor.stellarAddress,
      },
      period: {
        from: period.from ? period.from.toISOString() : null,
        to: period.to ? period.to.toISOString() : null,
      },
      generatedAt: new Date().toISOString(),
      metrics,
      platformAverages: platform,
      comparison: {
        rating: this.compare(metrics.ratings.average, platform.rating),
        completionRate: this.compare(
          metrics.students.completionRate,
          platform.completionRate,
        ),
        grossRevenue: this.compare(
          metrics.revenue.gross,
          platform.grossRevenuePerInstructor,
        ),
        enrollments: this.compare(
          metrics.students.enrollments,
          platform.enrollmentsPerInstructor,
        ),
      },
    };
  }

  // ----------------------------------------------------------
  // PLATFORM AVERAGES
  // ----------------------------------------------------------

  private async computePlatformAverages(period: ResolvedPeriod) {
    const [instructorCount, enrollmentAgg, completedCount, reviewAgg] =
      await Promise.all([
        this.prisma.user.count({ where: { role: 'INSTRUCTOR' } }),
        this.prisma.enrollment.aggregate({
          where: this.dateFilter('enrolledAt', period),
          _sum: { amountPaid: true },
          _count: { _all: true },
        }),
        this.prisma.enrollment.count({
          where: { status: 'COMPLETED', ...this.dateFilter('enrolledAt', period) },
        }),
        this.prisma.courseReview.aggregate({
          where: this.dateFilter('createdAt', period),
          _avg: { rating: true },
        }),
      ]);

    const totalEnrollments = enrollmentAgg._count._all;
    const gross = this.toNumber(enrollmentAgg._sum.amountPaid);
    const divisor = instructorCount || 1;

    return {
      instructorCount,
      rating: this.round(reviewAgg._avg.rating ?? 0),
      completionRate: this.rate(completedCount, totalEnrollments),
      grossRevenuePerInstructor: this.round(gross / divisor),
      enrollmentsPerInstructor: this.round(totalEnrollments / divisor),
    };
  }

  // ----------------------------------------------------------
  // HELPERS
  // ----------------------------------------------------------

  private resolvePeriod(dto: InstructorReportQueryDto): ResolvedPeriod {
    const from = dto.from ? new Date(dto.from) : null;
    const to = dto.to ? new Date(dto.to) : null;

    if (from && Number.isNaN(from.getTime())) {
      throw new BadRequestException('from is not a valid date');
    }
    if (to && Number.isNaN(to.getTime())) {
      throw new BadRequestException('to is not a valid date');
    }
    if (from && to && from > to) {
      throw new BadRequestException('from must be on or before to');
    }
    return { from, to };
  }

  private dateFilter(
    field: 'enrolledAt' | 'createdAt',
    period: ResolvedPeriod,
  ): Record<string, Prisma.DateTimeFilter> | Record<string, never> {
    if (!period.from && !period.to) return {};
    const range: Prisma.DateTimeFilter = {};
    if (period.from) range.gte = period.from;
    if (period.to) range.lte = period.to;
    return { [field]: range };
  }

  private compare(instructor: number, platformAverage: number): ComparisonPoint {
    const delta = this.round(instructor - platformAverage);
    const percentDiff =
      platformAverage === 0
        ? null
        : this.round((delta / platformAverage) * 100);
    let verdict: ComparisonPoint['verdict'] = 'on_par';
    if (delta > 0) verdict = 'above';
    else if (delta < 0) verdict = 'below';
    return { instructor, platformAverage, delta, percentDiff, verdict };
  }

  private toNumber(value: Prisma.Decimal | number | null | undefined): number {
    if (value === null || value === undefined) return 0;
    return typeof value === 'number' ? value : Number(value);
  }

  private round(value: number): number {
    return Math.round(value * 100) / 100;
  }

  private rate(numerator: number, denominator: number): number {
    if (!denominator) return 0;
    return Math.round((numerator / denominator) * 10000) / 10000;
  }
}
