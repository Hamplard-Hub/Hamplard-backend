import {
  Injectable, NotFoundException, ConflictException, Logger, HttpException,
  ForbiddenException, Inject, forwardRef, BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { InvoicesService } from '../invoices/invoices.service';
import { ReferralsService } from '../referrals/referrals.service';
import { NotificationType, CourseStatus, Prisma } from '@prisma/client';
import { FraudDetectionService, FraudCheckResult } from './fraud-detection.service';
import { DripScheduleService } from '../lessons/drip-schedule.service';
import { StellarService } from '../../common/stellar/stellar.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { SERVER_ANALYTICS_EVENTS } from '../analytics/dto/track-analytics-event.dto';
import { buildPricingSnapshot } from './pricing-snapshot';
import { CheckoutQuoteService } from '../billing/checkout-quote.service';

@Injectable()
export class EnrollmentsService {
  private readonly logger = new Logger(EnrollmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly invoices: InvoicesService,
    private readonly fraudDetection: FraudDetectionService,
    private readonly referrals: ReferralsService,
    private readonly stellar: StellarService,
    private readonly analytics: AnalyticsService,
    private readonly checkoutQuotes: CheckoutQuoteService,
    @Inject(forwardRef(() => DripScheduleService))
    private readonly dripSchedule: DripScheduleService,
  ) {}

  /**
   * Register an enrollment in the DB after the student has submitted
   * the enroll() transaction on-chain via Freighter.
   * The backend receives the txHash and verifies it on-chain before registering.
   * 
   * Issues #239 & #240:
   * - Verifies the payment transaction on-chain comprehensively (issue #403)
   * - Validates the student, course ID, and amount from the transaction
   * - Ensures txHash is unique (one payment = one enrollment)
   * - Rejects enrollment in non-ACTIVE courses
   * 
   * Issue #404: Wraps payment, enrollment, and course stats in a transaction
   *
   * Issue #333: Requires a checkout quote. The on-chain amount must match the
   * quote total, and the quote, its coupon and referral reward are consumed in
   * the same transaction as the enrollment (with a price snapshot for invoices).
   */
  async create(
    studentId: string,
    courseId: string,
    txHash: string,
    quoteId: string,
  ) {
    if (!quoteId) {
      throw new BadRequestException('quoteId is required. Request one from POST /checkout/quote.');
    }

    // ------------------------------------------------------------------
    // PRE-CHECK #0: Verify the course is ACTIVE (issue #239)
    // ------------------------------------------------------------------
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
    });
    if (!course) throw new NotFoundException(`Course ${courseId} not found`);
    this.assertCourseActive(course);

    // ------------------------------------------------------------------
    // PRE-CHECK #0A: Checkout quote is the caller's, unexpired, unused and
    // untampered (issue #333)
    // ------------------------------------------------------------------
    const quote = await this.checkoutQuotes.getUsableQuote(quoteId, studentId, courseId);

    // ------------------------------------------------------------------
    // PRE-CHECK #0B/#0C/#403: Verify the tx on-chain comprehensively
    // and get verified amount (not from request body)
    // ------------------------------------------------------------------
    const verifiedAmountPaid = await this.verifyPaymentTransaction(
      txHash, studentId, courseId, quote.total,
    );

    // Issue #333: the paid amount must match the quote exactly (to the cent)
    if (Math.abs(verifiedAmountPaid - quote.total) >= 0.005) {
      throw new BadRequestException(
        `On-chain amount ${verifiedAmountPaid} USDC does not match the checkout quote total of ${quote.total} USDC`,
      );
    }

    // ------------------------------------------------------------------
    // PRE-CHECK #1: Ensure student is not already enrolled
    // ------------------------------------------------------------------
    const existing = await this.prisma.enrollment.findUnique({
      where: { studentId_courseId: { studentId, courseId } },
    });
    if (existing) throw new ConflictException('Already enrolled in this course');

    // ------------------------------------------------------------------
    // PRE-CHECK #2/#3: Prerequisites + fraud scoring (issue #405)
    // ------------------------------------------------------------------
    const fraudResult = await this.runPreEnrollmentChecks(studentId, courseId, verifiedAmountPaid);

    // ------------------------------------------------------------------
    // STEP 1-4: Create Payment, Enrollment, consume the quote (+ coupon /
    // referral reward) and update Course stats atomically
    // (issue #404 — ensure if enrollment fails, payment is also rolled back)
    // ------------------------------------------------------------------
    let enrollment;
    try {
      enrollment = await this.prisma.$transaction(async (tx) => {
        // Create Payment record (issue #240 — txHash uniqueness)
        await tx.payment.create({
          data: {
            txHash,
            studentId,
            amountPaid: new Prisma.Decimal(verifiedAmountPaid),
            paymentType: 'ENROLLMENT',
          },
        });

        // Create enrollment record with fee + price snapshot
        const newEnrollment = await tx.enrollment.create({
          data: {
            studentId,
            courseId,
            txHash,
            amountPaid: new Prisma.Decimal(verifiedAmountPaid),
            ...buildPricingSnapshot(course, verifiedAmountPaid),
            platformFeePercent: course.platformFeePercent,
            listPrice: new Prisma.Decimal(quote.listPrice),
            couponDiscount: new Prisma.Decimal(quote.coupon?.discountAmount ?? 0),
            referralDiscount: new Prisma.Decimal(quote.referralReward?.discountAmount ?? 0),
            taxRegion: quote.taxRegion,
            taxRatePercent: new Prisma.Decimal(quote.taxRatePercent),
            taxAmount: new Prisma.Decimal(quote.taxAmount),
            couponId: quote.coupon?.couponId ?? null,
            referralRewardId: quote.referralReward?.rewardId ?? null,
            checkoutQuoteId: quote.quoteId,
          },
          include: { course: true, student: true },
        });

        // Consume the quote and redeem its coupon / referral reward (issue #333)
        await this.checkoutQuotes.consumeWithinTransaction(tx, quote, studentId, newEnrollment.id);

        // Update course stats
        await tx.course.update({
          where: { id: courseId },
          data: {
            totalEnrollments: { increment: 1 },
            totalRevenue: { increment: new Prisma.Decimal(verifiedAmountPaid) },
          },
        });

        return newEnrollment;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const target = String((error.meta as any)?.target ?? '');
        if (target.includes('couponId')) {
          throw new ConflictException('You have already used this coupon for this course');
        }
        if (target.includes('txHash')) {
          throw new ConflictException(
            `Payment ${txHash} has already been used. One transaction maps to one purchase.`,
          );
        }
        if (target.includes('checkoutQuoteId') || target.includes('enrollmentId')) {
          throw new ConflictException('Checkout quote has already been used');
        }
        throw new ConflictException('Already enrolled in this course');
      }
      throw error;
    }

    await this.analytics.trackEvent(
      {
        eventType: SERVER_ANALYTICS_EVENTS.ENROLLMENT_CREATED,
        properties: { enrollmentId: enrollment.id, courseId, amountPaid: verifiedAmountPaid },
      },
      { userId: studentId, source: 'server' },
    );
    await this.runPostEnrollmentSteps(enrollment, fraudResult, txHash, verifiedAmountPaid);

    this.logger.log(`Enrollment created: ${studentId} → ${courseId} (payment ${txHash}, quote ${quote.quoteId})`);
    return enrollment;
  }

  // ----------------------------------------------------------
  // SHARED ENROLLMENT PIPELINE
  //
  // Used by create() above and by BundlesService.enroll() so bundle
  // purchases get the same validation and side effects as single-course
  // purchases (issue #279).
  // ----------------------------------------------------------

  /** Rejects enrollment in courses that are not ACTIVE (issue #239). */
  assertCourseActive(course: { status: CourseStatus }) {
    if (course.status !== CourseStatus.ACTIVE) {
      throw new ForbiddenException(
        `Cannot enroll in a ${course.status} course. Only ACTIVE courses accept enrollments.`,
      );
    }
  }

  /**
   * Basic payment transaction verification for bundle enrollments.
   * Checks if transaction succeeded and hasn't been used.
   * Does not validate specific course/student as bundles span multiple courses.
   * Issue #403: For bundle context, we verify basic tx validity only.
   */
  async verifyPaymentTransactionBasic(txHash: string): Promise<void> {
    const txStatus = await this.stellar.getTransactionStatus(txHash);
    if (!txStatus) {
      throw new BadRequestException(
        `Transaction ${txHash} not found on-chain. Please verify the transaction hash.`,
      );
    }
    if (!txStatus.successful) {
      throw new BadRequestException(
        `Transaction ${txHash} did not succeed on-chain (status: ${txStatus.status}).`,
      );
    }

    const existingPayment = await this.prisma.payment.findUnique({
      where: { txHash },
    });
    if (existingPayment) {
      throw new ConflictException(
        `Payment ${txHash} has already been used. One transaction maps to one purchase.`,
      );
    }
  }

  /**
   * Comprehensive payment transaction verification (issue #403).
   * Validates:
   *  1. Transaction succeeded on-chain
   *  2. Called the enroll method on Hamplard contract
   *  3. Student address matches caller's wallet
   *  4. Course ID matches request
   *  5. Amount paid >= expected amount (the checkout quote total when given,
   *     otherwise the course price)
   *  6. Payment hasn't been used already (issue #240)
   * 
   * Returns the verified amount paid (from on-chain data, not request body).
   */
  async verifyPaymentTransaction(
    txHash: string,
    studentId: string,
    courseId: string,
    expectedAmount?: number,
  ): Promise<number> {
    // First check if payment has already been used (issue #240)
    const existingPayment = await this.prisma.payment.findUnique({
      where: { txHash },
    });
    if (existingPayment) {
      throw new ConflictException(
        `Payment ${txHash} has already been used. One transaction maps to one purchase.`,
      );
    }

    // Get student wallet address
    const student = await this.prisma.user.findUnique({
      where: { id: studentId },
      select: { stellarAddress: true },
    });
    if (!student) {
      throw new NotFoundException(`Student ${studentId} not found`);
    }

    // Get course for price validation
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: { price: true },
    });
    if (!course) {
      throw new NotFoundException(`Course ${courseId} not found`);
    }

    // Comprehensively verify the enrollment transaction on-chain
    try {
      const verified = await this.stellar.verifyEnrollmentTransaction(
        txHash,
        this.stellar.getContractId(),
        student.stellarAddress,
        courseId,
        expectedAmount ?? Number(course.price),
      );

      return verified.amountPaid;
    } catch (error) {
      // Re-throw as BadRequestException with more user-friendly message
      if (error.message.includes('mismatch')) {
        throw new BadRequestException(error.message);
      }
      if (error.message.includes('Insufficient')) {
        throw new BadRequestException(error.message);
      }
      throw new BadRequestException(
        `Transaction ${txHash} verification failed: ${error.message}`,
      );
    }
  }

  /**
   * Enforces course prerequisites (issue #24) and runs fraud scoring before
   * the enrollment is written. Throws 403 / 423 when the student cannot enroll.
   */
  async runPreEnrollmentChecks(
    studentId: string,
    courseId: string,
    amountPaid: number,
  ): Promise<FraudCheckResult> {
    const prereqCheck = await this.checkPrerequisites(studentId, courseId);
    if (!prereqCheck.eligible) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Prerequisites Not Met',
        message:
          'You must complete the prerequisite courses below before enrolling ' +
          'in this course.',
        missingPrerequisites: prereqCheck.missing,
      });
    }

    const fraudResult = await this.fraudDetection.processFraudCheck(
      null,
      studentId,
      courseId,
      amountPaid,
    );

    if (fraudResult.action === 'HOLD') {
      this.logger.warn(
        `Enrollment BLOCKED by fraud detection: student=${studentId} ` +
        `course=${courseId} score=${fraudResult.score} reasons=${fraudResult.reasons.join(', ')}`,
      );
      throw new HttpException(
        {
          statusCode: 423,
          error: 'Enrollment Locked',
          message:
            'Your enrollment has been flagged and placed on hold pending a fraud review. ' +
            'Please contact support if you believe this is an error.',
          riskScore: fraudResult.score,
          reasons: fraudResult.reasons,
          flagId: fraudResult.flagId,
        },
        423,
      );
    }

    return fraudResult;
  }

  /**
   * Side effects that follow a newly created enrollment: fraud flag
   * persistence, student/instructor notifications, invoice, referral
   * conversion and drip schedule initialisation.
   *
   * Issue #405: Receives the pre-computed fraudResult instead of recomputing it.
   * Only persists flags if needed and action is FLAG.
   */
  async runPostEnrollmentSteps(
    enrollment: {
      id: string;
      studentId: string;
      courseId: string;
      course: { title: string; instructorAddress: string };
    },
    fraudResult: FraudCheckResult,
    txHash: string,
    amountPaid: number,
  ) {
    const { studentId, courseId } = enrollment;

    // Persist fraud flag if score is HIGH (action=FLAG) and not yet persisted (issue #405)
    if (fraudResult.action === 'FLAG' && !fraudResult.flagId) {
      // Use shouldPersistFlag=true to force persistence in post-check
      this.fraudDetection
        .processFraudCheck(
          enrollment.id,
          studentId,
          courseId,
          amountPaid,
          true, // shouldPersistFlag - persist even though we already scored pre-enrollment
        )
        .catch((err: Error) =>
          this.logger.error(
            `Fraud flag persistence failed for enrollment ${enrollment.id}: ${err.message}`,
          ),
        );
    }

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

    // Track referral conversion + issue referrer reward
    try {
      await this.referrals.trackConversion(studentId, enrollment.id);
    } catch (error) {
      this.logger.warn(`Referral conversion tracking failed for ${studentId}: ${error.message}`);
    }

    // Initialize drip content unlock schedule
    try {
      await this.dripSchedule.calculateAndSyncUnlockSchedule(enrollment.id);
    } catch (error) {
      this.logger.error(`Drip schedule initialization failed for enrollment ${enrollment.id}`, error.message);
    }
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

  async searchAdmin(query: {
    studentId?: string;
    courseId?: string;
    txHash?: string;
    status?: any;
    page?: number;
    limit?: number;
  }) {
    const page = query.page || 1;
    const limit = query.limit || 20;

    const where: any = {};
    if (query.studentId) where.studentId = query.studentId;
    if (query.courseId) where.courseId = query.courseId;
    if (query.txHash) where.txHash = { contains: query.txHash, mode: 'insensitive' };
    if (query.status) where.status = query.status;

    const [enrollments, total] = await this.prisma.$transaction([
      this.prisma.enrollment.findMany({
        where,
        include: {
          student: { select: { id: true, name: true, email: true, stellarAddress: true } },
          course: { select: { id: true, title: true, price: true } },
        },
        orderBy: { enrolledAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.enrollment.count({ where }),
    ]);

    return {
      data: enrollments,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
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

    // Issue #335: lesson videos are private — students get a short-lived signed
    // URL from GET /lessons/:id after the drip check, never the stored path.
    return {
      ...enrollment,
      course: {
        ...enrollment.course,
        modules: enrollment.course.modules.map((module) => ({
          ...module,
          lessons: module.lessons.map(({ videoUrl, ...lesson }) => ({
            ...lesson,
            hasVideo: !!videoUrl,
          })),
        })),
      },
    };
  }

  async isEnrolled(studentId: string, courseId: string): Promise<boolean> {
    const count = await this.prisma.enrollment.count({
      where: { studentId, courseId },
    });
    return count > 0;
  }

  // ----------------------------------------------------------
  // PREREQUISITE VALIDATION (issue #24)
  // ----------------------------------------------------------

  /**
   * Validates whether a student has completed every prerequisite of a
   * course. Used both to gate enrollment creation and by the
   * GET /enrollments/:courseId/check-prerequisites feedback endpoint.
   */
  async checkPrerequisites(studentId: string, courseId: string) {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: { id: true, title: true },
    });
    if (!course) throw new NotFoundException(`Course ${courseId} not found`);

    const prerequisites = await this.prisma.coursePrerequisite.findMany({
      where: { courseId },
      include: {
        prerequisite: { select: { id: true, title: true } },
      },
    });

    if (!prerequisites.length) {
      return { courseId, eligible: true, missing: [], satisfied: [] };
    }

    const completed = await this.prisma.enrollment.findMany({
      where: {
        studentId,
        status: 'COMPLETED',
        courseId: { in: prerequisites.map((p) => p.prerequisiteId) },
      },
      select: { courseId: true },
    });
    const completedIds = new Set(completed.map((e) => e.courseId));

    const rows = prerequisites.map((p) => ({
      courseId: p.prerequisite.id,
      title: p.prerequisite.title,
      met: completedIds.has(p.prerequisite.id),
    }));

    return {
      courseId,
      eligible: rows.every((r) => r.met),
      missing: rows.filter((r) => !r.met),
      satisfied: rows.filter((r) => r.met),
    };
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
