import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { QuizzesService } from './quizzes.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { UserRole } from '@prisma/client';

describe('QuizzesService (Issue #168) — hide correctAnswer from students', () => {
  let service: QuizzesService;

  const mockQuestion = {
    id: 'q1',
    lessonId: 'l1',
    question: 'What is 2+2?',
    type: 'SINGLE_CHOICE',
    options: ['3', '4', '5'],
    correctAnswer: [1],
    explanation: 'Basic arithmetic',
    points: 1,
    position: 1,
  };

  const mockPrisma = {
    lesson: { findUnique: jest.fn().mockResolvedValue({ id: 'l1' }) },
    quizQuestion: {
      findUnique: jest.fn().mockResolvedValue(mockQuestion),
      findMany: jest.fn().mockResolvedValue([mockQuestion]),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QuizzesService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<QuizzesService>(QuizzesService);
  });

  it('should hide correctAnswer and explanation for STUDENT on getQuestionById', async () => {
    const result = await service.getQuestionById('q1', UserRole.STUDENT);
    expect(result).not.toHaveProperty('correctAnswer');
    expect(result).not.toHaveProperty('explanation');
    expect(result).toHaveProperty('question');
  });

  it('should include correctAnswer and explanation for INSTRUCTOR on getQuestionById', async () => {
    const result = await service.getQuestionById('q1', UserRole.INSTRUCTOR);
    expect(result).toHaveProperty('correctAnswer');
    expect(result).toHaveProperty('explanation');
  });

  it('should hide correctAnswer and explanation for STUDENT on getQuestionsByLesson', async () => {
    const results = await service.getQuestionsByLesson('l1', UserRole.STUDENT);
    expect(results.length).toBeGreaterThan(0);
    for (const q of results) {
      expect(q).not.toHaveProperty('correctAnswer');
      expect(q).not.toHaveProperty('explanation');
    }
  });

  it('should include correctAnswer for INSTRUCTOR on getQuestionsByLesson', async () => {
    const results = await service.getQuestionsByLesson('l1', UserRole.INSTRUCTOR);
    expect(results[0]).toHaveProperty('correctAnswer');
  });
});
