import { Prisma } from '@prisma/client';
import { buildPricingSnapshot, instructorNetFromSnapshot } from './pricing-snapshot';

describe('pricing snapshot (issue #332)', () => {
  const course = { price: new Prisma.Decimal('100'), platformFeePercent: 20 };

  it('captures list price and fee for a full-price purchase', () => {
    const snap = buildPricingSnapshot(course, 100);

    expect(snap.listPrice.toNumber()).toBe(100);
    expect(snap.platformFeePercent).toBe(20);
    expect(snap.platformFeeAmount.toNumber()).toBe(20);
    expect(snap.taxAmount.toNumber()).toBe(0);
    expect(snap.discountAmount.toNumber()).toBe(0);
    expect(snap.discountSource).toBeNull();
  });

  it('treats the amount above list price as tax and excludes it from the fee', () => {
    const snap = buildPricingSnapshot(course, 107.5);

    expect(snap.taxAmount.toNumber()).toBe(7.5);
    expect(snap.platformFeeAmount.toNumber()).toBe(20);
    expect(snap.discountAmount.toNumber()).toBe(0);
  });

  it('records a discount and its source when paid below list price', () => {
    const snap = buildPricingSnapshot(course, new Prisma.Decimal('66.67'), 'BUNDLE');

    expect(snap.discountAmount.toNumber()).toBe(33.33);
    expect(snap.discountSource).toBe('BUNDLE');
    expect(snap.platformFeeAmount.toNumber()).toBe(13.33);
  });

  it('is unaffected by later course fee changes', () => {
    const mutableCourse = { ...course };
    const snap = buildPricingSnapshot(mutableCourse, 100);
    mutableCourse.platformFeePercent = 50;

    expect(
      instructorNetFromSnapshot({ amountPaid: 100, ...snap, platformFeePercent: 20 }).toNumber(),
    ).toBe(80);
  });

  it('falls back to the fee percent for rows without a fee snapshot', () => {
    expect(
      instructorNetFromSnapshot({ amountPaid: 125, platformFeePercent: 20 }).toNumber(),
    ).toBe(100);
  });
});
