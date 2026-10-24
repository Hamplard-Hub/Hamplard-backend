import {
  Injectable, NotFoundException, BadRequestException,
  ForbiddenException, Logger,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { UploadsService } from '../uploads/uploads.service';
import { KycStatus, NotificationType } from '@prisma/client';
import { SubmitKycDto } from './dto/submit-kyc.dto';
import { ReviewKycDto } from './dto/review-kyc.dto';

@Injectable()
export class KycService {
  private readonly logger = new Logger(KycService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly uploads: UploadsService,
  ) {}

  // ----------------------------------------------------------
  // SUBMIT KYC (instructor)
  // ----------------------------------------------------------

  async submit(
    instructorId: string,
    dto: SubmitKycDto,
    documentFile: Express.Multer.File,
    additionalFile?: Express.Multer.File,
  ) {
    // Verify the user is an instructor
    const user = await this.prisma.user.findUnique({ where: { id: instructorId } });
    if (!user) throw new NotFoundException('User not found');

    // Check for an existing approved submission — no need to resubmit
    const approved = await this.prisma.kycSubmission.findFirst({
      where: { instructorId, status: KycStatus.APPROVED },
    });
    if (approved) {
      throw new BadRequestException('Your KYC is already approved');
    }

    // Save primary document (persist stable origin path; expose CDN URLs in response)
    const primary = await this.uploads.saveKycDocument(documentFile, instructorId);

    // Save secondary document if provided (e.g. selfie)
    let additional: Awaited<ReturnType<UploadsService['saveKycDocument']>> | undefined;
    if (additionalFile) {
      additional = await this.uploads.saveKycDocument(additionalFile, instructorId);
    }

    const submission = await this.prisma.kycSubmission.create({
      data: {
        instructorId,
        documentType: dto.documentType,
        documentUrl: primary.originUrl,
        additionalUrl: additional?.originUrl ?? null,
        status: KycStatus.PENDING,
      },
    });

    this.logger.log(`KYC submission created: ${submission.id} for instructor ${instructorId}`);
    return {
      ...submission,
      documentUrl: primary.cdnUrl,
      documentDelivery: primary,
      additionalUrl: additional?.cdnUrl ?? null,
      additionalDelivery: additional ?? null,
    };
  }

  // ----------------------------------------------------------
  // READ
  // ----------------------------------------------------------

  /** Get the current instructor's own KYC submission(s) */
  async findMySubmissions(instructorId: string) {
    return this.prisma.kycSubmission.findMany({
      where: { instructorId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Get the latest (most recent) KYC status for an instructor — used by payouts module */
  async getVerificationStatus(instructorId: string) {
    const latest = await this.prisma.kycSubmission.findFirst({
      where: { instructorId },
      orderBy: { createdAt: 'desc' },
      select: { status: true, adminNotes: true, reviewedAt: true },
    });
    return {
      isVerified: latest?.status === KycStatus.APPROVED,
      status: latest?.status ?? null,
      adminNotes: latest?.adminNotes ?? null,
      reviewedAt: latest?.reviewedAt ?? null,
    };
  }

  /** Admin: list all KYC submissions */
  async findAll(page = 1, limit = 20, status?: KycStatus) {
    const where: any = {};
    if (status) where.status = status;

    const [submissions, total] = await this.prisma.$transaction([
      this.prisma.kycSubmission.findMany({
        where,
        include: {
          instructor: { select: { id: true, name: true, stellarAddress: true, email: true } },
          reviewedBy: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.kycSubmission.count({ where }),
    ]);

    return { data: submissions, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async findOne(id: string) {
    const submission = await this.prisma.kycSubmission.findUnique({
      where: { id },
      include: {
        instructor: { select: { id: true, name: true, stellarAddress: true } },
        reviewedBy: { select: { id: true, name: true } },
      },
    });
    if (!submission) throw new NotFoundException(`KYC submission ${id} not found`);
    return submission;
  }

  // ----------------------------------------------------------
  // ADMIN REVIEW
  // ----------------------------------------------------------

  async review(id: string, adminId: string, dto: ReviewKycDto) {
    const submission = await this.findOne(id);

    const acceptedReviewStatuses: KycStatus[] = [
      KycStatus.PENDING,
      KycStatus.UNDER_REVIEW,
      KycStatus.APPROVED,
      KycStatus.REJECTED,
    ];
    if (!acceptedReviewStatuses.includes(dto.status)) {
      throw new BadRequestException('Use the revoke verification action to revoke an approval');
    }

    const reviewableStatuses: KycStatus[] = [KycStatus.PENDING, KycStatus.UNDER_REVIEW];
    if (!reviewableStatuses.includes(submission.status)) {
      throw new BadRequestException('Only PENDING or UNDER_REVIEW submissions can be reviewed');
    }

    const finalStatuses: KycStatus[] = [KycStatus.APPROVED, KycStatus.REJECTED];
    const isTransitioning = !finalStatuses.includes(dto.status as KycStatus);

    const updated = await this.prisma.$transaction(async (tx) => {
      const reviewed = await tx.kycSubmission.update({
        where: { id },
        data: {
          status: dto.status,
          adminNotes: dto.adminNotes ?? submission.adminNotes,
          reviewedById: adminId,
          reviewedAt: isTransitioning ? null : new Date(),
        },
      });

      // KYC submission status is canonical; keep the user flag as a synchronized projection.
      const latest = await tx.kycSubmission.findFirst({
        where: { instructorId: submission.instructorId },
        orderBy: { createdAt: 'desc' },
        select: { status: true },
      });
      await tx.user.update({
        where: { id: submission.instructorId },
        data: { isVerified: latest?.status === KycStatus.APPROVED },
      });

      return reviewed;
    });

    if (dto.status === KycStatus.APPROVED) {
      await this.notifications.notifyUser(
        submission.instructorId,
        NotificationType.KYC_APPROVED,
        'Identity verification approved',
        'Your identity documents have been verified. You are now eligible to receive payouts.',
        { submissionId: id },
      );
    } else if (dto.status === KycStatus.REJECTED) {
      await this.notifications.notifyUser(
        submission.instructorId,
        NotificationType.KYC_REJECTED,
        'Identity verification rejected',
        `Your KYC submission was rejected. ${dto.adminNotes ? `Reason: ${dto.adminNotes}` : 'Please resubmit with valid documents.'}`,
        { submissionId: id },
      );
    }

    this.logger.log(`KYC submission ${id} reviewed as ${dto.status} by admin ${adminId}`);
    return updated;
  }

  /** Admin: revoke an instructor's existing approval and block future payouts. */
  async revoke(id: string, adminId: string, adminNotes?: string) {
    const submission = await this.findOne(id);
    if (submission.status !== KycStatus.APPROVED) {
      throw new BadRequestException('Only an approved KYC submission can be revoked');
    }

    const revokedAt = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      // Revoke every approval for this instructor so historical duplicate approvals
      // cannot leave them verified after the current approval is revoked.
      await tx.kycSubmission.updateMany({
        where: { instructorId: submission.instructorId, status: KycStatus.APPROVED },
        data: {
          status: KycStatus.REVOKED,
          adminNotes: adminNotes ?? submission.adminNotes,
          reviewedById: adminId,
          reviewedAt: revokedAt,
        },
      });

      const revokedSubmission = await tx.kycSubmission.findUnique({ where: { id } });
      if (!revokedSubmission) {
        throw new NotFoundException(`KYC submission ${id} not found`);
      }
      await tx.user.update({
        where: { id: submission.instructorId },
        data: { isVerified: false },
      });
      return revokedSubmission;
    });

    await this.notifications.notifyUser(
      submission.instructorId,
      NotificationType.KYC_REVOKED,
      'Identity verification revoked',
      `Your identity verification has been revoked.${adminNotes ? ` Reason: ${adminNotes}` : ''}`,
      { submissionId: id },
    );

    this.logger.log(`KYC verification for instructor ${submission.instructorId} revoked by admin ${adminId}`);
    return updated;
  }
}
