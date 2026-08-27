import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CourseRestoreStatus, CourseStatus, LessonType } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RestoreService } from './restore.service';

describe('RestoreService', () => {
  let service: RestoreService;

  const mockPrisma = {
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
  });

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
      mockPrisma.courseRestoreJob.update.mockImplementation(async ({ data }) => ({
        id: 'job-2',
        ...data,
      }));
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

  describe('getStatus()', () => {
    it('throws when job is missing', async () => {
      mockPrisma.courseRestoreJob.findUnique.mockResolvedValue(null);
      await expect(service.getStatus('missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

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
});
