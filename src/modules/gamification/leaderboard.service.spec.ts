import { Test, TestingModule } from '@nestjs/testing';
import { LeaderboardService } from './leaderboard.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { LeaderboardScope } from './dto/leaderboard-query.dto';
import { BadRequestException } from '@nestjs/common';

const mockStudents = [
  {
    id: 'student-1',
    name: 'Alice',
    avatarUrl: 'http://avatar1.jpg',
    stellarAddress: 'GALICE',
    enrollments: [
      {
        status: 'COMPLETED',
        progressPercent: 100,
        lessonProgress: [{ id: 'lp-1' }, { id: 'lp-2' }],
      },
    ],
    assignments: [{ id: 'sub-1' }],
    examAttempts: [{ score: 85 }],
  },
  {
    id: 'student-2',
    name: 'Bob',
    avatarUrl: null,
    stellarAddress: 'GBOB',
    enrollments: [
      {
        status: 'ACTIVE',
        progressPercent: 50,
        lessonProgress: [{ id: 'lp-3' }],
      },
    ],
    assignments: [],
    examAttempts: [],
  },
];

let snapshotStore: Array<{
  scope: string;
  courseId: string | null;
  userId: string;
  rank: number;
  computedAt: Date;
}> = [];

const mockPrisma = {
  user: {
    findMany: jest.fn(),
  },
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
      mockPrisma.user.findMany.mockResolvedValue(mockStudents);

      const result = await service.getLeaderboard({
        scope: LeaderboardScope.GLOBAL,
        limit: 10,
      });

      expect(result.total).toBe(2);
      expect(result.data[0].userId).toBe('student-1');
      // Points calculation for student-1: (2 lessons * 10) + 100 bonus + (1 assignment * 50) + 85 exam = 255
      expect(result.data[0].points).toBe(255);
      expect(result.data[0].currentRank).toBe(1);

      // Points calculation for student-2: 1 lesson * 10 = 10
      expect(result.data[1].userId).toBe('student-2');
      expect(result.data[1].points).toBe(10);
      expect(result.data[1].currentRank).toBe(2);
    });

    it('tracks rank position changes after recalculation persisted in database', async () => {
      mockPrisma.user.findMany.mockResolvedValue(mockStudents);
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
      mockPrisma.user.findMany.mockResolvedValue(mockStudents);
      mockPrisma.course.findMany.mockResolvedValue([]);

      // Instance 1 calculates and persists rankings to the database
      await service.recalculateRankings();
      expect(snapshotStore.length).toBe(2);

      // Now simulate student-2 passing exams and overtaking student-1
      const updatedStudents = [
        {
          ...mockStudents[1], // student-2 now has 300 points
          examAttempts: [{ score: 290 }],
        },
        mockStudents[0], // student-1 has 255 points
      ];
      mockPrisma.user.findMany.mockResolvedValue(updatedStudents);

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
});
