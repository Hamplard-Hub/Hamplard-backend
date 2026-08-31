// revenue-report.service.ts — issue #62: platform + per-instructor revenue reports
import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RevenueReportQueryDto } from './dto/revenue-report-query.dto';
import { EnrollmentStatus } from '@prisma/client';

interface CourseBucket {
  courseId: string;
  courseTitle: string;
  instructorAddress: string;
  instructorId: string | null;
  instructorName: string | null;
  enrollmentCount: number;
  grossRevenue: number;
  platformFee: number;
  instructorNet: number;
}

interface InstructorBucket {
  instructorAddress: string;
  instructorId: string | null;
  instructorName: string | null;
  courseCount: number;
  enrollmentCount: number;
  grossRevenue: number;
  platformFee: number;
  instructorNet: number;
}

const CURRENCY = 'USDC';

@Injectable()
export class RevenueReportService {
  constructor(private readonly prisma: PrismaService) {}

  async generate(query: RevenueReportQueryDto) {
    const { startDate, endDate, instructorId, courseId, format } = query;
    this.validatePeriod(startDate, endDate);

    let instructorAddress: string | undefined;
    if (instructorId) {
      const instructor = await this.prisma.user.findUnique({ where: { id: instructorId } });
      if (!instructor || !instructor.stellarAddress) {
        throw new NotFoundException('Instructor not found');
      }
      instructorAddress = instructor.stellarAddress;
    }

    if (courseId) {
      const course = await this.prisma.course.findUnique({ where: { id: courseId } });
      if (!course) throw new NotFoundException('Course not found');
    }

    const where: any = {
      status: { not: EnrollmentStatus.REFUNDED },
    };
    if (startDate && endDate) {
      where.enrolledAt = { gte: new Date(startDate), lte: new Date(endDate) };
    }
    if (courseId) where.courseId = courseId;
    if (instructorAddress) where.course = { instructorAddress };

    const enrollments = await this.prisma.enrollment.findMany({
      where,
      select: {
        amountPaid: true,
        course: {
          select: {
            id: true,
            title: true,
            instructorAddress: true,
            platformFeePercent: true,
            instructor: { select: { id: true, name: true } },
          },
        },
      },
    });

    const byCourse = new Map<string, CourseBucket>();
    const byInstructor = new Map<string, InstructorBucket>();

    for (const enrollment of enrollments) {
      const { course } = enrollment;
      const amount = Number(enrollment.amountPaid);
      const fee = amount * (course.platformFeePercent / 100);
      const net = amount - fee;

      const courseBucket = byCourse.get(course.id) ?? {
        courseId: course.id,
        courseTitle: course.title,
        instructorAddress: course.instructorAddress,
        instructorId: course.instructor?.id ?? null,
        instructorName: course.instructor?.name ?? null,
        enrollmentCount: 0,
        grossRevenue: 0,
        platformFee: 0,
        instructorNet: 0,
      };
      courseBucket.enrollmentCount += 1;
      courseBucket.grossRevenue += amount;
      courseBucket.platformFee += fee;
      courseBucket.instructorNet += net;
      byCourse.set(course.id, courseBucket);

      const instructorBucket = byInstructor.get(course.instructorAddress) ?? {
        instructorAddress: course.instructorAddress,
        instructorId: course.instructor?.id ?? null,
        instructorName: course.instructor?.name ?? null,
        courseCount: 0,
        enrollmentCount: 0,
        grossRevenue: 0,
        platformFee: 0,
        instructorNet: 0,
      };
      instructorBucket.enrollmentCount += 1;
      instructorBucket.grossRevenue += amount;
      instructorBucket.platformFee += fee;
      instructorBucket.instructorNet += net;
      byInstructor.set(course.instructorAddress, instructorBucket);
    }

    // courseCount per instructor — computed once buckets are complete
    const coursesPerInstructor = new Map<string, Set<string>>();
    for (const bucket of byCourse.values()) {
      const set = coursesPerInstructor.get(bucket.instructorAddress) ?? new Set<string>();
      set.add(bucket.courseId);
      coursesPerInstructor.set(bucket.instructorAddress, set);
    }
    for (const [address, bucket] of byInstructor) {
      bucket.courseCount = coursesPerInstructor.get(address)?.size ?? 0;
    }

    const courseRows = [...byCourse.values()].map((b) => this.normalizeBucket(b));
    const instructorRows = [...byInstructor.values()].map((b) => this.normalizeBucket(b));

    const platformTotals = courseRows.reduce(
      (acc, row) => ({
        enrollmentCount: acc.enrollmentCount + row.enrollmentCount,
        grossRevenue: this.round(acc.grossRevenue + row.grossRevenue),
        platformFee: this.round(acc.platformFee + row.platformFee),
        instructorNet: this.round(acc.instructorNet + row.instructorNet),
      }),
      { enrollmentCount: 0, grossRevenue: 0, platformFee: 0, instructorNet: 0 },
    );

    const report = {
      period: { startDate: startDate ?? null, endDate: endDate ?? null },
      generatedAt: new Date(),
      currency: CURRENCY,
      platformTotals,
      byInstructor: instructorRows,
      byCourse: courseRows,
      rows: courseRows,
    };

    return format === 'csv' ? { ...report, csv: this.toCsv(courseRows) } : report;
  }

  private validatePeriod(startDate?: string, endDate?: string): void {
    if (!startDate && !endDate) return;
    if (!startDate || !endDate) {
      throw new BadRequestException('Both startDate and endDate must be provided together');
    }

    const start = new Date(startDate);
    const end = new Date(endDate);

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new BadRequestException('startDate and endDate must be valid ISO date strings');
    }
    if (start > end) {
      throw new BadRequestException('startDate must be before or equal to endDate');
    }
    if (end.getTime() > Date.now()) {
      throw new BadRequestException('endDate cannot be in the future');
    }
  }

  /** Currency normalization — every monetary total is rounded to 2 decimal places of USDC. */
  private round(value: number): number {
    return Math.round(value * 100) / 100;
  }

  private normalizeBucket<T extends { grossRevenue: number; platformFee: number; instructorNet: number }>(
    bucket: T,
  ): T {
    return {
      ...bucket,
      grossRevenue: this.round(bucket.grossRevenue),
      platformFee: this.round(bucket.platformFee),
      instructorNet: this.round(bucket.instructorNet),
    };
  }

  private toCsv(rows: CourseBucket[]): string {
    const headers = [
      'courseId', 'courseTitle', 'instructorName', 'instructorAddress',
      'enrollmentCount', 'grossRevenue', 'platformFee', 'instructorNet',
    ];
    const escape = (value: unknown) => {
      const str = String(value ?? '');
      return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };
    const lines = rows.map((r) =>
      [
        r.courseId, r.courseTitle, r.instructorName, r.instructorAddress,
        r.enrollmentCount, r.grossRevenue, r.platformFee, r.instructorNet,
      ].map(escape).join(','),
    );
    return [headers.join(','), ...lines].join('\n');
  }
}
