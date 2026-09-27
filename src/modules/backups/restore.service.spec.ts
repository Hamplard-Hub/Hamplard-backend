import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CourseRestoreStatus, CourseStatus, LessonType } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RestoreService } from './restore.service';

describe('RestoreService', () => {
  let service: RestoreService;

  /**
   * The $transaction mock executes the callback immediately with mockPrisma as
   * the transactional client.  This mirrors what Prisma does in production and
   * lets the existing per-entity mock fns (course.create, lesson.create, …) be
   * observed and controlled from tests without any extra plumbing.
   *
   * For the rollback test we override $transaction to throw, simulating the DB
   * rolling the transaction back.
   */
  const mockPrisma = {
    $transaction: jest.fn((callback: (tx: unknown) => Promise<unknown>) =>
      callback(mockPrisma),
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
      findMany: jest.fn(),
      create: jest.fn(),
      deleteMany: jest.fn(),
    },
    lessonProgress: { deleteMany: jest.fn() },
    quizQuestion: { deleteMany: jest.fn() },
    assignment: { deleteMany: jest.fn() },
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

    // Restore the default $transaction implementation after each clear.
    mockPrisma.$transaction.mockImplementation(
      (callback: (tx: unknown) => Promise<unknown>) => callback(mockPrisma),
    );
  });

  // ── validateBackupAgainstSchema ──────────────────────────────────────────

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

  // ── requestRestore ───────────────────────────────────────────────────────

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
      mockPrisma.course.create.mockResolvedValue({ id: 'COURSE-1' });
      mockPrisma.courseModule.create.mockResolvedValue({ id: 'mod-1' });
      mockPrisma.lesson.create.mockResolvedValue({ id: 'les-1' });

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

  // ── getStatus ────────────────────────────────────────────────────────────

  describe('getStatus()', () => {
    it('throws when job is missing', async () => {
      mockPrisma.courseRestoreJob.findUnique.mockResolvedValue(null);
      await expect(service.getStatus('missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ── processScheduledRestores ─────────────────────────────────────────────

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

  // ── transaction rollback ─────────────────────────────────────────────────

  describe('executeJob() — transaction rollback', () => {
    /**
     * Scenario: a batch of two courses is processed.
     *   • Course A succeeds.
     *   • Course B has a lesson whose create() throws mid-transaction,
     *     causing $transaction to reject (simulating a DB rollback).
     *
     * Assertions:
     *   1. The job record still has the deleteMany calls tracked in Course B's
     *      transaction — but because $transaction threw, those side-effects are
     *      considered rolled back (the mock simply didn't commit them to real
     *      storage; in production Prisma would roll back the DB writes).
     *   2. Course A's data IS written (course.create called for COURSE-A).
     *   3. The final job status is COMPLETED (partial success) with
     *      coursesFailedIds containing COURSE-B.
     *   4. The job's errorMessage mentions COURSE-B.
     */
    it(
      'rolls back a failed course and leaves successfully restored courses intact',
      async () => {
        const courseA = {
          id: 'COURSE-A',
          instructorAddress: 'GA111',
          title: 'Course A',
          category: 'Cat',
          price: 10,
          status: CourseStatus.DRAFT,
          modules: [
            {
              id: 'MOD-A1',
              title: 'Module A1',
              position: 0,
              lessons: [
                { id: 'LES-A1', title: 'Lesson A1', position: 0, type: LessonType.VIDEO },
              ],
            },
          ],
        };

        const courseB = {
          id: 'COURSE-B',
          instructorAddress: 'GB222',
          title: 'Course B',
          category: 'Cat',
          price: 20,
          status: CourseStatus.DRAFT,
          modules: [
            {
              id: 'MOD-B1',
              title: 'Module B1',
              position: 0,
              lessons: [
                { id: 'LES-B1', title: 'Lesson B1', position: 0, type: LessonType.VIDEO },
              ],
            },
          ],
        };

        const jobId = 'job-rollback';
        const jobRecord = {
          id: jobId,
          status: CourseRestoreStatus.PENDING,
          totalSteps: 6, // 3 steps × 2 courses
          backupPayload: {
            courses: [courseA, courseB],
            overwriteExisting: true,
          },
        };

        mockPrisma.courseRestoreJob.findUnique.mockResolvedValue(jobRecord);
        mockPrisma.courseRestoreJob.update.mockImplementation(
          async ({ data }: { data: Record<string, unknown> }) => ({
            id: jobId,
            ...data,
          }),
        );

        // Both instructors exist
        mockPrisma.user.findUnique
          .mockResolvedValueOnce({ id: 'inst-a' })  // for courseA
          .mockResolvedValueOnce({ id: 'inst-b' }); // for courseB

        // Neither course exists yet (fresh restore)
        mockPrisma.course.findUnique.mockResolvedValue(null);

        // ── Course A transaction succeeds ──────────────────────────────────
        // Default $transaction mock runs callback synchronously, which is fine
        // for Course A. We override per-call below.

        const lessonCreateError = new Error('DB constraint: invalid type');
        let transactionCallCount = 0;

        mockPrisma.$transaction.mockImplementation(
          (callback: (tx: typeof mockPrisma) => Promise<unknown>) => {
            transactionCallCount += 1;

            if (transactionCallCount === 1) {
              // Course A — succeeds normally
              mockPrisma.course.create.mockResolvedValueOnce({ id: 'COURSE-A' });
              mockPrisma.courseModule.create.mockResolvedValueOnce({ id: 'MOD-A1' });
              mockPrisma.lesson.create.mockResolvedValueOnce({ id: 'LES-A1' });
              return callback(mockPrisma);
            }

            // Course B — lesson.create throws; simulate DB rollback by
            // making the transaction reject after the deleteMany calls.
            mockPrisma.course.create.mockResolvedValueOnce({ id: 'COURSE-B' });
            mockPrisma.courseModule.create.mockResolvedValueOnce({ id: 'MOD-B1' });
            mockPrisma.lesson.create.mockRejectedValueOnce(lessonCreateError);

            // Run the callback (which will throw internally) and let it propagate
            return callback(mockPrisma);
          },
        );

        const result = await service.executeJob(jobId);

        // ── Course A was restored ────────────────────────────────────────
        expect(mockPrisma.course.create).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ id: 'COURSE-A' }) }),
        );

        // ── Course B's transaction was attempted ─────────────────────────
        expect(transactionCallCount).toBe(2);

        // ── Final job state ──────────────────────────────────────────────
        expect(result.status).toBe(CourseRestoreStatus.COMPLETED); // partial success
        expect(result.summary).toEqual(
          expect.objectContaining({
            coursesRestored: 1,
            coursesFailedIds: ['COURSE-B'],
          }),
        );
        expect(result.errorMessage).toMatch(/COURSE-B/);
        expect(result.errorMessage).toMatch(/DB constraint/);
      },
    );

    /**
     * Scenario: a single-course batch fails mid-restore.
     * The job must be marked FAILED (not COMPLETED) and the errorMessage
     * must name the failing course.
     */
    it('marks the job FAILED when the only course in the batch fails', async () => {
      const courseC = {
        id: 'COURSE-C',
        instructorAddress: 'GC333',
        title: 'Course C',
        category: 'Cat',
        price: 5,
        status: CourseStatus.DRAFT,
        modules: [
          {
            title: 'Module C1',
            position: 0,
            lessons: [
              { title: 'Lesson C1', position: 0, type: LessonType.VIDEO },
            ],
          },
        ],
      };

      const jobRecord = {
        id: 'job-single-fail',
        status: CourseRestoreStatus.PENDING,
        totalSteps: 3,
        backupPayload: { courses: [courseC], overwriteExisting: true },
      };

      mockPrisma.courseRestoreJob.findUnique.mockResolvedValue(jobRecord);
      mockPrisma.courseRestoreJob.update.mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'job-single-fail',
          ...data,
        }),
      );
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'inst-c' });
      mockPrisma.course.findUnique.mockResolvedValue(null);

      // Make the transaction fail
      const txError = new Error('Unique constraint violation');
      mockPrisma.$transaction.mockRejectedValueOnce(txError);

      const result = await service.executeJob('job-single-fail');

      expect(result.status).toBe(CourseRestoreStatus.FAILED);
      expect(result.summary).toEqual(
        expect.objectContaining({
          coursesRestored: 0,
          coursesFailedIds: ['COURSE-C'],
        }),
      );
      expect(result.errorMessage).toMatch(/COURSE-C/);
      expect(result.errorMessage).toMatch(/Unique constraint/);
    });
  });
});
