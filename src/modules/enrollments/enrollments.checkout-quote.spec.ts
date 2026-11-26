import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { CourseStatus } from '@prisma/client';
import { EnrollmentsService } from './enrollments.service';
import { FraudDetectionService } from './fraud-detection.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { InvoicesService } from '../invoices/invoices.service';
import { ReferralsService } from '../referrals/referrals.service';
import { DripScheduleService } from '../lessons/drip-schedule.service';
import { StellarService } from '../../common/stellar/stellar.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { CheckoutQuoteService } from '../billing/checkout-quote.service';

/**
 * Issue #333 — enrollment requires a checkout quote, only succeeds when the
 * on-chain amount matches the quote total, and consumes the quote (with its
 * coupon / referral reward) inside the enrollment transaction.
 */
describe('EnrollmentsService.create with checkout quotes (Issue #333)', () => {
  let service: EnrollmentsService;

  const quote = {
    quoteId: 'quote-1',
    courseId: 'course-1',
    currency: 'USDC',
    listPrice: 100,
    coupon: { couponId: 'coupon-1', code: 'SAVE20', discountAmount: 20 },
    referralReward: null,
    discountTotal: 20,
    subtotal: 80,
    taxRegion: 'NG',
    taxRatePercent: 7.5,
    taxAmount: 6,
    total: 86,
    signature: 'sig',
    expiresAt: new Date(Date.now() + 60_000),
  };

  const tx = {
    payment: { create: jest.fn().mockResolvedValue({ id: 'payment-1' }) },
    enrollment: { create: jest.fn() },
    course: { update: jest.fn().mockResolvedValue({}) },
  };

  const mockPrisma = {
    course: {
      findUnique: jest.fn(),
    },
    enrollment: { findUnique: jest.fn() },
    payment: { findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
    coursePrerequisite: { findMany: jest.fn() },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };

  const mockStellar = {
    getContractId: jest.fn().mockReturnValue('CCONTRACT'),
    verifyEnrollmentTransaction: jest.fn(),
  };

  const mockCheckoutQuotes = {
    getUsableQuote: jest.fn(),
    consumeWithinTransaction: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    mockPrisma.course.findUnique.mockResolvedValue({
      id: 'course-1',
      title: 'Tailoring',
      price: 100,
      status: CourseStatus.ACTIVE,
      platformFeePercent: 20,
      instructorAddress: 'GINSTRUCTOR',
    });
    mockPrisma.enrollment.findUnique.mockResolvedValue(null);
    mockPrisma.payment.findUnique.mockResolvedValue(null);
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'student-1', stellarAddress: 'GSTUDENT' });
    mockPrisma.coursePrerequisite.findMany.mockResolvedValue([]);
    tx.enrollment.create.mockImplementation(async ({ data }: any) => ({
      id: 'enroll-1',
      ...data,
      course: { title: 'Tailoring', instructorAddress: 'GINSTRUCTOR' },
      student: { id: 'student-1' },
    }));
    mockCheckoutQuotes.getUsableQuote.mockResolvedValue(quote);
    mockCheckoutQuotes.consumeWithinTransaction.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EnrollmentsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: StellarService, useValue: mockStellar },
        { provide: CheckoutQuoteService, useValue: mockCheckoutQuotes },
        {
          provide: FraudDetectionService,
          useValue: {
            processFraudCheck: jest.fn().mockResolvedValue({ action: 'ALLOW', score: 0, reasons: [] }),
          },
        },
        { provide: NotificationsService, useValue: { notifyUser: jest.fn().mockResolvedValue({}) } },
        { provide: InvoicesService, useValue: { generateForEnrollment: jest.fn().mockResolvedValue({}) } },
        { provide: ReferralsService, useValue: { trackConversion: jest.fn().mockResolvedValue({}) } },
        {
          provide: DripScheduleService,
          useValue: { calculateAndSyncUnlockSchedule: jest.fn().mockResolvedValue({}) },
        },
        { provide: AnalyticsService, useValue: { trackEvent: jest.fn().mockResolvedValue({}) } },
      ],
    }).compile();

    service = module.get(EnrollmentsService);
  });

  it('requires a quote id', async () => {
    await expect(service.create('student-1', 'course-1', 'tx-1', ''))
      .rejects.toThrow(BadRequestException);
    expect(mockStellar.verifyEnrollmentTransaction).not.toHaveBeenCalled();
  });

  it('verifies the on-chain payment against the quote total, not the list price', async () => {
    mockStellar.verifyEnrollmentTransaction.mockResolvedValue({ amountPaid: 86 });

    await service.create('student-1', 'course-1', 'tx-1', 'quote-1');

    expect(mockCheckoutQuotes.getUsableQuote).toHaveBeenCalledWith('quote-1', 'student-1', 'course-1');
    expect(mockStellar.verifyEnrollmentTransaction).toHaveBeenCalledWith(
      'tx-1', 'CCONTRACT', 'GSTUDENT', 'course-1', 86,
    );
  });

  it('stores the quote price snapshot and consumes the quote in the same transaction', async () => {
    mockStellar.verifyEnrollmentTransaction.mockResolvedValue({ amountPaid: 86 });

    const enrollment = await service.create('student-1', 'course-1', 'tx-1', 'quote-1');

    expect(tx.enrollment.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        checkoutQuoteId: 'quote-1',
        couponId: 'coupon-1',
        taxRegion: 'NG',
      }),
    }));
    expect(Number(enrollment.amountPaid)).toBe(86);
    expect(Number(enrollment.listPrice)).toBe(100);
    expect(Number(enrollment.couponDiscount)).toBe(20);
    expect(Number(enrollment.taxAmount)).toBe(6);
    expect(mockCheckoutQuotes.consumeWithinTransaction)
      .toHaveBeenCalledWith(tx, quote, 'student-1', 'enroll-1');
  });

  it('rejects an on-chain amount that does not match the quote total', async () => {
    mockStellar.verifyEnrollmentTransaction.mockResolvedValue({ amountPaid: 100 });

    await expect(service.create('student-1', 'course-1', 'tx-1', 'quote-1'))
      .rejects.toThrow('does not match the checkout quote total');
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockCheckoutQuotes.consumeWithinTransaction).not.toHaveBeenCalled();
  });

  it('does not enroll when the quote is unusable', async () => {
    mockCheckoutQuotes.getUsableQuote.mockRejectedValue(
      new ConflictException('Checkout quote has already been used'),
    );

    await expect(service.create('student-1', 'course-1', 'tx-1', 'quote-1'))
      .rejects.toThrow(ConflictException);
    expect(mockStellar.verifyEnrollmentTransaction).not.toHaveBeenCalled();
  });

  it('propagates a failed coupon/quote redemption so the enrollment rolls back', async () => {
    mockStellar.verifyEnrollmentTransaction.mockResolvedValue({ amountPaid: 86 });
    mockCheckoutQuotes.consumeWithinTransaction.mockRejectedValue(
      new BadRequestException('This coupon is no longer available'),
    );

    await expect(service.create('student-1', 'course-1', 'tx-1', 'quote-1'))
      .rejects.toThrow('This coupon is no longer available');
  });
});
