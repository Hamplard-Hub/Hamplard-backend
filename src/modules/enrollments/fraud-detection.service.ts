// fraud-detection.service.ts
// Enrollment Fraud Detection Service — Hamplard Backend
//
// Responsibilities:
//  1. Real-time risk scoring on every enrollment attempt.
//  2. Persisting EnrollmentFraudFlag records for HIGH/CRITICAL risk.
//  3. Blocking enrollment creation when score reaches CRITICAL threshold.
//  4. Admin review queue for flagged and held enrollments.
//  5. Admin clear/confirm actions on individual fraud flags.

import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { FraudFlagStatus, FraudRiskLevel } from '@prisma/client';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** What action the caller (EnrollmentsService) should take after the check. */
export type FraudAction = 'ALLOW' | 'FLAG' | 'HOLD';

/** Full result of a fraud score computation. */
export interface FraudScoreResult {
  score: number;
  riskLevel: FraudRiskLevel;
  reasons: string[];
  action: FraudAction;
}

/** Result of processFraudCheck — includes the persisted flag id when created. */
export interface FraudCheckResult {
  action: FraudAction;
  score: number;
  riskLevel: FraudRiskLevel;
  reasons: string[];
  /** Present when a flag record was persisted in the DB. */
  flagId?: string;
}

/** DTO for the admin review action. */
export interface ReviewFlagDto {
  /** The resolution the admin is applying. */
  decision: 'CLEARED' | 'CONFIRMED';
  /** Optional free-text note from the admin. */
  reviewNotes?: string;
}

// ---------------------------------------------------------------------------
// Named fraud rule identifiers — used in `reasons` arrays stored in DB
// ---------------------------------------------------------------------------

const RULES = {
  RAPID_REPEAT_PURCHASE:       'RAPID_REPEAT_PURCHASE',
  HIGH_DAILY_VOLUME:           'HIGH_DAILY_VOLUME',
  PRIOR_FRAUD_HISTORY:         'PRIOR_FRAUD_HISTORY',
  HIGH_AMOUNT_ANOMALY:         'HIGH_AMOUNT_ANOMALY',
  EXCESSIVE_ACTIVE_ENROLLMENTS:'EXCESSIVE_ACTIVE_ENROLLMENTS',
  DUPLICATE_COURSE_PURCHASE:   'DUPLICATE_COURSE_PURCHASE',
} as const;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class FraudDetectionService {
  private readonly logger = new Logger(FraudDetectionService.name);

  // --- configurable thresholds (read from ConfigService / .env) ------------

  /** Hours in the "rapid purchase" rolling window. */
  private readonly windowHours: number;
  /** Max enrollments allowed within windowHours before RAPID_REPEAT_PURCHASE fires. */
  private readonly maxEnrollmentsPerWindow: number;
  /** Max enrollments allowed in 24 h before HIGH_DAILY_VOLUME fires. */
  private readonly maxDailyEnrollments: number;
  /** Max simultaneously ACTIVE enrollments before EXCESSIVE_ACTIVE_ENROLLMENTS fires. */
  private readonly maxActiveEnrollments: number;
  /** Amount paid (USDC) above which HIGH_AMOUNT_ANOMALY fires. */
  private readonly highAmountThreshold: number;
  /** Score at or above which a flag is persisted (status OPEN). */
  private readonly highRiskThreshold: number;
  /** Score at or above which the enrollment is blocked (status HELD). */
  private readonly criticalScoreThreshold: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.windowHours            = this.config.get<number>('FRAUD_WINDOW_HOURS', 1);
    this.maxEnrollmentsPerWindow= this.config.get<number>('FRAUD_MAX_ENROLLMENTS_PER_WINDOW', 3);
    this.maxDailyEnrollments    = this.config.get<number>('FRAUD_MAX_DAILY_ENROLLMENTS', 10);
    this.maxActiveEnrollments   = this.config.get<number>('FRAUD_MAX_ACTIVE_ENROLLMENTS', 20);
    this.highAmountThreshold    = this.config.get<number>('FRAUD_HIGH_AMOUNT_THRESHOLD_USDC', 500);
    this.highRiskThreshold      = this.config.get<number>('FRAUD_HIGH_RISK_SCORE_THRESHOLD', 70);
    this.criticalScoreThreshold = this.config.get<number>('FRAUD_CRITICAL_SCORE_THRESHOLD', 90);
  }

  // =========================================================================
  // PUBLIC — called by EnrollmentsService before persisting enrollment
  // =========================================================================

  /**
   * Run the full fraud check pipeline for an incoming enrollment request.
   *
   * Steps:
   *  1. Score the enrollment using available signals.
   *  2. If score < HIGH threshold → return ALLOW (no flag persisted).
   *  3. If HIGH ≤ score < CRITICAL → persist flag (OPEN), return FLAG.
   *  4. If score ≥ CRITICAL → persist flag (HELD), return HOLD.
   *
   * NOTE: When action is HOLD, the enrollment itself should NOT be created.
   *       The caller (EnrollmentsService) is responsible for enforcing this.
   *
   * @param enrollmentId  The newly created enrollment UUID (pass null when HOLD
   *                      check is run *before* DB creation — see integration note).
   * @param studentId     Platform user ID of the student.
   * @param courseId      Course being enrolled in.
   * @param amountPaid    USDC amount from the enrollment payload.
   */
  async processFraudCheck(
    enrollmentId: string | null,
    studentId: string,
    courseId: string,
    amountPaid: number,
  ): Promise<FraudCheckResult> {
    const { score, riskLevel, reasons, action } =
      await this.scoreEnrollment(studentId, courseId, amountPaid);

    // Below HIGH threshold — no persistence, just allow
    if (action === 'ALLOW') {
      this.logger.debug(
        `Fraud check ALLOW: student=${studentId} score=${score} (${riskLevel})`,
      );
      return { action, score, riskLevel, reasons };
    }

    // FLAG or HOLD — persist a fraud flag if we have an enrollmentId
    // (For HOLD the caller skips creating the enrollment, so we persist
    //  with a sentinel enrollmentId provided by the service layer.)
    if (!enrollmentId) {
      // Cannot persist without an enrollment FK — return result only
      this.logger.warn(
        `Fraud check ${action} (score=${score}) for student=${studentId} ` +
        `but no enrollmentId provided — flag not persisted.`,
      );
      return { action, score, riskLevel, reasons };
    }

    const status: FraudFlagStatus =
      action === 'HOLD' ? FraudFlagStatus.HELD : FraudFlagStatus.OPEN;

    const flag = await this.prisma.enrollmentFraudFlag.create({
      data: {
        enrollmentId,
        studentId,
        riskScore: score,
        riskLevel,
        reasons,
        status,
      },
    });

    this.logger.warn(
      `Fraud flag created: id=${flag.id} action=${action} ` +
      `score=${score} student=${studentId} reasons=${reasons.join(', ')}`,
    );

    return { action, score, riskLevel, reasons, flagId: flag.id };
  }

  // =========================================================================
  // PUBLIC — Admin: review queue
  // =========================================================================

  /**
   * Paginated admin review queue of fraud-flagged enrollments.
   * Supports filtering by status and riskLevel.
   */
  async getFraudReviewQueue(
    filters: { status?: FraudFlagStatus; riskLevel?: FraudRiskLevel },
    page = 1,
    limit = 20,
  ) {
    const where: Record<string, unknown> = {};
    if (filters.status)    where.status    = filters.status;
    if (filters.riskLevel) where.riskLevel = filters.riskLevel;

    const [data, total] = await this.prisma.$transaction([
      this.prisma.enrollmentFraudFlag.findMany({
        where,
        include: {
          enrollment: {
            include: {
              course:  { select: { id: true, title: true } },
              student: { select: { id: true, name: true, email: true, stellarAddress: true } },
            },
          },
          reviewedBy: { select: { id: true, name: true } },
        },
        orderBy: [{ riskScore: 'desc' }, { createdAt: 'desc' }],
        skip:  (page - 1) * limit,
        take:  limit,
      }),
      this.prisma.enrollmentFraudFlag.count({ where }),
    ]);

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Single fraud flag detail — for the admin drill-down view.
   */
  async getFlagById(id: string) {
    const flag = await this.prisma.enrollmentFraudFlag.findUnique({
      where: { id },
      include: {
        enrollment: {
          include: {
            course:  { select: { id: true, title: true, price: true } },
            student: { select: { id: true, name: true, email: true, stellarAddress: true } },
          },
        },
        reviewedBy: { select: { id: true, name: true } },
      },
    });

    if (!flag) throw new NotFoundException(`Fraud flag ${id} not found`);
    return flag;
  }

  /**
   * Admin resolves a fraud flag — either CLEARED or CONFIRMED.
   *
   * - CLEARED: admin determined no fraud; flag is archived.
   * - CONFIRMED: admin confirmed fraud; flag is marked CONFIRMED.
   *   (Downstream actions such as enrollment voiding are left to a
   *    dedicated admin workflow — out of scope for this service.)
   */
  async reviewFlag(id: string, adminId: string, dto: ReviewFlagDto) {
    const flag = await this.prisma.enrollmentFraudFlag.findUnique({ where: { id } });
    if (!flag) throw new NotFoundException(`Fraud flag ${id} not found`);

    const reviewableStatuses: FraudFlagStatus[] = [
      FraudFlagStatus.OPEN,
      FraudFlagStatus.HELD,
    ];
    if (!reviewableStatuses.includes(flag.status)) {
      throw new BadRequestException(
        `Only OPEN or HELD flags can be reviewed. Current status: ${flag.status}`,
      );
    }

    const newStatus: FraudFlagStatus =
      dto.decision === 'CONFIRMED'
        ? FraudFlagStatus.CONFIRMED
        : FraudFlagStatus.CLEARED;

    const updated = await this.prisma.enrollmentFraudFlag.update({
      where: { id },
      data: {
        status:      newStatus,
        reviewedById: adminId,
        reviewNotes: dto.reviewNotes ?? null,
        reviewedAt:  new Date(),
      },
    });

    this.logger.log(
      `Fraud flag ${id} reviewed as ${newStatus} by admin ${adminId}`,
    );
    return updated;
  }

  /**
   * Aggregate risk summary for a specific student account.
   * Useful for admin user-profile pages.
   */
  async getStudentRiskProfile(studentId: string) {
    const [flags, confirmedCount, heldCount] = await this.prisma.$transaction([
      this.prisma.enrollmentFraudFlag.findMany({
        where: { studentId },
        orderBy: { createdAt: 'desc' },
        select: {
          id:        true,
          riskScore: true,
          riskLevel: true,
          reasons:   true,
          status:    true,
          createdAt: true,
        },
      }),
      this.prisma.enrollmentFraudFlag.count({
        where: { studentId, status: FraudFlagStatus.CONFIRMED },
      }),
      this.prisma.enrollmentFraudFlag.count({
        where: { studentId, status: FraudFlagStatus.HELD },
      }),
    ]);

    const maxScore = flags.length
      ? Math.max(...flags.map((f) => f.riskScore))
      : 0;

    return {
      studentId,
      totalFlags:     flags.length,
      confirmedFraud: confirmedCount,
      heldCount,
      maxRiskScore:   maxScore,
      overallRisk:    this.mapScoreToLevel(maxScore),
      flags,
    };
  }

  // =========================================================================
  // PRIVATE — Scoring engine
  // =========================================================================

  /**
   * Computes the fraud risk score for an enrollment attempt.
   * All DB reads happen in a single transaction for consistency.
   */
  async scoreEnrollment(
    studentId: string,
    courseId: string,
    amountPaid: number,
  ): Promise<FraudScoreResult> {
    const now = new Date();
    const windowStart = new Date(now.getTime() - this.windowHours * 60 * 60 * 1000);
    const dayStart    = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // -------------------------------------------------------------------
    // Gather all raw signal data in one parallel query group
    // -------------------------------------------------------------------
    const [
      enrollmentsInWindow,
      enrollmentsInDay,
      activeEnrollments,
      priorConfirmedFlags,
    ] = await this.prisma.$transaction([
      // How many enrollments did this student make in the rolling window?
      this.prisma.enrollment.count({
        where: {
          studentId,
          enrolledAt: { gte: windowStart },
        },
      }),

      // How many enrollments did this student make in the last 24 h?
      this.prisma.enrollment.count({
        where: {
          studentId,
          enrolledAt: { gte: dayStart },
        },
      }),

      // How many ACTIVE enrollments does the student currently have?
      this.prisma.enrollment.count({
        where: {
          studentId,
          status: 'ACTIVE',
        },
      }),

      // Does this student have prior CONFIRMED fraud flags?
      this.prisma.enrollmentFraudFlag.count({
        where: {
          studentId,
          status: FraudFlagStatus.CONFIRMED,
        },
      }),
    ]);

    // -------------------------------------------------------------------
    // Score accumulation
    // -------------------------------------------------------------------
    let score = 0;
    const reasons: string[] = [];

    // Signal 1: Rapid repeat purchases (highest weight — primary task signal)
    if (enrollmentsInWindow >= this.maxEnrollmentsPerWindow) {
      score += 40;
      reasons.push(RULES.RAPID_REPEAT_PURCHASE);
      this.logger.debug(
        `[${studentId}] RAPID_REPEAT_PURCHASE: ${enrollmentsInWindow} enrollments in ${this.windowHours}h window (+40)`,
      );
    }

    // Signal 2: High daily enrollment volume
    if (enrollmentsInDay >= this.maxDailyEnrollments) {
      score += 25;
      reasons.push(RULES.HIGH_DAILY_VOLUME);
      this.logger.debug(
        `[${studentId}] HIGH_DAILY_VOLUME: ${enrollmentsInDay} enrollments in 24h (+25)`,
      );
    }

    // Signal 3: Prior confirmed fraud
    if (priorConfirmedFlags > 0) {
      score += 35;
      reasons.push(RULES.PRIOR_FRAUD_HISTORY);
      this.logger.debug(
        `[${studentId}] PRIOR_FRAUD_HISTORY: ${priorConfirmedFlags} confirmed fraud flags (+35)`,
      );
    }

    // Signal 4: Unusually high payment amount
    if (amountPaid > this.highAmountThreshold) {
      score += 15;
      reasons.push(RULES.HIGH_AMOUNT_ANOMALY);
      this.logger.debug(
        `[${studentId}] HIGH_AMOUNT_ANOMALY: amount=${amountPaid} USDC > threshold=${this.highAmountThreshold} (+15)`,
      );
    }

    // Signal 5: Excessive simultaneously active enrollments
    if (activeEnrollments >= this.maxActiveEnrollments) {
      score += 20;
      reasons.push(RULES.EXCESSIVE_ACTIVE_ENROLLMENTS);
      this.logger.debug(
        `[${studentId}] EXCESSIVE_ACTIVE_ENROLLMENTS: ${activeEnrollments} active (+20)`,
      );
    }

    // Signal 6: Duplicate course purchase attempt (same courseId enrolled by
    //           another student sharing the same stellarAddress prefix cluster —
    //           here we detect if this student already has any prior enrollment
    //           record for the same course, which would indicate a refund+re-enroll
    //           pattern or account duplication).
    const duplicateCourseAttempt = await this.prisma.enrollment.count({
      where: { courseId, studentId },
    });
    if (duplicateCourseAttempt > 0) {
      score += 30;
      reasons.push(RULES.DUPLICATE_COURSE_PURCHASE);
      this.logger.debug(
        `[${studentId}] DUPLICATE_COURSE_PURCHASE: existing enrollment in course=${courseId} (+30)`,
      );
    }

    // Clamp score to [0, 100]
    score = Math.min(100, Math.max(0, score));

    const riskLevel = this.mapScoreToLevel(score);
    const action    = this.mapScoreToAction(score);

    this.logger.debug(
      `Fraud score for student=${studentId}: ${score} → ${riskLevel} → action=${action}`,
    );

    return { score, riskLevel, reasons, action };
  }

  // =========================================================================
  // PRIVATE — Helpers
  // =========================================================================

  /** Maps a numeric risk score to the FraudRiskLevel enum value. */
  private mapScoreToLevel(score: number): FraudRiskLevel {
    if (score >= this.criticalScoreThreshold) return FraudRiskLevel.CRITICAL;
    if (score >= this.highRiskThreshold)      return FraudRiskLevel.HIGH;
    if (score >= 40)                           return FraudRiskLevel.MEDIUM;
    return FraudRiskLevel.LOW;
  }

  /** Maps a numeric risk score to the appropriate action for the caller. */
  private mapScoreToAction(score: number): FraudAction {
    if (score >= this.criticalScoreThreshold) return 'HOLD';
    if (score >= this.highRiskThreshold)      return 'FLAG';
    return 'ALLOW';
  }
}
