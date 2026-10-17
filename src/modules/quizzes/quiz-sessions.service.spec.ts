import { Test, TestingModule } from '@nestjs/testing';
import { QuizSessionsService } from './quiz-sessions.service';
import { QuizAttemptsService } from './quiz-attempts.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { QuizSessionStatus } from '@prisma/client';
import { ForbiddenException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SubmitQuizAttemptDto } from './dto/submit-quiz-attempt.dto';
import { SubmitSessionAnswersDto } from './dto/quiz-sessions.dto';

describe('QuizSessionsService', () => {
  let service: QuizSessionsService;

  // In-memory stand-in for the quiz_sessions table, shared across service
  // instances to prove sessions survive a restart / another instance.
  let store: Map<string, any>;
  let idSeq: number;

  const mockQuizAttempts = {
    submitQuizAttempt: jest.fn(),
    assertCanAttempt: jest.fn(),
  };

  const mockPrisma: any = {
    lesson: { findUnique: jest.fn() },
    quizQuestion: { count: jest.fn() },
    quizSession: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
  };

  const buildModule = () =>
    Test.createTestingModule({
      providers: [
        QuizSessionsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: QuizAttemptsService, useValue: mockQuizAttempts },
      ],
    }).compile();

  beforeEach(async () => {
    store = new Map();
    idSeq = 0;
    jest.clearAllMocks();

    mockPrisma.lesson.findUnique.mockResolvedValue({ id: 'lesson-1' });
    mockPrisma.quizQuestion.count.mockResolvedValue(3);

    mockPrisma.quizSession.create.mockImplementation(async ({ data }: any) => {
      const row = {
        id: `session-${++idSeq}`,
        ...data,
        result: null,
        autoSubmitted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      store.set(row.id, row);
      return { ...row };
    });
    mockPrisma.quizSession.findUnique.mockImplementation(async ({ where }: any) => {
      const row = store.get(where.id);
      return row ? { ...row } : null;
    });
    mockPrisma.quizSession.findMany.mockImplementation(async ({ where }: any) =>
      [...store.values()]
        .filter(
          (row) =>
            row.status === (where?.status ?? row.status) &&
            (where?.expiresAt?.lte ? row.expiresAt <= where.expiresAt.lte : true),
        )
        .map((row) => ({ ...row })),
    );
    mockPrisma.quizSession.update.mockImplementation(async ({ where, data }: any) => {
      const row = store.get(where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data, { updatedAt: new Date() });
      return { ...row };
    });

    mockQuizAttempts.assertCanAttempt.mockResolvedValue({
      lesson: { id: 'lesson-1' },
      priorAttempts: 0,
    });
    mockQuizAttempts.submitQuizAttempt.mockResolvedValue({
      lessonId: 'lesson-1',
      totalQuestions: 3,
      totalPointsPossible: 3,
      totalPointsEarned: 3,
      scorePercentage: 100,
      passThresholdPercentage: 70,
      passed: true,
      answers: [],
      submittedAt: new Date().toISOString(),
    });

    const module: TestingModule = await buildModule();
    service = module.get<QuizSessionsService>(QuizSessionsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('persists a started session so another instance can read it', async () => {
    const started = await service.startSession('lesson-1', 'user-1', {
      durationMinutes: 15,
    });

    expect(mockPrisma.quizSession.create).toHaveBeenCalled();
    expect(started.status).toBe(QuizSessionStatus.IN_PROGRESS);

    // Simulate a restart / a different instance sharing the same database.
    const restarted = await buildModule();
    const service2 = restarted.get<QuizSessionsService>(QuizSessionsService);

    const status = await service2.getSessionStatus(started.sessionId, 'user-1');
    expect(status.sessionId).toBe(started.sessionId);
    expect(status.status).toBe(QuizSessionStatus.IN_PROGRESS);
  });

  it('lets another instance submit a session started elsewhere', async () => {
    const started = await service.startSession('lesson-1', 'user-1', {
      durationMinutes: 15,
    });

    const restarted = await buildModule();
    const service2 = restarted.get<QuizSessionsService>(QuizSessionsService);

    const submitted = await service2.submitSession(started.sessionId, 'user-1', {
      answers: [],
    });

    expect(submitted.status).toBe(QuizSessionStatus.COMPLETED);
    expect(submitted.result?.scorePercentage).toBe(100);
    expect(store.get(started.sessionId).status).toBe(QuizSessionStatus.COMPLETED);
  });

  it('expiration sweep queries expired IN_PROGRESS sessions from storage', async () => {
    const started = await service.startSession('lesson-1', 'user-1', {
      durationMinutes: 15,
    });

    // Force expiry in storage, as if time had passed.
    store.get(started.sessionId).expiresAt = new Date(Date.now() - 1000);

    await service.handleAutoSubmitOnTimeout();

    expect(mockPrisma.quizSession.findMany).toHaveBeenCalledWith({
      where: {
        status: QuizSessionStatus.IN_PROGRESS,
        expiresAt: { lte: expect.any(Date) },
      },
      take: 100,
    });
    expect(store.get(started.sessionId).status).toBe(QuizSessionStatus.EXPIRED);
    expect(store.get(started.sessionId).autoSubmitted).toBe(true);
  });

  // ----------------------------------------------------------
  // Issue #238 — sessions share the attempt gate
  // ----------------------------------------------------------

  it('refuses to start a session for a non-enrolled user (403)', async () => {
    mockQuizAttempts.assertCanAttempt.mockRejectedValue(
      new ForbiddenException('You must be enrolled in this course to attempt this quiz'),
    );

    await expect(
      service.startSession('lesson-1', 'user-1', { durationMinutes: 15 }),
    ).rejects.toThrow(ForbiddenException);
    expect(mockQuizAttempts.assertCanAttempt).toHaveBeenCalledWith('lesson-1', 'user-1');
    expect(mockPrisma.quizSession.create).not.toHaveBeenCalled();
  });

  it('refuses to start a session once the attempt limit is reached', async () => {
    mockQuizAttempts.assertCanAttempt.mockRejectedValue(
      new ForbiddenException('Maximum number of attempts (3) reached for this quiz'),
    );

    await expect(
      service.startSession('lesson-1', 'user-1', {}),
    ).rejects.toThrow(/Maximum number of attempts/);
    expect(mockPrisma.quizSession.create).not.toHaveBeenCalled();
  });

  it('closes an expired session without grading when access was lost', async () => {
    const started = await service.startSession('lesson-1', 'user-1', {});
    store.get(started.sessionId).expiresAt = new Date(Date.now() - 1000);
    mockQuizAttempts.submitQuizAttempt.mockRejectedValue(
      new ForbiddenException('Maximum number of attempts (1) reached for this quiz'),
    );

    await service.handleAutoSubmitOnTimeout();

    const row = store.get(started.sessionId);
    expect(row.status).toBe(QuizSessionStatus.EXPIRED);
    expect(row.autoSubmitted).toBe(true);
    expect(row.result).toBeNull();
  });

  // ----------------------------------------------------------
  // Issue #236 — client passThreshold is not part of the contract
  // ----------------------------------------------------------

  it('submits session answers without forwarding any client passThreshold', async () => {
    const started = await service.startSession('lesson-1', 'user-1', {});

    await service.submitSession(started.sessionId, 'user-1', {
      answers: [],
      passThreshold: 0,
    } as any);

    expect(mockQuizAttempts.submitQuizAttempt).toHaveBeenCalledWith(
      'lesson-1',
      { answers: [] },
      'user-1',
    );
  });
});

describe('Quiz DTO validation (#236)', () => {
  // Mirrors the global ValidationPipe options in main.ts.
  const validateLikeApp = (cls: any, body: object) =>
    validate(plainToInstance(cls, body), { whitelist: true, forbidNonWhitelisted: true });

  it.each([
    ['SubmitQuizAttemptDto', SubmitQuizAttemptDto],
    ['SubmitSessionAnswersDto', SubmitSessionAnswersDto],
  ])('%s rejects a client-supplied passThreshold', async (_name, dtoClass) => {
    const errors = await validateLikeApp(dtoClass, { answers: [], passThreshold: 0 });

    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('passThreshold');
    expect(errors[0].constraints).toHaveProperty('whitelistValidation');
  });

  it.each([
    ['SubmitQuizAttemptDto', SubmitQuizAttemptDto],
    ['SubmitSessionAnswersDto', SubmitSessionAnswersDto],
  ])('%s accepts a payload with answers only', async (_name, dtoClass) => {
    const errors = await validateLikeApp(dtoClass, {
      answers: [{ questionId: 'q-1', answer: [0] }],
    });
    expect(errors).toHaveLength(0);
  });
});
