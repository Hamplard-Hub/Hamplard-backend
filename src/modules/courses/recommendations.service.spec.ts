import { Test, TestingModule } from '@nestjs/testing';
import {
  RecommendationsService,
  RECOMMENDATIONS_CACHE_NAMESPACE,
  RECOMMENDATIONS_CACHE_TTL_SECONDS,
} from './recommendations.service';
import { CacheService } from '../../common/cache/cache.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CourseStatus } from '@prisma/client';
import { NotFoundException } from '@nestjs/common';

const mockTargetCourse = {
  id: 'course-1',
  category: 'Tailoring',
  status: CourseStatus.ACTIVE,
};

const mockCoEnrolledCourse = {
  id: 'course-2',
  title: 'Advanced Sewing Techniques',
  category: 'Tailoring',
  level: 'Intermediate',
  price: 60,
  avgRating: 4.8,
  totalEnrollments: 120,
  thumbnailUrl: 'http://thumb2.jpg',
  status: CourseStatus.ACTIVE,
};

const mockFallbackCourse = {
  id: 'course-3',
  title: 'Pattern Drafting 101',
  category: 'Tailoring',
  level: 'Beginner',
  price: 40,
  avgRating: 4.5,
  totalEnrollments: 80,
  thumbnailUrl: 'http://thumb3.jpg',
  status: CourseStatus.ACTIVE,
};

const mockPrisma = {
  course: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
  },
  enrollment: {
    findMany: jest.fn(),
    groupBy: jest.fn(),
  },
};

const mockCache = {
  buildKey: jest.fn(
    (ns: string, params: Record<string, unknown> = {}) =>
      `cache:${ns}:${Object.keys(params)
        .sort()
        .map((k) => `${k}=${params[k]}`)
        .join('&')}`,
  ),
  get: jest.fn(),
  set: jest.fn(),
};

const totalQueries = () =>
  mockPrisma.course.findUnique.mock.calls.length +
  mockPrisma.course.findMany.mock.calls.length +
  mockPrisma.enrollment.findMany.mock.calls.length +
  mockPrisma.enrollment.groupBy.mock.calls.length;

describe('RecommendationsService', () => {
  let service: RecommendationsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RecommendationsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: CacheService, useValue: mockCache },
      ],
    }).compile();

    service = module.get<RecommendationsService>(RecommendationsService);
    jest.resetAllMocks();
    mockCache.buildKey.mockImplementation(
      (ns: string, params: Record<string, unknown> = {}) =>
        `cache:${ns}:${Object.keys(params)
          .sort()
          .map((k) => `${k}=${params[k]}`)
          .join('&')}`,
    );
    mockCache.get.mockResolvedValue(null);
    mockCache.set.mockResolvedValue(undefined);
  });

  describe('getRecommendations()', () => {
    it('throws NotFoundException if target course does not exist', async () => {
      mockPrisma.course.findUnique.mockResolvedValue(null);

      await expect(service.getRecommendations('non-existent')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('does not cache a NotFound result', async () => {
      mockPrisma.course.findUnique.mockResolvedValue(null);

      await expect(service.getRecommendations('non-existent')).rejects.toThrow(
        NotFoundException,
      );
      expect(mockCache.set).not.toHaveBeenCalled();
    });

    it('recommends courses based on co-enrollment patterns and category fallback', async () => {
      mockPrisma.course.findUnique.mockResolvedValue(mockTargetCourse);
      mockPrisma.enrollment.groupBy.mockResolvedValue([
        { courseId: 'course-2', _count: { courseId: 7 } },
      ]);
      mockPrisma.course.findMany
        .mockResolvedValueOnce([mockCoEnrolledCourse]) // winning course rows
        .mockResolvedValueOnce([mockFallbackCourse]); // category fallback

      const recommendations = await service.getRecommendations('course-1', 2);

      expect(recommendations.length).toBe(2);
      expect(recommendations[0].id).toBe('course-2');
      expect(recommendations[0].matchReason).toBe('co_enrollment');
      expect(recommendations[0].score).toBe(7);
      expect(recommendations[1].id).toBe('course-3');
      expect(recommendations[1].matchReason).toBe('category_fallback');
    });

    it('aggregates in the database with a subquery filter instead of loading enrollments', async () => {
      mockPrisma.course.findUnique.mockResolvedValue(mockTargetCourse);
      mockPrisma.enrollment.groupBy.mockResolvedValue([]);
      mockPrisma.course.findMany.mockResolvedValue([]);

      await service.getRecommendations('course-1', 3);

      expect(mockPrisma.enrollment.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.enrollment.groupBy).toHaveBeenCalledWith({
        by: ['courseId'],
        where: {
          courseId: { not: 'course-1' },
          course: { status: CourseStatus.ACTIVE },
          student: { enrollments: { some: { courseId: 'course-1' } } },
        },
        _count: { courseId: true },
        orderBy: [{ _count: { courseId: 'desc' } }, { courseId: 'asc' }],
        take: 3,
      });
    });

    it('preserves ranking order from the aggregate (highest co-enrollment first)', async () => {
      mockPrisma.course.findUnique.mockResolvedValue(mockTargetCourse);
      mockPrisma.enrollment.groupBy.mockResolvedValue([
        { courseId: 'course-3', _count: { courseId: 9 } },
        { courseId: 'course-2', _count: { courseId: 4 } },
      ]);
      // DB returns rows in arbitrary order; service must follow the aggregate's order.
      mockPrisma.course.findMany.mockResolvedValueOnce([mockCoEnrolledCourse, mockFallbackCourse]);

      const recommendations = await service.getRecommendations('course-1', 2);

      expect(recommendations.map((r) => r.id)).toEqual(['course-3', 'course-2']);
      expect(recommendations.map((r) => r.score)).toEqual([9, 4]);
      // limit already satisfied -> no fallback query
      expect(mockPrisma.course.findMany).toHaveBeenCalledTimes(1);
    });

    it('runs a bounded number of queries regardless of enrollment volume', async () => {
      mockPrisma.course.findUnique.mockResolvedValue(mockTargetCourse);
      mockPrisma.course.findMany.mockResolvedValue([mockCoEnrolledCourse]);

      for (const count of [1, 1_000, 1_000_000]) {
        jest.clearAllMocks();
        mockCache.get.mockResolvedValue(null);
        mockPrisma.enrollment.groupBy.mockResolvedValue([
          { courseId: 'course-2', _count: { courseId: count } },
        ]);

        await service.getRecommendations('course-1', 5);

        expect(totalQueries()).toBeLessThanOrEqual(4);
      }
    });

    it('caches computed results for 5 minutes', async () => {
      mockPrisma.course.findUnique.mockResolvedValue(mockTargetCourse);
      mockPrisma.enrollment.groupBy.mockResolvedValue([
        { courseId: 'course-2', _count: { courseId: 1 } },
      ]);
      mockPrisma.course.findMany
        .mockResolvedValueOnce([mockCoEnrolledCourse])
        .mockResolvedValueOnce([]);

      const result = await service.getRecommendations('course-1', 5);

      expect(mockCache.buildKey).toHaveBeenCalledWith(RECOMMENDATIONS_CACHE_NAMESPACE, {
        courseId: 'course-1',
        limit: 5,
      });
      expect(mockCache.set).toHaveBeenCalledWith(
        `cache:${RECOMMENDATIONS_CACHE_NAMESPACE}:courseId=course-1&limit=5`,
        result,
        RECOMMENDATIONS_CACHE_TTL_SECONDS,
      );
      expect(RECOMMENDATIONS_CACHE_TTL_SECONDS).toBe(300);
    });

    it('returns cached results without touching the database', async () => {
      const cached = [{ id: 'course-2', matchReason: 'co_enrollment', score: 3 }];
      mockCache.get.mockResolvedValue(cached);

      const result = await service.getRecommendations('course-1', 5);

      expect(result).toBe(cached);
      expect(totalQueries()).toBe(0);
      expect(mockCache.set).not.toHaveBeenCalled();
    });

    it('uses the normalised limit in the cache key so out-of-range limits share an entry', async () => {
      mockPrisma.course.findUnique.mockResolvedValue(mockTargetCourse);
      mockPrisma.enrollment.groupBy.mockResolvedValue([]);
      mockPrisma.course.findMany.mockResolvedValue([]);

      await service.getRecommendations('course-1', 9999);

      expect(mockCache.buildKey).toHaveBeenCalledWith(RECOMMENDATIONS_CACHE_NAMESPACE, {
        courseId: 'course-1',
        limit: 5,
      });
    });
  });
});
