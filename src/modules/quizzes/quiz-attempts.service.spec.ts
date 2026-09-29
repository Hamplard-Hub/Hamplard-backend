import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { QuizAttemptsService } from './quiz-attempts.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { QuestionType } from '@prisma/client';

describe('QuizAttemptsService', () => {
  let service: QuizAttemptsService;

  const mockPrisma: any = {
    lesson: { findUnique: jest.fn() },
    quizQuestion: { findMany: jest.fn() },
    quizAttempt: { create: jest.fn(), findMany: jest.fn() },
  };

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

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QuizAttemptsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<QuizAttemptsService>(QuizAttemptsService);
    jest.clearAllMocks();

    mockPrisma.lesson.findUnique.mockResolvedValue({ id: 'lesson-1' });
    mockPrisma.quizQuestion.findMany.mockResolvedValue(questions);
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

      const result = await service.submitQuizAttempt(
        'lesson-1',
        {
          answers: [
            { questionId: 'q-1', answer: [1] },
            { questionId: 'q-2', answer: ['true'] },
          ],
        },
        'student-1',
      );

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
      mockPrisma.quizAttempt.create.mockResolvedValue({
        id: 'attempt-2',
        attemptedAt: new Date(),
      });

      const result = await service.submitQuizAttempt(
        'lesson-1',
        {
          answers: [
            { questionId: 'q-1', answer: [0] },
            { questionId: 'q-2', answer: ['false'] },
          ],
        },
        'student-1',
      );

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
  });
});
