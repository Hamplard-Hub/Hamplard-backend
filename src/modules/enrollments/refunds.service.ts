// refunds.service.ts
import {
  Injectable, NotFoundException, ForbiddenException,
  ConflictException, BadRequestException, Logger,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StellarService } from '../../common/stellar/stellar.service';
import { RefundStatus, EnrollmentStatus, UserRole, AuditAction, AuditTargetType } from '@prisma/client';
import { CreateRefundDto } from './dto/create-refund.dto';
import { ApproveRefundDto } from './dto/approve-refund.dto';
import { RejectRefundDto } from './dto/reject-refund.dto';
import { ProcessRefundDto } from './dto/process-refund.dto';
import { AnalyticsService } from '../analytics/analytics.service';
import { SERVER_ANALYTICS_EVENTS } from '../analytics/dto/track-analytics-event.dto';

/** Refund requests must be filed within this many days of enrollment. */
const REFUND_ELIGIBILITY_WINDOW_DAYS = 14;

@Injectable()
export class RefundsService {
  private readonly logger = new Logger(RefundsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stellar: StellarService,
    private readonly analytics: AnalyticsService,
  ) {}

  // ----------------------------------------------------------
  // STUDENT — request a refund
  // ----------------------------------------------------------

  async create(studentId: string, dto: CreateRefundDto) {
    const enrollment = await this.prisma.enrollment.findUnique({
      where: { id: dto.enrollmentId },
    });
    if (!enrollment) throw new NotFoundException('Enrollment not found');
    if (enrollment.studentId !== studentId) {
      throw new ForbiddenException('This enrollment does not belong to you');
    }
    if (enrollment.status === EnrollmentStatus.REFUNDED) {
      throw new ConflictException('This enrollment has already been refunded');
    }

    const existing = await this.prisma.refund.findFirst({
      where: {
        enrollmentId: dto.enrollmentId,
        status: { in: [RefundStatus.PENDING, RefundStatus.APPROVED] },
      },
    });
    if (existing) {
      throw new ConflictException('A refund request is already in progress for this enrollment');
    }

    const windowEnd = new Date(enrollment.enrolledAt);
    windowEnd.setDate(windowEnd.getDate() + REFUND_ELIGIBILITY_WINDOW_DAYS);
    if (new Date() > windowEnd) {
      throw new BadRequestException(
        `Refund eligibility window (${REFUND_ELIGIBILITY_WINDOW_DAYS} days from enrollment) has expired`,
      );
    }

    // Issue #250: Sum previously processed/approved refunds and cap new requests at remaining balance
    const previousRefunds = await this.prisma.refund.aggregate({
      where: {
        enrollmentId: dto.enrollmentId,
        status: { in: [RefundStatus.PROCESSED, RefundStatus.APPROVED] },
      },
      _sum: { approvedAmount: true },
    });

    const amountPaid = Number(enrollment.amountPaid);
    const previouslyRefunded = Number(previousRefunds._sum.approvedAmount || 0);
    const remainingBalance = amountPaid - previouslyRefunded;

    const requestedAmount = dto.requestedAmount ?? amountPaid;
    if (requestedAmount > remainingBalance) {
      throw new BadRequestException(
        `Requested amount cannot exceed remaining balance (${remainingBalance} USDC)`,
      );
    }

    const refund = await this.prisma.refund.create({
      data: {
        enrollmentId: dto.enrollmentId,
        studentId,
        reason: dto.reason,
        requestedAmount,
        isPartial: requestedAmount < amountPaid,
      },
    });

    this.logger.log(`Refund requested: ${refund.id} for enrollment ${dto.enrollmentId}`);
    return refund;
  }

  // ----------------------------------------------------------
  // READ — status lookup
  // ----------------------------------------------------------

  async findByStudent(studentId: string, page = 1, limit = 20) {
    const [data, total] = await this.prisma.$transaction([
      this.prisma.refund.findMany({
        where: { studentId },
        include: { enrollment: { include: { course: { select: { title: true } } } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.refund.count({ where: { studentId } }),
    ]);
    return { data, meta: { total, page, limit } };
  }

  async findAll(filters: { status?: RefundStatus; page?: number; limit?: number }) {
    const { status, page = 1, limit = 20 } = filters;
    const where = status ? { status } : {};

    const [data, total] = await this.prisma.$transaction([
      this.prisma.refund.findMany({
        where,
        include: {
          enrollment: { include: { course: { select: { title: true } } } },
          student: { select: { name: true, email: true, stellarAddress: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.refund.count({ where }),
    ]);
    return { data, meta: { total, page, limit } };
  }

  async findOne(id: string, requesterId: string, requesterRole: UserRole) {
    const refund = await this.prisma.refund.findUnique({
      where: { id },
      include: { enrollment: { include: { course: { select: { title: true } } } } },
    });
    if (!refund) throw new NotFoundException('Refund not found');
    if (requesterRole !== UserRole.ADMIN && refund.studentId !== requesterId) {
      throw new ForbiddenException('This refund request does not belong to you');
    }
    return refund;
  }

  // ----------------------------------------------------------
  // ADMIN — approve / reject / process
  // ----------------------------------------------------------

  async approve(id: string, adminId: string, dto: ApproveRefundDto, ipAddress?: string) {
    const refund = await this.getPendingOrThrow(id);
    const enrollment = await this.prisma.enrollment.findUniqueOrThrow({
      where: { id: refund.enrollmentId },
    });

    // Issue #250: Sum previously processed/approved refunds and cap approvals at remaining balance
    const previousRefunds = await this.prisma.refund.aggregate({
      where: {
        enrollmentId: refund.enrollmentId,
        status: { in: [RefundStatus.PROCESSED, RefundStatus.APPROVED] },
        id: { not: id }, // Exclude current refund
      },
      _sum: { approvedAmount: true },
    });

    const amountPaid = Number(enrollment.amountPaid);
    const previouslyRefunded = Number(previousRefunds._sum.approvedAmount || 0);
    const remainingBalance = amountPaid - previouslyRefunded;

    const requestedAmount = Number(refund.requestedAmount);
    const approvedAmount = dto.approvedAmount ?? requestedAmount;
    if (approvedAmount > requestedAmount) {
      throw new BadRequestException('Approved amount cannot exceed the requested amount');
    }
    if (approvedAmount > remainingBalance) {
      throw new BadRequestException(
        `Approved amount cannot exceed remaining balance (${remainingBalance} USDC)`,
      );
    }

    const updated = await this.prisma.refund.update({
      where: { id },
      data: {
        status: RefundStatus.APPROVED,
        approvedAmount,
        isPartial: approvedAmount < amountPaid,
        adminNote: dto.adminNote,
      },
    });

    // Audit log
    await this.prisma.adminAuditLog.create({
      data: {
        actorId: adminId,
        action: AuditAction.REFUND_APPROVED,
        targetType: AuditTargetType.REFUND,
        targetId: id,
        metadata: {
          enrollmentId: refund.enrollmentId,
          studentId: refund.studentId,
          requestedAmount,
          approvedAmount,
          isPartial: approvedAmount < amountPaid,
          adminNote: dto.adminNote,
        },
        ipAddress,
      },
    });

    return updated;
  }

  async reject(id: string, adminId: string, dto: RejectRefundDto, ipAddress?: string) {
    const refund = await this.getPendingOrThrow(id);
    const updated = await this.prisma.refund.update({
      where: { id },
      data: { status: RefundStatus.REJECTED, adminNote: dto.reason },
    });

    // Audit log
    await this.prisma.adminAuditLog.create({
      data: {
        actorId: adminId,
        action: AuditAction.REFUND_REJECTED,
        targetType: AuditTargetType.REFUND,
        targetId: id,
        metadata: {
          enrollmentId: refund.enrollmentId,
          studentId: refund.studentId,
          requestedAmount: Number(refund.requestedAmount),
          reason: dto.reason,
        },
        ipAddress,
      },
    });

    return updated;
  }

  async process(id: string, adminId: string, dto: ProcessRefundDto, ipAddress?: string) {
    const refund = await this.prisma.refund.findUnique({ where: { id } });
    if (!refund) throw new NotFoundException('Refund not found');
    if (refund.status !== RefundStatus.APPROVED) {
      throw new BadRequestException('Only APPROVED refunds can be processed');
    }

    // Issue #249: Reject refunds with unverified transaction hashes
    const txStatus = await this.stellar.getTransactionStatus(dto.txHash);
    if (txStatus === null) {
      throw new BadRequestException('The provided refund transaction hash could not be verified (not found on-chain)');
    }
    if (!txStatus.successful) {
      throw new BadRequestException('The provided refund transaction did not succeed on-chain');
    }

    const enrollment = await this.prisma.enrollment.findUniqueOrThrow({
      where: { id: refund.enrollmentId },
    });
    const isFullRefund = Number(refund.approvedAmount) >= Number(enrollment.amountPaid);

    const [updatedRefund] = await this.prisma.$transaction([
      this.prisma.refund.update({
        where: { id },
        data: { status: RefundStatus.PROCESSED, txHash: dto.txHash, processedAt: new Date() },
      }),
      ...(isFullRefund
        ? [this.prisma.enrollment.update({
            where: { id: enrollment.id },
            data: { status: EnrollmentStatus.REFUNDED },
          })]
        : []),
    ]);

    // Audit log
    await this.prisma.adminAuditLog.create({
      data: {
        actorId: adminId,
        action: AuditAction.REFUND_PROCESSED,
        targetType: AuditTargetType.REFUND,
        targetId: id,
        metadata: {
          enrollmentId: refund.enrollmentId,
          studentId: refund.studentId,
          approvedAmount: Number(refund.approvedAmount),
          txHash: dto.txHash,
          isFullRefund,
        },
        ipAddress,
      },
    });

    this.logger.log(`Refund processed: ${id} (${isFullRefund ? 'full' : 'partial'})`);
    await this.analytics.trackEvent(
      {
        eventType: SERVER_ANALYTICS_EVENTS.REFUND_PROCESSED,
        properties: {
          refundId: id,
          enrollmentId: refund.enrollmentId,
          amount: Number(refund.approvedAmount),
          isFullRefund,
        },
      },
      { userId: refund.studentId, source: 'server' },
    );
    return updatedRefund;
  }

  private async getPendingOrThrow(id: string) {
    const refund = await this.prisma.refund.findUnique({ where: { id } });
    if (!refund) throw new NotFoundException('Refund not found');
    if (refund.status !== RefundStatus.PENDING) {
      throw new BadRequestException('Only PENDING refund requests can be reviewed');
    }
    return refund;
  }
}
