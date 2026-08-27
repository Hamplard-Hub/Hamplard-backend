import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  DiscountType,
  NotificationType,
  ReferralRewardKind,
  ReferralRewardStatus,
  ReferralStatus,
} from '@prisma/client';
import { randomBytes } from 'crypto';
import { UpdateRewardRulesDto } from './dto/update-reward-rules.dto';

export interface ReferralRewardRules {
  referrerDiscountPercent: number;
  refereeDiscountPercent: number;
  rewardExpiryDays: number;
  maxRewardsPerReferrer: number;
}

@Injectable()
export class ReferralsService {
  private readonly logger = new Logger(ReferralsService.name);

  /** In-memory overrides for admin-managed reward rules (env defaults underneath). */
  private ruleOverrides: Partial<ReferralRewardRules> = {};

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
  ) {}

  // ----------------------------------------------------------
  // REWARD RULES
  // ----------------------------------------------------------

  getRewardRules(): ReferralRewardRules {
    return {
      referrerDiscountPercent: this.ruleOverrides.referrerDiscountPercent
        ?? Number(this.config.get('REFERRAL_REFERRER_DISCOUNT_PERCENT', 10)),
      refereeDiscountPercent: this.ruleOverrides.refereeDiscountPercent
        ?? Number(this.config.get('REFERRAL_REFEREE_DISCOUNT_PERCENT', 10)),
      rewardExpiryDays: this.ruleOverrides.rewardExpiryDays
        ?? Number(this.config.get('REFERRAL_REWARD_EXPIRY_DAYS', 90)),
      maxRewardsPerReferrer: this.ruleOverrides.maxRewardsPerReferrer
        ?? Number(this.config.get('REFERRAL_MAX_REWARDS_PER_REFERRER', 50)),
    };
  }

  updateRewardRules(dto: UpdateRewardRulesDto): ReferralRewardRules {
    if (dto.referrerDiscountPercent !== undefined) {
      this.ruleOverrides.referrerDiscountPercent = dto.referrerDiscountPercent;
    }
    if (dto.refereeDiscountPercent !== undefined) {
      this.ruleOverrides.refereeDiscountPercent = dto.refereeDiscountPercent;
    }
    if (dto.rewardExpiryDays !== undefined) {
      this.ruleOverrides.rewardExpiryDays = dto.rewardExpiryDays;
    }
    if (dto.maxRewardsPerReferrer !== undefined) {
      this.ruleOverrides.maxRewardsPerReferrer = dto.maxRewardsPerReferrer;
    }
    this.logger.log(`Referral reward rules updated: ${JSON.stringify(this.getRewardRules())}`);
    return this.getRewardRules();
  }

  // ----------------------------------------------------------
  // CODE GENERATION
  // ----------------------------------------------------------

  /**
   * Returns the authenticated user's referral code, creating one if missing.
   */
  async getOrCreateCode(userId: string) {
    const existing = await this.prisma.referralCode.findUnique({
      where: { userId },
    });
    if (existing) return existing;

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const code = await this.generateUniqueCode();

    const created = await this.prisma.referralCode.create({
      data: { userId, code },
    });

    this.logger.log(`Referral code generated for user ${userId}: ${code}`);
    return created;
  }

  // ----------------------------------------------------------
  // VALIDATE
  // ----------------------------------------------------------

  async validateCode(rawCode: string, requestingUserId?: string) {
    const code = rawCode.toUpperCase().trim();
    const referralCode = await this.prisma.referralCode.findUnique({
      where: { code },
      include: {
        user: { select: { id: true, name: true, stellarAddress: true } },
      },
    });

    if (!referralCode) {
      throw new NotFoundException(`Referral code "${rawCode}" not found`);
    }
    if (!referralCode.isActive) {
      throw new BadRequestException('This referral code is no longer active');
    }
    if (requestingUserId && referralCode.userId === requestingUserId) {
      throw new BadRequestException('You cannot use your own referral code');
    }

    const rules = this.getRewardRules();

    return {
      valid: true,
      code: referralCode.code,
      referrer: {
        id: referralCode.user.id,
        name: referralCode.user.name,
      },
      refereeDiscountPercent: rules.refereeDiscountPercent,
      referrerDiscountPercent: rules.referrerDiscountPercent,
    };
  }

  // ----------------------------------------------------------
  // SIGNUP TRACKING (called from AuthService on first login)
  // ----------------------------------------------------------

  /**
   * Records a referral signup when a new user registers with a valid code.
   * Issues a pending referee welcome reward (activated on first enrollment conversion path,
   * or issued immediately so it can be applied at checkout).
   */
  async trackSignup(referredUserId: string, rawCode: string) {
    const code = rawCode.toUpperCase().trim();

    const alreadyReferred = await this.prisma.referral.findUnique({
      where: { referredUserId },
    });
    if (alreadyReferred) {
      throw new ConflictException('This user has already been referred');
    }

    const referralCode = await this.prisma.referralCode.findUnique({
      where: { code },
    });
    if (!referralCode) {
      throw new NotFoundException(`Referral code "${rawCode}" not found`);
    }
    if (!referralCode.isActive) {
      throw new BadRequestException('This referral code is no longer active');
    }
    if (referralCode.userId === referredUserId) {
      throw new BadRequestException('You cannot use your own referral code');
    }

    const rules = this.getRewardRules();
    const expiresAt = this.expiryDate(rules.rewardExpiryDays);

    const referral = await this.prisma.$transaction(async (tx) => {
      const created = await tx.referral.create({
        data: {
          referralCodeId: referralCode.id,
          referrerId: referralCode.userId,
          referredUserId,
          status: ReferralStatus.SIGNED_UP,
        },
      });

      await tx.referralCode.update({
        where: { id: referralCode.id },
        data: { totalSignups: { increment: 1 } },
      });

      // Welcome discount for the new user — ready to apply at first enrollment
      if (rules.refereeDiscountPercent > 0) {
        await tx.referralReward.create({
          data: {
            referralId: created.id,
            beneficiaryId: referredUserId,
            kind: ReferralRewardKind.REFEREE,
            discountType: DiscountType.PERCENTAGE,
            discountValue: rules.refereeDiscountPercent,
            status: ReferralRewardStatus.ISSUED,
            issuedAt: new Date(),
            expiresAt,
          },
        });
      }

      return created;
    });

    this.logger.log(
      `Referral signup tracked: referred=${referredUserId} code=${code} referrer=${referralCode.userId}`,
    );
    return referral;
  }

  // ----------------------------------------------------------
  // CONVERSION + REFERRER REWARD ISSUANCE
  // ----------------------------------------------------------

  /**
   * Marks a referral as converted when the referred user enrolls for the first time,
   * and issues a referrer enrollment-discount reward according to the active rules.
   */
  async trackConversion(referredUserId: string, enrollmentId: string) {
    const referral = await this.prisma.referral.findUnique({
      where: { referredUserId },
      include: { rewards: true },
    });

    // Not referred — nothing to do
    if (!referral) return null;

    // Already converted — idempotent
    if (referral.status === ReferralStatus.CONVERTED) {
      return referral;
    }

    const rules = this.getRewardRules();

    const referrerRewardCount = await this.prisma.referralReward.count({
      where: {
        beneficiaryId: referral.referrerId,
        kind: ReferralRewardKind.REFERRER,
        status: { in: [ReferralRewardStatus.ISSUED, ReferralRewardStatus.REDEEMED] },
      },
    });

    const canIssueReferrerReward =
      rules.referrerDiscountPercent > 0
      && referrerRewardCount < rules.maxRewardsPerReferrer;

    const expiresAt = this.expiryDate(rules.rewardExpiryDays);

    const updated = await this.prisma.$transaction(async (tx) => {
      const converted = await tx.referral.update({
        where: { id: referral.id },
        data: {
          status: ReferralStatus.CONVERTED,
          convertedAt: new Date(),
          enrollmentId,
        },
      });

      await tx.referralCode.update({
        where: { id: referral.referralCodeId },
        data: { totalConversions: { increment: 1 } },
      });

      if (canIssueReferrerReward) {
        await tx.referralReward.create({
          data: {
            referralId: referral.id,
            beneficiaryId: referral.referrerId,
            kind: ReferralRewardKind.REFERRER,
            discountType: DiscountType.PERCENTAGE,
            discountValue: rules.referrerDiscountPercent,
            status: ReferralRewardStatus.ISSUED,
            issuedAt: new Date(),
            expiresAt,
          },
        });
      }

      return converted;
    });

    if (canIssueReferrerReward) {
      try {
        await this.notifications.notifyUser(
          referral.referrerId,
          NotificationType.REFERRAL_REWARD_ISSUED,
          'Referral reward unlocked!',
          `A student you referred enrolled. You earned a ${rules.referrerDiscountPercent}% enrollment discount.`,
          { referralId: referral.id, enrollmentId },
        );
      } catch (error) {
        this.logger.warn(`Failed to notify referrer ${referral.referrerId}: ${error.message}`);
      }
    }

    this.logger.log(
      `Referral converted: referred=${referredUserId} enrollment=${enrollmentId} rewardIssued=${canIssueReferrerReward}`,
    );
    return updated;
  }

  // ----------------------------------------------------------
  // PERFORMANCE STATUS
  // ----------------------------------------------------------

  async getPerformanceStatus(userId: string) {
    const referralCode = await this.getOrCreateCode(userId);
    const rules = this.getRewardRules();

    const [signups, conversions, rewards, recentReferrals] = await Promise.all([
      this.prisma.referral.count({ where: { referrerId: userId } }),
      this.prisma.referral.count({
        where: { referrerId: userId, status: ReferralStatus.CONVERTED },
      }),
      this.prisma.referralReward.findMany({
        where: { beneficiaryId: userId },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.referral.findMany({
        where: { referrerId: userId },
        include: {
          referredUser: { select: { id: true, name: true, createdAt: true } },
          rewards: true,
        },
        orderBy: { signedUpAt: 'desc' },
        take: 20,
      }),
    ]);

    const issuedRewards = rewards.filter((r) => r.status === ReferralRewardStatus.ISSUED);
    const redeemedRewards = rewards.filter((r) => r.status === ReferralRewardStatus.REDEEMED);
    const pendingRewards = rewards.filter((r) => r.status === ReferralRewardStatus.PENDING);

    const conversionRate = signups > 0 ? Number(((conversions / signups) * 100).toFixed(2)) : 0;

    return {
      code: referralCode.code,
      isActive: referralCode.isActive,
      totals: {
        signups,
        conversions,
        conversionRate,
        rewardsIssued: issuedRewards.length + redeemedRewards.length,
        rewardsRedeemed: redeemedRewards.length,
        rewardsAvailable: issuedRewards.filter((r) => !this.isExpired(r.expiresAt)).length,
        rewardsPending: pendingRewards.length,
      },
      rewardRules: rules,
      recentReferrals: recentReferrals.map((r) => ({
        id: r.id,
        status: r.status,
        signedUpAt: r.signedUpAt,
        convertedAt: r.convertedAt,
        referredUser: r.referredUser,
        rewards: r.rewards.map((rw) => ({
          id: rw.id,
          kind: rw.kind,
          status: rw.status,
          discountType: rw.discountType,
          discountValue: Number(rw.discountValue),
          expiresAt: rw.expiresAt,
        })),
      })),
    };
  }

  // ----------------------------------------------------------
  // REWARDS — LIST / VALIDATE / REDEEM
  // ----------------------------------------------------------

  async listMyRewards(userId: string) {
    await this.expireStaleRewards(userId);

    const rewards = await this.prisma.referralReward.findMany({
      where: { beneficiaryId: userId },
      include: {
        referral: {
          select: {
            id: true,
            status: true,
            referredUser: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return rewards.map((r) => ({
      ...r,
      discountValue: Number(r.discountValue),
      usable: r.status === ReferralRewardStatus.ISSUED && !this.isExpired(r.expiresAt),
    }));
  }

  /**
   * Preview the discount for an available referral reward without redeeming it.
   */
  async previewReward(
    userId: string,
    originalPrice: number,
    rewardId?: string,
  ) {
    await this.expireStaleRewards(userId);
    const reward = await this.findUsableReward(userId, rewardId);

    const discountAmount = this.calculateDiscount(
      reward.discountType,
      Number(reward.discountValue),
      originalPrice,
    );
    const finalPrice = Math.max(0, originalPrice - discountAmount);

    return {
      valid: true,
      rewardId: reward.id,
      kind: reward.kind,
      discountType: reward.discountType,
      discountValue: Number(reward.discountValue),
      discountAmount: Number(discountAmount.toFixed(2)),
      originalPrice,
      finalPrice: Number(finalPrice.toFixed(2)),
      expiresAt: reward.expiresAt,
    };
  }

  /**
   * Marks a referral reward as redeemed after a successful enrollment purchase.
   */
  async redeemReward(userId: string, rewardId: string, enrollmentId: string) {
    const reward = await this.prisma.referralReward.findUnique({ where: { id: rewardId } });
    if (!reward || reward.beneficiaryId !== userId) {
      throw new NotFoundException('Referral reward not found');
    }
    if (reward.status !== ReferralRewardStatus.ISSUED) {
      throw new BadRequestException('This referral reward is not available for redemption');
    }
    if (this.isExpired(reward.expiresAt)) {
      await this.prisma.referralReward.update({
        where: { id: rewardId },
        data: { status: ReferralRewardStatus.EXPIRED },
      });
      throw new BadRequestException('This referral reward has expired');
    }

    return this.prisma.referralReward.update({
      where: { id: rewardId },
      data: {
        status: ReferralRewardStatus.REDEEMED,
        redeemedAt: new Date(),
        enrollmentId,
      },
    });
  }

  async deactivateCode(userId: string) {
    const code = await this.prisma.referralCode.findUnique({ where: { userId } });
    if (!code) throw new NotFoundException('No referral code found for this user');
    return this.prisma.referralCode.update({
      where: { userId },
      data: { isActive: false },
    });
  }

  // ----------------------------------------------------------
  // HELPERS
  // ----------------------------------------------------------

  private async generateUniqueCode(): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const suffix = randomBytes(3).toString('hex').toUpperCase();
      const code = `HAMP-${suffix}`;
      const exists = await this.prisma.referralCode.findUnique({ where: { code } });
      if (!exists) return code;
    }
    throw new ConflictException('Unable to generate a unique referral code. Please try again.');
  }

  private expiryDate(days: number): Date {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d;
  }

  private isExpired(expiresAt: Date | null | undefined): boolean {
    return !!expiresAt && expiresAt < new Date();
  }

  private async expireStaleRewards(userId: string) {
    await this.prisma.referralReward.updateMany({
      where: {
        beneficiaryId: userId,
        status: ReferralRewardStatus.ISSUED,
        expiresAt: { lt: new Date() },
      },
      data: { status: ReferralRewardStatus.EXPIRED },
    });
  }

  private async findUsableReward(userId: string, rewardId?: string) {
    if (rewardId) {
      const reward = await this.prisma.referralReward.findUnique({ where: { id: rewardId } });
      if (!reward || reward.beneficiaryId !== userId) {
        throw new NotFoundException('Referral reward not found');
      }
      if (reward.status !== ReferralRewardStatus.ISSUED || this.isExpired(reward.expiresAt)) {
        throw new BadRequestException('This referral reward is not usable');
      }
      return reward;
    }

    const reward = await this.prisma.referralReward.findFirst({
      where: {
        beneficiaryId: userId,
        status: ReferralRewardStatus.ISSUED,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: { expiresAt: 'asc' },
    });
    if (!reward) {
      throw new NotFoundException('No usable referral rewards available');
    }
    return reward;
  }

  private calculateDiscount(
    type: DiscountType,
    value: number,
    originalPrice: number,
  ): number {
    if (type === DiscountType.PERCENTAGE) {
      return (originalPrice * Math.min(value, 100)) / 100;
    }
    return Math.min(value, originalPrice);
  }
}
