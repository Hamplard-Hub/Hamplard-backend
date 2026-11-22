import { Test, TestingModule } from '@nestjs/testing';
import { LeaderboardService, COURSE_BATCH_SIZE } from './leaderboard.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { LeaderboardScope } from './dto/leaderboard-query.dto';
import { BadRequestException } from '@nestjs/common';

// Rows as returned by the aggregate SQL query in LeaderboardService
// (points are already summed by Postgres and arrive as bigint).
//   student-1: (2 lessons * 10) + 100 completion bonus + (1 assignment * 50) + 85 exam = 255
//   student-2: 1 lesson * 10 = 10
const mockStudentRows = [
  { userId: 'student-1', name: 'Alice', avatarUrl: 'http://avatar1.jpg', points: BigInt(255) },
  { userId: 'student-2', name: 'Bob', avatarUrl: null, points: BigInt(10) },
];

let snapshotStore: Array<{
  scope: string;
  courseId: string | null;
  userId: string;
  rank: number;
  computedAt: Date;
}> = [];

const mockPrisma = {
  $queryRaw: jest.fn(),
  course: {
    findMany: jest.fn(),
  },
  leaderboardSnapshot: {
    findMany: jest.fn(async (args?: any) => {
      const scope = args?.where?.scope;
      const courseId = args?.where?.courseId ?? null;
      return snapshotStore.filter(
        (s) => s.scope === scope && (s.courseId ?? null) === courseId,
      );
    }),
    deleteMany: jest.fn(async (args?: any) => {
      const scope = args?.where?.scope;
      const courseId = args?.where?.courseId ?? null;
      snapshotStore = snapshotStore.filter(
        (s) => !(s.scope === scope && (s.courseId ?? null) === courseId),
      );
      return { count: 1 };
    }),
    createMany: jest.fn(async (args?: any) => {
      if (args?.data) {
        snapshotStore.push(...args.data);
      }
      return { count: args?.data?.length ?? 0 };
    }),
  },
  $transaction: jest.fn(async (callback: any) => {
    if (typeof callback === 'function') {
      return callback(mockPrisma);
    }
    return Promise.all(callback);
  }),
};

describe('LeaderboardService', () => {
  let service: LeaderboardService;

  beforeEach(async () => {
    snapshotStore = [];
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LeaderboardService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<LeaderboardService>(LeaderboardService);
    jest.clearAllMocks();
  });

  describe('getLeaderboard()', () => {
    it('throws BadRequestException if course scope is selected without courseId', async () => {
      await expect(
        service.getLeaderboard({ scope: LeaderboardScope.COURSE }),
      ).rejects.toThrow(BadRequestException);
    });

    it('returns top-N leaderboard entries for global scope with calculated points and rank', async () => {
      mockPrisma.$queryRaw.mockResolvedValue(mockStudentRows);

      const result = await service.getLeaderboard({
        scope: LeaderboardScope.GLOBAL,
        limit: 10,
      });

      expect(result.total).toBe(2);
      expect(result.data[0].userId).toBe('student-1');
      expect(result.data[0].points).toBe(255);
      expect(result.data[0].currentRank).toBe(1);

      expect(result.data[1].userId).toBe('student-2');
      expect(result.data[1].points).toBe(10);
      expect(result.data[1].currentRank).toBe(2);
    });

    it('tracks rank position changes after recalculation persisted in database', async () => {
      mockPrisma.$queryRaw.mockResolvedValue(mockStudentRows);
      mockPrisma.course.findMany.mockResolvedValue([]);

      // First run: initial recalculation snapshot
      await service.recalculateRankings();
      expect(mockPrisma.$transaction).toHaveBeenCalled();
      expect(snapshotStore.length).toBe(2);

      // Now query leaderboard
      const result = await service.getLeaderboard({
        scope: LeaderboardScope.GLOBAL,
        limit: 10,
      });

      expect(result.data[0].previousRank).toBe(1);
      expect(result.data[0].rankChange).toBe(0);
      expect(result.data[1].previousRank).toBe(2);
      expect(result.data[1].rankChange).toBe(0);
    });

    it('verifies rank-change survives a fresh service instantiation (application restart)', async () => {
      mockPrisma.$queryRaw.mockResolvedValue(mockStudentRows);
      mockPrisma.course.findMany.mockResolvedValue([]);

      // Instance 1 calculates and persists rankings to the database
      await service.recalculateRankings();
      expect(snapshotStore.length).toBe(2);

      // Now simulate student-2 passing exams and overtaking student-1
      // (student-2 now has 300 points, student-1 still has 255)
      mockPrisma.$queryRaw.mockResolvedValue([
        { ...mockStudentRows[1], points: BigInt(300) },
        mockStudentRows[0],
      ]);

      // Simulate application restart: instantiate a fresh second service instance
      const freshModule: TestingModule = await Test.createTestingModule({
        providers: [
          LeaderboardService,
          { provide: PrismaService, useValue: mockPrisma },
        ],
      }).compile();
      const freshService = freshModule.get<LeaderboardService>(LeaderboardService);

      // Fresh instance reads leaderboard without in-memory state
      const result = await freshService.getLeaderboard({
        scope: LeaderboardScope.GLOBAL,
        limit: 10,
      });

      // student-2 was rank 2 in the database snapshot, now rank 1 -> rankChange = +1
      expect(result.data[0].userId).toBe('student-2');
      expect(result.data[0].currentRank).toBe(1);
      expect(result.data[0].previousRank).toBe(2);
      expect(result.data[0].rankChange).toBe(1); // 2 - 1 = +1

      // student-1 was rank 1 in the database snapshot, now rank 2 -> rankChange = -1
      expect(result.data[1].userId).toBe('student-1');
      expect(result.data[1].currentRank).toBe(2);
      expect(result.data[1].previousRank).toBe(1);
      expect(result.data[1].rankChange).toBe(-1); // 1 - 2 = -1
    });
  });

  describe('aggregate points calculation', () => {
    it('computes points via a single aggregate SQL query and never loads nested relations', async () => {
      mockPrisma.$queryRaw.mockResolvedValue(mockStudentRows);

      const result = await service.getLeaderboard({ scope: LeaderboardScope.GLOBAL });

      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect((mockPrisma as any).user).toBeUndefined();
      // bigint from Postgres is converted to a plain number
      expect(typeof result.data[0].points).toBe('number');
    });

    it('scopes the aggregate query to the requested course', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([mockStudentRows[1]]);

      const result = await service.getLeaderboard({
        scope: LeaderboardScope.COURSE,
        courseId: 'course-1',
      });

      const sql = mockPrisma.$queryRaw.mock.calls[0][0];
      expect(sql.values).toContain('course-1');
      expect(result.total).toBe(1);
      expect(result.courseId).toBe('course-1');
    });

    it('keeps the order returned by SQL when assigning ranks', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([
        { userId: 'a', name: 'A', avatarUrl: null, points: BigInt(7) },
        { userId: 'b', name: 'B', avatarUrl: null, points: BigInt(7) },
        { userId: 'c', name: 'C', avatarUrl: null, points: BigInt(1) },
      ]);

      const result = await service.getLeaderboard({ scope: LeaderboardScope.GLOBAL });

      expect(result.data.map((e) => [e.userId, e.currentRank])).toEqual([
        ['a', 1],
        ['b', 2],
        ['c', 3],
      ]);
    });
  });

  describe('recalculateRankings() course batching', () => {
    const makeCourses = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({ id: `course-${from + i}` }));

    it('walks courses in keyset-paginated batches and snapshots each course', async () => {
      mockPrisma.$queryRaw.mockResolvedValue(mockStudentRows);
      mockPrisma.course.findMany
        .mockResolvedValueOnce(makeCourses(1, COURSE_BATCH_SIZE))
        .mockResolvedValueOnce(makeCourses(COURSE_BATCH_SIZE + 1, 2));

      const result = await service.recalculateRankings();

      expect(result).toEqual({ status: 'recalculated', coursesCount: COURSE_BATCH_SIZE + 2 });
      expect(mockPrisma.course.findMany).toHaveBeenCalledTimes(2);
      expect(mockPrisma.course.findMany.mock.calls[0][0]).toMatchObject({
        take: COURSE_BATCH_SIZE,
        orderBy: { id: 'asc' },
      });
      expect(mockPrisma.course.findMany.mock.calls[0][0].cursor).toBeUndefined();
      expect(mockPrisma.course.findMany.mock.calls[1][0]).toMatchObject({
        take: COURSE_BATCH_SIZE,
        cursor: { id: `course-${COURSE_BATCH_SIZE}` },
        skip: 1,
      });

      // 1 global query + 1 query per course
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1 + COURSE_BATCH_SIZE + 2);
      const courseSnapshots = snapshotStore.filter((s) => s.scope === LeaderboardScope.COURSE);
      expect(courseSnapshots).toHaveLength((COURSE_BATCH_SIZE + 2) * 2);
    });

    it('stops after a short batch without an extra query', async () => {
      mockPrisma.$queryRaw.mockResolvedValue(mockStudentRows);
      mockPrisma.course.findMany.mockResolvedValueOnce(makeCourses(1, 2));

      const result = await service.recalculateRankings();

      expect(result.coursesCount).toBe(2);
      expect(mockPrisma.course.findMany).toHaveBeenCalledTimes(1);
    });
  });
});
import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { performance } from 'perf_hooks';
import { PrismaService } from '../../common/prisma/prisma.service';
import { LeaderboardQueryDto, LeaderboardScope } from './dto/leaderboard-query.dto';

export interface LeaderboardEntry {
  userId: string;
  name: string;
  avatarUrl?: string | null;
  points: number;
  currentRank: number;
  previousRank: number | null;
  rankChange: number; // positive = moved up, negative = moved down, 0 = unchanged
}

/**
 * Number of courses recalculated per batch. Courses are read with keyset
 * pagination and each batch is processed concurrently, so this also caps the
 * number of in-flight leaderboard queries / DB connections used by the job.
 */
export const COURSE_BATCH_SIZE = 5;

interface RankedStudent {
  userId: string;
  name: string;
  avatarUrl?: string | null;
  points: number;
}

interface StudentPointsRow {
  userId: string;
  name: string;
  avatarUrl: string | null;
  // SUM()/COUNT() come back from Postgres as bigint
  points: bigint | number;
}

@Injectable()
export class LeaderboardService {
  private readonly logger = new Logger(LeaderboardService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getLeaderboard(query: LeaderboardQueryDto) {
    if (query.scope === LeaderboardScope.COURSE && !query.courseId) {
      throw new BadRequestException('courseId is required when scope is course');
    }

    const limit = query.limit && query.limit > 0 ? query.limit : 10;
    const page = query.page && query.page > 0 ? query.page : 1;

    const courseId = query.scope === LeaderboardScope.COURSE ? query.courseId : null;
    const snapshots = await this.prisma.leaderboardSnapshot.findMany({
      where: {
        scope: query.scope,
        courseId,
      },
    });
    const previousRanks = new Map<string, number>(
      snapshots.map((s) => [s.userId, s.rank]),
    );

    const rankedStudents = await this.calculateStudentPoints(query.scope, query.courseId);

    const entries: LeaderboardEntry[] = rankedStudents.map((student, index) => {
      const currentRank = index + 1;
      const prevRank = previousRanks.has(student.userId) ? previousRanks.get(student.userId)! : null;
      const rankChange = prevRank !== null ? prevRank - currentRank : 0;

      return {
        userId: student.userId,
        name: student.name,
        avatarUrl: student.avatarUrl,
        points: student.points,
        currentRank,
        previousRank: prevRank,
        rankChange,
      };
    });

    const skip = (page - 1) * limit;
    const paginatedEntries = entries.slice(skip, skip + limit);

    return {
      data: paginatedEntries,
      total: entries.length,
      page,
      limit,
      scope: query.scope,
      courseId: query.courseId,
    };
  }

  @Cron(CronExpression.EVERY_HOUR)
  async handlePeriodicRecalculation() {
    this.logger.log('Starting periodic leaderboard ranking recalculation...');
    await this.recalculateRankings();
    this.logger.log('Periodic leaderboard ranking recalculation completed.');
  }

  async recalculateRankings() {
    const computedAt = new Date();
    const startedAt = performance.now();
    const heapBefore = process.memoryUsage().heapUsed;

    // 1. Recalculate Global rankings
    const globalStartedAt = performance.now();
    await this.recalculateScope(LeaderboardScope.GLOBAL, null, computedAt);
    const globalMs = performance.now() - globalStartedAt;
    this.logger.log(`Global leaderboard recalculated in ${globalMs.toFixed(0)}ms`);

    // 2. Recalculate Course-level rankings in batches (keyset pagination so
    // the full course list is never held in memory).
    const coursesStartedAt = performance.now();
    let coursesCount = 0;
    let batchCount = 0;
    let cursor: string | undefined;

    while (true) {
      const batch = await this.prisma.course.findMany({
        select: { id: true },
        orderBy: { id: 'asc' },
        take: COURSE_BATCH_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (batch.length === 0) break;

      const batchStartedAt = performance.now();
      await Promise.all(
        batch.map((course) =>
          this.recalculateScope(LeaderboardScope.COURSE, course.id, computedAt),
        ),
      );

      batchCount += 1;
      coursesCount += batch.length;
      cursor = batch[batch.length - 1].id;
      this.logger.log(
        `Course batch ${batchCount} (${batch.length} courses) recalculated in ` +
          `${(performance.now() - batchStartedAt).toFixed(0)}ms`,
      );

      if (batch.length < COURSE_BATCH_SIZE) break;
    }

    const totalMs = performance.now() - startedAt;
    const heapDeltaMb = (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024;
    this.logger.log(
      `Leaderboard recalculation finished in ${totalMs.toFixed(0)}ms ` +
        `(global: ${globalMs.toFixed(0)}ms, ` +
        `${coursesCount} courses in ${batchCount} batches: ${(performance.now() - coursesStartedAt).toFixed(0)}ms, ` +
        `heap delta: ${heapDeltaMb.toFixed(1)}MB)`,
    );

    return { status: 'recalculated', coursesCount };
  }

  /** Computes the ranking for one scope and replaces its stored snapshot. */
  private async recalculateScope(
    scope: LeaderboardScope,
    courseId: string | null,
    computedAt: Date,
  ): Promise<void> {
    const startedAt = performance.now();
    const rankings = await this.calculateStudentPoints(scope, courseId ?? undefined);
    const calculatedAt = performance.now();

    await this.prisma.$transaction(async (tx) => {
      await tx.leaderboardSnapshot.deleteMany({
        where: { scope, courseId },
      });
      if (rankings.length > 0) {
        await tx.leaderboardSnapshot.createMany({
          data: rankings.map((student, index) => ({
            scope,
            courseId,
            userId: student.userId,
            rank: index + 1,
            computedAt,
          })),
        });
      }
    });

    if (courseId) {
      this.logger.debug(
        `Course ${courseId}: ${rankings.length} students, calculate ` +
          `${(calculatedAt - startedAt).toFixed(0)}ms, persist ` +
          `${(performance.now() - calculatedAt).toFixed(0)}ms`,
      );
    }
  }

  /**
   * Computes every student's points (and orders them) entirely in SQL, so only
   * one small scalar row per student reaches Node - no nested relations are
   * ever loaded.
   *
   * Scoring rules (unchanged):
   *  - 10 pts per completed lesson, per enrollment
   *  - +100 pts per enrollment that is COMPLETED or at 100% progress
   *  - 50 pts per APPROVED assignment submission
   *  - score pts per passed exam attempt
   *
   * For COURSE scope only enrollments in that course (and the students
   * enrolled in it) are considered; approved assignments and passed exams are
   * still counted across all of the student's activity, as before.
   */
  private async calculateStudentPoints(
    scope: LeaderboardScope,
    courseId?: string,
  ): Promise<RankedStudent[]> {
    const isCourseScope = scope === LeaderboardScope.COURSE && !!courseId;

    const enrollmentFilter = isCourseScope
      ? Prisma.sql`WHERE e."courseId" = ${courseId}`
      : Prisma.empty;
    // Only the students enrolled in the course matter, so don't aggregate
    // assignments/exams of everybody else.
    const studentFilter = isCourseScope
      ? Prisma.sql`AND "studentId" IN (SELECT "studentId" FROM enrollment_points)`
      : Prisma.empty;
    const enrolledOnly = isCourseScope
      ? Prisma.sql`AND ep."studentId" IS NOT NULL`
      : Prisma.empty;

    const query = Prisma.sql`
      WITH enrollment_points AS (
        SELECT
          e."studentId" AS "studentId",
          COUNT(lp.id) * 10
            + CASE WHEN e."status" = 'COMPLETED' OR e."progressPercent" = 100 THEN 100 ELSE 0 END
            AS points
        FROM "enrollments" e
        LEFT JOIN "lesson_progress" lp
          ON lp."enrollmentId" = e.id AND lp."completed" = true
        ${enrollmentFilter}
        GROUP BY e.id
      )
      SELECT
        u.id AS "userId",
        COALESCE(u."name", u."stellarAddress") AS "name",
        u."avatarUrl" AS "avatarUrl",
        (
          COALESCE(ep.points, 0) + COALESCE(ap.points, 0) + COALESCE(xp.points, 0)
        )::bigint AS "points"
      FROM "users" u
      LEFT JOIN (
        SELECT "studentId", SUM(points) AS points
        FROM enrollment_points
        GROUP BY "studentId"
      ) ep ON ep."studentId" = u.id
      LEFT JOIN (
        SELECT "studentId", COUNT(*) * 50 AS points
        FROM "assignment_submissions"
        WHERE "status" = 'APPROVED' ${studentFilter}
        GROUP BY "studentId"
      ) ap ON ap."studentId" = u.id
      LEFT JOIN (
        SELECT "studentId", SUM("score") AS points
        FROM "exam_attempts"
        WHERE "passed" = true ${studentFilter}
        GROUP BY "studentId"
      ) xp ON xp."studentId" = u.id
      WHERE u."role" = 'STUDENT' ${enrolledOnly}
      ORDER BY "points" DESC, u.id ASC
    `;

    const rows = await this.prisma.$queryRaw<StudentPointsRow[]>(query);

    return rows.map((row) => ({
      userId: row.userId,
      name: row.name,
      avatarUrl: row.avatarUrl,
      points: Number(row.points),
    }));
  }
}
