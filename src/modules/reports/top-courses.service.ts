// top-courses.service.ts
import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EnrollmentStatus } from '@prisma/client';
import {
  TopCoursesMetric,
  TopCoursesWindow,
  TopCoursesQueryDto,
} from './dto/top-courses-query.dto';

interface RankedCourse {
  courseId: string;
  metricValue: number;
}

const WINDOW_DAYS: Record<TopCoursesWindow, number | null> = {
  [TopCoursesWindow.LAST_7_DAYS]: 7,
  [TopCoursesWindow.LAST_30_DAYS]: 30,
  [TopCoursesWindow.LAST_90_DAYS]: 90,
  [TopCoursesWindow.ALL_TIME]: null,
};

@Injectable()
export class TopCoursesService {
  constructor(private readonly prisma: PrismaService) {}

  async getTopCourses(query: TopCoursesQueryDto) {
    const metric = query.metric ?? TopCoursesMetric.ENROLLMENTS;
    const window = query.window ?? TopCoursesWindow.ALL_TIME;
    const limit = query.limit ?? 10;

    if (!Object.values(TopCoursesMetric).includes(metric)) {
      throw new BadRequestException(`Invalid ranking metric: ${metric}`);
    }
    if (!Object.values(TopCoursesWindow).includes(window)) {
      throw new BadRequestException(`Invalid time window: ${window}`);
    }

    const since = this.resolveWindowStart(window);

    let ranked: RankedCourse[];
    switch (metric) {
      case TopCoursesMetric.REVENUE:
        ranked = await this.rankByRevenue(since, limit);
        break;
      case TopCoursesMetric.COMPLETION_RATE:
        ranked = await this.rankByCompletionRate(since, limit);
        break;
      case TopCoursesMetric.ENROLLMENTS:
      default:
        ranked = await this.rankByEnrollments(since, limit);
        break;
    }

    const courses = await this.prisma.course.findMany({
      where: { id: { in: ranked.map((r) => r.courseId) } },
      select: {
        id: true,
        title: true,
        category: true,
        level: true,
        instructorAddress: true,
        price: true,
        status: true,
        thumbnailUrl: true,
      },
    });
    const courseMap = new Map(courses.map((c) => [c.id, c]));

    const data = ranked
      .filter((r) => courseMap.has(r.courseId))
      .map((r, index) => ({
        rank: index + 1,
        course: courseMap.get(r.courseId),
        metric,
        metricValue: r.metricValue,
      }));

    return { metric, window, limit, data };
  }

  private resolveWindowStart(window: TopCoursesWindow): Date | undefined {
    const days = WINDOW_DAYS[window];
    if (days === null || days === undefined) return undefined;
    const since = new Date();
    since.setDate(since.getDate() - days);
    return since;
  }

  private async rankByEnrollments(since: Date | undefined, limit: number): Promise<RankedCourse[]> {
    const grouped = await (this.prisma.enrollment as any).groupBy({
      by: ['courseId'],
      where: {
        status: { not: EnrollmentStatus.REFUNDED },
        ...(since ? { enrolledAt: { gte: since } } : {}),
      },
      _count: { _all: true },
      orderBy: { _count: { _all: 'desc' } },
      take: limit,
    });

    return grouped.map((g: any) => ({ courseId: g.courseId, metricValue: g._count._all }));
  }

  private async rankByRevenue(since: Date | undefined, limit: number): Promise<RankedCourse[]> {
    const grouped = await (this.prisma.enrollment as any).groupBy({
      by: ['courseId'],
      where: {
        status: { not: EnrollmentStatus.REFUNDED },
        ...(since ? { enrolledAt: { gte: since } } : {}),
      },
      _sum: { amountPaid: true },
      orderBy: { _sum: { amountPaid: 'desc' } },
      take: limit,
    });

    return grouped.map((g: any) => ({
      courseId: g.courseId,
      metricValue: Number(g._sum.amountPaid ?? 0),
    }));
  }

  private async rankByCompletionRate(since: Date | undefined, limit: number): Promise<RankedCourse[]> {
    const grouped = await (this.prisma.enrollment as any).groupBy({
      by: ['courseId', 'status'],
      where: {
        status: { not: EnrollmentStatus.REFUNDED },
        ...(since ? { enrolledAt: { gte: since } } : {}),
      },
      _count: { _all: true },
    });

    const totals = new Map<string, { total: number; completed: number }>();
    for (const g of grouped as any[]) {
      const entry = totals.get(g.courseId) ?? { total: 0, completed: 0 };
      entry.total += g._count._all;
      if (g.status === EnrollmentStatus.COMPLETED) entry.completed += g._count._all;
      totals.set(g.courseId, entry);
    }

    return Array.from(totals.entries())
      .map(([courseId, { total, completed }]) => ({
        courseId,
        metricValue: total > 0 ? Math.round((completed / total) * 10000) / 100 : 0,
      }))
      .sort((a, b) => b.metricValue - a.metricValue)
      .slice(0, limit);
  }
}
