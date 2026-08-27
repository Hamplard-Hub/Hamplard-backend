import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ReferralsService } from './referrals.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  DiscountType,
  ReferralRewardKind,
  ReferralRewardStatus,
  ReferralStatus,
} from '@prisma/client';

describe('ReferralsService', () => {
  let service: ReferralsService;

  const mockPrisma: any = {
    user: { findUnique: jest.fn() },
    referralCode: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    referral: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
    referralReward: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  const mockNotifications = {
    notifyUser: jest.fn(),
  };

  const mockConfig = {
    get: jest.fn((key: string, defaultValue?: number) => {
      const defaults: Record<string, number> = {
        REFERRAL_REFERRER_DISCOUNT_PERCENT: 10,
        REFERRAL_REFEREE_DISCOUNT_PERCENT: 10,
        REFERRAL_REWARD_EXPIRY_DAYS: 90,
        REFERRAL_MAX_REWARDS_PER_REFERRER: 50,
      };
      return defaults[key] ?? defaultValue;
    }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReferralsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfig },
        { provide: NotificationsService, useValue: mockNotifications },
      ],
    }).compile();

    service = module.get<ReferralsService>(ReferralsService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getOrCreateCode', () => {
    it('returns existing code without creating a new one', async () => {
      const existing = { id: 'rc-1', userId: 'u-1', code: 'HAMP-ABC123', isActive: true };
      mockPrisma.referralCode.findUnique.mockResolvedValue(existing);

      const result = await service.getOrCreateCode('u-1');

      expect(result).toEqual(existing);
      expect(mockPrisma.referralCode.create).not.toHaveBeenCalled();
    });

    it('generates a new unique referral code when none exists', async () => {
      mockPrisma.referralCode.findUnique
        .mockResolvedValueOnce(null) // getOrCreateCode lookup by userId
        .mockResolvedValueOnce(null); // uniqueness check in generateUniqueCode
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'u-1' });
      mockPrisma.referralCode.create.mockResolvedValue({
        id: 'rc-1',
        userId: 'u-1',
        code: 'HAMP-DEADBE',
        isActive: true,
      });

      const result = await service.getOrCreateCode('u-1');

      expect(mockPrisma.referralCode.create).toHaveBeenCalled();
      expect(result.userId).toBe('u-1');
      expect(result.code).toMatch(/^HAMP-/);
    });

    it('throws when user does not exist', async () => {
      mockPrisma.referralCode.findUnique.mockResolvedValue(null);
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(service.getOrCreateCode('missing')).rejects.toThrow(NotFoundException);
    });
  });

  describe('validateCode', () => {
    it('validates an active referral code', async () => {
      mockPrisma.referralCode.findUnique.mockResolvedValue({
        id: 'rc-1',
        code: 'HAMP-ABC123',
        isActive: true,
        userId: 'referrer-1',
        user: { id: 'referrer-1', name: 'Ada', stellarAddress: 'GADA' },
      });

      const result = await service.validateCode('hamp-abc123');

      expect(result.valid).toBe(true);
      expect(result.code).toBe('HAMP-ABC123');
      expect(result.refereeDiscountPercent).toBe(10);
    });

    it('rejects an inactive code', async () => {
      mockPrisma.referralCode.findUnique.mockResolvedValue({
        id: 'rc-1',
        code: 'HAMP-ABC123',
        isActive: false,
        userId: 'referrer-1',
        user: { id: 'referrer-1', name: 'Ada', stellarAddress: 'GADA' },
      });

      await expect(service.validateCode('HAMP-ABC123')).rejects.toThrow(BadRequestException);
    });

    it('rejects self-referral', async () => {
      mockPrisma.referralCode.findUnique.mockResolvedValue({
        id: 'rc-1',
        code: 'HAMP-ABC123',
        isActive: true,
        userId: 'u-1',
        user: { id: 'u-1', name: 'Ada', stellarAddress: 'GADA' },
      });

      await expect(service.validateCode('HAMP-ABC123', 'u-1')).rejects.toThrow(BadRequestException);
    });

    it('throws when code is not found', async () => {
      mockPrisma.referralCode.findUnique.mockResolvedValue(null);
      await expect(service.validateCode('NOPE')).rejects.toThrow(NotFoundException);
    });
  });

  describe('trackSignup', () => {
    it('tracks signup and issues referee reward', async () => {
      mockPrisma.referral.findUnique.mockResolvedValue(null);
      mockPrisma.referralCode.findUnique.mockResolvedValue({
        id: 'rc-1',
        code: 'HAMP-ABC123',
        isActive: true,
        userId: 'referrer-1',
      });

      const createdReferral = {
        id: 'ref-1',
        referralCodeId: 'rc-1',
        referrerId: 'referrer-1',
        referredUserId: 'new-user',
        status: ReferralStatus.SIGNED_UP,
      };

      mockPrisma.$transaction.mockImplementation(async (cb: any) =>
        cb({
          referral: {
            create: jest.fn().mockResolvedValue(createdReferral),
          },
          referralCode: {
            update: jest.fn().mockResolvedValue({}),
          },
          referralReward: {
            create: jest.fn().mockResolvedValue({}),
          },
        }),
      );

      const result = await service.trackSignup('new-user', 'HAMP-ABC123');

      expect(result.id).toBe('ref-1');
      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });

    it('rejects duplicate referral for the same user', async () => {
      mockPrisma.referral.findUnique.mockResolvedValue({ id: 'ref-1' });
      await expect(service.trackSignup('new-user', 'HAMP-ABC123')).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('trackConversion', () => {
    it('returns null when user was not referred', async () => {
      mockPrisma.referral.findUnique.mockResolvedValue(null);
      const result = await service.trackConversion('user-x', 'enr-1');
      expect(result).toBeNull();
    });

    it('is idempotent when already converted', async () => {
      const converted = {
        id: 'ref-1',
        status: ReferralStatus.CONVERTED,
        referrerId: 'referrer-1',
        rewards: [],
      };
      mockPrisma.referral.findUnique.mockResolvedValue(converted);

      const result = await service.trackConversion('new-user', 'enr-1');
      expect(result).toEqual(converted);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('converts referral and issues referrer reward under the rules', async () => {
      mockPrisma.referral.findUnique.mockResolvedValue({
        id: 'ref-1',
        status: ReferralStatus.SIGNED_UP,
        referrerId: 'referrer-1',
        referralCodeId: 'rc-1',
        rewards: [],
      });
      mockPrisma.referralReward.count.mockResolvedValue(0);

      const updated = {
        id: 'ref-1',
        status: ReferralStatus.CONVERTED,
        enrollmentId: 'enr-1',
      };

      mockPrisma.$transaction.mockImplementation(async (cb: any) =>
        cb({
          referral: {
            update: jest.fn().mockResolvedValue(updated),
          },
          referralCode: {
            update: jest.fn().mockResolvedValue({}),
          },
          referralReward: {
            create: jest.fn().mockResolvedValue({}),
          },
        }),
      );
      mockNotifications.notifyUser.mockResolvedValue(undefined);

      const result = await service.trackConversion('new-user', 'enr-1');

      expect(result.status).toBe(ReferralStatus.CONVERTED);
      expect(mockNotifications.notifyUser).toHaveBeenCalled();
    });

    it('skips referrer reward when max rewards per referrer is reached', async () => {
      mockPrisma.referral.findUnique.mockResolvedValue({
        id: 'ref-1',
        status: ReferralStatus.SIGNED_UP,
        referrerId: 'referrer-1',
        referralCodeId: 'rc-1',
        rewards: [],
      });
      mockPrisma.referralReward.count.mockResolvedValue(50);

      const rewardCreate = jest.fn();
      mockPrisma.$transaction.mockImplementation(async (cb: any) =>
        cb({
          referral: {
            update: jest.fn().mockResolvedValue({
              id: 'ref-1',
              status: ReferralStatus.CONVERTED,
            }),
          },
          referralCode: {
            update: jest.fn().mockResolvedValue({}),
          },
          referralReward: {
            create: rewardCreate,
          },
        }),
      );

      await service.trackConversion('new-user', 'enr-1');
      expect(rewardCreate).not.toHaveBeenCalled();
      expect(mockNotifications.notifyUser).not.toHaveBeenCalled();
    });
  });

  describe('getPerformanceStatus', () => {
    it('returns aggregated signup/conversion/reward performance', async () => {
      mockPrisma.referralCode.findUnique.mockResolvedValue({
        id: 'rc-1',
        userId: 'u-1',
        code: 'HAMP-ABC123',
        isActive: true,
      });
      mockPrisma.referral.count
        .mockResolvedValueOnce(4) // signups
        .mockResolvedValueOnce(2); // conversions
      mockPrisma.referralReward.findMany.mockResolvedValue([
        {
          id: 'rw-1',
          status: ReferralRewardStatus.ISSUED,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
        {
          id: 'rw-2',
          status: ReferralRewardStatus.REDEEMED,
          expiresAt: null,
        },
      ]);
      mockPrisma.referral.findMany.mockResolvedValue([
        {
          id: 'ref-1',
          status: ReferralStatus.CONVERTED,
          signedUpAt: new Date(),
          convertedAt: new Date(),
          referredUser: { id: 'u-2', name: 'Bob', createdAt: new Date() },
          rewards: [
            {
              id: 'rw-1',
              kind: ReferralRewardKind.REFERRER,
              status: ReferralRewardStatus.ISSUED,
              discountType: DiscountType.PERCENTAGE,
              discountValue: 10,
              expiresAt: null,
            },
          ],
        },
      ]);

      const result = await service.getPerformanceStatus('u-1');

      expect(result.code).toBe('HAMP-ABC123');
      expect(result.totals.signups).toBe(4);
      expect(result.totals.conversions).toBe(2);
      expect(result.totals.conversionRate).toBe(50);
      expect(result.recentReferrals).toHaveLength(1);
    });
  });

  describe('reward rules', () => {
    it('returns default reward rules from config', () => {
      const rules = service.getRewardRules();
      expect(rules.referrerDiscountPercent).toBe(10);
      expect(rules.refereeDiscountPercent).toBe(10);
      expect(rules.rewardExpiryDays).toBe(90);
      expect(rules.maxRewardsPerReferrer).toBe(50);
    });

    it('applies admin overrides to reward rules', () => {
      const updated = service.updateRewardRules({
        referrerDiscountPercent: 15,
        maxRewardsPerReferrer: 20,
      });
      expect(updated.referrerDiscountPercent).toBe(15);
      expect(updated.maxRewardsPerReferrer).toBe(20);
      expect(updated.refereeDiscountPercent).toBe(10);
    });
  });

  describe('previewReward / redeemReward', () => {
    it('previews percentage discount for a usable reward', async () => {
      mockPrisma.referralReward.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.referralReward.findFirst.mockResolvedValue({
        id: 'rw-1',
        beneficiaryId: 'u-1',
        status: ReferralRewardStatus.ISSUED,
        discountType: DiscountType.PERCENTAGE,
        discountValue: 10,
        kind: ReferralRewardKind.REFEREE,
        expiresAt: new Date(Date.now() + 86_400_000),
      });

      const result = await service.previewReward('u-1', 50);

      expect(result.valid).toBe(true);
      expect(result.discountAmount).toBe(5);
      expect(result.finalPrice).toBe(45);
    });

    it('redeems an issued reward', async () => {
      mockPrisma.referralReward.findUnique.mockResolvedValue({
        id: 'rw-1',
        beneficiaryId: 'u-1',
        status: ReferralRewardStatus.ISSUED,
        expiresAt: new Date(Date.now() + 86_400_000),
      });
      mockPrisma.referralReward.update.mockResolvedValue({
        id: 'rw-1',
        status: ReferralRewardStatus.REDEEMED,
        enrollmentId: 'enr-1',
      });

      const result = await service.redeemReward('u-1', 'rw-1', 'enr-1');
      expect(result.status).toBe(ReferralRewardStatus.REDEEMED);
    });

    it('rejects redemption of a non-issued reward', async () => {
      mockPrisma.referralReward.findUnique.mockResolvedValue({
        id: 'rw-1',
        beneficiaryId: 'u-1',
        status: ReferralRewardStatus.REDEEMED,
        expiresAt: null,
      });

      await expect(service.redeemReward('u-1', 'rw-1', 'enr-1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
