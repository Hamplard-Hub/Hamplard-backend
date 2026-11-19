import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CourseStatus } from '@prisma/client';
import { CacheService } from '../../common/cache/cache.service';

/** Cache namespace + TTL for recommendation results (5 minutes). */
export const RECOMMENDATIONS_CACHE_NAMESPACE = 'courses:recommendations';
export const RECOMMENDATIONS_CACHE_TTL_SECONDS = 300;

export interface RecommendedCourseItem {
  id: string;
  title: string;
  category: string;
  level: string;
  price: any;
  avgRating: number;
  totalEnrollments: number;
  thumbnailUrl?: string | null;
  matchReason: 'co_enrollment' | 'category_fallback';
  score?: number;
}

@Injectable()
export class RecommendationsService {
  private readonly logger = new Logger(RecommendationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async getRecommendations(courseId: string, limit: number = 5): Promise<RecommendedCourseItem[]> {
    const effectiveLimit = limit > 0 && limit <= 20 ? limit : 5;

    const cacheKey = this.cache.buildKey(RECOMMENDATIONS_CACHE_NAMESPACE, {
      courseId,
      limit: effectiveLimit,
    });
    const cached = await this.cache.get<RecommendedCourseItem[]>(cacheKey);
    if (cached) return cached;

    const recommendations = await this.computeRecommendations(courseId, effectiveLimit);
    await this.cache.set(cacheKey, recommendations, RECOMMENDATIONS_CACHE_TTL_SECONDS);
    return recommendations;
  }

  /**
   * Runs at most 4 queries regardless of how many enrollments exist:
   *   1. target course lookup
   *   2. one aggregate (groupBy courseId, filtered by a subquery on the target's enrollments)
   *   3. one fetch of the (<= limit) winning course rows
   *   4. optional category fallback
   */
  private async computeRecommendations(
    courseId: string,
    effectiveLimit: number,
  ): Promise<RecommendedCourseItem[]> {
    const targetCourse = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: { id: true, category: true, status: true },
    });

    if (!targetCourse) {
      throw new NotFoundException(`Course with ID ${courseId} not found`);
    }

    const recommendations: RecommendedCourseItem[] = [];
    const addedCourseIds = new Set<string>([targetCourse.id]);

    // 1. Co-enrollment recommendation logic.
    // The relation filter on `student` is compiled by Prisma into a SQL subquery
    // (students enrolled in the target course); no student IDs are loaded into memory.
    const coEnrollmentCounts = await this.prisma.enrollment.groupBy({
      by: ['courseId'],
      where: {
        courseId: { not: targetCourse.id },
        course: { status: CourseStatus.ACTIVE },
        student: { enrollments: { some: { courseId: targetCourse.id } } },
      },
      _count: { courseId: true },
      // courseId is a deterministic tie-breaker so equal counts are stably ordered.
      orderBy: [{ _count: { courseId: 'desc' } }, { courseId: 'asc' }],
      take: effectiveLimit,
    });

    if (coEnrollmentCounts.length > 0) {
      const coursesById = new Map(
        (
          await this.prisma.course.findMany({
            where: { id: { in: coEnrollmentCounts.map((row) => row.courseId) } },
            select: {
              id: true,
              title: true,
              category: true,
              level: true,
              price: true,
              avgRating: true,
              totalEnrollments: true,
              thumbnailUrl: true,
            },
          })
        ).map((course) => [course.id, course]),
      );

      for (const row of coEnrollmentCounts) {
        const course = coursesById.get(row.courseId);
        if (!course) continue;
        addedCourseIds.add(course.id);
        recommendations.push({
          id: course.id,
          title: course.title,
          category: course.category,
          level: course.level,
          price: course.price,
          avgRating: course.avgRating,
          totalEnrollments: course.totalEnrollments,
          thumbnailUrl: course.thumbnailUrl,
          matchReason: 'co_enrollment',
          score: row._count.courseId,
        });
      }
    }

    // 2. Category-based fallback ranking
    if (recommendations.length < effectiveLimit) {
      const needed = effectiveLimit - recommendations.length;
      const fallbackCourses = await this.prisma.course.findMany({
        where: {
          category: targetCourse.category,
          status: CourseStatus.ACTIVE,
          id: { notIn: Array.from(addedCourseIds) },
        },
        orderBy: [{ avgRating: 'desc' }, { totalEnrollments: 'desc' }],
        take: needed,
      });

      for (const course of fallbackCourses) {
        addedCourseIds.add(course.id);
        recommendations.push({
          id: course.id,
          title: course.title,
          category: course.category,
          level: course.level,
          price: course.price,
          avgRating: course.avgRating,
          totalEnrollments: course.totalEnrollments,
          thumbnailUrl: course.thumbnailUrl,
          matchReason: 'category_fallback',
        });
      }
    }

    return recommendations;
  }
}
