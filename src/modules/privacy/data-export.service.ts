import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { DataExportStatus } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class DataExportService {
  private readonly logger = new Logger(DataExportService.name);
  private readonly exportDir: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.exportDir = this.config.get<string>('DATA_EXPORT_DIR', './data-exports');
    if (!fs.existsSync(this.exportDir)) {
      fs.mkdirSync(this.exportDir, { recursive: true });
    }
  }

  async requestExport(userId: string): Promise<{ jobId: string; status: DataExportStatus }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new BadRequestException('User not found');
    }

    const recentJob = await this.prisma.dataExportJob.findFirst({
      where: {
        userId,
        status: { in: ['PENDING', 'PROCESSING'] },
      },
    });

    if (recentJob) {
      return { jobId: recentJob.id, status: recentJob.status };
    }

    const job = await this.prisma.dataExportJob.create({
      data: { userId, status: 'PENDING' },
    });

    this.processExport(job.id, userId).catch((error) => {
      this.logger.error(`Export processing failed for job ${job.id}`, error.message);
    });

    return { jobId: job.id, status: 'PENDING' };
  }

  async getJobStatus(userId: string, jobId: string) {
    const job = await this.prisma.dataExportJob.findUnique({ where: { id: jobId } });
    if (!job) {
      throw new NotFoundException('Export job not found');
    }

    if (job.userId !== userId) {
      throw new ForbiddenException('You do not have access to this export job');
    }

    return {
      jobId: job.id,
      status: job.status,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      fileSize: job.fileSize,
      errorMessage: job.status === 'FAILED' ? 'Export generation failed' : undefined,
    };
  }

  async downloadExport(userId: string, jobId: string): Promise<{ filePath: string; contentType: string; fileName: string }> {
    const job = await this.prisma.dataExportJob.findUnique({ where: { id: jobId } });
    if (!job) {
      throw new NotFoundException('Export job not found');
    }

    if (job.userId !== userId) {
      throw new ForbiddenException('You do not have access to this export');
    }

    if (job.status !== 'COMPLETED') {
      throw new BadRequestException('Export is not ready for download');
    }

    if (!job.filePath) {
      throw new BadRequestException('Export file not found');
    }

    const resolvedPath = path.resolve(job.filePath);
    if (!resolvedPath.startsWith(path.resolve(this.exportDir))) {
      throw new ForbiddenException('Invalid export file path');
    }

    if (!fs.existsSync(resolvedPath)) {
      throw new BadRequestException('Export file has expired or been removed');
    }

    return {
      filePath: resolvedPath,
      contentType: 'application/json',
      fileName: `data-export-${jobId}.json`,
    };
  }

  private async processExport(jobId: string, userId: string): Promise<void> {
    await this.prisma.dataExportJob.update({
      where: { id: jobId },
      data: { status: 'PROCESSING' },
    });

    try {
      const userData = await this.compileUserData(userId);
      const jsonContent = JSON.stringify(userData, null, 2);
      const filePath = path.join(this.exportDir, `${jobId}.json`);

      fs.writeFileSync(filePath, jsonContent, 'utf-8');
      const stats = fs.statSync(filePath);

      await this.prisma.dataExportJob.update({
        where: { id: jobId },
        data: {
          status: 'COMPLETED',
          filePath,
          fileSize: stats.size,
          completedAt: new Date(),
        },
      });

      this.logger.log(`Export completed for job ${jobId}: ${stats.size} bytes`);
    } catch (error) {
      this.logger.error(`Export processing failed for job ${jobId}`, error.message);
      await this.prisma.dataExportJob.update({
        where: { id: jobId },
        data: {
          status: 'FAILED',
          errorMessage: 'Failed to generate export file',
        },
      });
    }
  }

  private async compileUserData(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        bio: true,
        avatarUrl: true,
        role: true,
        isVerified: true,
        emailVerifiedAt: true,
        stellarAddress: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    const [
      enrollments,
      certificates,
      assignments,
      notifications,
      examAttempts,
      reviews,
      discussionComments,
      refundRequests,
      disputes,
      kycSubmissions,
      invoices,
      couponRedemptions,
      referrals,
      referralRewards,
      wishlistItems,
      points,
      pointsAwards,
      questions,
      answers,
      smsMessages,
    ] = await Promise.all([
      this.prisma.enrollment.findMany({
        where: { studentId: userId },
        select: {
          id: true,
          courseId: true,
          amountPaid: true,
          status: true,
          progressPercent: true,
          enrolledAt: true,
          completedAt: true,
        },
      }),
      this.prisma.certificate.findMany({
        where: { studentId: userId },
        select: {
          id: true,
          courseId: true,
          courseTitle: true,
          isRevoked: true,
          issuedAt: true,
        },
      }),
      this.prisma.assignmentSubmission.findMany({
        where: { studentId: userId },
        select: {
          id: true,
          assignmentId: true,
          submissionUrl: true,
          notes: true,
          status: true,
          feedback: true,
          submittedAt: true,
        },
      }),
      this.prisma.notification.findMany({
        where: { userId },
        select: {
          id: true,
          type: true,
          title: true,
          message: true,
          read: true,
          createdAt: true,
        },
      }),
      this.prisma.examAttempt.findMany({
        where: { studentId: userId },
        select: {
          id: true,
          examId: true,
          score: true,
          passed: true,
          attemptedAt: true,
        },
      }),
      this.prisma.courseReview.findMany({
        where: { studentId: userId },
        select: {
          id: true,
          courseId: true,
          rating: true,
          comment: true,
          createdAt: true,
        },
      }),
      this.prisma.discussionComment.findMany({
        where: { authorId: userId },
        select: {
          id: true,
          discussionId: true,
          content: true,
          createdAt: true,
        },
      }),
      this.prisma.refund.findMany({
        where: { studentId: userId },
        select: {
          id: true,
          enrollmentId: true,
          reason: true,
          requestedAmount: true,
          approvedAmount: true,
          status: true,
          createdAt: true,
        },
      }),
      this.prisma.dispute.findMany({
        where: { filedById: userId },
        select: {
          id: true,
          referenceType: true,
          referenceId: true,
          subject: true,
          description: true,
          status: true,
          createdAt: true,
        },
      }),
      this.prisma.kycSubmission.findMany({
        where: { instructorId: userId },
        select: {
          id: true,
          documentType: true,
          status: true,
          createdAt: true,
        },
      }),
      this.prisma.invoice.findMany({
        where: { studentId: userId },
        select: {
          id: true,
          invoiceNumber: true,
          amount: true,
          issuedAt: true,
        },
      }),
      this.prisma.couponRedemption.findMany({
        where: { userId },
        select: {
          id: true,
          courseId: true,
          discount: true,
          redeemedAt: true,
        },
      }),
      this.prisma.referral.findMany({
        where: { referrerId: userId },
        select: {
          id: true,
          status: true,
          signedUpAt: true,
          convertedAt: true,
        },
      }),
      this.prisma.referralReward.findMany({
        where: { beneficiaryId: userId },
        select: {
          id: true,
          kind: true,
          discountType: true,
          discountValue: true,
          status: true,
          issuedAt: true,
          redeemedAt: true,
          expiresAt: true,
        },
      }),
      this.prisma.wishlistItem.findMany({
        where: { studentId: userId },
        select: {
          id: true,
          courseId: true,
          createdAt: true,
        },
      }),
      this.prisma.userPoints.findUnique({
        where: { userId },
        select: {
          totalPoints: true,
          currentStreak: true,
          longestStreak: true,
          lastActivityDate: true,
        },
      }),
      this.prisma.pointsAward.findMany({
        where: { userId },
        select: {
          id: true,
          activityType: true,
          points: true,
          awardedDate: true,
        },
      }),
      this.prisma.question.findMany({
        where: { authorId: userId },
        select: {
          id: true,
          lessonId: true,
          title: true,
          content: true,
          createdAt: true,
        },
      }),
      this.prisma.answer.findMany({
        where: { authorId: userId },
        select: {
          id: true,
          questionId: true,
          content: true,
          isBestAnswer: true,
          createdAt: true,
        },
      }),
      this.prisma.smsMessage.findMany({
        where: { userId },
        select: {
          id: true,
          phoneNumber: true,
          templateKey: true,
          message: true,
          status: true,
          sentAt: true,
          createdAt: true,
        },
      }),
    ]);

    return {
      exportedAt: new Date().toISOString(),
      user,
      enrollments,
      certificates,
      assignments,
      notifications,
      examAttempts,
      reviews,
      discussionComments,
      refundRequests,
      disputes,
      kycSubmissions,
      invoices,
      couponRedemptions,
      referrals,
      referralRewards,
      wishlistItems,
      gamification: {
        points,
        pointsAwards,
      },
      questions,
      answers,
      smsMessages,
    };
  }
}
