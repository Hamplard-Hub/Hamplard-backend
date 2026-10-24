import { Test, TestingModule } from '@nestjs/testing';
import { ExamsService } from './exams.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import { UserRole } from '@prisma/client';

describe('ExamsService', () => {
  let service: ExamsService;
  let prisma: any;

  const mockPrisma = {
    course: { findUnique: jest.fn() },
    exam: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    enrollment: { findUnique: jest.fn() },
    examAttempt: {
      findFirst: jest.fn(),
      create: jest.fn(),
      findMany: jest.fn(),
    },
    $executeRaw: jest.fn(),
    // Interactive transactions run the callback against the same mock client.
    $transaction: jest.fn((fn: (tx: any) => unknown) => fn(mockPrisma)),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExamsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<ExamsService>(ExamsService);
    prisma = module.get(PrismaService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('checkEligibility', () => {
    it('should return ineligible if student is not enrolled', async () => {
      mockPrisma.exam.findUnique.mockResolvedValue({
        id: 'exam-1',
        courseId: 'course-1',
        cooldownHours: 24,
      });
      mockPrisma.enrollment.findUnique.mockResolvedValue(null);

      const res = await service.checkEligibility('student-1', 'exam-1');
      expect(res.eligible).toBe(false);
      expect(res.reason).toContain('not enrolled');
    });

    it('should return ineligible if progress is under 100%', async () => {
      mockPrisma.exam.findUnique.mockResolvedValue({
        id: 'exam-1',
        courseId: 'course-1',
        cooldownHours: 24,
      });
      mockPrisma.enrollment.findUnique.mockResolvedValue({
        progressPercent: 50,
        status: 'ACTIVE',
      });

      const res = await service.checkEligibility('student-1', 'exam-1');
      expect(res.eligible).toBe(false);
      expect(res.reason).toContain('100% completed');
    });

    it('should return ineligible if student is under retake cooldown', async () => {
      mockPrisma.exam.findUnique.mockResolvedValue({
        id: 'exam-1',
        courseId: 'course-1',
        cooldownHours: 24,
      });
      mockPrisma.enrollment.findUnique.mockResolvedValue({
        progressPercent: 100,
        status: 'COMPLETED',
      });
      mockPrisma.examAttempt.findFirst.mockResolvedValue({
        passed: false,
        attemptedAt: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2 hours ago
      });

      const res = await service.checkEligibility('student-1', 'exam-1');
      expect(res.eligible).toBe(false);
      expect(res.reason).toContain('cooldown');
    });

    it('should return eligible if requirements are met', async () => {
      mockPrisma.exam.findUnique.mockResolvedValue({
        id: 'exam-1',
        courseId: 'course-1',
        cooldownHours: 24,
      });
      mockPrisma.enrollment.findUnique.mockResolvedValue({
        progressPercent: 100,
        status: 'COMPLETED',
      });
      mockPrisma.examAttempt.findFirst.mockResolvedValue(null);

      const res = await service.checkEligibility('student-1', 'exam-1');
      expect(res.eligible).toBe(true);
    });
  });

  describe('submitExam', () => {
    it('should validate answers and pass exam if score >= passingScore', async () => {
      const questions = [
        { id: 'q1', points: 1, correctAnswer: [0] },
        { id: 'q2', points: 1, correctAnswer: [1] },
      ];

      mockPrisma.exam.findUnique.mockResolvedValue({
        id: 'exam-1',
        courseId: 'course-1',
        passingScore: 70,
        cooldownHours: 24,
        questions,
      });
      mockPrisma.enrollment.findUnique.mockResolvedValue({
        progressPercent: 100,
        status: 'COMPLETED',
      });
      mockPrisma.examAttempt.findFirst.mockResolvedValue(null);
      mockPrisma.examAttempt.create.mockImplementation(({ data }) => Promise.resolve({ id: 'attempt-1', ...data }));

      const res = await service.submitExam('student-1', 'exam-1', {
        answers: { q1: [0], q2: [1] },
      });

      expect(res.score).toBe(100);
      expect(res.passed).toBe(true);
    });

    // ----------------------------------------------------------
    // Issue #304 — parallel submissions and answer types
    // ----------------------------------------------------------

    const eligibleStudent = (questions: unknown[]) => {
      mockPrisma.exam.findUnique.mockResolvedValue({
        id: 'exam-1',
        courseId: 'course-1',
        passingScore: 70,
        cooldownHours: 24,
        questions,
      });
      mockPrisma.enrollment.findUnique.mockResolvedValue({ progressPercent: 100, status: 'COMPLETED' });
      mockPrisma.examAttempt.findFirst.mockResolvedValue(null);
      mockPrisma.examAttempt.create.mockImplementation(({ data }) => Promise.resolve({ id: 'attempt-1', ...data }));
    };

    it('takes the per-student exam lock before reading the last attempt, in the same transaction', async () => {
      eligibleStudent([{ id: 'q1', points: 1, correctAnswer: [0] }]);

      await service.submitExam('student-1', 'exam-1', { answers: { q1: [0] } });

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      const [sql, ...params] = mockPrisma.$executeRaw.mock.calls[0];
      expect(sql.join('?')).toContain('pg_advisory_xact_lock');
      expect(params).toEqual(['student-1', 'exam-1']);
      const lockedAt = mockPrisma.$executeRaw.mock.invocationCallOrder[0];
      expect(lockedAt).toBeLessThan(mockPrisma.examAttempt.findFirst.mock.invocationCallOrder[0]);
      expect(lockedAt).toBeLessThan(mockPrisma.examAttempt.create.mock.invocationCallOrder[0]);
    });

    it('rejects a submission that finds an attempt inside the cooldown and records nothing', async () => {
      eligibleStudent([{ id: 'q1', points: 1, correctAnswer: [0] }]);
      // What the second of two parallel requests sees once the first has committed.
      mockPrisma.examAttempt.findFirst.mockResolvedValue({ passed: false, attemptedAt: new Date() });

      await expect(
        service.submitExam('student-1', 'exam-1', { answers: { q1: [0] } }),
      ).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.examAttempt.create).not.toHaveBeenCalled();
    });

    it('grades answers regardless of number/string type, whitespace and order', async () => {
      eligibleStudent([
        { id: 'q1', points: 1, correctAnswer: 1 },
        { id: 'q2', points: 1, correctAnswer: ['a', 'b'] },
        { id: 'q3', points: 1, correctAnswer: [0, 2] },
        { id: 'q4', points: 1, correctAnswer: 3 },
      ]);

      const res = await service.submitExam('student-1', 'exam-1', {
        answers: { q1: '1', q2: ['b', ' a '], q3: ['2', 0], q4: '4' },
      });

      expect(res.score).toBe(75);
      expect(res.passed).toBe(true);
    });

    it('does not credit a question that has no answer key', async () => {
      eligibleStudent([{ id: 'q1', points: 1 }]);

      const res = await service.submitExam('student-1', 'exam-1', { answers: { q1: 'undefined' } });

      expect(res.score).toBe(0);
    });
  });

  describe('deleteExam', () => {
    const mockExam = {
      id: 'exam-1',
      courseId: 'course-1',
      course: {
        id: 'course-1',
        instructor: { id: 'instructor-1' },
        instructorAddress: 'GBB123',
      },
    };

    it('should delete exam if requested by course instructor', async () => {
      mockPrisma.exam.findUnique.mockResolvedValue(mockExam);
      mockPrisma.examAttempt.findFirst.mockResolvedValue(null);
      mockPrisma.exam.delete.mockResolvedValue(mockExam);

      const result = await service.deleteExam('exam-1', 'instructor-1', UserRole.INSTRUCTOR);
      expect(result).toEqual(mockExam);
      expect(mockPrisma.exam.delete).toHaveBeenCalledWith({ where: { id: 'exam-1' } });
    });

    it('should delete exam if requested by admin', async () => {
      mockPrisma.exam.findUnique.mockResolvedValue(mockExam);
      mockPrisma.examAttempt.findFirst.mockResolvedValue(null);
      mockPrisma.exam.delete.mockResolvedValue(mockExam);

      const result = await service.deleteExam('exam-1', 'admin-99', UserRole.ADMIN);
      expect(result).toEqual(mockExam);
    });

    it('should throw ForbiddenException if requested by another instructor', async () => {
      mockPrisma.exam.findUnique.mockResolvedValue(mockExam);

      await expect(
        service.deleteExam('exam-1', 'other-instructor', UserRole.INSTRUCTOR),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw BadRequestException if student attempts exist', async () => {
      mockPrisma.exam.findUnique.mockResolvedValue(mockExam);
      mockPrisma.examAttempt.findFirst.mockResolvedValue({ id: 'attempt-1' });

      await expect(
        service.deleteExam('exam-1', 'instructor-1', UserRole.INSTRUCTOR),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException if exam does not exist', async () => {
      mockPrisma.exam.findUnique.mockResolvedValue(null);

      await expect(
        service.deleteExam('missing-exam', 'instructor-1', UserRole.INSTRUCTOR),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ----------------------------------------------------------
  // Issue #235 — answer key protection
  // ----------------------------------------------------------

  describe('getExamByCourse', () => {
    const storedExam = {
      id: 'exam-1',
      courseId: 'course-1',
      title: 'Certification Exam',
      passingScore: 70,
      cooldownHours: 24,
      questions: [
        { id: 'q1', question: 'Pick one', options: ['A', 'B'], points: 1, correctAnswer: [0], explanation: 'A is right' },
        { id: 'q2', question: 'Pick two', options: ['A', 'B', 'C'], points: 2, correctAnswer: [1, 2] },
      ],
      course: { instructorAddress: 'GOWNER' },
    };

    const student = { id: 'student-1', stellarAddress: 'GSTUDENT', role: UserRole.STUDENT };
    const owner = { id: 'instructor-1', stellarAddress: 'GOWNER', role: UserRole.INSTRUCTOR };
    const otherInstructor = { id: 'instructor-2', stellarAddress: 'GOTHER', role: UserRole.INSTRUCTOR };
    const admin = { id: 'admin-1', stellarAddress: null, role: UserRole.ADMIN };

    beforeEach(() => {
      mockPrisma.exam.findUnique.mockResolvedValue(storedExam);
    });

    it('strips correctAnswer and explanation for an enrolled student', async () => {
      mockPrisma.enrollment.findUnique.mockResolvedValue({ status: 'ACTIVE' });

      const exam: any = await service.getExamByCourse('course-1', student);

      expect(exam.questions).toEqual([
        { id: 'q1', question: 'Pick one', options: ['A', 'B'], points: 1 },
        { id: 'q2', question: 'Pick two', options: ['A', 'B', 'C'], points: 2 },
      ]);
      expect(exam).not.toHaveProperty('course');
      expect(JSON.stringify(exam)).not.toContain('correctAnswer');
      expect(mockPrisma.enrollment.findUnique).toHaveBeenCalledWith({
        where: { studentId_courseId: { studentId: 'student-1', courseId: 'course-1' } },
        select: { status: true },
      });
    });

    it('rejects a student who is not enrolled with 403', async () => {
      mockPrisma.enrollment.findUnique.mockResolvedValue(null);

      await expect(service.getExamByCourse('course-1', student)).rejects.toThrow(ForbiddenException);
    });

    it('rejects a refunded enrollment with 403', async () => {
      mockPrisma.enrollment.findUnique.mockResolvedValue({ status: 'REFUNDED' });

      await expect(service.getExamByCourse('course-1', student)).rejects.toThrow(ForbiddenException);
    });

    it('treats a non-owner instructor like a student (403 when not enrolled)', async () => {
      mockPrisma.enrollment.findUnique.mockResolvedValue(null);

      await expect(
        service.getExamByCourse('course-1', otherInstructor),
      ).rejects.toThrow(ForbiddenException);
    });

    it('returns the full answer key to the course owner', async () => {
      const exam: any = await service.getExamByCourse('course-1', owner);

      expect(exam.questions[0]).toEqual(
        expect.objectContaining({ correctAnswer: [0], explanation: 'A is right' }),
      );
      expect(mockPrisma.enrollment.findUnique).not.toHaveBeenCalled();
    });

    it('returns the full answer key to an admin', async () => {
      const exam: any = await service.getExamByCourse('course-1', admin);

      expect(exam.questions[1]).toHaveProperty('correctAnswer', [1, 2]);
      expect(mockPrisma.enrollment.findUnique).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the course has no exam', async () => {
      mockPrisma.exam.findUnique.mockResolvedValue(null);

      await expect(service.getExamByCourse('course-1', student)).rejects.toThrow(NotFoundException);
    });
  });
});
