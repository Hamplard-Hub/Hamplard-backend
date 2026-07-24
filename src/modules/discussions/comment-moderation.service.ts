import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateCommentDto } from './dto/create-comment.dto';
import { ReviewCommentDto } from './dto/review-comment.dto';
import { CommentReviewStatus } from '@prisma/client';
import Filter from 'bad-words';

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
  private readonly autoHideThreshold = 1;

  constructor(private readonly prisma: PrismaService) {
    this.filter.addWords(...this.bannedTerms);
  }

  private scanContent(content: string) {
    const lowerContent = content.toLowerCase();
    const matchedTerms = this.bannedTerms.filter((term) =>
      lowerContent.includes(term),
    );
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

  async createComment(authorId: string, dto: CreateCommentDto) {
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

  async findCommentsForDiscussion(discussionId: string) {
    return this.prisma.discussionComment.findMany({
      where: {
        discussionId,
        hidden: false,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findCommentById(id: string) {
    return this.prisma.discussionComment.findUnique({ where: { id } });
  }

  async findFlaggedComments() {
    return this.prisma.discussionComment.findMany({
      where: {
        flaggedCount: {
          gt: 0,
        },
      },
      orderBy: { createdAt: 'desc' },
    });
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
