import {
  BadRequestException, ConflictException, ForbiddenException, NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { CourseStatus } from '@prisma/client';
import { CheckoutQuoteService } from './checkout-quote.service';
import { FeeCalculatorService } from './fee-calculator.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CouponsService } from '../coupons/coupons.service';
import { ReferralsService } from '../referrals/referrals.service';

describe('CheckoutQuoteService (Issue #333)', () => {
  let service: CheckoutQuoteService;
  let stored: Record<string, any> | null;

  const mockPrisma = {
    course: { findUnique: jest.fn() },
    taxRate: { findMany: jest.fn() },
    checkoutQuote: {
      create: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
  };

  const mockCoupons = {
    validate: jest.fn(),
    redeemWithinTransaction: jest.fn(),
  };

  const mockReferrals = {
    previewReward: jest.fn(),
    redeemRewardWithinTransaction: jest.fn(),
  };

  const mockConfig = {
    get: jest.fn((key: string, fallback?: unknown) => {
      if (key === 'CHECKOUT_QUOTE_SECRET') return 'test-quote-secret';
      return fallback;
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    stored = null;

    mockPrisma.course.findUnique.mockResolvedValue({
      id: 'course-1', price: 100, status: CourseStatus.ACTIVE,
    });
    mockPrisma.taxRate.findMany.mockResolvedValue([
      { region: 'NG', ratePercent: 7.5 },
      { region: 'DEFAULT', ratePercent: 0 },
    ]);
    mockPrisma.checkoutQuote.create.mockImplementation(async ({ data }: any) => {
      stored = { consumedAt: null, enrollmentId: null, createdAt: new Date(), ...data };
      return stored;
    });
    mockPrisma.checkoutQuote.findUnique.mockImplementation(async () => stored);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CheckoutQuoteService,
        FeeCalculatorService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfig },
        { provide: CouponsService, useValue: mockCoupons },
        { provide: ReferralsService, useValue: mockReferrals },
      ],
    }).compile();

    service = module.get(CheckoutQuoteService);
  });

  describe('createQuote', () => {
    it('prices the course server-side with tax and no discounts', async () => {
      const quote = await service.createQuote('student-1', { courseId: 'course-1', region: 'ng' });

      expect(quote.listPrice).toBe(100);
      expect(quote.coupon).toBeNull();
      expect(quote.referralReward).toBeNull();
      expect(quote.subtotal).toBe(100);
      expect(quote.taxRegion).toBe('NG');
      expect(quote.taxRatePercent).toBe(7.5);
      expect(quote.taxAmount).toBe(7.5);
      expect(quote.total).toBe(107.5);
      expect(quote.signature).toMatch(/^[0-9a-f]{64}$/);
      expect(quote.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('applies the coupon to the list price and the referral reward after it', async () => {
      mockCoupons.validate.mockResolvedValue({
        couponId: 'coupon-1', code: 'SAVE20', discountAmount: 20,
      });
      mockReferrals.previewReward.mockResolvedValue({
        rewardId: 'reward-1', discountAmount: 8,
      });

      const quote = await service.createQuote('student-1', {
        courseId: 'course-1',
        region: 'NG',
        couponCode: 'save20',
        referralRewardId: 'reward-1',
      });

      expect(mockCoupons.validate).toHaveBeenCalledWith('student-1', { code: 'save20', courseId: 'course-1' });
      // Referral discount is computed on the post-coupon price (100 - 20)
      expect(mockReferrals.previewReward).toHaveBeenCalledWith('student-1', 80, 'reward-1');
      expect(quote.coupon).toEqual({ couponId: 'coupon-1', code: 'SAVE20', discountAmount: 20 });
      expect(quote.referralReward).toEqual({ rewardId: 'reward-1', discountAmount: 8 });
      expect(quote.discountTotal).toBe(28);
      expect(quote.subtotal).toBe(72);
      expect(quote.taxAmount).toBe(5.4);
      expect(quote.total).toBe(77.4);
    });

    it('rejects an unknown course', async () => {
      mockPrisma.course.findUnique.mockResolvedValue(null);
      await expect(service.createQuote('student-1', { courseId: 'nope' }))
        .rejects.toThrow(NotFoundException);
    });

    it('rejects a course that is not ACTIVE', async () => {
      mockPrisma.course.findUnique.mockResolvedValue({
        id: 'course-1', price: 100, status: CourseStatus.DRAFT,
      });
      await expect(service.createQuote('student-1', { courseId: 'course-1' }))
        .rejects.toThrow(ForbiddenException);
    });

    it('propagates an invalid coupon instead of issuing a quote', async () => {
      mockCoupons.validate.mockRejectedValue(new BadRequestException('This coupon has expired'));
      await expect(service.createQuote('student-1', { courseId: 'course-1', couponCode: 'OLD' }))
        .rejects.toThrow('This coupon has expired');
      expect(mockPrisma.checkoutQuote.create).not.toHaveBeenCalled();
    });
  });

  describe('getUsableQuote', () => {
    it('returns a valid quote for its owner and course', async () => {
      const created = await service.createQuote('student-1', { courseId: 'course-1' });
      const quote = await service.getUsableQuote(created.quoteId, 'student-1', 'course-1');
      expect(quote.total).toBe(100);
    });

    it('hides quotes that belong to another student', async () => {
      const created = await service.createQuote('student-1', { courseId: 'course-1' });
      await expect(service.getUsableQuote(created.quoteId, 'student-2', 'course-1'))
        .rejects.toThrow(NotFoundException);
    });

    it('rejects a quote issued for a different course', async () => {
      const created = await service.createQuote('student-1', { courseId: 'course-1' });
      await expect(service.getUsableQuote(created.quoteId, 'student-1', 'course-2'))
        .rejects.toThrow(BadRequestException);
    });

    it('rejects an expired quote', async () => {
      const created = await service.createQuote('student-1', { courseId: 'course-1' });
      stored!.expiresAt = new Date(Date.now() - 1000);
      await expect(service.getUsableQuote(created.quoteId, 'student-1', 'course-1'))
        .rejects.toThrow('expired');
    });

    it('rejects a quote that was already used', async () => {
      const created = await service.createQuote('student-1', { courseId: 'course-1' });
      stored!.consumedAt = new Date();
      await expect(service.getUsableQuote(created.quoteId, 'student-1', 'course-1'))
        .rejects.toThrow(ConflictException);
    });

    it('rejects a quote whose priced fields were tampered with', async () => {
      const created = await service.createQuote('student-1', { courseId: 'course-1' });
      stored!.total = 1;
      await expect(service.getUsableQuote(created.quoteId, 'student-1', 'course-1'))
        .rejects.toThrow('signature');
    });
  });

  describe('consumeWithinTransaction', () => {
    const tx = { checkoutQuote: { updateMany: jest.fn() } } as any;

    it('consumes the quote and redeems its coupon and referral reward', async () => {
      mockCoupons.validate.mockResolvedValue({ couponId: 'coupon-1', code: 'SAVE20', discountAmount: 20 });
      mockReferrals.previewReward.mockResolvedValue({ rewardId: 'reward-1', discountAmount: 8 });
      const quote = await service.createQuote('student-1', {
        courseId: 'course-1', couponCode: 'SAVE20', referralRewardId: 'reward-1',
      });
      tx.checkoutQuote.updateMany.mockResolvedValue({ count: 1 });

      await service.consumeWithinTransaction(tx, quote, 'student-1', 'enroll-1');

      expect(tx.checkoutQuote.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ id: quote.quoteId, consumedAt: null }),
        data: expect.objectContaining({ enrollmentId: 'enroll-1' }),
      }));
      expect(mockCoupons.redeemWithinTransaction).toHaveBeenCalledWith(tx, {
        couponId: 'coupon-1', userId: 'student-1', courseId: 'course-1', discount: 20,
      });
      expect(mockReferrals.redeemRewardWithinTransaction)
        .toHaveBeenCalledWith(tx, 'reward-1', 'student-1', 'enroll-1');
    });

    it('fails (rolling back the enrollment) when the quote was consumed concurrently', async () => {
      const quote = await service.createQuote('student-1', { courseId: 'course-1' });
      tx.checkoutQuote.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.consumeWithinTransaction(tx, quote, 'student-1', 'enroll-1'))
        .rejects.toThrow(ConflictException);
      expect(mockCoupons.redeemWithinTransaction).not.toHaveBeenCalled();
    });
  });
});
