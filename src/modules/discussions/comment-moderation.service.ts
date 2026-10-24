import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateCommentDto } from './dto/create-comment.dto';
import { ReviewCommentDto } from './dto/review-comment.dto';
import { CommentReviewStatus, EnrollmentStatus, UserRole } from '@prisma/client';
import Filter = require('bad-words');

@Injectable()
export class CommentModerationService {
  private readonly logger = new Logger(CommentModerationService.name);
  private readonly filter = new Filter();
  private readonly bannedTerms = [
    'spam',
    'scam',
    'fake',
    'click here',
    'free money',
    'buy now',
    'cancel subscription',
  ];
  // Whole-word patterns so innocent words like "scampi" or "fakes" are not flagged
  private readonly bannedTermPatterns = this.bannedTerms.map((term) => ({
    term,
    pattern: new RegExp(
      `\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}\\b`,
      'i',
    ),
  }));
  private readonly autoHideThreshold = 1;

  constructor(private readonly prisma: PrismaService) {
    this.filter.addWords(...this.bannedTerms);
  }

  private scanContent(content: string) {
    const matchedTerms = this.bannedTermPatterns
      .filter(({ pattern }) => pattern.test(content))
      .map(({ term }) => term);
    const hasProfanity = this.filter.isProfane(content);
    const reasons = new Set<string>(matchedTerms);

    if (hasProfanity) {
      reasons.add('profanity');
    }

    return {
      isFlagged: reasons.size > 0,
      reasons: [...reasons],
    };
  }

  /**
   * A discussion thread belongs to a course: `discussionId` is the course ID.
   * Only enrolled students, the course instructor or an admin may comment.
   */
  private async assertCanComment(authorId: string, role: UserRole | undefined, discussionId: string) {
    const course = await this.prisma.course.findUnique({
      where: { id: discussionId },
      select: { id: true, instructor: { select: { id: true } } },
    });
    if (!course) {
      throw new NotFoundException(`Discussion ${discussionId} not found`);
    }

    if (role === UserRole.ADMIN || course.instructor?.id === authorId) {
      return;
    }

    const enrollment = await this.prisma.enrollment.findUnique({
      where: { studentId_courseId: { studentId: authorId, courseId: discussionId } },
      select: { status: true },
    });
    if (
      !enrollment
      || (enrollment.status !== EnrollmentStatus.ACTIVE
        && enrollment.status !== EnrollmentStatus.COMPLETED)
    ) {
      throw new ForbiddenException('You must be enrolled in this course to join its discussion');
    }
  }

  async createComment(authorId: string, dto: CreateCommentDto, role?: UserRole) {
    await this.assertCanComment(authorId, role, dto.discussionId);

    const scan = this.scanContent(dto.content);
    const flaggedCount = scan.isFlagged ? 1 : 0;
    const hidden = scan.isFlagged && flaggedCount >= this.autoHideThreshold;
    const reviewStatus = scan.isFlagged
      ? CommentReviewStatus.PENDING
      : CommentReviewStatus.APPROVED;

    return this.prisma.discussionComment.create({
      data: {
        discussionId: dto.discussionId,
        authorId,
        content: dto.content,
        hidden,
        flaggedCount,
        reviewStatus,
        moderationNotes: scan.isFlagged ? `Auto-flagged: ${scan.reasons.join(', ')}` : null,
      },
    });
  }

  async findCommentsForDiscussion(discussionId: string, page = 1, limit = 20) {
    const pageNum = Number(page) > 0 ? Number(page) : 1;
    const limitNum = Number(limit) > 0 ? Number(limit) : 20;
    const skip = (pageNum - 1) * limitNum;

    const where = {
      discussionId,
      hidden: false,
      reviewStatus: { not: CommentReviewStatus.REJECTED },
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.discussionComment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limitNum,
      }),
      this.prisma.discussionComment.count({ where }),
    ]);

    return {
      data,
      meta: {
        total,
        page: pageNum,
        limit: limitNum,
      },
    };
  }

  async findCommentById(id: string, viewerRole?: UserRole | null) {
    const comment = await this.prisma.discussionComment.findUnique({ where: { id } });
    if (!comment) {
      throw new NotFoundException(`Comment ${id} not found`);
    }

    if (viewerRole === UserRole.ADMIN) {
      return comment;
    }

    // Hidden or rejected comments are invisible to everyone but admins
    if (comment.hidden || comment.reviewStatus === CommentReviewStatus.REJECTED) {
      throw new NotFoundException(`Comment ${id} not found`);
    }

    const { moderationNotes: _moderationNotes, ...publicComment } = comment;
    return publicComment;
  }

  async findFlaggedComments(page = 1, limit = 20) {
    const pageNum = Number(page) > 0 ? Number(page) : 1;
    const limitNum = Number(limit) > 0 ? Number(limit) : 20;
    const skip = (pageNum - 1) * limitNum;

    const where = {
      flaggedCount: {
        gt: 0,
      },
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.discussionComment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limitNum,
      }),
      this.prisma.discussionComment.count({ where }),
    ]);

    return {
      data,
      meta: {
        total,
        page: pageNum,
        limit: limitNum,
      },
    };
  }

  async getModerationSummary() {
    const flaggedCount = await this.prisma.discussionComment.count({
      where: {
        flaggedCount: {
          gt: 0,
        },
      },
    });

    const pendingCount = await this.prisma.discussionComment.count({
      where: {
        reviewStatus: CommentReviewStatus.PENDING,
      },
    });

    return {
      flaggedCount,
      pendingCount,
    };
  }

  async moderateComment(id: string, dto: ReviewCommentDto) {
    const isRejected = dto.reviewStatus === CommentReviewStatus.REJECTED;

    return this.prisma.discussionComment.update({
      where: { id },
      data: {
        reviewStatus: dto.reviewStatus,
        hidden: dto.hidden ?? isRejected,
        moderationNotes: dto.moderationNotes ?? null,
      },
    });
  }
}
