// revenue-report.service.ts — issue #62: platform + per-instructor revenue reports
import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RevenueReportQueryDto } from './dto/revenue-report-query.dto';
import { EnrollmentStatus, Prisma } from '@prisma/client';

export interface CourseBucket {
  courseId: string;
  courseTitle: string;
  instructorAddress: string;
  instructorId: string | null;
  instructorName: string | null;
  enrollmentCount: number;
  grossRevenue: number;
  taxAmount: number;
  platformFee: number;
  instructorNet: number;
}

export interface InstructorBucket {
  instructorAddress: string;
  instructorId: string | null;
  instructorName: string | null;
  courseCount: number;
  enrollmentCount: number;
  grossRevenue: number;
  taxAmount: number;
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

    // Issue #332: aggregate the pricing snapshot stored on each enrollment
    // (platform fee + tax captured at purchase time). Rows created before the
    // snapshot existed fall back to the enrollment's fee percent.
    const filters = Prisma.sql`
      WHERE e."status" != 'REFUNDED'
        ${courseId ? Prisma.sql`AND e."courseId" = ${courseId}` : Prisma.empty}
        ${instructorAddress ? Prisma.sql`AND c."instructorAddress" = ${instructorAddress}` : Prisma.empty}
        ${startDate && endDate
          ? Prisma.sql`AND e."enrolledAt" BETWEEN ${new Date(startDate)} AND ${new Date(endDate)}`
          : Prisma.empty}
    `;
    const platformFeeExpr = Prisma.sql`COALESCE(
      e."platformFeeAmount",
      (e."amountPaid" - e."taxAmount") * e."platformFeePercent" / 100
    )`;
    const aggregates = Prisma.sql`
        COUNT(e.id)::int AS "enrollmentCount",
        SUM(e."amountPaid")::decimal(20,2) AS "grossRevenue",
        SUM(e."taxAmount")::decimal(20,2) AS "taxAmount",
        SUM(${platformFeeExpr})::decimal(20,2) AS "platformFee",
        SUM(e."amountPaid" - e."taxAmount" - ${platformFeeExpr})::decimal(20,2) AS "instructorNet"
    `;

    const courseRows = await this.prisma.$queryRaw<CourseBucket[]>`
      SELECT
        c.id AS "courseId",
        c.title AS "courseTitle",
        c."instructorAddress",
        u.id AS "instructorId",
        u.name AS "instructorName",
        ${aggregates}
      FROM "enrollments" e
      JOIN "courses" c ON e."courseId" = c.id
      LEFT JOIN "users" u ON c."instructorAddress" = u."stellarAddress"
      ${filters}
      GROUP BY c.id, c.title, c."instructorAddress", u.id, u.name
      ORDER BY "grossRevenue" DESC
    `;

    // Get instructor-level aggregation
    const instructorRows = await this.prisma.$queryRaw<InstructorBucket[]>`
      SELECT
        c."instructorAddress",
        u.id AS "instructorId",
        u.name AS "instructorName",
        COUNT(DISTINCT c.id)::int AS "courseCount",
        ${aggregates}
      FROM "enrollments" e
      JOIN "courses" c ON e."courseId" = c.id
      LEFT JOIN "users" u ON c."instructorAddress" = u."stellarAddress"
      ${filters}
      GROUP BY c."instructorAddress", u.id, u.name
      ORDER BY "grossRevenue" DESC
    `;

    const normalizedCourseRows = courseRows.map(b => this.normalizeBucket(b));
    const normalizedInstructorRows = instructorRows.map(b => this.normalizeBucket(b));

    const platformTotals = normalizedCourseRows.reduce(
      (acc, row) => ({
        enrollmentCount: acc.enrollmentCount + row.enrollmentCount,
        grossRevenue: this.round(acc.grossRevenue + Number(row.grossRevenue)),
        taxAmount: this.round(acc.taxAmount + Number(row.taxAmount)),
        platformFee: this.round(acc.platformFee + Number(row.platformFee)),
        instructorNet: this.round(acc.instructorNet + Number(row.instructorNet)),
      }),
      { enrollmentCount: 0, grossRevenue: 0, taxAmount: 0, platformFee: 0, instructorNet: 0 },
    );

    const report = {
      period: { startDate: startDate ?? null, endDate: endDate ?? null },
      generatedAt: new Date(),
      currency: CURRENCY,
      platformTotals,
      byInstructor: normalizedInstructorRows,
      byCourse: normalizedCourseRows,
      rows: normalizedCourseRows,
    };

    return format === 'csv' ? { ...report, csv: this.toCsv(normalizedCourseRows) } : report;
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

  private normalizeBucket<
    T extends { grossRevenue: number; taxAmount: number; platformFee: number; instructorNet: number },
  >(bucket: T): T {
    return {
      ...bucket,
      grossRevenue: this.round(Number(bucket.grossRevenue)),
      taxAmount: this.round(Number(bucket.taxAmount ?? 0)),
      platformFee: this.round(Number(bucket.platformFee)),
      instructorNet: this.round(Number(bucket.instructorNet)),
    };
  }

  private toCsv(rows: CourseBucket[]): string {
    const headers = [
      'courseId', 'courseTitle', 'instructorName', 'instructorAddress',
      'enrollmentCount', 'grossRevenue', 'taxAmount', 'platformFee', 'instructorNet',
    ];
    const escape = (value: unknown) => {
      const str = String(value ?? '');
      return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };
    const lines = rows.map((r) =>
      [
        r.courseId, r.courseTitle, r.instructorName, r.instructorAddress,
        r.enrollmentCount, r.grossRevenue, r.taxAmount, r.platformFee, r.instructorNet,
      ].map(escape).join(','),
    );
    return [headers.join(','), ...lines].join('\n');
  }
}
