import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CommentReviewStatus, EnrollmentStatus, UserRole } from '@prisma/client';
import { CommentModerationService } from './comment-moderation.service';
import { PrismaService } from '../../common/prisma/prisma.service';

describe('CommentModerationService (Issue #286)', () => {
  let service: CommentModerationService;

  const mockPrisma: any = {
    course: { findUnique: jest.fn() },
    enrollment: { findUnique: jest.fn() },
    discussionComment: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  const baseComment = {
    id: 'comment-1',
    discussionId: 'course-1',
    authorId: 'student-1',
    content: 'Great lesson!',
    hidden: false,
    flaggedCount: 0,
    reviewStatus: CommentReviewStatus.APPROVED,
    moderationNotes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommentModerationService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<CommentModerationService>(CommentModerationService);
    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation((promises: any[]) => Promise.all(promises));
    mockPrisma.discussionComment.create.mockImplementation(async ({ data }: any) => data);
  });

  describe('findCommentById', () => {
    it('returns visible comments to the public without moderation notes', async () => {
      mockPrisma.discussionComment.findUnique.mockResolvedValue({
        ...baseComment,
        moderationNotes: 'internal',
      });

      const result: any = await service.findCommentById('comment-1');
      expect(result.id).toBe('comment-1');
      expect(result.moderationNotes).toBeUndefined();
    });

    it('returns 404 for hidden comments to non-admins', async () => {
      mockPrisma.discussionComment.findUnique.mockResolvedValue({ ...baseComment, hidden: true });

      await expect(service.findCommentById('comment-1')).rejects.toThrow(NotFoundException);
      await expect(
        service.findCommentById('comment-1', UserRole.STUDENT),
      ).rejects.toThrow(NotFoundException);
    });

    it('returns 404 for rejected comments to non-admins', async () => {
      mockPrisma.discussionComment.findUnique.mockResolvedValue({
        ...baseComment,
        reviewStatus: CommentReviewStatus.REJECTED,
      });

      await expect(service.findCommentById('comment-1')).rejects.toThrow(NotFoundException);
    });

    it('returns hidden comments with moderation notes to admins', async () => {
      const hidden = { ...baseComment, hidden: true, moderationNotes: 'Auto-flagged: spam' };
      mockPrisma.discussionComment.findUnique.mockResolvedValue(hidden);

      const result = await service.findCommentById('comment-1', UserRole.ADMIN);
      expect(result).toEqual(hidden);
    });

    it('returns 404 when the comment does not exist', async () => {
      mockPrisma.discussionComment.findUnique.mockResolvedValue(null);

      await expect(
        service.findCommentById('missing', UserRole.ADMIN),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('createComment', () => {
    const dto = { discussionId: 'course-1', content: 'Thanks for the lesson' };

    it('rejects comments on a discussion that does not exist', async () => {
      mockPrisma.course.findUnique.mockResolvedValue(null);

      await expect(service.createComment('student-1', dto)).rejects.toThrow(NotFoundException);
      expect(mockPrisma.discussionComment.create).not.toHaveBeenCalled();
    });

    it('rejects comments from users who are not enrolled', async () => {
      mockPrisma.course.findUnique.mockResolvedValue({ id: 'course-1', instructor: { id: 'inst-1' } });
      mockPrisma.enrollment.findUnique.mockResolvedValue(null);

      await expect(service.createComment('student-1', dto)).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.discussionComment.create).not.toHaveBeenCalled();
    });

    it('rejects comments from refunded enrollments', async () => {
      mockPrisma.course.findUnique.mockResolvedValue({ id: 'course-1', instructor: { id: 'inst-1' } });
      mockPrisma.enrollment.findUnique.mockResolvedValue({ status: EnrollmentStatus.REFUNDED });

      await expect(service.createComment('student-1', dto)).rejects.toThrow(ForbiddenException);
    });

    it('allows enrolled students to comment', async () => {
      mockPrisma.course.findUnique.mockResolvedValue({ id: 'course-1', instructor: { id: 'inst-1' } });
      mockPrisma.enrollment.findUnique.mockResolvedValue({ status: EnrollmentStatus.ACTIVE });

      const result: any = await service.createComment('student-1', dto);
      expect(result.reviewStatus).toBe(CommentReviewStatus.APPROVED);
      expect(result.hidden).toBe(false);
    });

    it('allows the course instructor and admins without enrollment', async () => {
      mockPrisma.course.findUnique.mockResolvedValue({ id: 'course-1', instructor: { id: 'inst-1' } });

      await expect(service.createComment('inst-1', dto, UserRole.INSTRUCTOR)).resolves.toBeDefined();
      await expect(service.createComment('admin-1', dto, UserRole.ADMIN)).resolves.toBeDefined();
      expect(mockPrisma.enrollment.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('banned term matching', () => {
    beforeEach(() => {
      mockPrisma.course.findUnique.mockResolvedValue({ id: 'course-1', instructor: { id: 'inst-1' } });
      mockPrisma.enrollment.findUnique.mockResolvedValue({ status: EnrollmentStatus.ACTIVE });
    });

    it.each([
      'I cooked scampi after class',
      'The lesson on spotting fakes was useful',
      'Spammers aside, this course is great',
    ])('does not flag innocent text: "%s"', async (content) => {
      const result: any = await service.createComment('student-1', { discussionId: 'course-1', content });
      expect(result.flaggedCount).toBe(0);
      expect(result.hidden).toBe(false);
    });

    it.each([
      'This is a scam',
      'Totally FAKE certificate',
      'Click   here for discounts',
    ])('flags whole banned terms: "%s"', async (content) => {
      const result: any = await service.createComment('student-1', { discussionId: 'course-1', content });
      expect(result.flaggedCount).toBe(1);
      expect(result.hidden).toBe(true);
      expect(result.reviewStatus).toBe(CommentReviewStatus.PENDING);
    });
  });

  describe('findCommentsForDiscussion pagination (Issue #147)', () => {
    it('applies default pagination (page=1, limit=20)', async () => {
      const mockComments = [baseComment];
      mockPrisma.discussionComment.findMany.mockResolvedValue(mockComments);
      mockPrisma.discussionComment.count.mockResolvedValue(1);

      const result = await service.findCommentsForDiscussion('course-1');

      expect(mockPrisma.discussionComment.findMany).toHaveBeenCalledWith({
        where: {
          discussionId: 'course-1',
          hidden: false,
          reviewStatus: { not: CommentReviewStatus.REJECTED },
        },
        orderBy: { createdAt: 'desc' },
        skip: 0,
        take: 20,
      });
      expect(mockPrisma.discussionComment.count).toHaveBeenCalledWith({
        where: {
          discussionId: 'course-1',
          hidden: false,
          reviewStatus: { not: CommentReviewStatus.REJECTED },
        },
      });
      expect(result).toEqual({
        data: mockComments,
        meta: { total: 1, page: 1, limit: 20 },
      });
    });

    it('paginates correctly on boundary page=2, limit=20', async () => {
      const page2Comments = [{ ...baseComment, id: 'comment-21' }];
      mockPrisma.discussionComment.findMany.mockResolvedValue(page2Comments);
      mockPrisma.discussionComment.count.mockResolvedValue(25);

      const result = await service.findCommentsForDiscussion('course-1', 2, 20);

      expect(mockPrisma.discussionComment.findMany).toHaveBeenCalledWith({
        where: {
          discussionId: 'course-1',
          hidden: false,
          reviewStatus: { not: CommentReviewStatus.REJECTED },
        },
        orderBy: { createdAt: 'desc' },
        skip: 20,
        take: 20,
      });
      expect(result).toEqual({
        data: page2Comments,
        meta: { total: 25, page: 2, limit: 20 },
      });
    });

    it('returns empty array when page exceeds total count', async () => {
      mockPrisma.discussionComment.findMany.mockResolvedValue([]);
      mockPrisma.discussionComment.count.mockResolvedValue(25);

      const result = await service.findCommentsForDiscussion('course-1', 3, 20);

      expect(mockPrisma.discussionComment.findMany).toHaveBeenCalledWith({
        where: {
          discussionId: 'course-1',
          hidden: false,
          reviewStatus: { not: CommentReviewStatus.REJECTED },
        },
        orderBy: { createdAt: 'desc' },
        skip: 40,
        take: 20,
      });
      expect(result).toEqual({
        data: [],
        meta: { total: 25, page: 3, limit: 20 },
      });
    });

    it('normalizes non-positive page and limit to default values', async () => {
      mockPrisma.discussionComment.findMany.mockResolvedValue([]);
      mockPrisma.discussionComment.count.mockResolvedValue(0);

      const result = await service.findCommentsForDiscussion('course-1', 0, -10);

      expect(mockPrisma.discussionComment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 0,
          take: 20,
        }),
      );
      expect(result.meta).toEqual({ total: 0, page: 1, limit: 20 });
    });
  });

  describe('findFlaggedComments pagination (Issue #147)', () => {
    it('applies default pagination (page=1, limit=20)', async () => {
      const flagged = [{ ...baseComment, flaggedCount: 1 }];
      mockPrisma.discussionComment.findMany.mockResolvedValue(flagged);
      mockPrisma.discussionComment.count.mockResolvedValue(1);

      const result = await service.findFlaggedComments();

      expect(mockPrisma.discussionComment.findMany).toHaveBeenCalledWith({
        where: {
          flaggedCount: { gt: 0 },
        },
        orderBy: { createdAt: 'desc' },
        skip: 0,
        take: 20,
      });
      expect(mockPrisma.discussionComment.count).toHaveBeenCalledWith({
        where: {
          flaggedCount: { gt: 0 },
        },
      });
      expect(result).toEqual({
        data: flagged,
        meta: { total: 1, page: 1, limit: 20 },
      });
    });

    it('paginates correctly on boundary page=2, limit=20', async () => {
      const flaggedPage2 = [{ ...baseComment, id: 'comment-flagged-21', flaggedCount: 2 }];
      mockPrisma.discussionComment.findMany.mockResolvedValue(flaggedPage2);
      mockPrisma.discussionComment.count.mockResolvedValue(30);

      const result = await service.findFlaggedComments(2, 20);

      expect(mockPrisma.discussionComment.findMany).toHaveBeenCalledWith({
        where: {
          flaggedCount: { gt: 0 },
        },
        orderBy: { createdAt: 'desc' },
        skip: 20,
        take: 20,
      });
      expect(result).toEqual({
        data: flaggedPage2,
        meta: { total: 30, page: 2, limit: 20 },
      });
    });

    it('returns empty array when requested page exceeds total count', async () => {
      mockPrisma.discussionComment.findMany.mockResolvedValue([]);
      mockPrisma.discussionComment.count.mockResolvedValue(10);

      const result = await service.findFlaggedComments(3, 10);

      expect(mockPrisma.discussionComment.findMany).toHaveBeenCalledWith({
        where: {
          flaggedCount: { gt: 0 },
        },
        orderBy: { createdAt: 'desc' },
        skip: 20,
        take: 10,
      });
      expect(result).toEqual({
        data: [],
        meta: { total: 10, page: 3, limit: 10 },
      });
    });

    it('normalizes non-positive page and limit to default values', async () => {
      mockPrisma.discussionComment.findMany.mockResolvedValue([]);
      mockPrisma.discussionComment.count.mockResolvedValue(0);

      const result = await service.findFlaggedComments(-1, 0);

      expect(mockPrisma.discussionComment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 0,
          take: 20,
        }),
      );
      expect(result.meta).toEqual({ total: 0, page: 1, limit: 20 });
    });
  });
});
