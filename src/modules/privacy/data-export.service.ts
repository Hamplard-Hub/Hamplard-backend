// data-export.service.ts
// Issue #73 — GDPR data export API.
//
// Users can request a full export of their personal data. Each request is
// tracked as a DataExportJob so its status can be polled. On completion the
// compiled JSON document is persisted on the job record and served as a
// downloadable file.
//
// Identity is validated at every step: only the authenticated user who
// created a job can view its status or download the resulting file.
import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { Prisma, DataExportJobStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';

/** A completed export is downloadable for 7 days before it is destroyed. */
const EXPORT_RETENTION_DAYS = 7;

/** One in-flight or recently created export per user at a time. */
const COOLDOWN_HOURS = 24;

/**
 * Sections compiled from across the modules. Each key maps to the Prisma
 * delegate used to fetch that user's records. Everything included here is
 * the user's own personal data (no other users' PII) per GDPR Article 20
 * data portability. The profile section is compiled separately from the
 * user record itself.
 */
const EXPORT_SECTIONS = {
  enrollments: (prisma: PrismaService, userId: string) =>
    prisma.enrollment.findMany({
      where: { studentId: userId },
      select: {
        id: true,
        courseId: true,
        amountPaid: true,
        txHash: true,
        status: true,
        progressPercent: true,
        enrolledAt: true,
        completedAt: true,
      },
    }),
  lessonProgress: (prisma: PrismaService, userId: string) =>
    prisma.lessonProgress.findMany({
      where: { enrollment: { studentId: userId } },
      select: { id: true, lessonId: true, completed: true, watchedSecs: true, completedAt: true },
    }),
  certificates: (prisma: PrismaService, userId: string) =>
    prisma.certificate.findMany({
      where: { studentId: userId },
      select: { id: true, courseId: true, courseTitle: true, issuedAt: true, isRevoked: true },
    }),
  reviews: (prisma: PrismaService, userId: string) =>
    prisma.courseReview.findMany({
      where: { studentId: userId },
      select: { id: true, courseId: true, rating: true, comment: true, createdAt: true },
    }),
  wishlistItems: (prisma: PrismaService, userId: string) =>
    prisma.wishlistItem.findMany({
      where: { studentId: userId },
      select: { id: true, courseId: true, createdAt: true },
    }),
  notifications: (prisma: PrismaService, userId: string) =>
    prisma.notification.findMany({
      where: { userId },
      select: { id: true, type: true, title: true, message: true, read: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    }),
  referralRewards: (prisma: PrismaService, userId: string) =>
    prisma.referralReward.findMany({
      where: { beneficiaryId: userId },
      select: { id: true, kind: true, status: true, issuedAt: true, redeemedAt: true },
    }),
  invoices: (prisma: PrismaService, userId: string) =>
    prisma.invoice.findMany({
      where: { studentId: userId },
      select: { id: true, invoiceNumber: true, amount: true, txHash: true, issuedAt: true },
    }),
  disputes: (prisma: PrismaService, userId: string) =>
    prisma.dispute.findMany({
      where: { filedById: userId },
      select: { id: true, referenceType: true, referenceId: true, status: true, createdAt: true },
    }),
  payoutRequests: (prisma: PrismaService, userId: string) =>
    prisma.payout.findMany({
      where: { instructorId: userId },
      select: { id: true, amount: true, currency: true, status: true, createdAt: true },
    }),
} as const;

type ExportSectionKey = keyof typeof EXPORT_SECTIONS;

@Injectable()
export class DataExportService {
  private readonly logger = new Logger(DataExportService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ----------------------------------------------------------
  // REQUEST AN EXPORT
  // ----------------------------------------------------------

  /**
   * Create a new export request for the authenticated user.
   *
   * The requester identity is taken from the verified JWT (never from the
   * request body), then re-checked against the database so a user deleted
   * mid-session cannot enqueue an orphan export. Only one export may be
   * requested per cooldown window.
   */
  async requestExport(userId: string) {
    if (!userId) {
      throw new BadRequestException('Authenticated user id is required');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, isBanned: true },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    if (user.isBanned) {
      throw new BadRequestException('Banned users cannot request a data export');
    }

    const inFlight = await this.prisma.dataExportJob.findFirst({
      where: {
        userId,
        status: { in: [DataExportJobStatus.PENDING, DataExportJobStatus.PROCESSING] },
      },
    });
    if (inFlight) {
      throw new BadRequestException({
        message: 'An export request is already being processed',
        existingJobId: inFlight.id,
      });
    }

    const lastJob = await this.prisma.dataExportJob.findFirst({
      where: { userId },
      orderBy: { requestedAt: 'desc' },
    });
    if (lastJob) {
      const cooldownMs = COOLDOWN_HOURS * 60 * 60 * 1000;
      const elapsed = Date.now() - new Date(lastJob.requestedAt).getTime();
      if (elapsed < cooldownMs) {
        const hoursLeft = Math.ceil((cooldownMs - elapsed) / (60 * 60 * 1000));
        throw new BadRequestException(
          `You can request a new export in about ${hoursLeft} hour(s). ` +
            `Your last export was requested at ${lastJob.requestedAt.toISOString()}.`,
        );
      }
    }

    const job = await this.prisma.dataExportJob.create({
      data: {
        userId,
        status: DataExportJobStatus.PENDING,
      },
    });

    this.logger.log(`Data export requested: job=${job.id} user=${userId}`);

    // Compilation runs inline; the job record tracks progress so the client
    // can poll for status. Failures are captured on the job itself.
    const completed = await this.processExport(job.id).catch((error) => {
      this.logger.error(
        `Data export job ${job.id} failed: ${error?.message ?? error}`,
      );
      return null;
    });

    // Never echo the full payload back on the request response — it is
    // retrieved through the dedicated download endpoint.
    if (completed && 'payload' in completed) {
      const { payload, ...jobWithoutPayload } = completed;
      void payload;
      return jobWithoutPayload;
    }

    return completed ?? job;
  }

  // ----------------------------------------------------------
  // TRACK JOB STATUS
  // ----------------------------------------------------------

  /**
   * Get the current status of an export job. Only the user who created the
   * job may see it — any other id is treated as not found so job ids are
   * not enumerable across accounts.
   */
  async getExportStatus(userId: string, jobId: string) {
    const job = await this.prisma.dataExportJob.findFirst({
      where: { id: jobId, userId },
      select: {
        id: true,
        status: true,
        errorMessage: true,
        requestedAt: true,
        startedAt: true,
        completedAt: true,
        expiresAt: true,
        downloadCount: true,
        lastDownloadAt: true,
        fileSizeBytes: true,
      },
    });
    if (!job) {
      throw new NotFoundException('Export request not found');
    }
    return job;
  }

  /**
   * List every export request made by the authenticated user, newest first.
   */
  async listMyExports(userId: string) {
    return this.prisma.dataExportJob.findMany({
      where: { userId },
      orderBy: { requestedAt: 'desc' },
      select: {
        id: true,
        status: true,
        errorMessage: true,
        requestedAt: true,
        completedAt: true,
        expiresAt: true,
        downloadCount: true,
        fileSizeBytes: true,
      },
    });
  }

  // ----------------------------------------------------------
  // DOWNLOAD
  // ----------------------------------------------------------

  /**
   * Return the export document for download. The compiled payload is stored
   * on the job record, so no external storage is required.
   */
  async downloadExport(userId: string, jobId: string) {
    const job = await this.prisma.dataExportJob.findFirst({
      where: { id: jobId, userId },
    });
    if (!job) {
      throw new NotFoundException('Export request not found');
    }

    if (job.status === DataExportJobStatus.EXPIRED) {
      throw new BadRequestException('This export has expired. Please request a new one.');
    }
    if (
      job.expiresAt &&
      job.status === DataExportJobStatus.COMPLETED &&
      new Date(job.expiresAt).getTime() < Date.now()
    ) {
      await this.prisma.dataExportJob.update({
        where: { id: job.id },
        data: { status: DataExportJobStatus.EXPIRED, payload: Prisma.JsonNull },
      });
      throw new BadRequestException('This export has expired. Please request a new one.');
    }
    if (job.status !== DataExportJobStatus.COMPLETED) {
      throw new BadRequestException(
        'Export is not ready for download yet. Check the job status and try again.',
      );
    }
    if (!job.payload) {
      this.logger.error(`Export job ${job.id} is COMPLETED but its payload is missing`);
      throw new InternalServerErrorException(
        'Export file is unavailable. Please request a new export.',
      );
    }

    await this.prisma.dataExportJob.update({
      where: { id: job.id },
      data: {
        downloadCount: { increment: 1 },
        lastDownloadAt: new Date(),
      },
    });

    return {
      jobId: job.id,
      filename: `hamplard-data-export-${job.id}.json`,
      contentType: 'application/json',
      payload: job.payload,
      checksum: job.checksum,
      generatedAt: job.completedAt,
    };
  }

  // ----------------------------------------------------------
  // INTERNALS
  // ----------------------------------------------------------

  /**
   * Compile the user's personal data across all modules, persist the result
   * on the job record, and mark the job COMPLETED (or FAILED).
   */
  private async processExport(jobId: string) {
    const job = await this.prisma.dataExportJob.findUnique({ where: { id: jobId } });
    if (!job) {
      throw new NotFoundException('Export request not found');
    }

    await this.prisma.dataExportJob.update({
      where: { id: jobId },
      data: { status: DataExportJobStatus.PROCESSING, startedAt: new Date() },
    });

    const userId = job.userId;

    try {
      const [profile, enrollments, lessonProgress, certificates, reviews, wishlistItems, notifications, referralRewards, invoices, disputes, payoutRequests] =
        await Promise.all([
          this.buildProfileSection(userId),
          EXPORT_SECTIONS.enrollments(this.prisma, userId),
          EXPORT_SECTIONS.lessonProgress(this.prisma, userId),
          EXPORT_SECTIONS.certificates(this.prisma, userId),
          EXPORT_SECTIONS.reviews(this.prisma, userId),
          EXPORT_SECTIONS.wishlistItems(this.prisma, userId),
          EXPORT_SECTIONS.notifications(this.prisma, userId),
          EXPORT_SECTIONS.referralRewards(this.prisma, userId),
          EXPORT_SECTIONS.invoices(this.prisma, userId),
          EXPORT_SECTIONS.disputes(this.prisma, userId),
          EXPORT_SECTIONS.payoutRequests(this.prisma, userId),
        ]);

      const exportedAt = new Date().toISOString();
      const payload = {
        format: 'hamplard-gdpr-data-export',
        version: 1,
        exportedAt,
        data: {
          profile,
          enrollments,
          lessonProgress,
          certificates,
          reviews,
          wishlistItems,
          notifications,
          referralRewards,
          invoices,
          disputes,
          payoutRequests,
        },
      };

      const serialized = JSON.stringify(payload);
      const checksum = createHash('sha256').update(serialized).digest('hex');

      const completedJob = await this.prisma.dataExportJob.update({
        where: { id: jobId },
        data: {
          status: DataExportJobStatus.COMPLETED,
          payload: payload as unknown as Prisma.InputJsonValue,
          checksum,
          fileSizeBytes: Buffer.byteLength(serialized, 'utf8'),
          completedAt: new Date(),
          expiresAt: new Date(Date.now() + EXPORT_RETENTION_DAYS * 24 * 60 * 60 * 1000),
          errorMessage: null,
        },
      });

      this.logger.log(`Data export job ${jobId} completed (${fileSizeLabel(completedJob.fileSizeBytes)})`);
      return completedJob;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.dataExportJob.update({
        where: { id: jobId },
        data: {
          status: DataExportJobStatus.FAILED,
          errorMessage: message.slice(0, 500),
        },
      });
      throw error;
    }
  }

  /**
   * The user's own account data. Credentials, 2FA secrets, recovery codes,
   * and refresh-token hashes are deliberately excluded — they are security
   * material, not portable personal data.
   */
  private async buildProfileSection(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        stellarAddress: true,
        email: true,
        name: true,
        bio: true,
        avatarUrl: true,
        role: true,
        isVerified: true,
        phoneNumber: true,
        phoneCountryCode: true,
        isPhoneVerified: true,
        createdAt: true,
        updatedAt: true,
        twoFactorEnabled: true,
      },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  /**
   * Destroy expired exports. Called opportunistically on download and by
   * the scheduler; keeps expired payloads out of the database.
   */
  async cleanupExpiredExports() {
    const result = await this.prisma.dataExportJob.updateMany({
      where: {
        status: DataExportJobStatus.COMPLETED,
        expiresAt: { lt: new Date() },
      },
      data: {
        status: DataExportJobStatus.EXPIRED,
        payload: Prisma.JsonNull,
        checksum: null,
      },
    });
    if (result.count > 0) {
      this.logger.log(`Expired ${result.count} data export job(s)`);
    }
    return result;
  }
}

function fileSizeLabel(bytes?: number | null): string {
  if (!bytes && bytes !== 0) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
