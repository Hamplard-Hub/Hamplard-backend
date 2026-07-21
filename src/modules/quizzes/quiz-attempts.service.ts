import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SubmitQuizAttemptDto, SingleAnswerDto } from './dto/submit-quiz-attempt.dto';
import { QuestionType } from '@prisma/client';

export interface AnswerValidationResult {
  questionId: string;
  question: string;
  type: QuestionType;
  submittedAnswer: any[];
  correctAnswer: any[];
  isCorrect: boolean;
  pointsEarned: number;
  pointsPossible: number;
  explanation?: string | null;
}

export interface QuizAttemptResult {
  lessonId: string;
  totalQuestions: number;
  totalPointsPossible: number;
  totalPointsEarned: number;
  scorePercentage: number;
  passThresholdPercentage: number;
  passed: boolean;
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
   * Handles quiz attempt submission, answer tracking, validation against question bank,
   * pass/fail threshold enforcement, and score computing.
   */
  async submitQuizAttempt(
    lessonId: string,
    dto: SubmitQuizAttemptDto,
    userId: string,
  ): Promise<QuizAttemptResult> {
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
    });

    if (!lesson) {
      throw new NotFoundException('Lesson not found');
    }

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

    const passThresholdPercentage = dto.passThreshold ?? 70;
    const passed = scorePercentage >= passThresholdPercentage;

    return {
      lessonId,
      totalQuestions: questions.length,
      totalPointsPossible,
      totalPointsEarned,
      scorePercentage,
      passThresholdPercentage,
      passed,
      answers: answerResults,
      submittedAt: new Date().toISOString(),
    };
  }
}
