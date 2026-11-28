import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException, ValidationPipe } from '@nestjs/common';
import { AssignmentStatus, EnrollmentStatus, UserRole } from '@prisma/client';
import { AssignmentsService } from './assignments.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SubmitAssignmentDto } from './dto/submit-assignment.dto';

describe('AssignmentsService - findSubmissionsByStudent pagination', () => {
  let service: AssignmentsService;

  const mockPrisma: any = {
    assignment: { findUnique: jest.fn() },
    enrollment: { findUnique: jest.fn() },
    assignmentSubmission: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    user: { findUnique: jest.fn() },
  };
  const mockNotifications = { notifyUser: jest.fn().mockResolvedValue({}) };

  const STUDENT_A = { id: 'student-a', role: UserRole.STUDENT };
  const STUDENT_B = { id: 'student-b', role: UserRole.STUDENT };
  const OWNER = { id: 'instructor-1', role: UserRole.INSTRUCTOR };
  const OTHER_INSTRUCTOR = { id: 'instructor-2', role: UserRole.INSTRUCTOR };
  const ADMIN = { id: 'admin-1', role: UserRole.ADMIN };

  const ASSIGNMENT_WITH_SUBMISSIONS = {
    id: 'assign-1',
    lessonId: 'lesson-1',
    title: 'Practical Sewing Task',
    submissions: [
      { id: 'sub-a', studentId: 'student-a', submissionUrl: 'https://cdn.test/a.jpg' },
      { id: 'sub-b', studentId: 'student-b', submissionUrl: 'https://cdn.test/b.jpg' },
    ],
    lesson: { module: { course: { instructor: { id: 'instructor-1' } } } },
  };
  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AssignmentsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationsService, useValue: mockNotifications },
      ],
    })
      .useMocker(() => ({}))
      .compile();

    service = module.get<AssignmentsService>(AssignmentsService);
    jest.clearAllMocks();
  });

  it('returns paginated submissions with meta', async () => {
    mockPrisma.assignmentSubmission.findMany.mockResolvedValue([{ id: 'sub-1' }]);
    mockPrisma.assignmentSubmission.count.mockResolvedValue(15);

    const result = await service.findSubmissionsByStudent('student-1', 2, 5);

    expect(result).toEqual({
      data: [{ id: 'sub-1' }],
      meta: { total: 15, page: 2, limit: 5, totalPages: 3 },
    });
    expect(mockPrisma.assignmentSubmission.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { studentId: 'student-1' },
        orderBy: { submittedAt: 'desc' },
        skip: 5,
        take: 5,
      }),
    );
  });

  it('does not leak the ownership lookup in the response', async () => {
    const result = await service.findByLesson('lesson-1', ADMIN);
    expect(result).not.toHaveProperty('lesson');
  });

  it('throws NotFoundException when the lesson has no assignment', async () => {
    mockPrisma.assignment.findUnique.mockResolvedValue(null);
    await expect(service.findByLesson('missing', STUDENT_A)).rejects.toThrow(NotFoundException);
  });

  describe('submit() — existence and enrollment checks', () => {
    const URL = 'https://cdn.test/garment.jpg';

    beforeEach(() => {
      mockPrisma.assignment.findUnique.mockResolvedValue({
        id: 'assign-1',
        lesson: { module: { courseId: 'course-1' } },
      });
      mockPrisma.assignmentSubmission.findUnique.mockResolvedValue(null);
      mockPrisma.assignmentSubmission.upsert.mockResolvedValue({
        id: 'sub-a',
        status: AssignmentStatus.SUBMITTED,
        assignment: {
          title: 'Practical Sewing Task',
          lesson: { module: { course: { instructorAddress: 'GINSTRUCTOR' } } },
        },
      });
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'instructor-1' });
    });

    it('throws NotFoundException for an unknown assignment ID without writing', async () => {
      mockPrisma.assignment.findUnique.mockResolvedValue(null);

      await expect(service.submit('student-a', 'nope', URL)).rejects.toThrow(NotFoundException);
      expect(mockPrisma.assignmentSubmission.upsert).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException for a student who is not enrolled', async () => {
      mockPrisma.enrollment.findUnique.mockResolvedValue(null);

      await expect(service.submit('student-a', 'assign-1', URL)).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.enrollment.findUnique).toHaveBeenCalledWith({
        where: { studentId_courseId: { studentId: 'student-a', courseId: 'course-1' } },
        select: { status: true },
      });
      expect(mockPrisma.assignmentSubmission.upsert).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException for a refunded enrollment', async () => {
      mockPrisma.enrollment.findUnique.mockResolvedValue({ status: EnrollmentStatus.REFUNDED });

      await expect(service.submit('student-a', 'assign-1', URL)).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.assignmentSubmission.upsert).not.toHaveBeenCalled();
    });

    it('accepts a submission from an enrolled student and notifies the instructor', async () => {
      mockPrisma.enrollment.findUnique.mockResolvedValue({ status: EnrollmentStatus.ACTIVE });

      const result = await service.submit('student-a', 'assign-1', URL, 'notes');

      expect(result.id).toBe('sub-a');
      expect(mockPrisma.assignmentSubmission.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ studentId: 'student-a', submissionUrl: URL }),
        }),
      );
      expect(mockNotifications.notifyUser).toHaveBeenCalledTimes(1);
    });
  });

  describe('findPendingForInstructor() (issue #434)', () => {
    beforeEach(() => {
      mockPrisma.assignmentSubmission.findMany.mockResolvedValue([]);
      mockPrisma.assignmentSubmission.count.mockResolvedValue(0);
    });

    it('scopes pending submissions by the instructor user relation', async () => {
      await service.findPendingForInstructor('instructor-1', 2, 10);

      const expectedWhere = {
        status: AssignmentStatus.SUBMITTED,
        assignment: {
          lesson: {
            module: { course: { instructor: { id: 'instructor-1' } } },
          },
        },
      };
      expect(mockPrisma.assignmentSubmission.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expectedWhere, skip: 10, take: 10 }),
      );
      expect(mockPrisma.assignmentSubmission.count).toHaveBeenCalledWith({ where: expectedWhere });
    });

    it('returns an empty page for a Google-only instructor with no Stellar address', async () => {
      const result = await service.findPendingForInstructor('google-only-instructor');

      expect(result).toEqual({
        data: [],
        meta: { total: 0, page: 1, limit: 20, totalPages: 0 },
      });
      expect(mockPrisma.assignmentSubmission.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            assignment: {
              lesson: {
                module: { course: { instructor: { id: 'google-only-instructor' } } },
              },
            },
          }),
        }),
      );
    });

    it('rejects a missing instructor id instead of querying platform-wide data', async () => {
      await expect(service.findPendingForInstructor(undefined)).rejects.toThrow(BadRequestException);
      expect(mockPrisma.assignmentSubmission.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.assignmentSubmission.count).not.toHaveBeenCalled();
    });
  });
});

describe('SubmitAssignmentDto validation (#244)', () => {
  // Mirrors the global ValidationPipe options in main.ts.
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const validateBody = (body: unknown) =>
    pipe.transform(body, { type: 'body', metatype: SubmitAssignmentDto });

  it('accepts a valid https URL with optional notes', async () => {
    await expect(
      validateBody({ submissionUrl: 'https://cdn.hamplard.com/a.jpg', notes: 'done' }),
    ).resolves.toBeInstanceOf(SubmitAssignmentDto);
  });

  it.each([
    ['a missing URL', {}],
    ['a non-URL string', { submissionUrl: 'not a url' }],
    ['a URL without protocol', { submissionUrl: 'cdn.hamplard.com/a.jpg' }],
    ['a javascript: URL', { submissionUrl: 'javascript:alert(1)' }],
    ['an unknown property', { submissionUrl: 'https://cdn.hamplard.com/a.jpg', grade: 'A' }],
  ])('rejects %s with 400', async (_label, body) => {
    await expect(validateBody(body)).rejects.toThrow(BadRequestException);
  });
});
