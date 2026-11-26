import { Prisma } from '@prisma/client';

export type DiscountSource = 'COUPON' | 'REFERRAL' | 'BUNDLE';

export interface EnrollmentPricingSnapshot {
  listPrice: Prisma.Decimal;
  platformFeePercent: number;
  platformFeeAmount: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  discountAmount: Prisma.Decimal;
  discountSource: DiscountSource | null;
}

/**
 * Issue #332 — pricing snapshot persisted on an enrollment at purchase time.
 *
 * Checkout charges `listPrice + tax`, so any amount paid above the list price
 * is recorded as tax and any shortfall as a discount. The platform fee is
 * taken on the tax-exclusive amount using the course fee percent at purchase.
 * Reports and payouts read these columns instead of the current course, so
 * later price/fee changes never rewrite history.
 */
export function buildPricingSnapshot(
  course: { price?: Prisma.Decimal | number | string | null; platformFeePercent?: number | null },
  amountPaid: Prisma.Decimal | number,
  discountSource?: DiscountSource,
): EnrollmentPricingSnapshot {
  const zero = new Prisma.Decimal(0);
  const paid = new Prisma.Decimal(amountPaid);
  const listPrice = new Prisma.Decimal(course.price ?? 0);
  const platformFeePercent = course.platformFeePercent ?? 0;

  const taxAmount = Prisma.Decimal.max(paid.sub(listPrice), zero);
  const netPaid = paid.sub(taxAmount);
  const discountAmount = Prisma.Decimal.max(listPrice.sub(netPaid), zero);
  const platformFeeAmount = netPaid.mul(platformFeePercent).div(100).toDecimalPlaces(2);

  return {
    listPrice,
    platformFeePercent,
    platformFeeAmount,
    taxAmount,
    discountAmount,
    discountSource: discountAmount.gt(0) ? discountSource ?? null : null,
  };
}

/**
 * Instructor share of an enrollment: tax-exclusive amount minus the platform
 * fee snapshot. Falls back to the fee percent for rows without a snapshot.
 */
export function instructorNetFromSnapshot(enrollment: {
  amountPaid: Prisma.Decimal | number | string;
  platformFeePercent: number;
  platformFeeAmount?: Prisma.Decimal | number | string | null;
  taxAmount?: Prisma.Decimal | number | string | null;
}): Prisma.Decimal {
  const paid = new Prisma.Decimal(enrollment.amountPaid);
  const tax = new Prisma.Decimal(enrollment.taxAmount ?? 0);
  const net = paid.sub(tax);
  const fee =
    enrollment.platformFeeAmount !== null && enrollment.platformFeeAmount !== undefined
      ? new Prisma.Decimal(enrollment.platformFeeAmount)
      : net.mul(enrollment.platformFeePercent).div(100);
  return net.sub(fee);
}
