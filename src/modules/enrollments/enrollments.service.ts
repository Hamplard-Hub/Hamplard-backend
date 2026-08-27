// enrollments.service.ts
import {
  Injectable, NotFoundException, ConflictException, Logger, HttpException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { InvoicesService } from '../invoices/invoices.service';
import { ReferralsService } from '../referrals/referrals.service';
import { NotificationType } from '@prisma/client';
import { FraudDetectionService } from './fraud-detection.service';

@Injectable()
export class EnrollmentsService {
  private readonly logger = new Logger(EnrollmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly invoices: InvoicesService,
    private readonly fraudDetection: FraudDetectionService,
    private readonly referrals: ReferralsService,
  ) {}

  /**
   * Register an enrollment in the DB after the student has submitted
   * the enroll() transaction on-chain via Freighter.
   * The backend receives the txHash and registers the enrollment.
   */
  async create(studentId: string, courseId: string, txHash: string, amountPaid: number) {
    const existing = await this.prisma.enrollment.findUnique({
      where: { studentId_courseId: { studentId, courseId } },
    });
    if (existing) throw new ConflictException('Already enrolled in this course');

    // ------------------------------------------------------------------
    // PRE-CHECK: Run fraud scoring before writing the enrollment to DB.
    // If the score is CRITICAL the enrollment is blocked entirely (HOLD).
    // We pass null for enrollmentId here because the row doesn't exist yet;
    // the flag for HOLD actions is persisted in the post-check below once
    // a sentinel record is available, or omitted if the call is rejected.
    // ------------------------------------------------------------------
    const preCheck = await this.fraudDetection.scoreEnrollment(
      studentId,
      courseId,
      amountPaid,
    );

    if (preCheck.action === 'HOLD') {
      this.logger.warn(
        `Enrollment BLOCKED by fraud detection: student=${studentId} ` +
        `course=${courseId} score=${preCheck.score} reasons=${preCheck.reasons.join(', ')}`,
      );
      // HTTP 423 Locked — enrollment is on automatic hold
      throw new HttpException(
        {
          statusCode: 423,
          error: 'Enrollment Locked',
          message:
            'Your enrollment has been flagged and placed on hold pending a fraud review. ' +
            'Please contact support if you believe this is an error.',
          riskScore: preCheck.score,
          reasons:   preCheck.reasons,
        },
        423,
      );
    }

    // ------------------------------------------------------------------
    // Create enrollment record
    // ------------------------------------------------------------------
    const enrollment = await this.prisma.enrollment.create({
      data: {
        studentId,
        courseId,
        txHash,
        amountPaid,
      },
      include: { course: true, student: true },
    });

    // ------------------------------------------------------------------
    // POST-CHECK: Persist fraud flag if score is HIGH (FLAG action).
    // Runs fire-and-forget — a flag failure must not break the enrollment.
    // ------------------------------------------------------------------
    if (preCheck.action === 'FLAG') {
      this.fraudDetection
        .processFraudCheck(enrollment.id, studentId, courseId, amountPaid)
        .catch((err: Error) =>
          this.logger.error(
            `Fraud flag persistence failed for enrollment ${enrollment.id}: ${err.message}`,
          ),
        );
    }

    // Update course stats
    await this.prisma.course.update({
      where: { id: courseId },
      data: {
        totalEnrollments: { increment: 1 },
        totalRevenue:     { increment: amountPaid },
      },
    });

    // Notify student
    await this.notifications.notifyUser(
      studentId,
      NotificationType.ENROLLMENT_CONFIRMED,
      'Enrollment confirmed!',
      `You are now enrolled in "${enrollment.course.title}". Start learning at your own pace.`,
      { courseId, txHash },
    );

    // Notify instructor
    const instructor = await this.prisma.user.findUnique({
      where: { stellarAddress: enrollment.course.instructorAddress },
    });
    if (instructor) {
      await this.notifications.notifyUser(
        instructor.id,
        NotificationType.NEW_ENROLLMENT,
        'New student enrolled',
        `A new student has enrolled in "${enrollment.course.title}".`,
        { courseId },
      );
    }

    try {
      await this.invoices.generateForEnrollment(enrollment.id);
    } catch (error) {
      this.logger.error(`Invoice generation failed for enrollment ${enrollment.id}`, error.message);
    }

    // Track referral conversion + issue referrer reward (idempotent if not referred)
    try {
      await this.referrals.trackConversion(studentId, enrollment.id);
    } catch (error) {
      this.logger.warn(`Referral conversion tracking failed for ${studentId}: ${error.message}`);
    }

    this.logger.log(`Enrollment created: ${studentId} → ${courseId}`);
    return enrollment;
  }

  async findByStudent(studentId: string, page = 1, limit = 20) {
    const [enrollments, total] = await this.prisma.$transaction([
      this.prisma.enrollment.findMany({
        where: { studentId },
        include: {
          course: {
            include: { instructor: { select: { name: true, avatarUrl: true } } },
          },
        },
        orderBy: { enrolledAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.enrollment.count({ where: { studentId } }),
    ]);
    return { data: enrollments, meta: { total, page, limit } };
  }

  async findOne(studentId: string, courseId: string) {
    const enrollment = await this.prisma.enrollment.findUnique({
      where: { studentId_courseId: { studentId, courseId } },
      include: {
        course: {
          include: {
            modules: {
              orderBy: { position: 'asc' },
              include: { lessons: { orderBy: { position: 'asc' } } },
            },
          },
        },
        lessonProgress: true,
      },
    });
    if (!enrollment) throw new NotFoundException('Enrollment not found');
    return enrollment;
  }

  async isEnrolled(studentId: string, courseId: string): Promise<boolean> {
    const count = await this.prisma.enrollment.count({
      where: { studentId, courseId },
    });
    return count > 0;
  }

  /**
   * Create or update an enrollment from a backup restore payload.
   * Used by EnrollmentRestoreService — does not send notifications/invoices.
   */
  async upsertFromBackup(data: {
    id?: string;
    studentId: string;
    courseId: string;
    amountPaid: number;
    txHash?: string | null;
    status?: string;
    progressPercent?: number;
    completedAt?: Date | null;
    enrolledAt?: Date;
    mode: 'create' | 'overwrite' | 'merge';
  }) {
    const existing = await this.prisma.enrollment.findUnique({
      where: {
        studentId_courseId: {
          studentId: data.studentId,
          courseId: data.courseId,
        },
      },
    });

    if (!existing) {
      const created = await this.prisma.enrollment.create({
        data: {
          ...(data.id ? { id: data.id } : {}),
          studentId: data.studentId,
          courseId: data.courseId,
          amountPaid: data.amountPaid,
          txHash: data.txHash ?? null,
          status: (data.status as any) ?? 'ACTIVE',
          progressPercent: data.progressPercent ?? 0,
          completedAt: data.completedAt ?? null,
          ...(data.enrolledAt ? { enrolledAt: data.enrolledAt } : {}),
        },
      });
      this.logger.log(
        `Restored enrollment created: ${created.studentId} → ${created.courseId}`,
      );
      return { enrollment: created, action: 'created' as const };
    }

    if (data.mode === 'create') {
      return { enrollment: existing, action: 'skipped' as const };
    }

    if (data.mode === 'overwrite') {
      const enrollment = await this.prisma.enrollment.update({
        where: { id: existing.id },
        data: {
          amountPaid: data.amountPaid,
          txHash: data.txHash ?? null,
          status: (data.status as any) ?? existing.status,
          progressPercent: data.progressPercent ?? 0,
          completedAt: data.completedAt ?? null,
          ...(data.enrolledAt ? { enrolledAt: data.enrolledAt } : {}),
        },
      });
      return { enrollment, action: 'overwritten' as const };
    }

    // merge
    const incomingProgress = data.progressPercent ?? 0;
    const preferIncoming = incomingProgress >= existing.progressPercent;
    const enrollment = await this.prisma.enrollment.update({
      where: { id: existing.id },
      data: {
        amountPaid: preferIncoming ? data.amountPaid : existing.amountPaid,
        txHash: data.txHash ?? existing.txHash,
        status: preferIncoming
          ? ((data.status as any) ?? existing.status)
          : existing.status,
        progressPercent: Math.max(existing.progressPercent, incomingProgress),
        completedAt: preferIncoming
          ? (data.completedAt ?? existing.completedAt)
          : existing.completedAt,
        enrolledAt:
          data.enrolledAt && data.enrolledAt < existing.enrolledAt
            ? data.enrolledAt
            : existing.enrolledAt,
      },
    });
    return { enrollment, action: 'merged' as const };
  }
}
