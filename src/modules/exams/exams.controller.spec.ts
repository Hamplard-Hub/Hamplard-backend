import { Test, TestingModule } from '@nestjs/testing';
import { ExamsController } from './exams.controller';
import { ExamsService } from './exams.service';
import { RolesGuard } from '../../common/guards/roles.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { ForbiddenException } from '@nestjs/common';

describe('ExamsController', () => {
  let controller: ExamsController;
  let service: ExamsService;

  const mockExamsService = {
    createOrUpdateExam: jest.fn(),
    getExamByCourse: jest.fn(),
    checkEligibility: jest.fn(),
    submitExam: jest.fn(),
    getAttemptHistory: jest.fn(),
    deleteExam: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ExamsController],
      providers: [
        { provide: ExamsService, useValue: mockExamsService },
        Reflector,
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<ExamsController>(ExamsController);
    service = module.get<ExamsService>(ExamsService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('createOrUpdateExam', () => {
    it('calls service.createOrUpdateExam with CurrentUser id', async () => {
      const dto = {
        courseId: 'course-1',
        title: 'Certification Exam',
        questions: [{ id: 'q1', points: 1, correctAnswer: [0] }],
      };
      mockExamsService.createOrUpdateExam.mockResolvedValue({ id: 'exam-1', ...dto });

      const result = await controller.createOrUpdateExam('instructor-1', dto as any);
      expect(mockExamsService.createOrUpdateExam).toHaveBeenCalledWith('instructor-1', dto);
      expect(result.id).toBe('exam-1');
    });

    it('has RolesGuard and Roles decorator requiring INSTRUCTOR or ADMIN', () => {
      const reflector = new Reflector();
      const roles = reflector.get<string[]>('roles', controller.createOrUpdateExam);
      expect(roles).toEqual([UserRole.INSTRUCTOR, UserRole.ADMIN]);
    });
  });

  describe('deleteExam', () => {
    it('calls service.deleteExam with user id and role', async () => {
      mockExamsService.deleteExam.mockResolvedValue({ id: 'exam-1' });

      const result = await controller.deleteExam('exam-1', {
        id: 'instructor-1',
        role: UserRole.INSTRUCTOR,
      });

      expect(mockExamsService.deleteExam).toHaveBeenCalledWith(
        'exam-1',
        'instructor-1',
        UserRole.INSTRUCTOR,
      );
      expect(result).toEqual({ id: 'exam-1' });
    });

    it('has RolesGuard and Roles decorator requiring INSTRUCTOR or ADMIN', () => {
      const reflector = new Reflector();
      const roles = reflector.get<string[]>('roles', controller.deleteExam);
      expect(roles).toEqual([UserRole.INSTRUCTOR, UserRole.ADMIN]);
    });

    it('propagates 403 ForbiddenException if instructor is not owner', async () => {
      mockExamsService.deleteExam.mockRejectedValue(
        new ForbiddenException('Only the course instructor or an admin can delete this exam'),
      );

      await expect(
        controller.deleteExam('exam-1', {
          id: 'wrong-instructor',
          role: UserRole.INSTRUCTOR,
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
