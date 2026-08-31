import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  EngagementReportQueryDto,
  EngagementScope,
} from './dto/engagement-report-query.dto';

/** Cap on the number of student ids echoed back in the inactivity list. */
const INACTIVE_LIST_LIMIT = 100;

interface ResolvedPeriod {
  from: Date | null;
  to: Date | null;
}

export interface EngagementReport {
  scope: EngagementScope;
  studentId?: string;
  courseId?: string;
  period: { from: string | null; to: string | null };
  generatedAt: string;
  summary: {
    students: number;
    enrollments: number;
    completedEnrollments: number;
    courseCompletionRate: number;
    avgProgressPercent: number;
    watchTime: {
      totalSeconds: number;
      totalHours: number;
      avgSecondsPerStudent: number;
    };
    lessons: {
      started: number;
      completed: number;
      completionRate: number;
    };
    streaks: {
      avgCurrentStreak: number;
      longestStreak: number;
    };
    inactivity: {
      thresholdDays: number;
      inactiveStudents: number;
      inactiveRate: number;
      studentIds: string[];
      truncated: boolean;
    };
  };
}

@Injectable()
export class EngagementReportService {
  constructor(private readonly prisma: PrismaService) {}

  async getReport(dto: EngagementReportQueryDto): Promise<EngagementReport> {
    const scope = dto.scope ?? EngagementScope.PLATFORM;
    await this.validateScope(scope, dto);
    const period = this.resolvePeriod(dto);
    const thresholdDays = dto.inactiveDays ?? 14;

    const enrollmentWhere = this.buildEnrollmentWhere(scope, dto, period);
    const enrollments = await this.prisma.enrollment.findMany({
      where: enrollmentWhere,
      select: {
        id: true,
        studentId: true,
        status: true,
        progressPercent: true,
        updatedAt: true,
        enrolledAt: true,
      },
    });

    const enrollmentIds = enrollments.map((e) => e.id);
    const studentIds = [...new Set(enrollments.map((e) => e.studentId))];

    const [watchAgg, lessonsCompleted, lastActivityByEnrollment, points] =
      await Promise.all([
        this.prisma.lessonProgress.aggregate({
          where: this.lessonProgressWhere(enrollmentIds, period),
          _sum: { watchedSecs: true },
          _count: { _all: true },
        }),
        this.prisma.lessonProgress.count({
          where: {
            ...this.lessonProgressWhere(enrollmentIds, period),
            completed: true,
          },
        }),
        enrollmentIds.length
          ? this.prisma.lessonProgress.groupBy({
              by: ['enrollmentId'],
              where: { enrollmentId: { in: enrollmentIds } },
              _max: { updatedAt: true },
            })
          : Promise.resolve(
              [] as Array<{
                enrollmentId: string;
                _max: { updatedAt: Date | null };
              }>,
            ),
        studentIds.length
          ? this.prisma.userPoints.findMany({
              where: { userId: { in: studentIds } },
              select: {
                userId: true,
                currentStreak: true,
                longestStreak: true,
              },
            })
          : Promise.resolve(
              [] as Array<{
                userId: string;
                currentStreak: number;
                longestStreak: number;
              }>,
            ),
      ]);

    const lessonsStarted = watchAgg._count._all;
    const totalWatchSeconds = watchAgg._sum.watchedSecs ?? 0;
    const completedEnrollments = enrollments.filter(
      (e) => e.status === 'COMPLETED',
    ).length;

    const avgProgressPercent = enrollments.length
      ? this.round(
          enrollments.reduce((sum, e) => sum + e.progressPercent, 0) /
            enrollments.length,
        )
      : 0;

    const avgCurrentStreak = points.length
      ? this.round(
          points.reduce((sum, p) => sum + p.currentStreak, 0) / points.length,
        )
      : 0;
    const longestStreak = points.reduce(
      (max, p) => Math.max(max, p.longestStreak),
      0,
    );

    const inactivity = this.computeInactivity(
      enrollments,
      lastActivityByEnrollment,
      studentIds,
      thresholdDays,
    );

    return {
      scope,
      ...(scope === EngagementScope.STUDENT ? { studentId: dto.studentId } : {}),
      ...(scope === EngagementScope.COURSE ? { courseId: dto.courseId } : {}),
      period: {
        from: period.from ? period.from.toISOString() : null,
        to: period.to ? period.to.toISOString() : null,
      },
      generatedAt: new Date().toISOString(),
      summary: {
        students: studentIds.length,
        enrollments: enrollments.length,
        completedEnrollments,
        courseCompletionRate: this.rate(completedEnrollments, enrollments.length),
        avgProgressPercent,
        watchTime: {
          totalSeconds: totalWatchSeconds,
          totalHours: this.round(totalWatchSeconds / 3600),
          avgSecondsPerStudent: studentIds.length
            ? this.round(totalWatchSeconds / studentIds.length)
            : 0,
        },
        lessons: {
          started: lessonsStarted,
          completed: lessonsCompleted,
          completionRate: this.rate(lessonsCompleted, lessonsStarted),
        },
        streaks: {
          avgCurrentStreak,
          longestStreak,
        },
        inactivity: {
          thresholdDays,
          inactiveStudents: inactivity.count,
          inactiveRate: this.rate(inactivity.count, studentIds.length),
          studentIds: inactivity.ids.slice(0, INACTIVE_LIST_LIMIT),
          truncated: inactivity.ids.length > INACTIVE_LIST_LIMIT,
        },
      },
    };
  }

  // ----------------------------------------------------------
  // VALIDATION
  // ----------------------------------------------------------

  private async validateScope(
    scope: EngagementScope,
    dto: EngagementReportQueryDto,
  ) {
    if (scope === EngagementScope.STUDENT) {
      if (!dto.studentId) {
        throw new BadRequestException('studentId is required when scope=STUDENT');
      }
      const student = await this.prisma.user.findUnique({
        where: { id: dto.studentId },
        select: { id: true },
      });
      if (!student) throw new NotFoundException('Student not found');
    }

    if (scope === EngagementScope.COURSE) {
      if (!dto.courseId) {
        throw new BadRequestException('courseId is required when scope=COURSE');
      }
      const course = await this.prisma.course.findUnique({
        where: { id: dto.courseId },
        select: { id: true },
      });
      if (!course) throw new NotFoundException('Course not found');
    }
  }

  private resolvePeriod(dto: EngagementReportQueryDto): ResolvedPeriod {
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

  // ----------------------------------------------------------
  // QUERY BUILDERS
  // ----------------------------------------------------------

  private buildEnrollmentWhere(
    scope: EngagementScope,
    dto: EngagementReportQueryDto,
    period: ResolvedPeriod,
  ): Prisma.EnrollmentWhereInput {
    const where: Prisma.EnrollmentWhereInput = {};
    if (scope === EngagementScope.STUDENT) where.studentId = dto.studentId;
    if (scope === EngagementScope.COURSE) where.courseId = dto.courseId;

    if (period.from || period.to) {
      where.enrolledAt = {};
      if (period.from) where.enrolledAt.gte = period.from;
      if (period.to) where.enrolledAt.lte = period.to;
    }
    return where;
  }

  private lessonProgressWhere(
    enrollmentIds: string[],
    period: ResolvedPeriod,
  ): Prisma.LessonProgressWhereInput {
    const where: Prisma.LessonProgressWhereInput = {
      enrollmentId: { in: enrollmentIds },
    };
    if (period.from || period.to) {
      where.updatedAt = {};
      if (period.from) where.updatedAt.gte = period.from;
      if (period.to) where.updatedAt.lte = period.to;
    }
    return where;
  }

  // ----------------------------------------------------------
  // INACTIVITY FLAGGING
  // ----------------------------------------------------------

  private computeInactivity(
    enrollments: Array<{ studentId: string; id: string; updatedAt: Date }>,
    lastActivityByEnrollment: Array<{
      enrollmentId: string;
      _max: { updatedAt: Date | null };
    }>,
    studentIds: string[],
    thresholdDays: number,
  ): { count: number; ids: string[] } {
    const cutoff = new Date(Date.now() - thresholdDays * 24 * 60 * 60 * 1000);

    const progressByEnrollment = new Map<string, Date>();
    for (const row of lastActivityByEnrollment) {
      if (row._max.updatedAt) {
        progressByEnrollment.set(row.enrollmentId, row._max.updatedAt);
      }
    }

    // Roll enrollment-level activity up to the student.
    const lastActivityByStudent = new Map<string, Date>();
    for (const enrollment of enrollments) {
      const candidates = [enrollment.updatedAt];
      const progress = progressByEnrollment.get(enrollment.id);
      if (progress) candidates.push(progress);
      const latest = candidates.reduce((a, b) => (a > b ? a : b));

      const current = lastActivityByStudent.get(enrollment.studentId);
      if (!current || latest > current) {
        lastActivityByStudent.set(enrollment.studentId, latest);
      }
    }

    const inactive = studentIds.filter((id) => {
      const last = lastActivityByStudent.get(id);
      return !last || last < cutoff;
    });

    return { count: inactive.length, ids: inactive };
  }

  // ----------------------------------------------------------
  // HELPERS
  // ----------------------------------------------------------

  private round(value: number): number {
    return Math.round(value * 100) / 100;
  }

  /** Ratio in the 0–1 range, rounded to 4 dp. 0 when the denominator is 0. */
  private rate(numerator: number, denominator: number): number {
    if (!denominator) return 0;
    return Math.round((numerator / denominator) * 10000) / 10000;
  }
}
