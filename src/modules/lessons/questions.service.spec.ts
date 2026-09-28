import { Test, TestingModule } from '@nestjs/testing';
import { QuestionsService } from './questions.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';

describe('QuestionsService', () => {
  let service: QuestionsService;

  const mockPrisma = {
    lesson: {
      findUnique: jest.fn(),
    },
    question: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
    },
    answer: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    enrollment: {
      findUnique: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  const mockLesson = {
    id: 'lesson-1',
    title: 'Intro Lesson',
    isFree: false,
    module: {
      id: 'module-1',
      courseId: 'course-1',
      course: {
        id: 'course-1',
        title: 'Master Course',
        instructor: { id: 'instructor-1' },
        instructorAddress: 'GINSTR',
      },
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QuestionsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<QuestionsService>(QuestionsService);
    jest.clearAllMocks();
  });

  describe('createQuestion', () => {
    const dto = {
      title: 'How does this work?',
      content: 'I need some help understanding step 2.',
    };

    it('allows an enrolled student to ask a question', async () => {
      mockPrisma.lesson.findUnique.mockResolvedValue(mockLesson);
      mockPrisma.enrollment.findUnique.mockResolvedValue({ id: 'enroll-1' });
      mockPrisma.question.create.mockResolvedValue({
        id: 'q-1',
        lessonId: 'lesson-1',
        authorId: 'student-1',
        ...dto,
      });

      const result = await service.createQuestion(
        'lesson-1',
        'student-1',
        UserRole.STUDENT,
        dto,
      );

      expect(result.id).toBe('q-1');
      expect(mockPrisma.question.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            lessonId: 'lesson-1',
            authorId: 'student-1',
            title: dto.title,
            content: dto.content,
          }),
        }),
      );
    });

    it('allows the course instructor to ask a question without enrollment check', async () => {
      mockPrisma.lesson.findUnique.mockResolvedValue(mockLesson);
      mockPrisma.question.create.mockResolvedValue({
        id: 'q-1',
        lessonId: 'lesson-1',
        authorId: 'instructor-1',
        ...dto,
      });

      const result = await service.createQuestion(
        'lesson-1',
        'instructor-1',
        UserRole.INSTRUCTOR,
        dto,
      );

      expect(result.id).toBe('q-1');
      expect(mockPrisma.enrollment.findUnique).not.toHaveBeenCalled();
    });

    it('allows an admin to ask a question without enrollment check', async () => {
      mockPrisma.lesson.findUnique.mockResolvedValue(mockLesson);
      mockPrisma.question.create.mockResolvedValue({
        id: 'q-1',
        lessonId: 'lesson-1',
        authorId: 'admin-1',
        ...dto,
      });

      const result = await service.createQuestion(
        'lesson-1',
        'admin-1',
        UserRole.ADMIN,
        dto,
      );

      expect(result.id).toBe('q-1');
      expect(mockPrisma.enrollment.findUnique).not.toHaveBeenCalled();
    });

    it('allows questions on free preview lessons even if not enrolled', async () => {
      mockPrisma.lesson.findUnique.mockResolvedValue({
        ...mockLesson,
        isFree: true,
      });
      mockPrisma.enrollment.findUnique.mockResolvedValue(null);
      mockPrisma.question.create.mockResolvedValue({
        id: 'q-1',
        ...dto,
      });

      const result = await service.createQuestion(
        'lesson-1',
        'student-anon',
        UserRole.STUDENT,
        dto,
      );

      expect(result.id).toBe('q-1');
    });

    it('throws ForbiddenException if non-enrolled user posts on paid lesson', async () => {
      mockPrisma.lesson.findUnique.mockResolvedValue(mockLesson);
      mockPrisma.enrollment.findUnique.mockResolvedValue(null);

      await expect(
        service.createQuestion('lesson-1', 'student-2', UserRole.STUDENT, dto),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws NotFoundException if lesson does not exist', async () => {
      mockPrisma.lesson.findUnique.mockResolvedValue(null);

      await expect(
        service.createQuestion('missing-lesson', 'student-1', UserRole.STUDENT, dto),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('getQuestionsByLesson', () => {
    it('returns paginated list of questions', async () => {
      mockPrisma.lesson.findUnique.mockResolvedValue({ id: 'lesson-1' });
      const questions = [
        { id: 'q-1', title: 'Q1', answers: [] },
        { id: 'q-2', title: 'Q2', answers: [] },
      ];
      mockPrisma.$transaction.mockResolvedValue([questions, 2]);

      const result = await service.getQuestionsByLesson('lesson-1', 1, 10);
      expect(result.data).toHaveLength(2);
      expect(result.meta.total).toBe(2);
      expect(result.meta.totalPages).toBe(1);
    });

    it('throws NotFoundException if lesson not found', async () => {
      mockPrisma.lesson.findUnique.mockResolvedValue(null);

      await expect(
        service.getQuestionsByLesson('missing-lesson'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('createAnswer', () => {
    const dto = { content: 'Here is the solution to your question.' };
    const mockQuestion = {
      id: 'q-1',
      authorId: 'student-1',
      lesson: mockLesson,
    };

    it('allows an enrolled student to answer a question', async () => {
      mockPrisma.question.findUnique.mockResolvedValue(mockQuestion);
      mockPrisma.enrollment.findUnique.mockResolvedValue({ id: 'enroll-2' });
      mockPrisma.answer.create.mockResolvedValue({
        id: 'ans-1',
        questionId: 'q-1',
        authorId: 'student-2',
        ...dto,
      });

      const result = await service.createAnswer(
        'q-1',
        'student-2',
        UserRole.STUDENT,
        dto,
      );

      expect(result.id).toBe('ans-1');
    });

    it('throws ForbiddenException if non-enrolled user answers on paid lesson', async () => {
      mockPrisma.question.findUnique.mockResolvedValue(mockQuestion);
      mockPrisma.enrollment.findUnique.mockResolvedValue(null);

      await expect(
        service.createAnswer('q-1', 'student-non-enrolled', UserRole.STUDENT, dto),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws NotFoundException if question does not exist', async () => {
      mockPrisma.question.findUnique.mockResolvedValue(null);

      await expect(
        service.createAnswer('missing-q', 'student-1', UserRole.STUDENT, dto),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('markBestAnswer', () => {
    const mockAnswer = {
      id: 'ans-1',
      questionId: 'q-1',
      authorId: 'student-2',
      isBestAnswer: false,
      question: {
        id: 'q-1',
        authorId: 'author-1',
      },
    };

    it('allows the question author to mark an answer as the best answer', async () => {
      mockPrisma.answer.findUnique.mockResolvedValue(mockAnswer);
      mockPrisma.$transaction.mockImplementation(async (cb) => {
        const tx = {
          answer: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            update: jest.fn().mockResolvedValue({ ...mockAnswer, isBestAnswer: true }),
          },
        };
        return cb(tx);
      });

      const result = await service.markBestAnswer('ans-1', 'author-1', UserRole.STUDENT);
      expect(result.isBestAnswer).toBe(true);
    });

    it('allows an admin to mark an answer as the best answer', async () => {
      mockPrisma.answer.findUnique.mockResolvedValue(mockAnswer);
      mockPrisma.$transaction.mockImplementation(async (cb) => {
        const tx = {
          answer: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            update: jest.fn().mockResolvedValue({ ...mockAnswer, isBestAnswer: true }),
          },
        };
        return cb(tx);
      });

      const result = await service.markBestAnswer('ans-1', 'admin-user', UserRole.ADMIN);
      expect(result.isBestAnswer).toBe(true);
    });

    it('throws ForbiddenException if a user other than author or admin tries to mark best answer', async () => {
      mockPrisma.answer.findUnique.mockResolvedValue(mockAnswer);

      await expect(
        service.markBestAnswer('ans-1', 'random-user', UserRole.STUDENT),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws NotFoundException if answer not found', async () => {
      mockPrisma.answer.findUnique.mockResolvedValue(null);

      await expect(
        service.markBestAnswer('missing-ans', 'author-1', UserRole.STUDENT),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
