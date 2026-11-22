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
