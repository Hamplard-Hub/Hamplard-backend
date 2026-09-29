import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { KycService } from '../kyc/kyc.service';
import { PayoutQueryDto } from './dto/payout-query.dto';
import { CreatePayoutDto, UpdatePayoutStatusDto } from './dto/create-payout.dto';
import { PayoutStatus, UserRole } from '@prisma/client';

@Injectable()
export class PayoutsService {
  private readonly logger = new Logger(PayoutsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kyc: KycService,
  ) {}

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
  async createPayout(dto: CreatePayoutDto) {
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

    const payout = await this.prisma.payout.create({
      data: {
        instructorId: dto.instructorId,
        amount: dto.amount,
        currency: dto.currency ?? 'USDC',
        status: PayoutStatus.PENDING,
        periodStart: dto.periodStart ? new Date(dto.periodStart) : null,
        periodEnd: dto.periodEnd ? new Date(dto.periodEnd) : null,
      },
    });

    this.logger.log(`Payout record created: ${payout.id} for instructor ${dto.instructorId}`);
    return payout;
  }

  /**
   * Track payout status transitions (PENDING -> PROCESSING -> COMPLETED/FAILED).
   */
  async updatePayoutStatus(payoutId: string, dto: UpdatePayoutStatusDto) {
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

    this.logger.log(
      `Payout status transition: ${payoutId} updated from ${payout.status} to ${dto.status}`,
    );

    return updated;
  }
}
