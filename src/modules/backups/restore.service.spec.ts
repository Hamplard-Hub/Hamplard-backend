import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CourseRestoreStatus, CourseStatus, LessonType } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RestoreService } from './restore.service';

describe('RestoreService', () => {
  let service: RestoreService;

  // ─── Transactional client mock ────────────────────────────────────────────
  // $transaction receives a callback; we pass a tx object whose methods are
  // the same mocks so tests can assert on them normally.
  const txMock = {
    courseModule: {
      findMany: jest.fn(),
      create: jest.fn(),
      deleteMany: jest.fn(),
    },
    lesson: {
      findMany: jest.fn(),
      create: jest.fn(),
      deleteMany: jest.fn(),
    },
    lessonProgress: { deleteMany: jest.fn() },
    quizQuestion: { deleteMany: jest.fn() },
    assignment: { deleteMany: jest.fn() },
    course: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  };

  const mockPrisma = {
    $transaction: jest.fn((cb: (tx: typeof txMock) => Promise<unknown>) =>
      cb(txMock),
    ),
    courseRestoreJob: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
    },
    user: { findUnique: jest.fn() },
    course: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    courseModule: {
      findMany: jest.fn(),
      create: jest.fn(),
      deleteMany: jest.fn(),
    },
    lesson: {
      create: jest.fn(),
      deleteMany: jest.fn(),
    },
  };

  const validCourse = {
    id: 'COURSE-1',
    instructorAddress: 'GABC',
    title: 'Tailoring 101',
    category: 'Tailoring',
    price: 50,
    status: CourseStatus.DRAFT,
    modules: [
      {
        title: 'Basics',
        position: 0,
        lessons: [
          {
            title: 'Intro',
            position: 0,
            type: LessonType.VIDEO,
          },
        ],
      },
    ],
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RestoreService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get(RestoreService);
    jest.clearAllMocks();

    // Default $transaction: execute the callback with txMock
    mockPrisma.$transaction.mockImplementation(
      (cb: (tx: typeof txMock) => Promise<unknown>) => cb(txMock),
    );
  });

  // ─── validateBackupAgainstSchema() ───────────────────────────────────────

  describe('validateBackupAgainstSchema()', () => {
    it('accepts a valid backup payload', () => {
      expect(service.validateBackupAgainstSchema([validCourse])).toEqual([]);
    });

    it('rejects invalid lesson types and missing fields', () => {
      const errors = service.validateBackupAgainstSchema([
        {
          ...validCourse,
          title: '',
          modules: [
            {
              title: 'M',
              position: 0,
              lessons: [{ title: 'L', position: 0, type: 'NOPE' }],
            },
          ],
        },
      ]);
      expect(errors.some((e) => e.field === 'title')).toBe(true);
      expect(errors.some((e) => e.field === 'lessons.type')).toBe(true);
    });
  });

  // ─── requestRestore() ────────────────────────────────────────────────────

  describe('requestRestore()', () => {
    it('rejects invalid payloads before creating a job', async () => {
      await expect(
        service.requestRestore('admin-1', {
          courses: [{ ...validCourse, price: -1 }],
        }),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.courseRestoreJob.create).not.toHaveBeenCalled();
    });

    it('schedules a restore for the future', async () => {
      const scheduledFor = new Date(Date.now() + 60_000).toISOString();
      mockPrisma.courseRestoreJob.create.mockResolvedValue({
        id: 'job-1',
        status: CourseRestoreStatus.SCHEDULED,
        scheduledFor: new Date(scheduledFor),
      });
      mockPrisma.courseRestoreJob.findUnique.mockResolvedValue({
        id: 'job-1',
        status: CourseRestoreStatus.SCHEDULED,
        requester: { id: 'admin-1' },
      });

      const result = await service.requestRestore('admin-1', {
        courses: [validCourse],
        scheduledFor,
      });

      expect(mockPrisma.courseRestoreJob.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: CourseRestoreStatus.SCHEDULED,
          }),
        }),
      );
      expect(result.id).toBe('job-1');
    });

    it('executes immediately when not scheduled', async () => {
      mockPrisma.courseRestoreJob.create.mockResolvedValue({
        id: 'job-2',
        status: CourseRestoreStatus.PENDING,
        totalSteps: 3,
        backupPayload: { courses: [validCourse], overwriteExisting: true },
      });
      mockPrisma.courseRestoreJob.findUnique.mockResolvedValue({
        id: 'job-2',
        status: CourseRestoreStatus.PENDING,
        totalSteps: 3,
        backupPayload: { courses: [validCourse], overwriteExisting: true },
      });
      mockPrisma.courseRestoreJob.update.mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'job-2',
          ...data,
        }),
      );
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'inst-1' });
      mockPrisma.course.findUnique.mockResolvedValue(null);

      // Inside the transaction the tx mock handles course/module/lesson writes
      txMock.course.create.mockResolvedValue({ id: 'COURSE-1' });
      txMock.courseModule.create.mockResolvedValue({ id: 'mod-1' });
      txMock.lesson.create.mockResolvedValue({ id: 'les-1' });
      txMock.courseModule.findMany.mockResolvedValue([]);

      const result = await service.requestRestore('admin-1', {
        courses: [validCourse],
      });

      expect(result.status).toBe(CourseRestoreStatus.COMPLETED);
      expect(result.progressPercent).toBe(100);
      expect(result.summary).toEqual(
        expect.objectContaining({
          coursesRestored: 1,
          modulesRestored: 1,
          lessonsRestored: 1,
        }),
      );
    });
  });

  // ─── getStatus() ─────────────────────────────────────────────────────────

  describe('getStatus()', () => {
    it('throws when job is missing', async () => {
      mockPrisma.courseRestoreJob.findUnique.mockResolvedValue(null);
      await expect(service.getStatus('missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ─── processScheduledRestores() ──────────────────────────────────────────

  describe('processScheduledRestores()', () => {
    it('executes due scheduled jobs', async () => {
      mockPrisma.courseRestoreJob.findMany.mockResolvedValue([
        { id: 'due-1' },
      ]);
      const spy = jest
        .spyOn(service, 'executeJob')
        .mockResolvedValue({ id: 'due-1' } as any);

      await service.processScheduledRestores();
      expect(spy).toHaveBeenCalledWith('due-1');
      spy.mockRestore();
    });
  });

  // ─── Transaction atomicity tests ─────────────────────────────────────────

  describe('executeJob() — transaction atomicity', () => {
    /**
     * Sets up a job with two courses:
     *   course-A: valid, restores cleanly
     *   course-B: lesson.create throws mid-transaction (simulates invalid
     *             lesson type or DB constraint violation)
     *
     * Expected outcome:
     *   - course-A is marked as restored in the summary
     *   - course-B is marked as failed with an error entry
     *   - The $transaction for course-B is rolled back (Prisma handles this;
     *     we verify the callback threw and that the outer error is captured)
     *   - The overall job status is COMPLETED (partial success), not FAILED
     */
    it('records a per-course failure without affecting other courses', async () => {
      const courseA = { ...validCourse, id: 'COURSE-A' };
      const courseB = {
        ...validCourse,
        id: 'COURSE-B',
        modules: [
          {
            title: 'Module B',
            position: 0,
            lessons: [
              {
                title: 'Bad Lesson',
                position: 0,
                type: LessonType.VIDEO,
              },
            ],
          },
        ],
      };

      mockPrisma.courseRestoreJob.findUnique.mockResolvedValue({
        id: 'job-tx',
        status: CourseRestoreStatus.PENDING,
        totalSteps: 6, // 3 steps per course × 2
        backupPayload: {
          courses: [courseA, courseB],
          overwriteExisting: true,
        },
      });
      mockPrisma.courseRestoreJob.update.mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'job-tx',
          ...data,
        }),
      );

      // Both instructors exist
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'inst-1' });
      // Neither course exists yet (fresh create)
      mockPrisma.course.findUnique.mockResolvedValue(null);

      // course-A transaction succeeds
      let callCount = 0;
      mockPrisma.$transaction.mockImplementation(
        async (cb: (tx: typeof txMock) => Promise<unknown>) => {
          callCount += 1;
          if (callCount === 1) {
            // course-A: set up happy-path tx mocks
            txMock.courseModule.findMany.mockResolvedValue([]);
            txMock.course.create.mockResolvedValue({ id: 'COURSE-A' });
            txMock.courseModule.create.mockResolvedValue({ id: 'mod-a' });
            txMock.lesson.create.mockResolvedValue({ id: 'les-a' });
            return cb(txMock);
          }
          // course-B: lesson.create throws to simulate a mid-restore failure
          txMock.courseModule.findMany.mockResolvedValue([]);
          txMock.course.create.mockResolvedValue({ id: 'COURSE-B' });
          txMock.courseModule.create.mockResolvedValue({ id: 'mod-b' });
          txMock.lesson.create.mockRejectedValue(
            new Error('Invalid lesson type: UNKNOWN'),
          );
          // The callback throws → $transaction rejects, simulating a rollback
          return cb(txMock);
        },
      );

      const result = await service.executeJob('job-tx');

      // Overall job is COMPLETED (at least one course succeeded)
      expect(result.status).toBe(CourseRestoreStatus.COMPLETED);

      const summary = result.summary as any;

      // course-A succeeded
      expect(summary.coursesRestored).toBe(1);

      // course-B failed and was captured
      expect(summary.coursesFailed).toBe(1);
      expect(summary.errors).toHaveLength(1);
      expect(summary.errors[0].courseId).toBe('COURSE-B');
      expect(summary.errors[0].message).toContain('Invalid lesson type');

      // No partial deletion leaked — $transaction was called exactly twice
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
    });

    it('marks the entire job FAILED when every course fails', async () => {
      const badCourse = {
        ...validCourse,
        id: 'COURSE-BAD',
      };

      mockPrisma.courseRestoreJob.findUnique.mockResolvedValue({
        id: 'job-all-fail',
        status: CourseRestoreStatus.PENDING,
        totalSteps: 3,
        backupPayload: { courses: [badCourse], overwriteExisting: true },
      });
      mockPrisma.courseRestoreJob.update.mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'job-all-fail',
          ...data,
        }),
      );

      mockPrisma.user.findUnique.mockResolvedValue({ id: 'inst-1' });
      mockPrisma.course.findUnique.mockResolvedValue(null);

      mockPrisma.$transaction.mockRejectedValue(
        new Error('DB constraint violation'),
      );

      const result = await service.executeJob('job-all-fail');

      expect(result.status).toBe(CourseRestoreStatus.FAILED);
      const summary = result.summary as any;
      expect(summary.coursesFailed).toBe(1);
      expect(summary.coursesRestored).toBe(0);
      expect(result.errorMessage).toContain('COURSE-BAD');
    });

    it('leaves course prior state intact when transaction rolls back', async () => {
      // This test verifies the service never calls deletions outside the tx.
      // The outer prisma.courseModule / prisma.lesson mocks should never be
      // touched during a restore — only txMock equivalents are used.
      const course = { ...validCourse, id: 'COURSE-RB' };

      mockPrisma.courseRestoreJob.findUnique.mockResolvedValue({
        id: 'job-rb',
        status: CourseRestoreStatus.PENDING,
        totalSteps: 3,
        backupPayload: {
          courses: [course],
          overwriteExisting: true,
        },
      });
      mockPrisma.courseRestoreJob.update.mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'job-rb',
          ...data,
        }),
      );

      mockPrisma.user.findUnique.mockResolvedValue({ id: 'inst-1' });
      // Existing course — triggers the delete path inside the transaction
      mockPrisma.course.findUnique.mockResolvedValue({ id: 'COURSE-RB' });

      // Simulate the transaction throwing after the deletes (mid-restore)
      mockPrisma.$transaction.mockImplementation(
        async (cb: (tx: typeof txMock) => Promise<unknown>) => {
          txMock.courseModule.findMany.mockResolvedValue([
            { id: 'old-mod-1' },
          ]);
          txMock.lesson.findMany.mockResolvedValue([{ id: 'old-les-1' }]);
          txMock.lessonProgress.deleteMany.mockResolvedValue({ count: 1 });
          txMock.quizQuestion.deleteMany.mockResolvedValue({ count: 0 });
          txMock.assignment.deleteMany.mockResolvedValue({ count: 0 });
          txMock.lesson.deleteMany.mockResolvedValue({ count: 1 });
          txMock.courseModule.deleteMany.mockResolvedValue({ count: 1 });
          txMock.course.update.mockResolvedValue({ id: 'COURSE-RB' });
          txMock.courseModule.create.mockResolvedValue({ id: 'new-mod-1' });
          // Fail when creating the lesson (simulates DB error after deletes)
          txMock.lesson.create.mockRejectedValue(
            new Error('Lesson create failed'),
          );
          // Calling cb will reject — Prisma would roll back; we honour that here
          return cb(txMock);
        },
      );

      const result = await service.executeJob('job-rb');

      // The restore failed
      expect(result.status).toBe(CourseRestoreStatus.FAILED);

      // The outer prisma object's destructive methods were NEVER called directly —
      // all deletes happened through the tx mock (inside the transaction).
      expect(mockPrisma.lesson.deleteMany).not.toHaveBeenCalled();
      expect(mockPrisma.courseModule.deleteMany).not.toHaveBeenCalled();
    });
  });
});
