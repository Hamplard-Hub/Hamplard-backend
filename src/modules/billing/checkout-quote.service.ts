import {
  Injectable, BadRequestException, ConflictException, ForbiddenException,
  NotFoundException, Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CheckoutQuote, CourseStatus, Prisma } from '@prisma/client';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CouponsService } from '../coupons/coupons.service';
import { ReferralsService } from '../referrals/referrals.service';
import { FeeCalculatorService } from './fee-calculator.service';
import { CreateCheckoutQuoteDto } from './dto/create-checkout-quote.dto';

const DEFAULT_QUOTE_TTL_SECONDS = 900;

type Money = number | Prisma.Decimal;

/** The quote fields covered by the HMAC signature. */
interface SignedQuoteFields {
  id: string;
  studentId: string;
  courseId: string;
  currency: string;
  listPrice: Money;
  couponId: string | null;
  couponDiscount: Money;
  referralRewardId: string | null;
  referralDiscount: Money;
  subtotal: Money;
  taxRegion: string;
  taxRatePercent: Money;
  taxAmount: Money;
  total: Money;
  expiresAt: Date;
}

/** Plain-number view of a quote, as returned to clients and used by enrollment. */
export interface CheckoutQuoteView {
  quoteId: string;
  courseId: string;
  currency: string;
  listPrice: number;
  coupon: { couponId: string; code: string | null; discountAmount: number } | null;
  referralReward: { rewardId: string; discountAmount: number } | null;
  discountTotal: number;
  subtotal: number;
  taxRegion: string;
  taxRatePercent: number;
  taxAmount: number;
  total: number;
  signature: string;
  expiresAt: Date;
}

/**
 * Issue #333: prices a checkout server-side — course price, coupon, referral
 * reward and regional tax — into a single signed, short-lived quote. The
 * enrollment endpoint requires the quote id, checks the on-chain amount
 * against `total`, and consumes the quote together with any coupon/reward
 * redemption in the enrollment transaction.
 */
@Injectable()
export class CheckoutQuoteService {
  private readonly logger = new Logger(CheckoutQuoteService.name);
  private readonly secret: string;
  private readonly ttlSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly feeCalculator: FeeCalculatorService,
    private readonly coupons: CouponsService,
    private readonly referrals: ReferralsService,
  ) {
    this.secret =
      this.config.get<string>('CHECKOUT_QUOTE_SECRET')
      || this.config.get<string>('JWT_SECRET')
      || 'hamplard-checkout-quote-dev-secret';
    this.ttlSeconds = Number(
      this.config.get('CHECKOUT_QUOTE_TTL_SECONDS', DEFAULT_QUOTE_TTL_SECONDS),
    );
  }

  // ----------------------------------------------------------
  // CREATE
  // ----------------------------------------------------------

  async createQuote(studentId: string, dto: CreateCheckoutQuoteDto): Promise<CheckoutQuoteView> {
    const course = await this.prisma.course.findUnique({
      where: { id: dto.courseId },
      select: { id: true, price: true, status: true },
    });
    if (!course) throw new NotFoundException(`Course ${dto.courseId} not found`);
    if (course.status !== CourseStatus.ACTIVE) {
      throw new ForbiddenException(
        `Cannot check out a ${course.status} course. Only ACTIVE courses accept enrollments.`,
      );
    }

    const round = (v: number) => this.feeCalculator.round(v);
    const listPrice = round(Number(course.price));

    // Coupon is applied to the list price (validate() re-reads the price server-side).
    let couponId: string | null = null;
    let couponCode: string | null = null;
    let couponDiscount = 0;
    if (dto.couponCode) {
      const coupon = await this.coupons.validate(studentId, {
        code: dto.couponCode,
        courseId: course.id,
      });
      couponId = coupon.couponId;
      couponCode = coupon.code;
      couponDiscount = round(coupon.discountAmount);
    }

    // Referral reward is applied to the price after the coupon.
    const afterCoupon = round(Math.max(0, listPrice - couponDiscount));
    let referralRewardId: string | null = null;
    let referralDiscount = 0;
    if (dto.referralRewardId) {
      const reward = await this.referrals.previewReward(
        studentId,
        afterCoupon,
        dto.referralRewardId,
      );
      referralRewardId = reward.rewardId;
      referralDiscount = round(reward.discountAmount);
    }

    const subtotal = round(Math.max(0, afterCoupon - referralDiscount));
    const taxRegion = this.feeCalculator.normalizeRegion(dto.region);
    const taxRatePercent = await this.feeCalculator.getTaxRate(dto.region);
    const taxAmount = round(subtotal * (taxRatePercent / 100));
    const total = round(subtotal + taxAmount);

    const id = randomUUID();
    const expiresAt = new Date(Date.now() + this.ttlSeconds * 1000);
    const fields = {
      id,
      studentId,
      courseId: course.id,
      currency: 'USDC',
      listPrice,
      couponId,
      couponDiscount,
      referralRewardId,
      referralDiscount,
      subtotal,
      taxRegion,
      taxRatePercent,
      taxAmount,
      total,
      expiresAt,
    };
    const signature = this.sign(fields);

    const quote = await this.prisma.checkoutQuote.create({
      data: { ...fields, couponCode, signature },
    });

    this.logger.log(`Checkout quote ${id} issued: student=${studentId} course=${course.id} total=${total}`);
    return this.toView(quote);
  }

  // ----------------------------------------------------------
  // VERIFY + CONSUME (called by EnrollmentsService.create)
  // ----------------------------------------------------------

  /**
   * Loads a quote and checks it belongs to the caller and course, has not
   * expired or been used, and that its priced fields still match the signature.
   */
  async getUsableQuote(quoteId: string, studentId: string, courseId: string): Promise<CheckoutQuoteView> {
    const quote = await this.prisma.checkoutQuote.findUnique({ where: { id: quoteId } });
    if (!quote || quote.studentId !== studentId) {
      throw new NotFoundException('Checkout quote not found');
    }
    if (quote.courseId !== courseId) {
      throw new BadRequestException('Checkout quote was issued for a different course');
    }
    if (quote.consumedAt) {
      throw new ConflictException('Checkout quote has already been used');
    }
    if (quote.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('Checkout quote has expired. Request a new quote.');
    }
    if (!this.verify(quote)) {
      this.logger.error(`Checkout quote ${quote.id} failed signature verification`);
      throw new BadRequestException('Checkout quote signature is invalid');
    }
    return this.toView(quote);
  }

  /**
   * Marks the quote consumed and redeems its coupon / referral reward inside
   * the enrollment transaction, so all of them commit or roll back together.
   */
  async consumeWithinTransaction(
    tx: Prisma.TransactionClient,
    quote: CheckoutQuoteView,
    studentId: string,
    enrollmentId: string,
  ) {
    const now = new Date();
    const { count } = await tx.checkoutQuote.updateMany({
      where: { id: quote.quoteId, studentId, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now, enrollmentId },
    });
    if (count !== 1) {
      throw new ConflictException('Checkout quote has already been used or has expired');
    }

    if (quote.coupon) {
      await this.coupons.redeemWithinTransaction(tx, {
        couponId: quote.coupon.couponId,
        userId: studentId,
        courseId: quote.courseId,
        discount: quote.coupon.discountAmount,
      });
    }

    if (quote.referralReward) {
      await this.referrals.redeemRewardWithinTransaction(
        tx,
        quote.referralReward.rewardId,
        studentId,
        enrollmentId,
      );
    }
  }

  // ----------------------------------------------------------
  // SIGNING
  // ----------------------------------------------------------

  private canonical(q: SignedQuoteFields): string {
    const money = (v: Money) => Number(v).toFixed(2);
    return [
      q.id,
      q.studentId,
      q.courseId,
      q.currency,
      money(q.listPrice),
      q.couponId ?? '',
      money(q.couponDiscount),
      q.referralRewardId ?? '',
      money(q.referralDiscount),
      money(q.subtotal),
      q.taxRegion,
      Number(q.taxRatePercent).toFixed(4),
      money(q.taxAmount),
      money(q.total),
      q.expiresAt.toISOString(),
    ].join('|');
  }

  private sign(fields: SignedQuoteFields): string {
    return createHmac('sha256', this.secret).update(this.canonical(fields)).digest('hex');
  }

  private verify(quote: CheckoutQuote): boolean {
    const expected = Buffer.from(this.sign(quote));
    const actual = Buffer.from(quote.signature);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private toView(quote: CheckoutQuote): CheckoutQuoteView {
    const couponDiscount = Number(quote.couponDiscount);
    const referralDiscount = Number(quote.referralDiscount);
    return {
      quoteId: quote.id,
      courseId: quote.courseId,
      currency: quote.currency,
      listPrice: Number(quote.listPrice),
      coupon: quote.couponId
        ? { couponId: quote.couponId, code: quote.couponCode, discountAmount: couponDiscount }
        : null,
      referralReward: quote.referralRewardId
        ? { rewardId: quote.referralRewardId, discountAmount: referralDiscount }
        : null,
      discountTotal: this.feeCalculator.round(couponDiscount + referralDiscount),
      subtotal: Number(quote.subtotal),
      taxRegion: quote.taxRegion,
      taxRatePercent: Number(quote.taxRatePercent),
      taxAmount: Number(quote.taxAmount),
      total: Number(quote.total),
      signature: quote.signature,
      expiresAt: quote.expiresAt,
    };
  }
}
