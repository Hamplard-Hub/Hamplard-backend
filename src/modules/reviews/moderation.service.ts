import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ModerationAction, NotificationType, ReviewStatus } from '@prisma/client';
import { ModerateReviewDto } from './dto/moderate-review.dto';

@Injectable()
export class ModerationService {
  private readonly logger = new Logger(ModerationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  // ------------------------------------------------------------------
  // MODERATION QUEUE
  // ------------------------------------------------------------------

  /**
   * Returns all reviews currently in the moderation queue (status = FLAGGED),
   * paginated, with their flags and author info.
   */
  async getQueue(page = 1, limit = 20) {
    const where = { status: ReviewStatus.FLAGGED };

    const [reviews, total] = await this.prisma.$transaction([
      this.prisma.review.findMany({
        where,
        include: {
          author:  { select: { name: true, stellarAddress: true, avatarUrl: true } },
          course:  { select: { id: true, title: true } },
          flags:   {
            include: { reporter: { select: { name: true, stellarAddress: true } } },
            orderBy: { createdAt: 'desc' },
          },
          _count: { select: { flags: true } },
        },
        orderBy: { flagCount: 'desc' }, // highest flag counts first
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.review.count({ where }),
    ]);

    return { data: reviews, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  // ------------------------------------------------------------------
  // MODERATE (approve / remove)
  // ------------------------------------------------------------------

  /**
   * Admin approves or removes a flagged review.
   *
   * APPROVED → review status set back to VISIBLE and flagCount reset to 0.
   *            All existing flags for this review are cleared.
   * REMOVED  → review status set to REMOVED (soft-delete; still in DB for audit).
   *            The review author is notified.
   */
  async moderateReview(
    reviewId: string,
    moderatorId: string,
    dto: ModerateReviewDto,
  ) {
    const review = await this.prisma.review.findUnique({
      where: { id: reviewId },
      include: { author: true },
    });
    if (!review) throw new NotFoundException(`Review ${reviewId} not found`);

    if (review.status === ReviewStatus.REMOVED) {
      throw new ForbiddenException('Review has already been removed');
    }

    let newStatus: ReviewStatus;
    if (dto.action === ModerationAction.APPROVED) {
      newStatus = ReviewStatus.APPROVED;
    } else {
      newStatus = ReviewStatus.REMOVED;
    }

    // Update the review and log the action in a transaction
    const [updatedReview] = await this.prisma.$transaction([
      this.prisma.review.update({
        where: { id: reviewId },
        data: {
          status:    newStatus,
          // Clear flag count when approving so future flags start fresh
          flagCount: dto.action === ModerationAction.APPROVED ? 0 : review.flagCount,
        },
      }),
      // Delete all existing flags if approved (clean slate)
      ...(dto.action === ModerationAction.APPROVED
        ? [this.prisma.reviewFlag.deleteMany({ where: { reviewId } })]
        : []),
      // Record moderation audit log
      this.prisma.moderationLog.create({
        data: {
          reviewId,
          moderatorId,
          action: dto.action,
          reason: dto.reason,
        },
      }),
    ]);

    // Send notification to the review author
    const notifType =
      dto.action === ModerationAction.APPROVED
        ? NotificationType.REVIEW_APPROVED
        : NotificationType.REVIEW_REMOVED;

    const notifTitle =
      dto.action === ModerationAction.APPROVED
        ? 'Your review has been approved'
        : 'Your review has been removed';

    const notifMessage =
      dto.action === ModerationAction.APPROVED
        ? 'A moderator reviewed your flagged review and confirmed it complies with our community guidelines.'
        : `Your review has been removed by a moderator.${dto.reason ? ` Reason: ${dto.reason}` : ''}`;

    await this.notifications.notifyUser(
      review.authorId,
      notifType,
      notifTitle,
      notifMessage,
      { reviewId, courseId: review.courseId },
    );

    this.logger.log(
      `Review ${reviewId} ${dto.action} by moderator ${moderatorId}${dto.reason ? ` (reason: ${dto.reason})` : ''}`,
    );
    return updatedReview;
  }

  // ------------------------------------------------------------------
  // AUDIT HISTORY
  // ------------------------------------------------------------------

  /**
   * Full audit log of moderation actions for a specific review.
   */
  async getReviewAuditHistory(reviewId: string) {
    const review = await this.prisma.review.findUnique({ where: { id: reviewId } });
    if (!review) throw new NotFoundException(`Review ${reviewId} not found`);

    return this.prisma.moderationLog.findMany({
      where: { reviewId },
      include: {
        moderator: { select: { name: true, stellarAddress: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Admin dashboard view — audit history across all reviews, paginated.
   */
  async getAllAuditHistory(page = 1, limit = 50) {
    const [logs, total] = await this.prisma.$transaction([
      this.prisma.moderationLog.findMany({
        include: {
          review:   { select: { id: true, courseId: true, body: true, status: true } },
          moderator: { select: { name: true, stellarAddress: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.moderationLog.count(),
    ]);

    return { data: logs, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }
}
