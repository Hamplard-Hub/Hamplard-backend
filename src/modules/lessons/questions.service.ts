import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateQuestionDto } from './dto/create-question.dto';
import { CreateAnswerDto } from './dto/create-answer.dto';
import { UserRole } from '@prisma/client';

@Injectable()
export class QuestionsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Post a question on a lesson.
   * Restricts asking to enrolled students, course instructor, or admin.
   */
  async createQuestion(
    lessonId: string,
    authorId: string,
    userRole: UserRole | undefined,
    dto: CreateQuestionDto,
  ) {
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
      include: {
        module: {
          include: {
            course: { include: { instructor: true } },
          },
        },
      },
    });

    if (!lesson) {
      throw new NotFoundException('Lesson not found');
    }

    const course = lesson.module.course;
    const isInstructor =
      course.instructor?.id === authorId ||
      course.instructorAddress === authorId;
    const isAdmin = userRole === UserRole.ADMIN;

    if (!isInstructor && !isAdmin) {
      const enrollment = await this.prisma.enrollment.findUnique({
        where: {
          studentId_courseId: {
            studentId: authorId,
            courseId: course.id,
          },
        },
      });

      if (!enrollment && !lesson.isFree) {
        throw new ForbiddenException(
          'You must be enrolled in this course to ask a question',
        );
      }
    }

    return this.prisma.question.create({
      data: {
        lessonId,
        authorId,
        title: dto.title,
        content: dto.content,
      },
      include: {
        author: { select: { id: true, name: true, avatarUrl: true } },
      },
    });
  }

  /**
   * List questions for a lesson (paginated).
   */
  async getQuestionsByLesson(lessonId: string, page = 1, limit = 20) {
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
    });

    if (!lesson) {
      throw new NotFoundException('Lesson not found');
    }

    const [data, total] = await this.prisma.$transaction([
      this.prisma.question.findMany({
        where: { lessonId },
        include: {
          author: { select: { id: true, name: true, avatarUrl: true } },
          answers: {
            include: {
              author: { select: { id: true, name: true, avatarUrl: true } },
            },
            orderBy: [{ isBestAnswer: 'desc' }, { createdAt: 'asc' }],
          },
          _count: { select: { answers: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.question.count({ where: { lessonId } }),
    ]);

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Post an answer to a question.
   * Restricts answering to enrolled students, course instructor, or admin.
   */
  async createAnswer(
    questionId: string,
    authorId: string,
    userRole: UserRole | undefined,
    dto: CreateAnswerDto,
  ) {
    const question = await this.prisma.question.findUnique({
      where: { id: questionId },
      include: {
        lesson: {
          include: {
            module: {
              include: {
                course: { include: { instructor: true } },
              },
            },
          },
        },
      },
    });

    if (!question) {
      throw new NotFoundException('Question not found');
    }

    const course = question.lesson.module.course;
    const isInstructor =
      course.instructor?.id === authorId ||
      course.instructorAddress === authorId;
    const isAdmin = userRole === UserRole.ADMIN;

    if (!isInstructor && !isAdmin) {
      const enrollment = await this.prisma.enrollment.findUnique({
        where: {
          studentId_courseId: {
            studentId: authorId,
            courseId: course.id,
          },
        },
      });

      if (!enrollment && !question.lesson.isFree) {
        throw new ForbiddenException(
          'You must be enrolled in this course to answer a question',
        );
      }
    }

    return this.prisma.answer.create({
      data: {
        questionId,
        authorId,
        content: dto.content,
      },
      include: {
        author: { select: { id: true, name: true, avatarUrl: true } },
      },
    });
  }

  /**
   * Mark an answer as the best answer.
   * Only the original question author or an admin can mark it.
   */
  async markBestAnswer(answerId: string, userId: string, userRole?: UserRole) {
    const answer = await this.prisma.answer.findUnique({
      where: { id: answerId },
      include: {
        question: true,
      },
    });

    if (!answer) {
      throw new NotFoundException('Answer not found');
    }

    const isAuthor = answer.question.authorId === userId;
    const isAdmin = userRole === UserRole.ADMIN;

    if (!isAuthor && !isAdmin) {
      throw new ForbiddenException(
        'Only the question author or an admin can mark an answer as the best answer',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.answer.updateMany({
        where: { questionId: answer.questionId, isBestAnswer: true },
        data: { isBestAnswer: false },
      });

      return tx.answer.update({
        where: { id: answerId },
        data: { isBestAnswer: true },
        include: {
          author: { select: { id: true, name: true, avatarUrl: true } },
        },
      });
    });
  }
}
