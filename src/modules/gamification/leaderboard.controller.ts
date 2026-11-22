import { Controller, Get, Post, Query, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { LeaderboardService } from './leaderboard.service';
import { LeaderboardQueryDto } from './dto/leaderboard-query.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard, Roles } from '../../common/guards/roles.guard';
import { UserRole } from '@prisma/client';

@ApiTags('leaderboard')
@Controller('gamification/leaderboard')
export class LeaderboardController {
  constructor(private readonly leaderboardService: LeaderboardService) {}

  @Get()
  @ApiOperation({ summary: 'Get top student rankings by points (global or course scope)' })
  getLeaderboard(@Query() query: LeaderboardQueryDto) {
    return this.leaderboardService.getLeaderboard(query);
  }

  @Post('recalculate')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Manually trigger leaderboard rankings recalculation (admin only)' })
  recalculateRankings() {
    return this.leaderboardService.recalculateRankings();
  }
}
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