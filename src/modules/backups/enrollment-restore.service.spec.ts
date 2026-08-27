import { Test, TestingModule } from '@nestjs/testing';
import { EnrollmentStatus } from '@prisma/client';
import { EnrollmentsService } from '../enrollments/enrollments.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  EnrollmentConflictStrategy,
} from './dto/restore-enrollments.dto';
import { EnrollmentRestoreService } from './enrollment-restore.service';

describe('EnrollmentRestoreService', () => {
  let service: EnrollmentRestoreService;

  const mockPrisma = {
    user: { findUnique: jest.fn() },
    course: { findUnique: jest.fn() },
    enrollment: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    lessonProgress: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  };

  const mockEnrollments = {
    upsertFromBackup: jest.fn(),
  };

  const COURSE = {
    id: 'course-1',
    modules: [
      { lessons: [{ id: 'lesson-1' }, { id: 'lesson-2' }] },
    ],
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EnrollmentRestoreService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EnrollmentsService, useValue: mockEnrollments },
      ],
    }).compile();

    service = module.get(EnrollmentRestoreService);
    jest.clearAllMocks();
  });

  it('restores enrollments and tracks counts', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'student-1' });
    mockPrisma.course.findUnique.mockResolvedValue(COURSE);
    mockEnrollments.upsertFromBackup.mockResolvedValue({
      enrollment: { id: 'enroll-1', studentId: 'student-1', courseId: 'course-1' },
      action: 'created',
    });
    mockPrisma.lessonProgress.findUnique.mockResolvedValue(null);
    mockPrisma.lessonProgress.create.mockResolvedValue({ id: 'prog-1' });

    const report = await service.restore('admin-1', {
      conflictStrategy: EnrollmentConflictStrategy.SKIP,
      enrollments: [
        {
          studentId: 'student-1',
          courseId: 'course-1',
          amountPaid: 50,
          status: EnrollmentStatus.ACTIVE,
          progressPercent: 40,
          lessonProgress: [
            { lessonId: 'lesson-1', completed: true, watchedSecs: 120 },
            { lessonId: 'missing-lesson', completed: false },
          ],
        },
      ],
    });

    expect(report.counts.enrollmentsRestored).toBe(1);
    expect(report.counts.progressRestored).toBe(1);
    expect(report.counts.progressSkipped).toBe(1);
    expect(report.issues.some((i) => i.lessonId === 'missing-lesson')).toBe(true);
    expect(service.getReport(report.id)).toEqual(report);
    expect(service.listReports()).toHaveLength(1);
  });

  it('skips invalid enrollments when course is missing', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'student-1' });
    mockPrisma.course.findUnique.mockResolvedValue(null);

    const report = await service.restore('admin-1', {
      enrollments: [
        {
          studentId: 'student-1',
          courseId: 'gone-course',
          amountPaid: 10,
        },
      ],
    });

    expect(report.counts.validationFailures).toBe(1);
    expect(report.counts.enrollmentsSkipped).toBe(1);
    expect(report.counts.enrollmentsRestored).toBe(0);
    expect(mockEnrollments.upsertFromBackup).not.toHaveBeenCalled();
  });

  it('resolves conflicts with OVERWRITE strategy', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'student-1' });
    mockPrisma.course.findUnique.mockResolvedValue(COURSE);
    mockEnrollments.upsertFromBackup.mockResolvedValue({
      enrollment: { id: 'enroll-1' },
      action: 'overwritten',
    });

    const report = await service.restore('admin-1', {
      conflictStrategy: EnrollmentConflictStrategy.OVERWRITE,
      enrollments: [
        {
          studentId: 'student-1',
          courseId: 'course-1',
          amountPaid: 99,
          progressPercent: 80,
        },
      ],
    });

    expect(report.counts.enrollmentsOverwritten).toBe(1);
    expect(report.counts.enrollmentsRestored).toBe(1);
    expect(mockEnrollments.upsertFromBackup).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'overwrite' }),
    );
  });

  it('tracks skipped conflicts', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'student-1' });
    mockPrisma.course.findUnique.mockResolvedValue(COURSE);
    mockEnrollments.upsertFromBackup.mockResolvedValue({
      enrollment: { id: 'enroll-1' },
      action: 'skipped',
    });

    const report = await service.restore('admin-1', {
      conflictStrategy: EnrollmentConflictStrategy.SKIP,
      enrollments: [
        {
          studentId: 'student-1',
          courseId: 'course-1',
          amountPaid: 10,
        },
      ],
    });

    expect(report.counts.enrollmentsSkipped).toBe(1);
    expect(report.counts.enrollmentsRestored).toBe(0);
  });
});
