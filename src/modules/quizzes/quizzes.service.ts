import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateQuestionDto, UpdateQuestionDto, ReorderQuestionsDto } from './dto/create-question.dto';
import { QuestionType, UserRole } from '@prisma/client';

@Injectable()
export class QuizzesService {
  private readonly logger = new Logger(QuizzesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Validates option array and correct answer structure against question type.
   */
  private validateQuestionData(
    type: QuestionType,
    options?: string[],
    correctAnswer?: any[],
  ) {
    if (!correctAnswer || !Array.isArray(correctAnswer) || correctAnswer.length === 0) {
      throw new BadRequestException('correctAnswer must be a non-empty array');
    }

    if (type === QuestionType.SINGLE_CHOICE || type === QuestionType.MULTIPLE_CHOICE) {
      if (!options || !Array.isArray(options) || options.length < 2) {
        throw new BadRequestException(
          'Choice questions must have at least 2 options',
        );
      }

      if (type === QuestionType.SINGLE_CHOICE && correctAnswer.length !== 1) {
        throw new BadRequestException(
          'SINGLE_CHOICE questions must have exactly 1 correct answer index',
        );
      }

      for (const idx of correctAnswer) {
        if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= options.length) {
          throw new BadRequestException(
            `Correct answer index ${idx} is out of bounds for provided options`,
          );
        }
      }
    } else if (type === QuestionType.TRUE_FALSE) {
      if (correctAnswer.length !== 1) {
        throw new BadRequestException('TRUE_FALSE questions must have exactly 1 correct answer');
      }
      const val = String(correctAnswer[0]).toLowerCase();
      if (val !== 'true' && val !== 'false' && val !== '0' && val !== '1') {
        throw new BadRequestException(
          'TRUE_FALSE correct answer must be "true", "false", or a boolean representation',
        );
      }
    } else if (type === QuestionType.SHORT_ANSWER) {
      for (const ans of correctAnswer) {
        if (typeof ans !== 'string' || ans.trim() === '') {
          throw new BadRequestException(
            'SHORT_ANSWER correct answers must be non-empty strings',
          );
        }
      }
    }
  }

  /**
   * Helper to verify instructor owns the course that owns the lesson, or user is admin.
   */
  private async verifyLessonOwnership(lessonId: string, userId: string, role: string) {
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
      include: {
        module: {
          include: {
            course: {
              include: { instructor: true },
            },
          },
        },
      },
    });

    if (!lesson) {
      throw new NotFoundException('Lesson not found');
    }

    if (role !== UserRole.ADMIN) {
      const course = lesson.module.course;
      if (course.instructorAddress !== userId && course.instructor?.id !== userId) {
        throw new ForbiddenException('You are not authorized to manage questions for this course');
      }
    }

    return lesson;
  }

  /**
   * Create a question attached to a lesson.
   */
  async createQuestion(
    lessonId: string,
    dto: CreateQuestionDto,
    userId: string,
    userRole: string,
  ) {
    await this.verifyLessonOwnership(lessonId, userId, userRole);
    this.validateQuestionData(dto.type, dto.options, dto.correctAnswer);

    return this.prisma.quizQuestion.create({
      data: {
        lessonId,
        question: dto.question,
        type: dto.type,
        options: dto.options ? (dto.options as any) : undefined,
        correctAnswer: dto.correctAnswer as any,
        explanation: dto.explanation,
        points: dto.points ?? 1,
        position: dto.position,
      },
    });
  }

  /**
   * Get all questions for a given lesson (ordered by position asc).
   */
  async getQuestionsByLesson(lessonId: string) {
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
    });
    if (!lesson) {
      throw new NotFoundException('Lesson not found');
    }

    return this.prisma.quizQuestion.findMany({
      where: { lessonId },
      orderBy: { position: 'asc' },
    });
  }

  /**
   * Get single question by ID.
   */
  async getQuestionById(id: string) {
    const question = await this.prisma.quizQuestion.findUnique({
      where: { id },
    });
    if (!question) {
      throw new NotFoundException('Quiz question not found');
    }
    return question;
  }

  /**
   * Update question by ID.
   */
  async updateQuestion(
    id: string,
    dto: UpdateQuestionDto,
    userId: string,
    userRole: string,
  ) {
    const existing = await this.getQuestionById(id);
    await this.verifyLessonOwnership(existing.lessonId, userId, userRole);

    const targetType = dto.type ?? existing.type;
    const targetOptions = dto.options ?? (existing.options as string[] | undefined);
    const targetCorrectAnswer = dto.correctAnswer ?? (existing.correctAnswer as any[]);

    this.validateQuestionData(targetType, targetOptions, targetCorrectAnswer);

    return this.prisma.quizQuestion.update({
      where: { id },
      data: {
        ...(dto.question !== undefined && { question: dto.question }),
        ...(dto.type !== undefined && { type: dto.type }),
        ...(dto.options !== undefined && { options: dto.options as any }),
        ...(dto.correctAnswer !== undefined && { correctAnswer: dto.correctAnswer as any }),
        ...(dto.explanation !== undefined && { explanation: dto.explanation }),
        ...(dto.points !== undefined && { points: dto.points }),
        ...(dto.position !== undefined && { position: dto.position }),
      },
    });
  }

  /**
   * Delete a question.
   */
  async deleteQuestion(id: string, userId: string, userRole: string) {
    const existing = await this.getQuestionById(id);
    await this.verifyLessonOwnership(existing.lessonId, userId, userRole);

    return this.prisma.quizQuestion.delete({
      where: { id },
    });
  }

  /**
   * Reorder questions within a lesson.
   */
  async reorderQuestions(
    lessonId: string,
    dto: ReorderQuestionsDto,
    userId: string,
    userRole: string,
  ) {
    await this.verifyLessonOwnership(lessonId, userId, userRole);

    const updatePromises = dto.questionOrders.map((item) =>
      this.prisma.quizQuestion.updateMany({
        where: { id: item.id, lessonId },
        data: { position: item.position },
      }),
    );

    await Promise.all(updatePromises);
    return this.getQuestionsByLesson(lessonId);
  }
}
