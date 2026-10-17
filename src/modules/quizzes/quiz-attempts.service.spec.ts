import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { QuizAttemptsService } from './quiz-attempts.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EnrollmentStatus, QuestionType } from '@prisma/client';

describe('QuizAttemptsService', () => {
  let service: QuizAttemptsService;

  const mockPrisma: any = {
    lesson: { findUnique: jest.fn() },
    enrollment: { findUnique: jest.fn() },
    quizQuestion: { findMany: jest.fn() },
    quizAttempt: {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      findFirst: jest.fn(),
    },
  };

  const lesson = (overrides: Record<string, unknown> = {}) => ({
    id: 'lesson-1',
    isFree: false,
    passThreshold: 70,
    maxAttempts: null,
    attemptCooldownMinutes: 0,
    module: { courseId: 'course-1' },
    ...overrides,
  });

  const questions = [
    {
      id: 'q-1',
      lessonId: 'lesson-1',
      question: 'What is 2 + 2?',
      type: QuestionType.SINGLE_CHOICE,
      correctAnswer: [1],
      explanation: '2 + 2 = 4',
      points: 2,
    },
    {
      id: 'q-2',
      lessonId: 'lesson-1',
      question: 'The sky is blue.',
      type: QuestionType.TRUE_FALSE,
      correctAnswer: ['true'],
      explanation: null,
      points: 1,
    },
  ];

  const allCorrect = {
    answers: [
      { questionId: 'q-1', answer: [1] },
      { questionId: 'q-2', answer: ['true'] },
    ],
  };
  // q-1 correct (2 pts), q-2 wrong → 2/3 = 66.67%
  const twoThirds = {
    answers: [
      { questionId: 'q-1', answer: [1] },
      { questionId: 'q-2', answer: ['false'] },
    ],
  };
  const allWrong = {
    answers: [
      { questionId: 'q-1', answer: [0] },
      { questionId: 'q-2', answer: ['false'] },
    ],
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QuizAttemptsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<QuizAttemptsService>(QuizAttemptsService);
    jest.clearAllMocks();

    mockPrisma.lesson.findUnique.mockResolvedValue(lesson());
    mockPrisma.enrollment.findUnique.mockResolvedValue({ status: EnrollmentStatus.ACTIVE });
    mockPrisma.quizQuestion.findMany.mockResolvedValue(questions);
    mockPrisma.quizAttempt.count.mockResolvedValue(0);
    mockPrisma.quizAttempt.findFirst.mockResolvedValue(null);
    mockPrisma.quizAttempt.create.mockResolvedValue({
      id: 'attempt-1',
      attemptedAt: new Date(),
    });
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('submitQuizAttempt', () => {
    it('persists the computed result as a QuizAttempt row', async () => {
      const attemptedAt = new Date();
      mockPrisma.quizAttempt.create.mockResolvedValue({
        id: 'attempt-1',
        attemptedAt,
      });

      const result = await service.submitQuizAttempt('lesson-1', allCorrect, 'student-1');

      expect(mockPrisma.quizAttempt.create).toHaveBeenCalledWith({
        data: {
          lessonId: 'lesson-1',
          studentId: 'student-1',
          score: 100,
          passed: true,
          answers: expect.any(Array),
        },
      });
      expect(result.attemptId).toBe('attempt-1');
      expect(result.scorePercentage).toBe(100);
      expect(result.passed).toBe(true);
      expect(result.submittedAt).toBe(attemptedAt.toISOString());
    });

    it('persists failing attempts too', async () => {
      const result = await service.submitQuizAttempt('lesson-1', allWrong, 'student-1');

      expect(result.passed).toBe(false);
      expect(mockPrisma.quizAttempt.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          lessonId: 'lesson-1',
          studentId: 'student-1',
          passed: false,
        }),
      });
    });

    it('rejects answers for questions outside the lesson without persisting', async () => {
      await expect(
        service.submitQuizAttempt(
          'lesson-1',
          { answers: [{ questionId: 'other', answer: [0] }] },
          'student-1',
        ),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.quizAttempt.create).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for an unknown lesson', async () => {
      mockPrisma.lesson.findUnique.mockResolvedValue(null);
      await expect(
        service.submitQuizAttempt('missing', allCorrect, 'student-1'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ----------------------------------------------------------
  // Issue #236 — server-enforced pass threshold
  // ----------------------------------------------------------

  describe('server-stored pass threshold (#236)', () => {
    it('grades against the lesson passThreshold from the database', async () => {
      mockPrisma.lesson.findUnique.mockResolvedValue(lesson({ passThreshold: 60 }));

      const result = await service.submitQuizAttempt('lesson-1', twoThirds, 'student-1');

      expect(result.scorePercentage).toBeCloseTo(66.67);
      expect(result.passThresholdPercentage).toBe(60);
      expect(result.passed).toBe(true);
    });

    it('fails the same score when the stored threshold is higher', async () => {
      mockPrisma.lesson.findUnique.mockResolvedValue(lesson({ passThreshold: 90 }));

      const result = await service.submitQuizAttempt('lesson-1', twoThirds, 'student-1');

      expect(result.passThresholdPercentage).toBe(90);
      expect(result.passed).toBe(false);
    });

    it('ignores a passThreshold smuggled into the payload', async () => {
      mockPrisma.lesson.findUnique.mockResolvedValue(lesson({ passThreshold: 70 }));

      const result = await service.submitQuizAttempt(
        'lesson-1',
        { ...allWrong, passThreshold: 0 } as any,
        'student-1',
      );

      expect(result.passThresholdPercentage).toBe(70);
      expect(result.passed).toBe(false);
      expect(mockPrisma.quizAttempt.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ passed: false }),
      });
    });
  });

  // ----------------------------------------------------------
  // Issue #238 — enrollment gating, attempt limits, answer masking
  // ----------------------------------------------------------

  describe('enrollment gating (#238)', () => {
    it('rejects a user with no enrollment with 403', async () => {
      mockPrisma.enrollment.findUnique.mockResolvedValue(null);

      await expect(
        service.submitQuizAttempt('lesson-1', allCorrect, 'student-1'),
      ).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.enrollment.findUnique).toHaveBeenCalledWith({
        where: { studentId_courseId: { studentId: 'student-1', courseId: 'course-1' } },
        select: { status: true },
      });
      expect(mockPrisma.quizAttempt.create).not.toHaveBeenCalled();
    });

    it('rejects a REFUNDED enrollment with 403', async () => {
      mockPrisma.enrollment.findUnique.mockResolvedValue({ status: EnrollmentStatus.REFUNDED });

      await expect(
        service.submitQuizAttempt('lesson-1', allCorrect, 'student-1'),
      ).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.quizAttempt.create).not.toHaveBeenCalled();
    });

    it('accepts a COMPLETED enrollment', async () => {
      mockPrisma.enrollment.findUnique.mockResolvedValue({ status: EnrollmentStatus.COMPLETED });

      await expect(
        service.submitQuizAttempt('lesson-1', allCorrect, 'student-1'),
      ).resolves.toEqual(expect.objectContaining({ passed: true }));
    });

    it('lets anyone attempt a free preview lesson without enrollment', async () => {
      mockPrisma.lesson.findUnique.mockResolvedValue(lesson({ isFree: true }));
      mockPrisma.enrollment.findUnique.mockResolvedValue(null);

      await service.submitQuizAttempt('lesson-1', allCorrect, 'student-1');

      expect(mockPrisma.enrollment.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.quizAttempt.create).toHaveBeenCalled();
    });
  });

  describe('attempt limits and cooldown (#238)', () => {
    it('blocks submissions once maxAttempts is reached', async () => {
      mockPrisma.lesson.findUnique.mockResolvedValue(lesson({ maxAttempts: 3 }));
      mockPrisma.quizAttempt.count.mockResolvedValue(3);

      await expect(
        service.submitQuizAttempt('lesson-1', allCorrect, 'student-1'),
      ).rejects.toThrow(/Maximum number of attempts/);
      expect(mockPrisma.quizAttempt.create).not.toHaveBeenCalled();
    });

    it('allows the final attempt and reports attempts remaining', async () => {
      mockPrisma.lesson.findUnique.mockResolvedValue(lesson({ maxAttempts: 3 }));
      mockPrisma.quizAttempt.count.mockResolvedValue(2);

      const result = await service.submitQuizAttempt('lesson-1', allWrong, 'student-1');

      expect(result.attemptNumber).toBe(3);
      expect(result.attemptsRemaining).toBe(0);
    });

    it('reports unlimited attempts as null', async () => {
      const result = await service.submitQuizAttempt('lesson-1', allWrong, 'student-1');
      expect(result.attemptsRemaining).toBeNull();
    });

    it('blocks submissions inside the cooldown window', async () => {
      mockPrisma.lesson.findUnique.mockResolvedValue(lesson({ attemptCooldownMinutes: 30 }));
      mockPrisma.quizAttempt.count.mockResolvedValue(1);
      mockPrisma.quizAttempt.findFirst.mockResolvedValue({
        attemptedAt: new Date(Date.now() - 10 * 60 * 1000),
      });

      await expect(
        service.submitQuizAttempt('lesson-1', allCorrect, 'student-1'),
      ).rejects.toThrow(/cooldown/);
      expect(mockPrisma.quizAttempt.create).not.toHaveBeenCalled();
    });

    it('allows a retake once the cooldown has elapsed', async () => {
      mockPrisma.lesson.findUnique.mockResolvedValue(lesson({ attemptCooldownMinutes: 30 }));
      mockPrisma.quizAttempt.count.mockResolvedValue(1);
      mockPrisma.quizAttempt.findFirst.mockResolvedValue({
        attemptedAt: new Date(Date.now() - 31 * 60 * 1000),
      });

      await expect(
        service.submitQuizAttempt('lesson-1', allCorrect, 'student-1'),
      ).resolves.toEqual(expect.objectContaining({ attemptNumber: 2 }));
    });
  });

  describe('answer key masking (#238)', () => {
    it('hides correctAnswer and explanation on a failed non-final attempt', async () => {
      mockPrisma.lesson.findUnique.mockResolvedValue(lesson({ maxAttempts: 3 }));

      const result = await service.submitQuizAttempt('lesson-1', allWrong, 'student-1');

      expect(result.answersRevealed).toBe(false);
      for (const answer of result.answers) {
        expect(answer).not.toHaveProperty('correctAnswer');
        expect(answer).not.toHaveProperty('explanation');
        expect(answer).toHaveProperty('isCorrect', false);
      }
      // The full key is still persisted server-side for grading audits.
      const persisted = mockPrisma.quizAttempt.create.mock.calls[0][0].data.answers;
      expect(persisted[0]).toHaveProperty('correctAnswer', [1]);
    });

    it('hides the answer key when attempts are unlimited and the student failed', async () => {
      const result = await service.submitQuizAttempt('lesson-1', allWrong, 'student-1');
      expect(result.answersRevealed).toBe(false);
      expect(result.answers[0]).not.toHaveProperty('correctAnswer');
    });

    it('reveals the answer key on the final allowed attempt', async () => {
      mockPrisma.lesson.findUnique.mockResolvedValue(lesson({ maxAttempts: 2 }));
      mockPrisma.quizAttempt.count.mockResolvedValue(1);

      const result = await service.submitQuizAttempt('lesson-1', allWrong, 'student-1');

      expect(result.answersRevealed).toBe(true);
      expect(result.answers[0]).toEqual(
        expect.objectContaining({ correctAnswer: [1], explanation: '2 + 2 = 4' }),
      );
    });

    it('reveals the answer key once the student passes', async () => {
      const result = await service.submitQuizAttempt('lesson-1', allCorrect, 'student-1');
      expect(result.answersRevealed).toBe(true);
      expect(result.answers[0]).toHaveProperty('correctAnswer', [1]);
    });
  });

  describe('getAttemptHistory', () => {
    it('returns the student’s attempts for a lesson, newest first', async () => {
      const rows = [
        { id: 'attempt-2', lessonId: 'lesson-1', studentId: 'student-1', score: 40, passed: false },
        { id: 'attempt-1', lessonId: 'lesson-1', studentId: 'student-1', score: 100, passed: true },
      ];
      mockPrisma.quizAttempt.findMany.mockResolvedValue(rows);

      const history = await service.getAttemptHistory('student-1', 'lesson-1');

      expect(mockPrisma.quizAttempt.findMany).toHaveBeenCalledWith({
        where: { studentId: 'student-1', lessonId: 'lesson-1' },
        orderBy: { attemptedAt: 'desc' },
      });
      expect(history).toEqual(rows);
    });

    it('strips the answer key from stored breakdowns until reveal is allowed', async () => {
      mockPrisma.lesson.findUnique.mockResolvedValue({ maxAttempts: 3 });
      mockPrisma.quizAttempt.findMany.mockResolvedValue([
        {
          id: 'attempt-1',
          passed: false,
          answers: [
            { questionId: 'q-1', isCorrect: false, correctAnswer: [1], explanation: '2 + 2 = 4' },
          ],
        },
      ]);

      const history: any[] = await service.getAttemptHistory('student-1', 'lesson-1');

      expect(history[0].answers[0]).toEqual({ questionId: 'q-1', isCorrect: false });
    });
  });
});
