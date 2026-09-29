import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ReviewsService } from './reviews.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EnrollmentsService } from '../enrollments/enrollments.service';

describe('ReviewsService (Issue #173) — edit/delete/admin', () => {
  let service: ReviewsService;

  const existingReview = {
    id: 'rev1',
    courseId: 'course1',
    studentId: 'student1',
    rating: 4,
    comment: 'Good course',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockPrisma = {
    course: { findUnique: jest.fn().mockResolvedValue({ id: 'course1' }), update: jest.fn() },
    courseReview: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      aggregate: jest.fn().mockResolvedValue({ _avg: { rating: 4 }, _count: { _all: 1 } }),
    },
    $transaction: jest.fn(),
  };

  const mockEnrollments = { isEnrolled: jest.fn().mockResolvedValue(true) };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReviewsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EnrollmentsService, useValue: mockEnrollments },
      ],
    }).compile();

    service = module.get<ReviewsService>(ReviewsService);
    jest.clearAllMocks();
  });

  it('should update own review', async () => {
    mockPrisma.courseReview.findUnique.mockResolvedValue(existingReview);
    mockPrisma.courseReview.update.mockResolvedValue({ ...existingReview, rating: 5 });

    const result = await service.updateMyReview('student1', 'course1', { rating: 5 });
    expect(result.rating).toBe(5);
  });

  it('should reject update from non-owner (403)', async () => {
    mockPrisma.courseReview.findUnique.mockResolvedValue(existingReview);

    await expect(
      service.updateMyReview('other-student', 'course1', { rating: 3 }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('should delete own review', async () => {
    mockPrisma.courseReview.findUnique.mockResolvedValue(existingReview);
    mockPrisma.courseReview.delete.mockResolvedValue(existingReview);

    const result = await service.deleteMyReview('student1', 'course1');
    expect(result.message).toBe('Review deleted');
  });

  it('should reject delete from non-owner (403)', async () => {
    mockPrisma.courseReview.findUnique.mockResolvedValue(existingReview);

    await expect(
      service.deleteMyReview('other-student', 'course1'),
    ).rejects.toThrow(ForbiddenException);
  });

  it('should 404 on delete if review not found', async () => {
    mockPrisma.courseReview.findUnique.mockResolvedValue(null);

    await expect(
      service.deleteMyReview('student1', 'course1'),
    ).rejects.toThrow(NotFoundException);
  });

  it('admin should delete any review by id', async () => {
    mockPrisma.courseReview.findUnique.mockResolvedValue(existingReview);
    mockPrisma.courseReview.delete.mockResolvedValue(existingReview);

    const result = await service.adminDeleteReview('rev1');
    expect(result.message).toBe('Review deleted by admin');
  });

  it('admin delete should 404 if review not found', async () => {
    mockPrisma.courseReview.findUnique.mockResolvedValue(null);

    await expect(service.adminDeleteReview('nonexistent')).rejects.toThrow(NotFoundException);
  });
});
