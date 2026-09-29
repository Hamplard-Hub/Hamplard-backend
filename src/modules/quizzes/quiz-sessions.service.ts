import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { QuizSessionStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { QuizAttemptsService, QuizAttemptResult } from './quiz-attempts.service';
import { StartQuizSessionDto, SubmitSessionAnswersDto } from './dto/quiz-sessions.dto';

export { QuizSessionStatus };

export interface QuizSessionStatusResponse {
  sessionId: string;
  lessonId: string;
  userId: string;
  status: QuizSessionStatus;
  startTime: string;
  expiresAt: string;
  durationSeconds: number;
  elapsedSeconds: number;
  remainingSeconds: number;
  isExpired: boolean;
  result?: QuizAttemptResult;
}

type QuizSessionRow = {
  id: string;
  lessonId: string;
  userId: string;
  startTime: Date;
  durationSeconds: number;
  expiresAt: Date;
  status: QuizSessionStatus;
  result: unknown;
  autoSubmitted: boolean;
};

@Injectable()
export class QuizSessionsService {
  private readonly logger = new Logger(QuizSessionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly quizAttemptsService: QuizAttemptsService,
  ) {}

  /**
   * Starts a timed quiz session for a student (persisted so any instance
   * can query, submit, or auto-expire it).
   */
  async startSession(
    lessonId: string,
    userId: string,
    dto: StartQuizSessionDto,
  ): Promise<QuizSessionStatusResponse> {
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
    });

    if (!lesson) {
      throw new NotFoundException('Lesson not found');
    }

    const questionCount = await this.prisma.quizQuestion.count({
      where: { lessonId },
    });

    if (questionCount === 0) {
      throw new BadRequestException('This lesson has no quiz questions in the bank');
    }

    const durationMinutes = dto?.durationMinutes ?? 15;
    const durationSeconds = durationMinutes * 60;
    const startTime = new Date();
    const expiresAt = new Date(startTime.getTime() + durationSeconds * 1000);

    const session = (await this.prisma.quizSession.create({
      data: {
        lessonId,
        userId,
        startTime,
        durationSeconds,
        expiresAt,
        status: QuizSessionStatus.IN_PROGRESS,
      },
    })) as unknown as QuizSessionRow;

    this.logger.log(`Started quiz session ${session.id} for user ${userId} on lesson ${lessonId}`);

    return this.buildStatusResponse(session);
  }

  /**
   * Provides time-remaining and current status of a quiz session.
   */
  async getSessionStatus(
    sessionId: string,
    userId: string,
  ): Promise<QuizSessionStatusResponse> {
    const session = await this.loadOwnedSession(sessionId, userId);
    const current = await this.persistExpirationIfElapsed(session);
    return this.buildStatusResponse(current);
  }

  /**
   * Validates remaining time and submits answers for evaluation.
   */
  async submitSession(
    sessionId: string,
    userId: string,
    dto: SubmitSessionAnswersDto,
  ): Promise<QuizSessionStatusResponse> {
    const session = await this.loadOwnedSession(sessionId, userId);
    const current = await this.persistExpirationIfElapsed(session);

    if (current.status === QuizSessionStatus.EXPIRED) {
      throw new BadRequestException('Quiz session has expired and cannot accept new submissions');
    }

    if (current.status === QuizSessionStatus.COMPLETED) {
      throw new BadRequestException('Quiz session has already been completed');
    }

    const result = await this.quizAttemptsService.submitQuizAttempt(
      current.lessonId,
      {
        answers: dto.answers,
        passThreshold: dto.passThreshold,
      },
      userId,
    );

    const updated = (await this.prisma.quizSession.update({
      where: { id: sessionId },
      data: {
        status: QuizSessionStatus.COMPLETED,
        result: result as any,
      },
    })) as unknown as QuizSessionRow;

    this.logger.log(`Session ${sessionId} completed by user ${userId} with score ${result.scorePercentage}%`);

    return this.buildStatusResponse(updated);
  }

  /**
   * Auto-submits a quiz session on timeout.
   */
  async autoSubmitSession(
    sessionId: string,
    userId: string,
    dto?: SubmitSessionAnswersDto,
  ): Promise<QuizSessionStatusResponse> {
    const session = await this.loadOwnedSession(sessionId, userId);

    if (session.status === QuizSessionStatus.COMPLETED) {
      return this.buildStatusResponse(session);
    }

    const answers = dto?.answers ?? [];
    const passThreshold = dto?.passThreshold ?? 70;

    const result = await this.quizAttemptsService.submitQuizAttempt(
      session.lessonId,
      {
        answers,
        passThreshold,
      },
      userId,
    );

    const updated = (await this.prisma.quizSession.update({
      where: { id: sessionId },
      data: {
        status: QuizSessionStatus.EXPIRED,
        autoSubmitted: true,
        result: result as any,
      },
    })) as unknown as QuizSessionRow;

    this.logger.log(`Session ${sessionId} auto-submitted due to timeout for user ${userId}`);

    return this.buildStatusResponse(updated);
  }

  /**
   * Cron task running every minute to auto-submit expired sessions.
   * Queries only IN_PROGRESS, expired rows so any instance can expire
   * sessions started elsewhere.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async handleAutoSubmitOnTimeout(): Promise<void> {
    const expired = (await this.prisma.quizSession.findMany({
      where: {
        status: QuizSessionStatus.IN_PROGRESS,
        expiresAt: { lte: new Date() },
      },
      take: 100,
    })) as unknown as QuizSessionRow[];

    for (const session of expired) {
      try {
        await this.autoSubmitSession(session.id, session.userId);
      } catch (error) {
        this.logger.error(`Failed to auto-submit expired session ${session.id}`, error as Error);
      }
    }
  }

  private async loadOwnedSession(
    sessionId: string,
    userId: string,
  ): Promise<QuizSessionRow> {
    const session = (await this.prisma.quizSession.findUnique({
      where: { id: sessionId },
    })) as unknown as QuizSessionRow | null;

    if (!session) {
      throw new NotFoundException('Quiz session not found');
    }

    if (session.userId !== userId) {
      throw new ForbiddenException('You do not have access to this quiz session');
    }

    return session;
  }

  private async persistExpirationIfElapsed(
    session: QuizSessionRow,
  ): Promise<QuizSessionRow> {
    if (session.status === QuizSessionStatus.IN_PROGRESS && new Date() >= session.expiresAt) {
      const updated = (await this.prisma.quizSession.update({
        where: { id: session.id },
        data: { status: QuizSessionStatus.EXPIRED },
      })) as unknown as QuizSessionRow;
      return updated;
    }
    return session;
  }

  private buildStatusResponse(session: QuizSessionRow): QuizSessionStatusResponse {
    const now = new Date();
    const elapsedSeconds = Math.max(0, Math.floor((now.getTime() - session.startTime.getTime()) / 1000));
    const remainingSeconds = Math.max(0, Math.floor((session.expiresAt.getTime() - now.getTime()) / 1000));
    const isExpired = session.status === QuizSessionStatus.EXPIRED || now >= session.expiresAt;

    return {
      sessionId: session.id,
      lessonId: session.lessonId,
      userId: session.userId,
      status: session.status,
      startTime: session.startTime.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
      durationSeconds: session.durationSeconds,
      elapsedSeconds,
      remainingSeconds,
      isExpired,
      result: (session.result as QuizAttemptResult | null) ?? undefined,
    };
  }
}
