import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../../common/prisma/prisma.service';
import { QuizAttemptsService, QuizAttemptResult } from './quiz-attempts.service';
import { StartQuizSessionDto, SubmitSessionAnswersDto } from './dto/quiz-sessions.dto';

export enum QuizSessionStatus {
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  EXPIRED = 'EXPIRED',
}

export interface QuizSessionData {
  id: string;
  lessonId: string;
  userId: string;
  startTime: Date;
  durationSeconds: number;
  expiresAt: Date;
  status: QuizSessionStatus;
  result?: QuizAttemptResult;
  autoSubmitted?: boolean;
}

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

@Injectable()
export class QuizSessionsService {
  private readonly logger = new Logger(QuizSessionsService.name);
  private readonly sessions = new Map<string, QuizSessionData>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly quizAttemptsService: QuizAttemptsService,
  ) {}

  /**
   * Starts a timed quiz session for a student.
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
    const id = uuidv4();

    const session: QuizSessionData = {
      id,
      lessonId,
      userId,
      startTime,
      durationSeconds,
      expiresAt,
      status: QuizSessionStatus.IN_PROGRESS,
    };

    this.sessions.set(id, session);
    this.logger.log(`Started quiz session ${id} for user ${userId} on lesson ${lessonId}`);

    return this.buildStatusResponse(session);
  }

  /**
   * Provides time-remaining and current status of a quiz session.
   */
  async getSessionStatus(
    sessionId: string,
    userId: string,
  ): Promise<QuizSessionStatusResponse> {
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new NotFoundException('Quiz session not found');
    }

    if (session.userId !== userId) {
      throw new ForbiddenException('You do not have access to this quiz session');
    }

    this.checkAndUpdateExpiration(session);

    return this.buildStatusResponse(session);
  }

  /**
   * Validates remaining time and submits answers for evaluation.
   */
  async submitSession(
    sessionId: string,
    userId: string,
    dto: SubmitSessionAnswersDto,
  ): Promise<QuizSessionStatusResponse> {
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new NotFoundException('Quiz session not found');
    }

    if (session.userId !== userId) {
      throw new ForbiddenException('You do not have access to this quiz session');
    }

    this.checkAndUpdateExpiration(session);

    if (session.status === QuizSessionStatus.EXPIRED) {
      throw new BadRequestException('Quiz session has expired and cannot accept new submissions');
    }

    if (session.status === QuizSessionStatus.COMPLETED) {
      throw new BadRequestException('Quiz session has already been completed');
    }

    const result = await this.quizAttemptsService.submitQuizAttempt(
      session.lessonId,
      {
        answers: dto.answers,
        passThreshold: dto.passThreshold,
      },
      userId,
    );

    session.status = QuizSessionStatus.COMPLETED;
    session.result = result;

    this.logger.log(`Session ${sessionId} completed by user ${userId} with score ${result.scorePercentage}%`);

    return this.buildStatusResponse(session);
  }

  /**
   * Auto-submits a quiz session on timeout.
   */
  async autoSubmitSession(
    sessionId: string,
    userId: string,
    dto?: SubmitSessionAnswersDto,
  ): Promise<QuizSessionStatusResponse> {
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new NotFoundException('Quiz session not found');
    }

    if (session.userId !== userId) {
      throw new ForbiddenException('You do not have access to this quiz session');
    }

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

    session.status = QuizSessionStatus.EXPIRED;
    session.autoSubmitted = true;
    session.result = result;

    this.logger.log(`Session ${sessionId} auto-submitted due to timeout for user ${userId}`);

    return this.buildStatusResponse(session);
  }

  /**
   * Cron task running every minute to process expired sessions automatically.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async handleAutoSubmitOnTimeout(): Promise<void> {
    const now = new Date();
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.status === QuizSessionStatus.IN_PROGRESS && now >= session.expiresAt) {
        try {
          await this.autoSubmitSession(sessionId, session.userId);
        } catch (error) {
          this.logger.error(`Failed to auto-submit expired session ${sessionId}`, error);
        }
      }
    }
  }

  private checkAndUpdateExpiration(session: QuizSessionData): void {
    if (session.status === QuizSessionStatus.IN_PROGRESS) {
      const now = new Date();
      if (now >= session.expiresAt) {
        session.status = QuizSessionStatus.EXPIRED;
      }
    }
  }

  private buildStatusResponse(session: QuizSessionData): QuizSessionStatusResponse {
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
      result: session.result,
    };
  }
}
