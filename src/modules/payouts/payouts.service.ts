import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { KycService } from '../kyc/kyc.service';
import { PayoutQueryDto } from './dto/payout-query.dto';
import { CreatePayoutDto, UpdatePayoutStatusDto } from './dto/create-payout.dto';
import { PayoutStatus, UserRole, AuditAction, AuditTargetType } from '@prisma/client';

@Injectable()
export class PayoutsService {
  private readonly logger = new Logger(PayoutsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kyc: KycService,
  ) {}

  async getInstructorBalance(requestingUser: any, instructorId: string) {
    if (
      requestingUser.id !== instructorId &&
      requestingUser.role !== UserRole.ADMIN
    ) {
      throw new ForbiddenException(
        'Access denied: You can only view your own payout balance',
      );
    }

    const instructor = await this.prisma.user.findUnique({
      where: { id: instructorId },
      select: { id: true },
    });
    if (!instructor) throw new NotFoundException('Instructor not found');

    return {
      instructorId,
      currency: 'USDC',
      ...(await this.calculateInstructorBalance(this.prisma, instructorId)),
    };
  }

  private async calculateInstructorBalance(
    prisma: Prisma.TransactionClient | PrismaService,
    instructorId: string,
  ) {
    const enrollments = await prisma.enrollment.findMany({
      where: { course: { instructor: { id: instructorId } } },
      select: {
        amountPaid: true,
        platformFeePercent: true,
        refunds: {
          where: { status: { in: ['APPROVED', 'PROCESSED'] } },
          select: { approvedAmount: true },
        },
      },
    });

    let earned = new Prisma.Decimal(0);
    let refunded = new Prisma.Decimal(0);
    for (const enrollment of enrollments) {
      earned = earned.add(
        new Prisma.Decimal(enrollment.amountPaid)
          .mul(100 - enrollment.platformFeePercent)
          .div(100),
      );
      for (const refund of enrollment.refunds) {
        if (refund.approvedAmount !== null) {
          refunded = refunded.add(new Prisma.Decimal(refund.approvedAmount));
        }
      }
    }

    const payoutAggregate = await prisma.payout.aggregate({
      where: {
        instructorId,
        status: {
          in: [PayoutStatus.PENDING, PayoutStatus.PROCESSING, PayoutStatus.COMPLETED],
        },
      },
      _sum: { amount: true },
    });
    const payouts = new Prisma.Decimal(payoutAggregate._sum.amount ?? 0);
    const available = earned.sub(refunded).sub(payouts);
    return {
      totalEarned: earned.toNumber(),
      totalRefunded: refunded.toNumber(),
      totalPayouts: payouts.toNumber(),
      availableBalance: Math.max(0, available.toNumber()),
    };
  }

  /**
   * Get payout history for an instructor with date range and status filtering.
   * Validates instructor ownership.
   */
  async getInstructorPayoutHistory(
    requestingUser: any,
    instructorId: string,
    query: PayoutQueryDto,
  ) {
    // Validate requesting instructor ownership
    if (
      requestingUser.id !== instructorId &&
      requestingUser.role !== UserRole.ADMIN
    ) {
      throw new ForbiddenException(
        'Access denied: You can only view your own payout history',
      );
    }

    const { status, startDate, endDate, page = 1, limit = 20 } = query;
    const where: any = { instructorId };

    if (status) {
      where.status = status;
    }

    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }

    const [data, total] = await this.prisma.$transaction([
      this.prisma.payout.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.payout.count({ where }),
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
   * Export summary statement of payouts for an instructor.
   */
  async exportPayoutStatement(
    requestingUser: any,
    instructorId: string,
    query: PayoutQueryDto,
  ) {
    const history = await this.getInstructorPayoutHistory(
      requestingUser,
      instructorId,
      { ...query, limit: 1000, page: 1 },
    );

    const payouts = history.data;

    let totalAmountCompleted = 0;
    let totalAmountPending = 0;

    payouts.forEach((p) => {
      const amt = Number(p.amount);
      if (p.status === PayoutStatus.COMPLETED) {
        totalAmountCompleted += amt;
      } else if (
        p.status === PayoutStatus.PENDING ||
        p.status === PayoutStatus.PROCESSING
      ) {
        totalAmountPending += amt;
      }
    });

    return {
      statementDate: new Date(),
      instructorId,
      period: {
        startDate: query.startDate ?? null,
        endDate: query.endDate ?? null,
      },
      summary: {
        totalPayoutsCount: payouts.length,
        totalCompletedAmount: totalAmountCompleted,
        totalPendingAmount: totalAmountPending,
        currency: 'USDC',
      },
      payouts,
    };
  }

  /**
   * Create a new payout record (Admin or automated platform payout).
   */
  async createPayout(dto: CreatePayoutDto, adminId?: string, ipAddress?: string) {
    const instructor = await this.prisma.user.findUnique({
      where: { id: dto.instructorId },
    });

    if (!instructor) {
      throw new NotFoundException('Instructor not found');
    }

    const verification = await this.kyc.getVerificationStatus(dto.instructorId);
    if (!verification.isVerified) {
      throw new ForbiddenException(
        'Payout cannot be created: instructor has not completed KYC verification. ' +
          'Please submit your KYC documents and wait for approval before requesting payouts.',
      );
    }

    const payout = await this.prisma.$transaction(
      async (tx) => {
        const balance = await this.calculateInstructorBalance(
          tx,
          dto.instructorId,
        );
        if (
          new Prisma.Decimal(dto.amount).greaterThan(
            new Prisma.Decimal(balance.availableBalance),
          )
        ) {
          throw new BadRequestException(
            `Payout amount cannot exceed the available balance (${balance.availableBalance} USDC)`,
          );
        }

        return tx.payout.create({
          data: {
            instructorId: dto.instructorId,
            amount: dto.amount,
            currency: dto.currency ?? 'USDC',
            status: PayoutStatus.PENDING,
            periodStart: dto.periodStart ? new Date(dto.periodStart) : null,
            periodEnd: dto.periodEnd ? new Date(dto.periodEnd) : null,
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    if (adminId) {
      await this.prisma.adminAuditLog.create({
        data: {
          actorId: adminId,
          action: AuditAction.PAYOUT_CREATED,
          targetType: AuditTargetType.PAYOUT,
          targetId: payout.id,
          metadata: { instructorId: dto.instructorId, amount: Number(dto.amount), currency: dto.currency ?? 'USDC' },
          ipAddress,
        },
      });
    }

    this.logger.log(`Payout record created: ${payout.id} for instructor ${dto.instructorId}`);
    return payout;
  }

  /**
   * Track payout status transitions (PENDING -> PROCESSING -> COMPLETED/FAILED).
   */
  async updatePayoutStatus(payoutId: string, dto: UpdatePayoutStatusDto, adminId?: string, ipAddress?: string) {
    const payout = await this.prisma.payout.findUnique({
      where: { id: payoutId },
    });

    if (!payout) {
      throw new NotFoundException('Payout record not found');
    }

    const updated = await this.prisma.payout.update({
      where: { id: payoutId },
      data: {
        status: dto.status,
        txHash: dto.txHash ?? payout.txHash,
      },
    });

    if (adminId) {
      await this.prisma.adminAuditLog.create({
        data: {
          actorId: adminId,
          action: AuditAction.PAYOUT_STATUS_CHANGED,
          targetType: AuditTargetType.PAYOUT,
          targetId: payoutId,
          metadata: { previousStatus: payout.status, newStatus: dto.status, txHash: dto.txHash, instructorId: payout.instructorId, amount: Number(payout.amount) },
          ipAddress,
        },
      });
    }

    this.logger.log(
      `Payout status transition: ${payoutId} updated from ${payout.status} to ${dto.status}`,
    );

    return updated;
  }
}
