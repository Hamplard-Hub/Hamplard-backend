import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SubmitQuizAttemptDto } from './dto/submit-quiz-attempt.dto';
import { EnrollmentStatus, QuestionType } from '@prisma/client';

const ATTEMPTABLE_ENROLLMENT_STATUSES: EnrollmentStatus[] = [
  EnrollmentStatus.ACTIVE,
  EnrollmentStatus.COMPLETED,
];

/** Lesson fields that drive quiz access and grading policy. */
export interface QuizLesson {
  id: string;
  isFree: boolean;
  passThreshold: number;
  maxAttempts: number | null;
  attemptCooldownMinutes: number;
  module: { courseId: string };
}

export interface AnswerValidationResult {
  questionId: string;
  question: string;
  type: QuestionType;
  submittedAnswer: any[];
  /** Omitted until the answer reveal policy allows it (#238). */
  correctAnswer?: any[];
  isCorrect: boolean;
  pointsEarned: number;
  pointsPossible: number;
  explanation?: string | null;
}

export interface QuizAttemptResult {
  attemptId?: string;
  lessonId: string;
  totalQuestions: number;
  totalPointsPossible: number;
  totalPointsEarned: number;
  scorePercentage: number;
  passThresholdPercentage: number;
  passed: boolean;
  attemptNumber: number;
  /** null when the lesson allows unlimited attempts. */
  attemptsRemaining: number | null;
  answersRevealed: boolean;
  answers: AnswerValidationResult[];
  submittedAt: string;
}

@Injectable()
export class QuizAttemptsService {
  private readonly logger = new Logger(QuizAttemptsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Evaluates a student's submitted answer against the correct answer from the question bank.
   */
  private evaluateAnswer(
    type: QuestionType,
    submitted: any[],
    correct: any[],
  ): boolean {
    if (!submitted || !Array.isArray(submitted) || submitted.length === 0) {
      return false;
    }

    switch (type) {
      case QuestionType.SINGLE_CHOICE: {
        if (submitted.length !== 1 || correct.length !== 1) return false;
        return Number(submitted[0]) === Number(correct[0]);
      }

      case QuestionType.MULTIPLE_CHOICE: {
        if (submitted.length !== correct.length) return false;
        const normSubmitted = submitted.map((x) => Number(x)).sort((a, b) => a - b);
        const normCorrect = correct.map((x) => Number(x)).sort((a, b) => a - b);
        return normSubmitted.every((val, idx) => val === normCorrect[idx]);
      }

      case QuestionType.TRUE_FALSE: {
        if (submitted.length !== 1 || correct.length !== 1) return false;
        const normSubmitted = String(submitted[0]).trim().toLowerCase();
        const normCorrect = String(correct[0]).trim().toLowerCase();
        return normSubmitted === normCorrect;
      }

      case QuestionType.SHORT_ANSWER: {
        if (submitted.length === 0) return false;
        const normSubmitted = String(submitted[0]).trim().toLowerCase();
        return correct.some(
          (c) => String(c).trim().toLowerCase() === normSubmitted,
        );
      }

      default:
        return false;
    }
  }

  /**
   * Loads the lesson together with its stored quiz policy and parent course.
   */
  private async loadQuizLesson(lessonId: string): Promise<QuizLesson> {
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
      select: {
        id: true,
        isFree: true,
        passThreshold: true,
        maxAttempts: true,
        attemptCooldownMinutes: true,
        module: { select: { courseId: true } },
      },
    });

    if (!lesson) {
      throw new NotFoundException('Lesson not found');
    }
    return lesson;
  }

  /**
   * Issue #238 — only students with an ACTIVE/COMPLETED enrollment in the
   * parent course may attempt a quiz, unless the lesson is a free preview.
   */
  private async assertEnrolled(lesson: QuizLesson, userId: string): Promise<void> {
    if (lesson.isFree) return;

    const enrollment = await this.prisma.enrollment.findUnique({
      where: {
        studentId_courseId: { studentId: userId, courseId: lesson.module.courseId },
      },
      select: { status: true },
    });

    if (!enrollment || !ATTEMPTABLE_ENROLLMENT_STATUSES.includes(enrollment.status)) {
      throw new ForbiddenException('You must be enrolled in this course to attempt this quiz');
    }
  }

  /**
   * Issue #238 — enforces the lesson's maxAttempts and cooldown window.
   * Returns the number of attempts already recorded for the student.
   */
  private async assertAttemptAllowed(lesson: QuizLesson, userId: string): Promise<number> {
    const where = { lessonId: lesson.id, studentId: userId };
    const priorAttempts = await this.prisma.quizAttempt.count({ where });

    if (lesson.maxAttempts != null && priorAttempts >= lesson.maxAttempts) {
      throw new ForbiddenException(
        `Maximum number of attempts (${lesson.maxAttempts}) reached for this quiz`,
      );
    }

    if (lesson.attemptCooldownMinutes > 0 && priorAttempts > 0) {
      const lastAttempt = await this.prisma.quizAttempt.findFirst({
        where,
        orderBy: { attemptedAt: 'desc' },
        select: { attemptedAt: true },
      });
      if (lastAttempt) {
        const cooldownEnd =
          lastAttempt.attemptedAt.getTime() + lesson.attemptCooldownMinutes * 60 * 1000;
        const now = Date.now();
        if (now < cooldownEnd) {
          const remainingMinutes = Math.ceil((cooldownEnd - now) / (60 * 1000));
          throw new ForbiddenException(
            `Retake cooldown in effect. Please try again in ${remainingMinutes} minutes`,
          );
        }
      }
    }

    return priorAttempts;
  }

  /**
   * Runs every access check required before a student may attempt a quiz
   * (lesson exists, enrollment, attempt limit, cooldown). Shared with
   * QuizSessionsService so timed sessions are gated the same way.
   */
  async assertCanAttempt(
    lessonId: string,
    userId: string,
  ): Promise<{ lesson: QuizLesson; priorAttempts: number }> {
    const lesson = await this.loadQuizLesson(lessonId);
    await this.assertEnrolled(lesson, userId);
    const priorAttempts = await this.assertAttemptAllowed(lesson, userId);
    return { lesson, priorAttempts };
  }

  /**
   * Answer keys are revealed only once the student has passed or has used
   * their final allowed attempt, so they cannot be harvested for retakes.
   */
  private shouldRevealAnswers(
    lesson: Pick<QuizLesson, 'maxAttempts'>,
    attemptsUsed: number,
    passed: boolean,
  ): boolean {
    return passed || (lesson.maxAttempts != null && attemptsUsed >= lesson.maxAttempts);
  }

  private stripAnswerKey(answer: AnswerValidationResult): AnswerValidationResult {
    const sanitized = { ...answer };
    delete sanitized.correctAnswer;
    delete sanitized.explanation;
    return sanitized;
  }

  /**
   * Handles quiz attempt submission, answer tracking, validation against question bank,
   * pass/fail threshold enforcement, and score computing.
   */
  async submitQuizAttempt(
    lessonId: string,
    dto: SubmitQuizAttemptDto,
    userId: string,
  ): Promise<QuizAttemptResult> {
    const { lesson, priorAttempts } = await this.assertCanAttempt(lessonId, userId);

    const questions = await this.prisma.quizQuestion.findMany({
      where: { lessonId },
      orderBy: { position: 'asc' },
    });

    if (!questions || questions.length === 0) {
      throw new BadRequestException('This lesson has no quiz questions in the bank');
    }

    const questionMap = new Map(questions.map((q) => [q.id, q]));
    const submittedAnswerMap = new Map<string, any[]>();

    for (const ans of dto.answers) {
      if (!questionMap.has(ans.questionId)) {
        throw new BadRequestException(
          `Question ID ${ans.questionId} does not belong to lesson ${lessonId}`,
        );
      }
      submittedAnswerMap.set(ans.questionId, ans.answer);
    }

    let totalPointsPossible = 0;
    let totalPointsEarned = 0;
    const answerResults: AnswerValidationResult[] = [];

    for (const question of questions) {
      const pointsPossible = question.points;
      totalPointsPossible += pointsPossible;

      const submittedAns = submittedAnswerMap.get(question.id) || [];
      const correctAns = question.correctAnswer as any[];

      const isCorrect = this.evaluateAnswer(
        question.type,
        submittedAns,
        correctAns,
      );

      const pointsEarned = isCorrect ? pointsPossible : 0;
      totalPointsEarned += pointsEarned;

      answerResults.push({
        questionId: question.id,
        question: question.question,
        type: question.type,
        submittedAnswer: submittedAns,
        correctAnswer: correctAns,
        isCorrect,
        pointsEarned,
        pointsPossible,
        explanation: question.explanation,
      });
    }

    const scorePercentage =
      totalPointsPossible > 0
        ? Math.round((totalPointsEarned / totalPointsPossible) * 100 * 100) / 100
        : 0;

    // Issue #236 — the pass mark always comes from the stored lesson record.
    const passThresholdPercentage = lesson.passThreshold;
    const passed = scorePercentage >= passThresholdPercentage;

    // The full breakdown (incl. answer key) is persisted server-side only.
    const persisted = await this.prisma.quizAttempt.create({
      data: {
        lessonId,
        studentId: userId,
        score: Math.round(scorePercentage),
        passed,
        answers: answerResults as any,
      },
    });

    this.logger.log(
      `Quiz attempt recorded: lesson ${lessonId}, student ${userId}, score ${scorePercentage}%, passed: ${passed}`,
    );

    const attemptNumber = priorAttempts + 1;
    const answersRevealed = this.shouldRevealAnswers(lesson, attemptNumber, passed);

    return {
      attemptId: persisted.id,
      lessonId,
      totalQuestions: questions.length,
      totalPointsPossible,
      totalPointsEarned,
      scorePercentage,
      passThresholdPercentage,
      passed,
      attemptNumber,
      attemptsRemaining:
        lesson.maxAttempts == null ? null : Math.max(0, lesson.maxAttempts - attemptNumber),
      answersRevealed,
      answers: answersRevealed
        ? answerResults
        : answerResults.map((a) => this.stripAnswerKey(a)),
      submittedAt: persisted.attemptedAt.toISOString(),
    };
  }

  /**
   * Attempt history for a student on a lesson (mirrors ExamsService.getAttemptHistory).
   */
  async getAttemptHistory(studentId: string, lessonId: string) {
    const [lesson, attempts] = await Promise.all([
      this.prisma.lesson.findUnique({
        where: { id: lessonId },
        select: { maxAttempts: true },
      }),
      this.prisma.quizAttempt.findMany({
        where: { studentId, lessonId },
        orderBy: { attemptedAt: 'desc' },
      }),
    ]);

    // Persisted breakdowns contain the answer key — apply the same reveal policy (#238).
    const revealed = this.shouldRevealAnswers(
      { maxAttempts: lesson?.maxAttempts ?? null },
      attempts.length,
      attempts.some((a) => a.passed),
    );
    if (revealed) return attempts;

    return attempts.map((attempt) => ({
      ...attempt,
      answers: Array.isArray(attempt.answers)
        ? (attempt.answers as unknown as AnswerValidationResult[]).map((a) =>
            this.stripAnswerKey(a),
          )
        : attempt.answers,
    }));
  }
}
