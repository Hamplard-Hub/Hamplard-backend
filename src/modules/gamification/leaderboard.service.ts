import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
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

    // 1. Recalculate Global rankings
    const globalRankings = await this.calculateStudentPoints(LeaderboardScope.GLOBAL);
    await this.prisma.$transaction(async (tx) => {
      await tx.leaderboardSnapshot.deleteMany({
        where: { scope: LeaderboardScope.GLOBAL, courseId: null },
      });
      if (globalRankings.length > 0) {
        await tx.leaderboardSnapshot.createMany({
          data: globalRankings.map((student, index) => ({
            scope: LeaderboardScope.GLOBAL,
            courseId: null,
            userId: student.userId,
            rank: index + 1,
            computedAt,
          })),
        });
      }
    });

    // 2. Recalculate Course-level rankings
    const activeCourses = await this.prisma.course.findMany({
      select: { id: true },
    });

    for (const course of activeCourses) {
      const courseRankings = await this.calculateStudentPoints(LeaderboardScope.COURSE, course.id);
      await this.prisma.$transaction(async (tx) => {
        await tx.leaderboardSnapshot.deleteMany({
          where: { scope: LeaderboardScope.COURSE, courseId: course.id },
        });
        if (courseRankings.length > 0) {
          await tx.leaderboardSnapshot.createMany({
            data: courseRankings.map((student, index) => ({
              scope: LeaderboardScope.COURSE,
              courseId: course.id,
              userId: student.userId,
              rank: index + 1,
              computedAt,
            })),
          });
        }
      });
    }

    return { status: 'recalculated', coursesCount: activeCourses.length };
  }

  private async calculateStudentPoints(
    scope: LeaderboardScope,
    courseId?: string,
  ): Promise<{ userId: string; name: string; avatarUrl?: string | null; points: number }[]> {
    const studentWhere: any = { role: 'STUDENT' };
    if (scope === LeaderboardScope.COURSE && courseId) {
      studentWhere.enrollments = { some: { courseId } };
    }

    const students = await this.prisma.user.findMany({
      where: studentWhere,
      select: {
        id: true,
        name: true,
        avatarUrl: true,
        stellarAddress: true,
        enrollments: {
          where: scope === LeaderboardScope.COURSE && courseId ? { courseId } : undefined,
          select: {
            status: true,
            progressPercent: true,
            lessonProgress: { where: { completed: true }, select: { id: true } },
          },
        },
        assignments: {
          where: { status: 'APPROVED' },
          select: { id: true },
        },
        examAttempts: {
          where: { passed: true },
          select: { score: true },
        },
      },
    });

    const studentPoints = students.map((s) => {
      let points = 0;
      // 10 pts per completed lesson
      s.enrollments.forEach((e) => {
        points += e.lessonProgress.length * 10;
        if (e.status === 'COMPLETED' || e.progressPercent === 100) {
          points += 100; // 100 bonus pts for course completion
        }
      });

      // 50 pts per approved assignment
      points += s.assignments.length * 50;

      // Score pts for passed exams
      s.examAttempts.forEach((attempt) => {
        points += attempt.score;
      });

      return {
        userId: s.id,
        name: s.name ?? s.stellarAddress,
        avatarUrl: s.avatarUrl,
        points,
      };
    });

    return studentPoints.sort((a, b) => b.points - a.points);
  }
}
